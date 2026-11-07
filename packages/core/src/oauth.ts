import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { bytesToString } from '@siteinquisition/codecs';
import { sendReplay } from './replay.js';
import { SecretBox } from './secrets.js';
import type { CaptureStore, HeaderList } from './store.js';

/**
 * OAuth 2.0 profiles, so an API behind OAuth can be replayed without copying
 * tokens around by hand. A profile says how to get a token (authorization
 * code with PKCE, client credentials, password, or a refresh token alone)
 * and holds the tokens it got. `{{oauth:name}}` is its access token in any
 * request, refreshed (or fetched again) before a send once it has expired.
 *
 * For the authorization code grant the sign-in page opens in the built-in
 * browser. The proxy answers the redirect back to the redirect URI itself
 * (only while a sign-in is waiting, and only for the matching state), so the
 * redirect URI does not need to be a page that exists. Every token request is
 * recorded, tagged `oauth:<name>`.
 */

export type OAuthGrant = 'authorization_code' | 'client_credentials' | 'password' | 'refresh_token';

export interface OAuthTokens {
  accessToken: string;
  tokenType?: string;
  refreshToken?: string;
  idToken?: string;
  scope?: string;
  /** ms since epoch; missing when the server gave no expires_in. */
  expiresAt?: number;
  obtainedAt: number;
  /** Every field of the token response, for {{oauth:name.field}}. */
  raw: Record<string, unknown>;
}

export interface OAuthProfile {
  name: string;
  grant: OAuthGrant;
  /** Authorization endpoint (authorization code). */
  authUrl?: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  audience?: string;
  redirectUri?: string;
  /** Authorization code: send a PKCE challenge (on by default). */
  pkce?: boolean;
  pkceMethod?: 'S256' | 'plain';
  /** Where the client credentials go on the token request: an HTTP Basic header (default) or the form body. */
  clientAuth?: 'basic' | 'body';
  username?: string;
  password?: string;
  /** More parameters for the authorization request, as a=1&b=2. */
  extraAuthParams?: string;
  /** More parameters for the token request, as a=1&b=2. */
  extraTokenParams?: string;
  /** Where the endpoints were discovered from, if they were. */
  issuer?: string;
  tokens?: OAuthTokens;
}

/** A profile as the UI sees it: secrets included (it is the user's own app), tokens summarised. */
export interface OAuthProfileView extends Omit<OAuthProfile, 'tokens'> {
  token: null | { tokenType?: string; scope?: string; expiresAt?: number; obtainedAt: number; hasRefresh: boolean; hasIdToken: boolean; preview: string; expired: boolean };
  /** A sign-in is waiting for the redirect back. */
  waiting: boolean;
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256' | 'plain';
}

/** A PKCE verifier (43 to 128 characters of [A-Za-z0-9-._~]) and its challenge. */
export function makePkce(method: 'S256' | 'plain' = 'S256', verifier?: string): Pkce {
  const v = verifier ?? randomBytes(48).toString('base64url');
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(v)) throw new Error('a PKCE verifier is 43 to 128 characters of letters, digits and - . _ ~');
  return { verifier: v, method, challenge: method === 'plain' ? v : createHash('sha256').update(v).digest('base64url') };
}

interface Pending {
  name: string;
  state: string;
  nonce?: string;
  pkce?: Pkce;
  redirectUri: string;
  startedAt: number;
}

const PENDING_MS = 15 * 60_000;
/** Refresh this long before a token runs out. */
const SKEW_MS = 30_000;

const formOf = (fields: Array<[string, string | undefined]>, extra?: string): string => {
  const p = new URLSearchParams();
  for (const [k, v] of fields) if (v !== undefined && v !== '') p.append(k, v);
  for (const [k, v] of new URLSearchParams(extra ?? '')) p.set(k, v);
  return p.toString();
};

/** Strip the query and fragment, so a redirect is matched on origin and path. */
const redirectKey = (u: string): string | null => {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
};

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:15px system-ui,sans-serif;margin:15vh auto;max-width:34em;padding:0 16px;color:#222}h1{font-size:20px}</style><h1>${title}</h1><p>${text}</p>`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function normalizeProfile(p: Partial<OAuthProfile>): OAuthProfile {
  const name = String(p.name ?? '').trim();
  if (!name) throw new Error('an OAuth profile needs a name');
  if (!/^[\w.-]+$/.test(name)) throw new Error('a profile name is letters, digits, dot, dash and underscore, so it works in {{oauth:name}}');
  const grant: OAuthGrant = p.grant && ['authorization_code', 'client_credentials', 'password', 'refresh_token'].includes(p.grant) ? p.grant : 'authorization_code';
  const out: OAuthProfile = { name, grant, tokenUrl: String(p.tokenUrl ?? '').trim(), clientId: String(p.clientId ?? '').trim() };
  for (const k of ['authUrl', 'clientSecret', 'scope', 'audience', 'redirectUri', 'username', 'password', 'extraAuthParams', 'extraTokenParams', 'issuer'] as const) {
    const v = p[k];
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  out.pkce = p.pkce !== false;
  out.pkceMethod = p.pkceMethod === 'plain' ? 'plain' : 'S256';
  out.clientAuth = p.clientAuth === 'body' ? 'body' : 'basic';
  if (p.tokens) out.tokens = p.tokens;
  return out;
}

export class OAuthService extends EventEmitter<{ updated: [string] }> {
  private pending = new Map<string, Pending>();
  /** Token requests in flight per profile, so parallel sends share one refresh. */
  private inflight = new Map<string, Promise<OAuthTokens>>();

  constructor(
    private readonly store: CaptureStore,
    private readonly secrets: () => SecretBox | undefined,
  ) {
    super();
  }

  // ---------- profiles ----------
  profiles(): OAuthProfile[] {
    const raw = this.store.getMeta<OAuthProfile[] | string>('oauthProfiles');
    if (raw === undefined) return [];
    if (!SecretBox.isSealed(raw)) return raw as OAuthProfile[];
    const box = this.secrets();
    if (!box) throw new Error('Saved OAuth profiles are encrypted with a key from the OS keyring, which is not available. Unlock the keyring and try again.');
    try {
      return JSON.parse(box.open(raw).toString('utf8')) as OAuthProfile[];
    } catch {
      throw new Error('Saved OAuth profiles were encrypted on another computer or with another keyring and cannot be read here. Save new ones to replace them.');
    }
  }

  private write(list: OAuthProfile[]) {
    // Client secrets, passwords and tokens: encrypted when there is a keyring.
    const box = this.secrets();
    this.store.setMeta('oauthProfiles', box && list.length ? box.seal(JSON.stringify(list)) : list);
  }

  get(name: string): OAuthProfile {
    const p = this.profiles().find((x) => x.name === name);
    if (!p) throw new Error(`no OAuth profile "${name}"`);
    return p;
  }

  views(): OAuthProfileView[] {
    const now = Date.now();
    const waiting = new Set([...this.pending.values()].filter((p) => now - p.startedAt < PENDING_MS).map((p) => p.name));
    return this.profiles().map(({ tokens, ...p }) => ({
      ...p,
      waiting: waiting.has(p.name),
      token: tokens
        ? {
            tokenType: tokens.tokenType,
            scope: tokens.scope,
            expiresAt: tokens.expiresAt,
            obtainedAt: tokens.obtainedAt,
            hasRefresh: !!tokens.refreshToken,
            hasIdToken: !!tokens.idToken,
            preview: tokens.accessToken.length > 24 ? `${tokens.accessToken.slice(0, 12)}…${tokens.accessToken.slice(-6)}` : tokens.accessToken,
            expired: tokens.expiresAt !== undefined && tokens.expiresAt <= now,
          }
        : null,
    }));
  }

  /** Save a profile (new, or replacing the one with that name, or renaming `previous`). Tokens are kept unless the endpoints or client changed. */
  save(input: Partial<OAuthProfile>, previous?: string): OAuthProfileView {
    const next = normalizeProfile(input);
    const list = this.profiles();
    const at = list.findIndex((p) => p.name === (previous ?? next.name));
    if (previous && previous !== next.name && list.some((p) => p.name === next.name)) throw new Error(`there is already a profile "${next.name}"`);
    const old = at === -1 ? undefined : list[at];
    if (old?.tokens && !input.tokens && old.tokenUrl === next.tokenUrl && old.clientId === next.clientId) next.tokens = old.tokens;
    if (at === -1) list.push(next);
    else list[at] = next;
    this.write(list);
    this.emit('updated', next.name);
    return this.views().find((v) => v.name === next.name)!;
  }

  remove(name: string): boolean {
    const list = this.profiles();
    const next = list.filter((p) => p.name !== name);
    this.write(next);
    for (const [k, p] of this.pending) if (p.name === name) this.pending.delete(k);
    this.emit('updated', name);
    return next.length !== list.length;
  }

  /** Forget a profile's tokens (to test what happens without them, or sign in as someone else). */
  clearTokens(name: string): void {
    this.update(name, (p) => ({ ...p, tokens: undefined }));
  }

  private update(name: string, fn: (p: OAuthProfile) => OAuthProfile) {
    const list = this.profiles();
    const at = list.findIndex((p) => p.name === name);
    if (at === -1) throw new Error(`no OAuth profile "${name}"`);
    list[at] = fn(list[at]!);
    if (!list[at]!.tokens) delete list[at]!.tokens;
    this.write(list);
    this.emit('updated', name);
  }

  // ---------- tokens in requests ----------
  /** {{oauth:name}} (the access token), {{oauth:name.header}} ("Bearer ..."), or any field of the token response. */
  value(ref: string): string {
    const dot = ref.indexOf('.');
    const name = dot === -1 ? ref : ref.slice(0, dot);
    const field = dot === -1 ? 'access_token' : ref.slice(dot + 1);
    const t = this.get(name).tokens;
    if (!t) throw new Error(`OAuth profile "${name}" has no token yet: press Get token`);
    if (field === 'access_token' || field === 'access') return t.accessToken;
    if (field === 'header') return `${/^bearer$/i.test(t.tokenType ?? 'Bearer') ? 'Bearer' : t.tokenType} ${t.accessToken}`;
    if (field === 'refresh_token' || field === 'refresh') {
      if (!t.refreshToken) throw new Error(`OAuth profile "${name}" has no refresh token`);
      return t.refreshToken;
    }
    if (field === 'id_token' || field === 'id') {
      if (!t.idToken) throw new Error(`OAuth profile "${name}" has no ID token (ask for the openid scope)`);
      return t.idToken;
    }
    const v = t.raw[field];
    if (v === undefined) throw new Error(`the token response for "${name}" has no field "${field}"`);
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  /** Make sure each profile has a token that has not expired: refresh it, or fetch a new one where that needs nobody to sign in. */
  async ensure(names: string[], opts: { ignoreTlsErrors?: boolean; timeoutMs?: number } = {}): Promise<void> {
    for (const name of names) {
      const p = this.get(name);
      const t = p.tokens;
      if (t && (t.expiresAt === undefined || t.expiresAt - SKEW_MS > Date.now())) continue;
      if (t?.refreshToken) {
        try {
          await this.refresh(name, opts);
          continue;
        } catch (e) {
          if (p.grant === 'authorization_code' || p.grant === 'refresh_token') throw new Error(`OAuth profile "${name}": the refresh failed (${(e as Error).message}); sign in again with Get token`);
        }
      }
      if (p.grant === 'client_credentials' || p.grant === 'password') await this.fetch(name, opts);
      else if (!t) throw new Error(`OAuth profile "${name}" has no token yet: press Get token`);
      else throw new Error(`the token for OAuth profile "${name}" has expired and there is no refresh token: sign in again with Get token`);
    }
  }

  /** Get a token with the profile's grant now. Authorization code returns the sign-in URL instead, to open in the browser. */
  async fetch(name: string, opts: { ignoreTlsErrors?: boolean; timeoutMs?: number } = {}): Promise<OAuthTokens> {
    const p = this.get(name);
    if (p.grant === 'authorization_code') throw new Error('this profile signs in through the browser: use Get token in Replay');
    if (p.grant === 'refresh_token') return this.refresh(name, opts);
    return this.single(name, () =>
      this.tokenRequest(
        p,
        [
          ['grant_type', p.grant],
          ['scope', p.scope],
          ['audience', p.audience],
          ...(p.grant === 'password' ? ([['username', p.username], ['password', p.password]] as Array<[string, string | undefined]>) : []),
        ],
        opts,
      ),
    );
  }

  async refresh(name: string, opts: { ignoreTlsErrors?: boolean; timeoutMs?: number } = {}): Promise<OAuthTokens> {
    const p = this.get(name);
    const rt = p.tokens?.refreshToken ?? (p.grant === 'refresh_token' ? p.password : undefined);
    if (!rt) throw new Error(`OAuth profile "${name}" has no refresh token`);
    return this.single(name, () => this.tokenRequest(p, [['grant_type', 'refresh_token'], ['refresh_token', rt], ['scope', p.scope]], opts, p.tokens));
  }

  private single(name: string, run: () => Promise<OAuthTokens>): Promise<OAuthTokens> {
    const cur = this.inflight.get(name);
    if (cur) return cur;
    const pr = run().finally(() => this.inflight.delete(name));
    this.inflight.set(name, pr);
    return pr;
  }

  private async tokenRequest(p: OAuthProfile, fields: Array<[string, string | undefined]>, opts: { ignoreTlsErrors?: boolean; timeoutMs?: number }, previous?: OAuthTokens): Promise<OAuthTokens> {
    if (!p.tokenUrl) throw new Error(`OAuth profile "${p.name}" has no token URL`);
    const headers: HeaderList = [
      ['Content-Type', 'application/x-www-form-urlencoded'],
      ['Accept', 'application/json'],
    ];
    const all = [...fields];
    if (p.clientSecret && p.clientAuth !== 'body') {
      // RFC 6749 2.3.1: both parts are form-encoded before they are joined.
      const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
      headers.push(['Authorization', `Basic ${Buffer.from(`${enc(p.clientId)}:${enc(p.clientSecret)}`).toString('base64')}`]);
    } else {
      all.push(['client_id', p.clientId]);
      if (p.clientSecret) all.push(['client_secret', p.clientSecret]);
    }
    const body = new TextEncoder().encode(formOf(all, p.extraTokenParams));
    const res = await sendReplay(this.store, { method: 'POST', url: p.tokenUrl, headers, body, ignoreTlsErrors: opts.ignoreTlsErrors, timeoutMs: opts.timeoutMs });
    this.store.tagExchange(res.id, [...(this.store.getSummary(res.id)?.tags ?? []), `oauth:${p.name}`]);
    if (res.state !== 'complete' || res.status === null) throw new Error(`the token request failed: ${this.store.getExchange(res.id)?.error ?? res.state}`);
    const text = bytesToString(this.store.getBody(res.id, 'response', true) ?? new Uint8Array());
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A few old servers answer with a form body.
      json = Object.fromEntries(new URLSearchParams(text));
    }
    if (res.status >= 400 || typeof json.access_token !== 'string') {
      const err = typeof json.error === 'string' ? `${json.error}${typeof json.error_description === 'string' ? `: ${json.error_description}` : ''}` : `HTTP ${res.status}`;
      throw new Error(`the token endpoint said ${err}`);
    }
    const now = Date.now();
    const expiresIn = Number(json.expires_in);
    const tokens: OAuthTokens = {
      accessToken: json.access_token,
      tokenType: typeof json.token_type === 'string' ? json.token_type : undefined,
      // A refresh that returns no new refresh token keeps the old one.
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : previous?.refreshToken,
      idToken: typeof json.id_token === 'string' ? json.id_token : previous?.idToken,
      scope: typeof json.scope === 'string' ? json.scope : (previous?.scope ?? p.scope),
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
      obtainedAt: now,
      raw: json,
    };
    this.update(p.name, (x) => ({ ...x, tokens }));
    return tokens;
  }

  // ---------- authorization code ----------
  /** Start a sign-in: the URL to open, with state, nonce and the PKCE challenge in it. */
  begin(name: string): { url: string; state: string; redirectUri: string; pkce?: Pkce } {
    const p = this.get(name);
    if (p.grant !== 'authorization_code') throw new Error('only the authorization code grant signs in through a browser');
    if (!p.authUrl) throw new Error(`OAuth profile "${name}" has no authorization URL`);
    if (!p.redirectUri) throw new Error(`OAuth profile "${name}" has no redirect URI`);
    if (!redirectKey(p.redirectUri)) throw new Error('the redirect URI must be an absolute URL');
    const state = randomBytes(16).toString('base64url');
    const openid = /\bopenid\b/.test(p.scope ?? '');
    const nonce = openid ? randomBytes(16).toString('base64url') : undefined;
    const pkce = p.pkce !== false ? makePkce(p.pkceMethod ?? 'S256') : undefined;
    const u = new URL(p.authUrl);
    const q = formOf(
      [
        ['response_type', 'code'],
        ['client_id', p.clientId],
        ['redirect_uri', p.redirectUri],
        ['scope', p.scope],
        ['audience', p.audience],
        ['state', state],
        ['nonce', nonce],
        ['code_challenge', pkce?.challenge],
        ['code_challenge_method', pkce?.method],
      ],
      p.extraAuthParams,
    );
    u.search = u.search ? `${u.search.slice(1)}&${q}` : q;
    // One waiting sign-in per profile.
    for (const [k, x] of this.pending) if (x.name === name || Date.now() - x.startedAt > PENDING_MS) this.pending.delete(k);
    this.pending.set(state, { name, state, nonce, pkce, redirectUri: p.redirectUri, startedAt: Date.now() });
    this.emit('updated', name);
    return { url: u.href, state, redirectUri: p.redirectUri, pkce };
  }

  /** Cancel a waiting sign-in. */
  cancel(name: string): void {
    for (const [k, x] of this.pending) if (x.name === name) this.pending.delete(k);
    this.emit('updated', name);
  }

  /**
   * The proxy calls this for every request. While a sign-in waits, the
   * redirect back to its redirect URI is answered here (and the code
   * exchanged in the background) instead of going to the server.
   */
  capture(url: string): { status: number; headers: HeaderList; body: Uint8Array } | null {
    if (!this.pending.size) return null;
    const key = redirectKey(url);
    if (!key) return null;
    let state: string | null = null;
    try {
      state = new URL(url).searchParams.get('state');
    } catch {
      return null;
    }
    const p = state ? this.pending.get(state) : undefined;
    if (!p || redirectKey(p.redirectUri) !== key) return null;
    const page = (title: string, text: string, status = 200) => ({ status, headers: [['Content-Type', 'text/html; charset=utf-8'], ['Cache-Control', 'no-store']] as HeaderList, body: new TextEncoder().encode(PAGE(title, text)) });
    const err = new URL(url).searchParams.get('error');
    if (err) {
      this.pending.delete(p.state);
      this.emit('updated', p.name);
      const d = new URL(url).searchParams.get('error_description');
      return page('Sign-in failed', `The server said <b>${esc(err)}</b>${d ? `: ${esc(d)}` : ''}. Go back to SiteInquisition to try again.`, 400);
    }
    void this.complete(p.name, url).catch(() => undefined);
    return page('Signed in', `SiteInquisition has the code for <b>${esc(p.name)}</b> and is getting the token. You can close this tab.`);
  }

  /** Finish a sign-in from the URL the browser was sent back to (captured, or pasted by hand). */
  async complete(name: string, redirectedUrl: string, opts: { ignoreTlsErrors?: boolean; timeoutMs?: number } = {}): Promise<OAuthTokens> {
    let u: URL;
    try {
      u = new URL(redirectedUrl.trim());
    } catch {
      throw new Error('paste the whole address the browser was sent back to, starting with http');
    }
    // Some servers put the answer in the fragment.
    const params = u.searchParams.has('code') || u.searchParams.has('error') ? u.searchParams : new URLSearchParams(u.hash.slice(1));
    const err = params.get('error');
    const state = params.get('state');
    const p = (state ? this.pending.get(state) : undefined) ?? [...this.pending.values()].find((x) => x.name === name);
    if (err) throw new Error(`the server said ${err}${params.get('error_description') ? `: ${params.get('error_description')}` : ''}`);
    const code = params.get('code');
    if (!code) throw new Error('there is no code in that address');
    if (!p) throw new Error('no sign-in is waiting for this profile: press Get token first');
    if (p.name !== name) throw new Error(`that code belongs to the sign-in for "${p.name}"`);
    if (state && state !== p.state) throw new Error('the state in that address does not match the sign-in (an old tab?)');
    this.pending.delete(p.state);
    const profile = this.get(name);
    try {
      return await this.single(name, () =>
        this.tokenRequest(
          profile,
          [
            ['grant_type', 'authorization_code'],
            ['code', code],
            ['redirect_uri', p.redirectUri],
            ['code_verifier', p.pkce?.verifier],
          ],
          opts,
        ),
      );
    } finally {
      this.emit('updated', name);
    }
  }

  /** Read an OpenID Connect or OAuth server's metadata for its endpoints. */
  async discover(issuer: string, opts: { ignoreTlsErrors?: boolean } = {}): Promise<{ issuer: string; authUrl?: string; tokenUrl?: string; scopes?: string[]; pkceMethods?: string[]; grants?: string[] }> {
    const base = issuer.trim().replace(/\/+$/, '');
    const tries = /\/\.well-known\//.test(base) ? [base] : [`${base}/.well-known/openid-configuration`, `${base}/.well-known/oauth-authorization-server`];
    let last = '';
    for (const url of tries) {
      const res = await sendReplay(this.store, { method: 'GET', url, headers: [['Accept', 'application/json']], ignoreTlsErrors: opts.ignoreTlsErrors });
      this.store.tagExchange(res.id, [...(this.store.getSummary(res.id)?.tags ?? []), 'oauth:discovery']);
      if (res.status !== 200) {
        last = res.status === null ? (this.store.getExchange(res.id)?.error ?? 'no answer') : `HTTP ${res.status}`;
        continue;
      }
      try {
        const m = JSON.parse(bytesToString(this.store.getBody(res.id, 'response', true) ?? new Uint8Array())) as Record<string, unknown>;
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
        return {
          issuer: typeof m.issuer === 'string' ? m.issuer : base,
          authUrl: typeof m.authorization_endpoint === 'string' ? m.authorization_endpoint : undefined,
          tokenUrl: typeof m.token_endpoint === 'string' ? m.token_endpoint : undefined,
          scopes: list(m.scopes_supported),
          pkceMethods: list(m.code_challenge_methods_supported),
          grants: list(m.grant_types_supported),
        };
      } catch {
        last = 'the metadata is not JSON';
      }
    }
    throw new Error(`could not read the server metadata (${last})`);
  }
}
