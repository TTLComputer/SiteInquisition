import { JWT_RE, parseJwt, signJwt, type SigningKey } from './jwt.js';
import { decodeSessionCookie, signFlaskCookie } from './sessioncookies.js';
import type { KeyResolver } from './keys.js';
import type { CaptureStore } from './store.js';

/**
 * Re-signing and "evergreen" tokens. A signed value (a JWT, or a framework
 * session cookie that carries a readable payload) can be edited and re-signed
 * with a key the user holds. Registered as an evergreen token, it is re-signed
 * fresh every time it is sent — its expiry pushed forward and its iat/nbf
 * updated — so a captured token with a known key never goes stale.
 *
 * The same `{{sign:name}}` token resolves in Replay, in proxied traffic (via a
 * match-and-replace rule), in login macros and in flows, and an evergreen entry
 * can be bound to a cookie-jar cookie so the jar and proxy use the fresh value
 * directly.
 */

export type SignableKind = 'jwt' | 'flask';

/** What re-signing can do with a value, or null when it is not a signed token we can re-mint. */
export function signableKind(value: string): SignableKind | null {
  const v = value.trim();
  if (JWT_RE.test(v)) return 'jwt';
  try {
    const s = decodeSessionCookie('session', v);
    // Flask carries its payload in the clear, so we can read it, edit it and re-sign with the secret.
    if (s.framework === 'flask' && s.structure === 'signed' && s.payload !== undefined) return 'flask';
  } catch {
    // not a session cookie
  }
  return null;
}

export interface EvergreenEntry {
  /** Token name, used as {{sign:name}}. */
  name: string;
  kind: SignableKind;
  /** Name of the key in the key store to sign with. */
  keyName: string;
  /** JWT algorithm (default from the header, else HS256). */
  alg?: string;
  /** JWT header template. */
  header?: Record<string, unknown>;
  /** The claims (JWT) or session payload (Flask) to re-sign, editable by the user. */
  payload: unknown;
  /** Seconds to set `exp` ahead of now. Default 3600 (one hour). */
  ttlSeconds?: number;
  /** Set `iat` to now when signing (JWT). Default true. */
  bumpIat?: boolean;
  /** Set `nbf` to now when signing (JWT). Default false. */
  bumpNbf?: boolean;
  /** Flask: compress the payload (itsdangerous '.' marker). */
  compress?: boolean;
  /** Flask: signing salt (default 'cookie-session'). */
  salt?: string;
  /** Bind to a cookie-jar cookie so the jar and proxy use the fresh value. */
  cookie?: { domain: string; name: string };
  updatedAt: number;
}

export interface EvergreenStatus extends EvergreenEntry {
  /** Whether the bound key is present this session (so the token can be minted). */
  canSign: boolean;
}

const DEFAULT_TTL = 3600;

/** Re-sign an evergreen entry with the given key, setting fresh time claims. */
export function renderEvergreen(entry: Pick<EvergreenEntry, 'kind' | 'alg' | 'header' | 'payload' | 'ttlSeconds' | 'bumpIat' | 'bumpNbf' | 'compress' | 'salt'>, key: SigningKey, now = Date.now()): string {
  const sec = Math.floor(now / 1000);
  if (entry.kind === 'jwt') {
    const payload: Record<string, unknown> = { ...((entry.payload as Record<string, unknown>) ?? {}) };
    const ttl = entry.ttlSeconds ?? DEFAULT_TTL;
    payload.exp = sec + (ttl > 0 ? ttl : DEFAULT_TTL);
    if (entry.bumpIat !== false) payload.iat = sec;
    if (entry.bumpNbf) payload.nbf = sec;
    const header = { ...(entry.header ?? {}) };
    const alg = entry.alg ?? String(header.alg ?? 'HS256');
    return signJwt(header, payload, key, alg);
  }
  // Flask: the timestamp itsdangerous writes is "now", so re-signing already
  // refreshes a cookie whose freshness the server checks by Max-Age.
  if (key.kind !== 'hmac') throw new Error('a Flask session cookie needs an HMAC secret, not a PEM key');
  const secret = typeof key.secret === 'string' ? key.secret : key.secret.toString('utf8');
  return signFlaskCookie(entry.payload, secret, { at: now, ...(entry.compress ? { compress: true } : {}), ...(entry.salt ? { salt: entry.salt } : {}) });
}

const validName = (name: string) => {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid token name "${name}": use letters, digits, _ . -`);
};

/**
 * The registry of evergreen tokens. Entries live in the project's meta table,
 * so they travel with the project and reach every client as a `meta.set`
 * change. Keys themselves are never stored here — only the name of the key to
 * resolve from the key store when minting.
 */
export class Evergreen {
  constructor(
    private readonly store: CaptureStore,
    private readonly keys: KeyResolver,
  ) {}

  all(): EvergreenEntry[] {
    return this.store.getMeta<EvergreenEntry[]>('evergreen') ?? [];
  }

  list(): EvergreenStatus[] {
    return this.all().map((e) => ({ ...e, canSign: !!this.keys.resolve(e.keyName) }));
  }

  get(name: string): EvergreenEntry | undefined {
    return this.all().find((e) => e.name === name);
  }

  save(entry: EvergreenEntry): EvergreenStatus[] {
    validName(entry.name);
    if (entry.kind !== 'jwt' && entry.kind !== 'flask') throw new Error(`unknown token kind "${entry.kind}"`);
    if (!entry.keyName) throw new Error('an evergreen token needs a signing key');
    const clean: EvergreenEntry = { ...entry, updatedAt: Date.now() };
    const list = this.all().filter((e) => e.name !== entry.name);
    list.push(clean);
    list.sort((a, b) => a.name.localeCompare(b.name));
    this.store.setMeta('evergreen', list);
    return this.list();
  }

  delete(name: string): EvergreenStatus[] {
    this.store.setMeta(
      'evergreen',
      this.all().filter((e) => e.name !== name),
    );
    return this.list();
  }

  /** Mint a fresh value for `{{sign:name}}`. Throws when the token or its key is missing. */
  resolve(name: string, now = Date.now()): string {
    const e = this.get(name);
    if (!e) throw new Error(`no signed token "${name}"`);
    const key = this.keys.resolve(e.keyName);
    if (!key) throw new Error(`the key "${e.keyName}" for token "${name}" is not loaded this session`);
    return renderEvergreen(e, key, now);
  }

  /** The evergreen entry bound to a jar cookie (host-aware), if any. */
  forCookie(host: string, name: string): EvergreenEntry | undefined {
    const h = host.toLowerCase();
    return this.all().find((e) => {
      if (!e.cookie || e.cookie.name !== name) return false;
      const d = e.cookie.domain.toLowerCase().replace(/^\./, '');
      return h === d || h.endsWith(`.${d}`);
    });
  }

  /** A fresh value for a jar cookie, or null when it is not evergreen or the key is missing. */
  resignCookie(host: string, name: string, now = Date.now()): { value: string; token: string } | null {
    const e = this.forCookie(host, name);
    if (!e) return null;
    const key = this.keys.resolve(e.keyName);
    if (!key) return null;
    try {
      return { value: renderEvergreen(e, key, now), token: e.name };
    } catch {
      return null;
    }
  }
}
