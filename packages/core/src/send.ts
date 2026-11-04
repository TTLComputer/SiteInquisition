import { bytesToString, encodeChain, getCodec, looksLikeText } from '@siteinquisition/codecs';
import type { FlowRunner } from './flows.js';
import { cookieJar } from './cookies.js';
import { newId } from './ids.js';
import { sendReplay } from './replay.js';
import { applyRule, conditionsMatch, type HookMessage, type ReplaceRule } from './rules.js';
import { globToRegExp } from './scope.js';
import { loadAwsProfile, parseSigV4, signSigV4, type AwsCredentials } from './sigv4.js';
import type { CaptureStore, ExchangeSummary, HeaderList } from './store.js';
import { batchPlan, flowRefs, hasTokens, resolveTokens, TOKEN_RE, type TokenContext } from './tokens.js';
import { pickValue, pickValues, tagValue } from './values.js';
import type { CsrfBinding, TechService } from './tech.js';
import type { Vars } from './vars.js';

export interface SendOptions {
  /** Resolve {{tokens}} (default true). */
  tokens?: boolean;
  /** Replace the Cookie header with the jar's current cookies for this URL. */
  refreshCookies?: boolean;
  /** Run enabled request-phase match and replace rules. */
  applyRules?: boolean;
  /** Follow up to this many redirects (each hop is recorded). */
  followRedirects?: number;
  /** Re-sign with SigV4: a saved profile name, or "auto" to use the profile matching the captured signature. */
  sigv4?: string;
  /** When the response is 401 or 403, run the login macro for this host and send once more. */
  loginMacro?: boolean;
  /**
   * Put the latest CSRF token into every place the request carries one (from
   * the saved CSRF bindings). Loads a page for a token first when there is
   * none yet, and when the server rejects the token (400, 403, 419 or 422)
   * loads a fresh one and sends once more.
   */
  csrf?: boolean;
  ignoreTlsErrors?: boolean;
  timeoutMs?: number;
  /** Send over HTTP/3 ('h3') instead of HTTP/1.1. */
  protocol?: 'h1' | 'h3';
  /** Variables that override project variables for this send (a flow's own). */
  vars?: Record<string, string>;
  /** Run this flow first; its variables are visible as {{var:name}} and {{flow:name.var}}. */
  flow?: string;
  /** The body is written decoded: resolve tokens, then encode it with this codec chain (e.g. ["base64", "json"]). */
  bodyChain?: string[];
  /** How deep in nested flows this send is (internal). */
  flowDepth?: number;
}

export interface SendRequest {
  method: string;
  url: string;
  headers: HeaderList;
  body?: Uint8Array;
  replayOf?: string | null;
}

export interface Macro {
  id: string;
  name: string;
  enabled?: boolean;
  /** Hosts whose 401/403 responses trigger it. */
  host: string;
  /** Status codes that count as "logged out", default 401 and 403. */
  statuses?: number[];
  steps: Array<{ method: string; url: string; headers: HeaderList; body?: string }>;
}

export interface AwsProfile {
  name: string;
  /** "profile:<name>" reads ~/.aws/credentials, "env" reads AWS_* variables, "session" uses keys held in memory only. */
  source: string;
  region: string;
  service: string;
  /** Hosts this profile signs for (glob); used by "auto". */
  host?: string;
}

export interface SendDeps {
  store: CaptureStore;
  vars: Vars;
  projectDir: string;
  rules: () => ReplaceRule[];
  macros: () => Macro[];
  awsProfiles: () => AwsProfile[];
  sessionKeys: Map<string, AwsCredentials>;
  countHit: (ruleId: string) => void;
  tech?: TechService;
}

/** Statuses frameworks answer with when a CSRF token is missing or stale. */
const CSRF_REJECTED = new Set([400, 403, 419, 422]);

/** Encode a decoded body with a codec chain; terminal structured codecs (json, form, jwt) take the text as JSON. */
export function encodeBody(chain: string[], text: string): Uint8Array {
  const last = chain.length ? getCodec(chain[chain.length - 1]!) : undefined;
  let value: unknown = text;
  if (last?.terminal && last.id !== 'text') {
    try {
      value = JSON.parse(text);
    } catch (e) {
      throw new Error(`the body must be JSON to encode it with ${chain.join(' > ')}: ${(e as Error).message}`);
    }
  }
  return encodeChain(chain, value);
}

const text = (b: Uint8Array | undefined) => (b && b.length && looksLikeText(b) ? bytesToString(b) : null);

export function cookieHeaderFor(store: CaptureStore, url: string): string | null {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const now = Date.now();
  const list = cookieJar(store, now).filter((c) => {
    if (c.expired) return false;
    if (c.secure && u.protocol !== 'https:') return false;
    const domainOk = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`);
    return domainOk && u.pathname.startsWith(c.path);
  });
  list.sort((a, b) => b.path.length - a.path.length);
  return list.length ? list.map((c) => `${c.name}=${c.value}`).join('; ') : null;
}

export class Sender {
  /** Set by PowerTools once the flow runner exists. */
  flows?: FlowRunner;

  constructor(private readonly d: SendDeps) {}

  /** Everything a token can read, for one URL. */
  tokenContext(url: string, extra: { vars?: Record<string, string>; batch?: Map<string, string>; flows?: Map<string, Record<string, string>> } = {}): TokenContext {
    return {
      url,
      cookies: () => cookieJar(this.d.store),
      vars: () => (extra.vars ? { ...this.d.vars.values(), ...extra.vars } : this.d.vars.values()),
      projectDir: this.d.projectDir,
      batch: extra.batch,
      flows: extra.flows,
      pick: (arg) => pickValue(this.d.store, arg),
      each: (arg) => pickValues(this.d.store, arg),
      tag: (ref) => tagValue(this.d.store, ref),
    };
  }

  /** Run the flows a request refers to (and the opts.flow one), once each, for one send. */
  async runFlows(req: SendRequest, opts: SendOptions): Promise<{ flows: Map<string, Record<string, string>>; vars?: Record<string, string>; runs: string[] }> {
    const texts = [req.url, ...req.headers.flat(), text(req.body) ?? ''];
    const names = flowRefs(texts);
    if (opts.flow && !names.includes(opts.flow)) names.unshift(opts.flow);
    const flows = new Map<string, Record<string, string>>();
    const runs: string[] = [];
    if (!names.length) return { flows, vars: opts.vars, runs };
    if (!this.flows) throw new Error('flows are not available');
    for (const name of names) {
      const r = await this.flows.run(name, {}, opts.flowDepth ?? 0, { ignoreTlsErrors: opts.ignoreTlsErrors, timeoutMs: opts.timeoutMs });
      if (!r.ok) throw new Error(`flow "${name}" failed: ${r.error}`);
      flows.set(name, r.vars);
      runs.push(r.runId);
    }
    const vars = opts.flow ? { ...(opts.vars ?? {}), ...flows.get(opts.flow) } : opts.vars;
    return { flows, vars, runs };
  }

  /** Add tags to what the exchange has now (summaries in hand may be stale). */
  private addTags(id: string, tags: string[]) {
    if (tags.length) this.d.store.tagExchange(id, [...(this.d.store.getSummary(id)?.tags ?? []), ...tags]);
  }

  private resolveAll(req: SendRequest, extra: { vars?: Record<string, string>; batch?: Map<string, string>; flows?: Map<string, Record<string, string>> }): SendRequest {
    const ctx = this.tokenContext(req.url, extra);
    // Resolve the URL first so cookie tokens in headers see the final host.
    const url = resolveTokens(req.url, ctx);
    const c2 = { ...ctx, url };
    const body = text(req.body);
    return {
      ...req,
      url,
      headers: req.headers.map(([k, v]) => [resolveTokens(k, c2), resolveTokens(v, c2)]),
      body: body !== null && hasTokens(body) ? new TextEncoder().encode(resolveTokens(body, c2)) : req.body,
    };
  }

  private credentials(p: AwsProfile): AwsCredentials {
    if (p.source === 'session') {
      const k = this.d.sessionKeys.get(p.name);
      if (!k) throw new Error(`no keys entered for AWS profile "${p.name}" this session`);
      return k;
    }
    if (p.source === 'env') return loadAwsProfile('env');
    return loadAwsProfile(p.source.replace(/^profile:/, '') || 'default');
  }

  private pickProfile(name: string, req: SendRequest): AwsProfile | undefined {
    const profiles = this.d.awsProfiles();
    if (name !== 'auto') return profiles.find((p) => p.name === name);
    const host = new URL(req.url).hostname;
    const parsed = parseSigV4(req.headers.find(([k]) => k.toLowerCase() === 'authorization')?.[1]);
    return (
      profiles.find((p) => p.host && globToRegExp(p.host).test(host)) ??
      (parsed ? profiles.find((p) => p.region === parsed.region && p.service === parsed.service) : undefined)
    );
  }

  /** Apply the send options that change the request itself, in a fixed order. */
  prepare(req: SendRequest, opts: SendOptions, batch?: Map<string, string>, flows?: Map<string, Record<string, string>>): { req: SendRequest; applied: string[]; csrf: CsrfBinding[]; csrfMissing: CsrfBinding[] } {
    const applied: string[] = [];
    let csrf: CsrfBinding[] = [];
    let csrfMissing: CsrfBinding[] = [];
    let r = opts.tokens === false ? req : this.resolveAll(req, { vars: opts.vars, batch, flows });
    if (opts.bodyChain?.length) {
      r = { ...r, body: encodeBody(opts.bodyChain, text(r.body) ?? '') };
      applied.push(`encoded:${opts.bodyChain.join('>')}`);
    }
    if (opts.refreshCookies) {
      const cookie = cookieHeaderFor(this.d.store, r.url);
      const headers = r.headers.filter(([k]) => k.toLowerCase() !== 'cookie');
      if (cookie) headers.push(['Cookie', cookie]);
      r = { ...r, headers };
      applied.push('cookies from jar');
    }
    if (opts.csrf && this.d.tech) {
      const out = this.d.tech.applyCsrf(r);
      r = { ...r, ...out.req };
      csrf = out.used;
      csrfMissing = out.missing;
      applied.push(...csrf.map((b) => `csrf:${b.varName}`));
    }
    if (opts.applyRules) {
      const msg: HookMessage = { method: r.method, url: r.url, headers: [...r.headers], body: r.body ?? new Uint8Array() };
      for (const rule of this.d.rules()) {
        if (rule.enabled === false || rule.phase !== 'request' || !conditionsMatch(rule, msg)) continue;
        const n = applyRule(rule, msg, (s) => resolveTokens(s, this.tokenContext(msg.url, { vars: opts.vars, flows })));
        if (n) {
          applied.push(`rule:${rule.name}`);
          this.d.countHit(rule.id);
        }
      }
      r = { ...r, method: msg.method, url: msg.url, headers: msg.headers, body: msg.body };
    }
    if (opts.sigv4) {
      const profile = this.pickProfile(opts.sigv4, r);
      if (!profile) throw new Error(opts.sigv4 === 'auto' ? 'no AWS profile matches this host or its captured signature' : `no AWS profile "${opts.sigv4}"`);
      r = { ...r, headers: signSigV4(r, this.credentials(profile), profile) };
      applied.push(`sigv4:${profile.name}`);
    }
    return { req: r, applied, csrf, csrfMissing };
  }

  /** Load the page a CSRF token comes from; the tech service picks the token out of the response. */
  private async refreshCsrf(list: CsrfBinding[], url: string, opts: SendOptions): Promise<void> {
    const seen = new Set<string>();
    for (const b of list) {
      const target = this.d.tech!.refreshUrlFor(b, url);
      if (seen.has(target)) continue;
      seen.add(target);
      const res = await sendReplay(this.d.store, {
        method: 'GET',
        url: target,
        headers: [['Accept', 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'], ...(cookieHeaderFor(this.d.store, target) ? [['Cookie', cookieHeaderFor(this.d.store, target)!] as [string, string]] : [])],
        ignoreTlsErrors: opts.ignoreTlsErrors,
        timeoutMs: opts.timeoutMs,
        protocol: opts.protocol,
      });
      this.addTags(res.id, ['csrf-refresh']);
    }
  }

  async send(req: SendRequest, opts: SendOptions = {}, batch?: Map<string, string>): Promise<ExchangeSummary> {
    const fl = await this.runFlows(req, opts);
    const o = { ...opts, vars: fl.vars };
    let prepared = this.prepare(req, o, batch, fl.flows);
    if (prepared.csrfMissing.length) {
      // No token captured yet: load one first.
      await this.refreshCsrf(prepared.csrfMissing, prepared.req.url, opts);
      prepared = this.prepare(req, { ...o, refreshCookies: opts.refreshCookies ?? true }, batch, fl.flows);
    }
    const { req: r, applied } = prepared;
    let res = await sendReplay(this.d.store, { ...r, ignoreTlsErrors: opts.ignoreTlsErrors, timeoutMs: opts.timeoutMs, protocol: opts.protocol });
    this.addTags(res.id, [...applied, ...[...fl.flows.keys()].map((n) => `used-flow:${n}`)]);

    if (prepared.csrf.length && res.status !== null && CSRF_REJECTED.has(res.status)) {
      await this.refreshCsrf(prepared.csrf, r.url, opts);
      const again = this.prepare(req, { ...o, refreshCookies: opts.refreshCookies ?? true }, batch, fl.flows);
      res = await sendReplay(this.d.store, { ...again.req, ignoreTlsErrors: opts.ignoreTlsErrors, timeoutMs: opts.timeoutMs, protocol: opts.protocol });
      this.addTags(res.id, [...again.applied, 'after-csrf-refresh']);
    }

    if (opts.loginMacro && res.status !== null) {
      const host = new URL(r.url).hostname;
      const macro = this.d.macros().find((m) => m.enabled !== false && globToRegExp(m.host).test(host) && (m.statuses ?? [401, 403]).includes(res.status!));
      const loginFlow = macro ? undefined : this.flows?.authFlowFor(host, res.status);
      if (macro || loginFlow) {
        if (macro) await this.runMacro(macro.id);
        else {
          const lr = await this.flows!.run(loginFlow!, {}, opts.flowDepth ?? 0, { ignoreTlsErrors: opts.ignoreTlsErrors, timeoutMs: opts.timeoutMs });
          if (!lr.ok) throw new Error(`login flow "${loginFlow!.name}" failed: ${lr.error}`);
        }
        // Resend with fresh tokens and cookies; the login's responses have updated both.
        const again = this.prepare(req, { ...o, refreshCookies: opts.refreshCookies ?? true }, batch, fl.flows);
        res = await sendReplay(this.d.store, { ...again.req, ignoreTlsErrors: opts.ignoreTlsErrors, timeoutMs: opts.timeoutMs, protocol: opts.protocol });
        this.addTags(res.id, [...again.applied, `after-login:${macro?.name ?? loginFlow!.name}`]);
      }
    }

    let hops = Math.min(opts.followRedirects ?? 0, 20);
    let current = res;
    const flowRoot = res;
    while (hops-- > 0 && current.status !== null && current.status >= 300 && current.status < 400) {
      const ex = this.d.store.getExchange(current.id);
      const location = ex?.responseHeaders?.find(([k]) => k.toLowerCase() === 'location')?.[1];
      if (!location) break;
      const next = new URL(location, current.url).href;
      const keepBody = current.status === 307 || current.status === 308;
      const headers = r.headers.filter(([k]) => !['host', 'content-length', 'cookie', ...(keepBody ? [] : ['content-type'])].includes(k.toLowerCase()));
      const cookie = cookieHeaderFor(this.d.store, next);
      if (cookie) headers.push(['Cookie', cookie]);
      current = await sendReplay(this.d.store, {
        method: keepBody ? r.method : current.status === 303 || r.method === 'POST' ? 'GET' : r.method,
        url: next,
        headers,
        body: keepBody ? r.body : undefined,
        replayOf: r.replayOf,
        ignoreTlsErrors: opts.ignoreTlsErrors,
        timeoutMs: opts.timeoutMs,
        protocol: opts.protocol,
      });
      this.addTags(current.id, [`redirect-of:${flowRoot.id}`]);
    }
    return this.d.store.getSummary(res.id) ?? res;
  }

  /** One send per value of the batch tokens ({{counter}}, {{list}}). */
  async sendBatch(req: SendRequest, opts: SendOptions & { concurrency?: number; max?: number } = {}): Promise<{ batchId: string; sends: ExchangeSummary[]; errors: string[] }> {
    const texts = [req.url, ...req.headers.flat(), text(req.body) ?? ''];
    const plan = batchPlan(texts, this.d.projectDir, opts.max ?? 10_000, (arg) => pickValues(this.d.store, arg));
    const batchId = newId();
    const sends: ExchangeSummary[] = [];
    const errors: string[] = [];
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, 32));
    let next = 0;
    const worker = async () => {
      while (next < plan.length) {
        const i = next++;
        try {
          const s = await this.send(req, opts, plan[i]);
          this.addTags(s.id, [`batch:${batchId}`]);
          sends[i] = s;
        } catch (e) {
          errors[i] = (e as Error).message;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, worker));
    return { batchId, sends: sends.filter(Boolean), errors: errors.filter(Boolean) };
  }

  async runMacro(id: string): Promise<Array<{ step: number; exchangeId?: string; status: number | null; error?: string }>> {
    const macro = this.d.macros().find((m) => m.id === id);
    if (!macro) throw new Error('no such macro');
    const out: Array<{ step: number; exchangeId?: string; status: number | null; error?: string }> = [];
    for (let i = 0; i < macro.steps.length; i++) {
      const s = macro.steps[i]!;
      try {
        // Each step sees the cookies and variables the previous steps produced.
        const res = await this.send({ method: s.method, url: s.url, headers: s.headers, body: s.body ? new TextEncoder().encode(s.body) : undefined }, { refreshCookies: true });
        this.addTags(res.id, [`macro:${macro.name}`]);
        out.push({ step: i, exchangeId: res.id, status: res.status });
        if (res.state !== 'complete') break;
      } catch (e) {
        out.push({ step: i, status: null, error: (e as Error).message });
        break;
      }
    }
    return out;
  }
}

export const hasBatchTokens = (req: SendRequest): boolean =>
  [req.url, ...req.headers.flat(), text(req.body) ?? ''].some((t) => [...t.matchAll(TOKEN_RE)].some((m) => /^(counter|list|each)$/i.test(m[1]!)));
