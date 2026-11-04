import { bytesToString, looksLikeText } from '@siteinquisition/codecs';
import { cookieJar, parseSetCookie, type JarCookie } from './cookies.js';
import { newId } from './ids.js';
import { globToRegExp } from './scope.js';
import type { CaptureStore, Exchange, HeaderList } from './store.js';
import { GENERIC_CSRF_NAME, SIGNATURES, type CsrfSink, type CsrfSource, type Matcher, type Signature, type TechCategory, type TechCheck } from './techsigs.js';
import type { Vars } from './vars.js';

export * from './techsigs.js';

/**
 * Technology awareness: which platforms and frameworks a host runs on, which
 * cookies belong to the platform rather than the app, and where CSRF tokens
 * come from and go back to, so replays keep working.
 *
 * Everything here is passive. Detection reads captured traffic only; the
 * optional checks in a signature are sent only when the user asks.
 *
 * The user stays in charge of the result. Per host (or host glob) they can
 * reject a wrong detection or pin one that was missed, turn off a noisy
 * signature for the project, add signatures of their own, and say whether a
 * cookie is infrastructure or not. Overrides are applied when results are
 * read, so undoing one brings the detection straight back.
 */

// ---------- signature matching (pure) ----------

export interface DetectInput {
  host: string;
  /** Path with the query string. */
  path: string;
  requestHeaders: HeaderList;
  responseHeaders: HeaderList | null;
  requestBody?: string | null;
  responseBody?: string | null;
}

export interface TechHit {
  tech: string;
  confidence: number;
  evidence: string[];
}

interface CompiledMatcher {
  m: Matcher;
  name?: RegExp;
  value?: RegExp;
}

export interface CompiledSignature {
  sig: Signature;
  matchers: CompiledMatcher[];
}

const CATEGORIES: TechCategory[] = ['cloud', 'cdn', 'hosting', 'server', 'language', 'framework', 'frontend', 'cms', 'auth', 'protocol', 'security'];
const MATCH_IN = ['header', 'requestHeader', 'cookie', 'host', 'path', 'body', 'requestBody'];

/** Check a user-supplied signature and return it in canonical form; throws with a readable message. */
export function validateSignature(input: unknown): Signature {
  const s = input as Signature;
  if (!s || typeof s !== 'object') throw new Error('a signature must be an object');
  if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(s.id)) throw new Error(`signature id "${String(s.id)}" must be lower case letters, digits, . and -`);
  if (typeof s.name !== 'string' || !s.name.trim()) throw new Error(`signature "${s.id}" needs a name`);
  if (!CATEGORIES.includes(s.category)) throw new Error(`signature "${s.id}": category must be one of ${CATEGORIES.join(', ')}`);
  if (!Array.isArray(s.matchers)) throw new Error(`signature "${s.id}" needs a matchers list`);
  for (const m of s.matchers) {
    if (!MATCH_IN.includes(m?.in)) throw new Error(`signature "${s.id}": matcher "in" must be one of ${MATCH_IN.join(', ')}`);
    if ((m.in === 'header' || m.in === 'requestHeader' || m.in === 'cookie') && !m.name) throw new Error(`signature "${s.id}": a ${m.in} matcher needs a name`);
    if (!['header', 'requestHeader', 'cookie'].includes(m.in) && !m.match) throw new Error(`signature "${s.id}": a ${m.in} matcher needs a match pattern`);
    if (m.match) {
      try {
        new RegExp(m.match, 'i');
      } catch (e) {
        throw new Error(`signature "${s.id}": bad pattern ${m.match}: ${(e as Error).message}`);
      }
    }
    if (m.weight !== undefined && !(typeof m.weight === 'number' && m.weight >= 0 && m.weight <= 1)) throw new Error(`signature "${s.id}": weight must be between 0 and 1`);
  }
  for (const c of s.csrf ?? []) {
    if (!c.source?.from || !c.source.name) throw new Error(`signature "${s.id}": a CSRF pattern needs a source with from and name`);
    if (!Array.isArray(c.sinks) || !c.sinks.length) throw new Error(`signature "${s.id}": a CSRF pattern needs at least one sink`);
  }
  for (const c of s.checks ?? []) {
    if (c.probe && (!['GET', 'HEAD', 'OPTIONS'].includes(c.probe.method) || !c.probe.path?.startsWith('/'))) throw new Error(`signature "${s.id}": a probe must be a GET, HEAD or OPTIONS to a path starting with /`);
  }
  return s;
}

const nameGlob = (g: string) => globToRegExp(g);

export function compileSignatures(list: Signature[]): CompiledSignature[] {
  return list.map((sig) => ({
    sig,
    matchers: sig.matchers.map((m) => ({ m, name: m.name ? nameGlob(m.name) : undefined, value: m.match ? new RegExp(m.match, 'i') : undefined })),
  }));
}

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Cookies a request sent or a response set, as name and value. */
export function exchangeCookies(requestHeaders: HeaderList, responseHeaders: HeaderList | null): Array<{ name: string; value: string; set: boolean }> {
  const out: Array<{ name: string; value: string; set: boolean }> = [];
  for (const [k, v] of requestHeaders) {
    if (k.toLowerCase() !== 'cookie') continue;
    for (const part of v.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), set: false });
    }
  }
  for (const [k, v] of responseHeaders ?? []) {
    if (k.toLowerCase() !== 'set-cookie') continue;
    const c = parseSetCookie(v);
    if (c) out.push({ name: c.name, value: c.value, set: true });
  }
  return out;
}

/** Run signatures over one exchange. Confidence from several matches combines as 1 - Π(1 - w). */
export function detect(input: DetectInput, sigs: CompiledSignature[]): TechHit[] {
  const cookies = exchangeCookies(input.requestHeaders, input.responseHeaders);
  const host = input.host.toLowerCase();
  const out: TechHit[] = [];
  for (const { sig, matchers } of sigs) {
    let miss = 1;
    const evidence: string[] = [];
    for (const cm of matchers) {
      const found = matchOne(cm, input, host, cookies);
      if (found === null) continue;
      miss *= 1 - (cm.m.weight ?? 0.8);
      evidence.push(found);
    }
    if (evidence.length) out.push({ tech: sig.id, confidence: Math.round((1 - miss) * 1000) / 1000, evidence });
  }
  return out;
}

function matchOne(cm: CompiledMatcher, input: DetectInput, host: string, cookies: Array<{ name: string; value: string; set: boolean }>): string | null {
  const { m } = cm;
  switch (m.in) {
    case 'header':
    case 'requestHeader': {
      const list = m.in === 'header' ? (input.responseHeaders ?? []) : input.requestHeaders;
      for (const [k, v] of list) {
        if (!cm.name!.test(k.toLowerCase())) continue;
        if (cm.value && !cm.value.test(v)) continue;
        return `${m.in === 'header' ? 'response' : 'request'} header ${k}: ${clip(v, 60)}`;
      }
      return null;
    }
    case 'cookie': {
      for (const c of cookies) {
        if (!cm.name!.test(c.name.toLowerCase())) continue;
        if (cm.value && !cm.value.test(c.value)) continue;
        return `cookie ${c.name}`;
      }
      return null;
    }
    case 'host':
      return cm.value!.test(host) ? `host ${host}` : null;
    case 'path': {
      const hit = cm.value!.exec(input.path);
      return hit ? `path ${clip(input.path, 70)}` : null;
    }
    case 'body':
    case 'requestBody': {
      const text = m.in === 'body' ? input.responseBody : input.requestBody;
      if (!text) return null;
      const hit = cm.value!.exec(text);
      return hit ? `${m.in === 'body' ? 'response' : 'request'} body contains ${clip(hit[0], 60)}` : null;
    }
  }
  return null;
}

// ---------- HTML helpers ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const unescapeHtml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });

function tagAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1]!.toLowerCase()] = unescapeHtml(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/** Every `<tag>` of a kind with its attributes. */
export function htmlTags(html: string, tag: 'meta' | 'input'): Array<Record<string, string>> {
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  return [...html.matchAll(re)].map((m) => tagAttrs(m[0]));
}

function findJsonKey(v: unknown, key: string, depth = 0): string | undefined {
  if (depth > 6 || v === null || typeof v !== 'object') return undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = findJsonKey(x, key, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  for (const [k, x] of Object.entries(v)) if (k.toLowerCase() === key.toLowerCase() && typeof x === 'string') return x;
  for (const x of Object.values(v)) {
    const r = findJsonKey(x, key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** Read a CSRF token out of a response the way a source describes. */
export function readCsrfSource(src: CsrfSource, res: { headers: HeaderList | null; body: string | null }): string | undefined {
  let v: string | undefined;
  const lname = src.name.toLowerCase();
  switch (src.from) {
    case 'cookie':
      v = exchangeCookies([], res.headers).find((c) => c.name.toLowerCase() === lname)?.value;
      break;
    case 'header':
      v = res.headers?.find(([k]) => k.toLowerCase() === lname)?.[1];
      break;
    case 'meta':
      if (res.body) v = htmlTags(res.body, 'meta').find((a) => (a.name ?? a.property ?? '').toLowerCase() === lname)?.content;
      break;
    case 'input':
      if (res.body) v = htmlTags(res.body, 'input').find((a) => (a.name ?? '').toLowerCase() === lname)?.value;
      break;
    case 'json':
      if (res.body) {
        try {
          v = findJsonKey(JSON.parse(res.body), src.name);
        } catch {
          v = undefined;
        }
      }
      break;
    case 'regex':
      if (res.body) {
        const m = new RegExp(src.name).exec(res.body);
        v = m ? (m[1] ?? m[0]) : undefined;
      }
      break;
  }
  if (v === undefined || v === '') return undefined;
  if (src.urlDecode) {
    try {
      v = decodeURIComponent(v);
    } catch {
      // keep it as sent
    }
  }
  return v;
}

// ---------- user settings ----------

export interface TechOverride {
  id: string;
  /** Host or host glob; "*" for every host. */
  host: string;
  tech: string;
  action: 'pin' | 'reject';
  note?: string;
}

export interface CookieOverride {
  id: string;
  /** Cookie name glob. */
  name: string;
  /** Domain glob; empty for any. */
  domain?: string;
  infra: boolean;
}

export interface CsrfBinding {
  id: string;
  enabled?: boolean;
  /** Host glob this token belongs to. */
  host: string;
  /** Variable that holds the latest token ({{var:name}}). */
  varName: string;
  source: CsrfSource;
  sinks: CsrfSink[];
  /** Page to load for a fresh token; defaults to the page the token last came from. */
  refreshUrl?: string;
  /** The technology that suggested it, for display. */
  tech?: string;
}

export interface EffectiveTech {
  id: string;
  name: string;
  category: TechCategory;
  /** 0 to 1; 1 for pinned. */
  confidence: number;
  /** detected: seen in traffic. possible: seen, but weakly. pinned: the user said so. implied: follows from another. */
  status: 'detected' | 'possible' | 'pinned' | 'implied';
  evidence: string[];
  impliedBy?: string;
  overrideId?: string;
  sampleId?: string | null;
  checks: TechCheck[];
  docs?: string;
}

export interface HostTechReport {
  host: string;
  tech: EffectiveTech[];
  /** Detections the user turned down, so they can be restored. */
  rejected: Array<{ id: string; name: string; overrideId: string; host: string }>;
}

export interface CsrfFinding {
  /** Where this request carries the token. */
  sink: CsrfSink;
  value: string;
  /** Where the token comes from, when it could be found. */
  source?: CsrfSource;
  sourceExchangeId?: string;
  /** How the source was worked out. */
  how: 'cookie-echo' | 'value-match' | 'framework-pattern' | 'unknown';
  tech?: string;
  /** An existing binding that already keeps this sink fresh. */
  bindingId?: string;
  /** A ready-made binding to save. */
  suggestion?: Omit<CsrfBinding, 'id'>;
}

export const DETECTED_THRESHOLD = 0.5;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ---------- the service ----------

export class TechService {
  private compiled: CompiledSignature[] = [];
  private byId = new Map<string, Signature>();

  constructor(
    private readonly store: CaptureStore,
    private readonly vars: Vars,
  ) {
    this.reload();
    store.techHosts = (tech) => this.hostsWith(tech);
    store.on('change', (c) => {
      if (c.kind === 'meta.set' && (c.entityId === 'techSignatures' || c.entityId === 'techDisabled')) this.reload();
      if (c.kind !== 'exchange.response' && c.kind !== 'exchange.established') return;
      try {
        this.observe(c.entityId);
      } catch {
        // detection must never break capture
      }
    });
  }

  private meta<T>(key: string, fallback: T): T {
    return this.store.getMeta<T>(key) ?? fallback;
  }

  // ----- signatures -----

  builtIn(): Signature[] {
    return SIGNATURES;
  }
  custom(): Signature[] {
    return this.meta<Signature[]>('techSignatures', []);
  }
  setCustom(list: unknown[]): Signature[] {
    if (!Array.isArray(list)) throw new Error('signatures must be a list');
    const out = list.map(validateSignature);
    const ids = new Set<string>();
    for (const s of out) {
      if (ids.has(s.id)) throw new Error(`signature id "${s.id}" is used twice`);
      ids.add(s.id);
    }
    this.store.setMeta('techSignatures', out);
    return out;
  }
  disabled(): string[] {
    return this.meta<string[]>('techDisabled', []);
  }
  setDisabled(ids: string[]): string[] {
    const out = [...new Set(ids.map(String))];
    this.store.setMeta('techDisabled', out);
    return out;
  }
  /** Built-in plus custom, where a custom signature with a built-in id replaces it. Disabled ones are left out. */
  signatures(): Signature[] {
    return [...this.byId.values()];
  }
  signature(id: string): Signature | undefined {
    return this.byId.get(id);
  }

  private reload() {
    const off = new Set(this.disabled());
    const map = new Map<string, Signature>();
    for (const s of SIGNATURES) map.set(s.id, s);
    for (const s of this.custom()) map.set(s.id, s);
    for (const id of off) map.delete(id);
    this.byId = map;
    this.compiled = compileSignatures([...map.values()]);
  }

  // ----- overrides -----

  overrides(): TechOverride[] {
    return this.meta<TechOverride[]>('techOverrides', []);
  }
  setOverrides(list: Array<Omit<TechOverride, 'id'> & { id?: string }>): TechOverride[] {
    const out = list.map((o) => {
      if (!o.host?.trim()) throw new Error('an override needs a host (use * for every host)');
      if (!o.tech?.trim()) throw new Error('an override needs a technology id');
      if (o.action !== 'pin' && o.action !== 'reject') throw new Error('action must be "pin" or "reject"');
      return { ...o, host: o.host.trim().toLowerCase(), tech: o.tech.trim(), id: o.id ?? newId() };
    });
    this.store.setMeta('techOverrides', out);
    return out;
  }
  /** Pin or reject one technology for a host, replacing any earlier override for that pair. */
  override(host: string, tech: string, action: 'pin' | 'reject' | 'clear', note?: string): TechOverride[] {
    const h = host.trim().toLowerCase();
    const rest = this.overrides().filter((o) => !(o.host === h && o.tech === tech));
    return this.setOverrides(action === 'clear' ? rest : [...rest, { host: h, tech, action, ...(note ? { note } : {}) }]);
  }

  cookieOverrides(): CookieOverride[] {
    return this.meta<CookieOverride[]>('cookieOverrides', []);
  }
  setCookieOverrides(list: Array<Omit<CookieOverride, 'id'> & { id?: string }>): CookieOverride[] {
    const out = list.map((o) => {
      if (!o.name?.trim()) throw new Error('a cookie override needs a cookie name');
      if (typeof o.infra !== 'boolean') throw new Error('infra must be true or false');
      return { ...o, id: o.id ?? newId() };
    });
    this.store.setMeta('cookieOverrides', out);
    return out;
  }

  // ----- detection -----

  private inputFor(ex: Exchange): DetectInput {
    return {
      host: ex.host,
      path: ex.path,
      requestHeaders: ex.requestHeaders,
      responseHeaders: ex.responseHeaders,
      requestBody: this.text(ex, 'request', 64 * 1024),
      responseBody: this.text(ex, 'response', 256 * 1024),
    };
  }

  private text(ex: Exchange, side: 'request' | 'response', max: number): string | null {
    const size = side === 'request' ? ex.reqBodySize : (ex.resBodySize ?? 0);
    if (!size || size > 4 * 1024 * 1024) return null;
    const headers = side === 'request' ? ex.requestHeaders : ex.responseHeaders;
    const ct = headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    if (ct && !/(text|html|json|javascript|xml|x-www-form-urlencoded|graphql)/i.test(ct)) return null;
    const b = this.store.getBody(ex.id, side, true);
    if (!b?.length) return null;
    const cut = b.subarray(0, max);
    return looksLikeText(cut) ? bytesToString(cut) : null;
  }

  /** Detect on one recorded exchange and update its host's results; also refresh CSRF variables. */
  observe(exchangeId: string): TechHit[] {
    const ex = this.store.getExchange(exchangeId);
    if (!ex) return [];
    const input = this.inputFor(ex);
    const hits = detect(input, this.compiled);
    for (const h of hits) this.store.recordHostTech(ex.host.toLowerCase(), h.tech, h.confidence, h.evidence, ex.id, ex.startedAt);
    this.captureCsrf(ex, input.responseBody ?? null);
    return hits;
  }

  /** Detections on a single exchange, without recording anything. */
  detectExchange(exchangeId: string): TechHit[] {
    const ex = this.store.getExchange(exchangeId);
    if (!ex) throw new Error('no such exchange');
    return detect(this.inputFor(ex), this.compiled).map((h) => ({ ...h, name: this.byId.get(h.tech)?.name ?? h.tech }));
  }

  /** Forget all detections and run the current signatures over the most recent traffic again. */
  rescan(limit = 5000): { exchanges: number; hosts: number } {
    this.store.clearHostTech();
    const list = this.store.search('', { limit });
    for (const s of list.reverse()) {
      try {
        const ex = this.store.getExchange(s.id);
        if (!ex || ex.state === 'pending') continue;
        const input = this.inputFor(ex);
        for (const h of detect(input, this.compiled)) this.store.recordHostTech(ex.host.toLowerCase(), h.tech, h.confidence, h.evidence, ex.id, ex.startedAt);
      } catch {
        // skip an unreadable exchange
      }
    }
    return { exchanges: list.length, hosts: new Set(list.map((e) => e.host)).size };
  }

  private overridesFor(host: string): Map<string, TechOverride> {
    // A rule for the exact host beats a glob; among equals the later one wins.
    const h = host.toLowerCase();
    const out = new Map<string, { o: TechOverride; exact: boolean }>();
    for (const o of this.overrides()) {
      const exact = o.host === h;
      if (!exact && !globToRegExp(o.host).test(h)) continue;
      const prev = out.get(o.tech);
      if (prev && prev.exact && !exact) continue;
      out.set(o.tech, { o, exact });
    }
    return new Map([...out].map(([k, v]) => [k, v.o]));
  }

  /** What a host runs on, after the user's overrides. */
  hostReport(host: string, rows = this.store.hostTech(host.toLowerCase())): HostTechReport {
    const h = host.toLowerCase();
    const ov = this.overridesFor(h);
    const out = new Map<string, EffectiveTech>();
    const rejected: HostTechReport['rejected'] = [];
    const describe = (id: string) => {
      const s = this.byId.get(id);
      return { id, name: s?.name ?? id, category: s?.category ?? ('framework' as TechCategory), checks: s?.checks ?? [], ...(s?.docs ? { docs: s.docs } : {}) };
    };
    for (const r of rows) {
      if (!this.byId.has(r.tech)) continue;
      const o = ov.get(r.tech);
      if (o?.action === 'reject') continue;
      out.set(r.tech, { ...describe(r.tech), confidence: r.confidence, status: r.confidence >= DETECTED_THRESHOLD ? 'detected' : 'possible', evidence: r.evidence, sampleId: r.sampleId });
    }
    for (const [tech, o] of ov) {
      if (o.action === 'reject') {
        rejected.push({ id: tech, name: this.byId.get(tech)?.name ?? tech, overrideId: o.id, host: o.host });
        continue;
      }
      const prev = out.get(tech);
      out.set(tech, { ...describe(tech), confidence: 1, status: 'pinned', evidence: prev?.evidence ?? [o.note ? `pinned: ${o.note}` : 'pinned by you'], overrideId: o.id, sampleId: prev?.sampleId ?? null });
    }
    // Follow implications from anything we are reasonably sure of.
    const queue = [...out.values()].filter((t) => t.status !== 'possible');
    while (queue.length) {
      const t = queue.shift()!;
      for (const imp of this.byId.get(t.id)?.implies ?? []) {
        if (!this.byId.has(imp) || ov.get(imp)?.action === 'reject') continue;
        const prev = out.get(imp);
        if (prev && prev.status !== 'possible') continue;
        const e: EffectiveTech = { ...describe(imp), confidence: Math.max(prev?.confidence ?? 0, t.confidence * 0.9), status: 'implied', evidence: [...(prev?.evidence ?? []), `implied by ${t.name}`], impliedBy: t.id, sampleId: prev?.sampleId ?? null };
        out.set(imp, e);
        queue.push(e);
      }
    }
    const order: Record<EffectiveTech['status'], number> = { pinned: 0, detected: 1, implied: 2, possible: 3 };
    const tech = [...out.values()].sort((a, b) => order[a.status] - order[b.status] || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || b.confidence - a.confidence);
    return { host: h, tech, rejected };
  }

  /** Every host with traffic and its technologies (not "possible" ones). */
  allHosts(): Array<{ host: string; tech: Array<Pick<EffectiveTech, 'id' | 'name' | 'category' | 'status'>> }> {
    const rows = this.store.hostTech();
    const byHost = new Map<string, typeof rows>();
    for (const r of rows) byHost.set(r.host, [...(byHost.get(r.host) ?? []), r]);
    const hosts = new Set([...byHost.keys(), ...(this.overrides().some((o) => o.action === 'pin') ? this.store.hosts().map((x) => x.toLowerCase()) : [])]);
    return [...hosts].map((host) => ({
      host,
      tech: this.hostReport(host, byHost.get(host) ?? [])
        .tech.filter((t) => t.status !== 'possible')
        .map(({ id, name, category, status }) => ({ id, name, category, status })),
    }));
  }

  /** Hosts running a technology (by id, or by name ignoring case), for `tech:` searches. */
  hostsWith(tech: string): string[] {
    const want = tech.toLowerCase();
    const ids = new Set([...this.byId.values()].filter((s) => s.id === want || s.name.toLowerCase() === want).map((s) => s.id));
    if (!ids.size) ids.add(want);
    const lower = new Set<string>();
    for (const h of this.allHosts()) if (h.tech.some((t) => ids.has(t.id))) lower.add(h.host);
    // Exchange hosts are stored as seen; match them case-insensitively.
    return this.store.hosts().filter((x) => lower.has(x.toLowerCase()));
  }

  // ----- infrastructure cookies -----

  /** Why a cookie belongs to the platform rather than the app, or null when it is the app's. */
  infraReason(name: string, domain: string): string | null {
    const n = name.toLowerCase();
    const d = domain.toLowerCase();
    for (const o of [...this.cookieOverrides()].reverse()) {
      if (!globToRegExp(o.name).test(n)) continue;
      if (o.domain && !globToRegExp(o.domain).test(d)) continue;
      return o.infra ? 'marked as infrastructure by you' : null;
    }
    for (const s of this.byId.values()) {
      for (const ic of s.infraCookies ?? []) if (globToRegExp(ic.name).test(n)) return ic.reason;
    }
    return null;
  }

  /** The cookie jar with an `infra` reason on platform cookies. */
  annotateJar(jar: JarCookie[] = cookieJar(this.store)): Array<JarCookie & { infra: string | null }> {
    return jar.map((c) => ({ ...c, infra: this.infraReason(c.name, c.domain) }));
  }

  // ----- CSRF -----

  csrfBindings(): CsrfBinding[] {
    return this.meta<CsrfBinding[]>('csrfBindings', []);
  }
  setCsrfBindings(list: Array<Omit<CsrfBinding, 'id'> & { id?: string }>): CsrfBinding[] {
    const out = list.map((b) => {
      if (!b.host?.trim()) throw new Error('a CSRF binding needs a host');
      if (!b.varName || !/^[\w.-]+$/.test(b.varName)) throw new Error(`invalid variable name "${b.varName}"`);
      if (!b.source?.from || !b.source.name) throw new Error('a CSRF binding needs a source');
      if (!['cookie', 'header', 'meta', 'input', 'json', 'regex'].includes(b.source.from)) throw new Error(`invalid CSRF source "${b.source.from}"`);
      if (b.source.from === 'regex') new RegExp(b.source.name);
      if (!Array.isArray(b.sinks) || !b.sinks.length) throw new Error('a CSRF binding needs at least one place to send the token');
      for (const s of b.sinks) if (!['header', 'form', 'json', 'query'].includes(s.in) || !s.name) throw new Error('each sink needs "in" (header, form, json or query) and a name');
      if (b.refreshUrl) new URL(b.refreshUrl);
      return { ...b, host: b.host.trim().toLowerCase(), id: b.id ?? newId() };
    });
    this.store.setMeta('csrfBindings', out);
    return out;
  }

  private bindingsFor(host: string): CsrfBinding[] {
    const h = host.toLowerCase();
    return this.csrfBindings().filter((b) => b.enabled !== false && globToRegExp(b.host).test(h));
  }

  /** Keep each binding's variable at the latest token seen in responses. */
  private captureCsrf(ex: Exchange, body: string | null) {
    if (!ex.responseHeaders) return;
    for (const b of this.bindingsFor(ex.host)) {
      const v = readCsrfSource(b.source, { headers: ex.responseHeaders, body });
      if (v !== undefined) this.vars.set(b.varName, v, `csrf:${b.id}`, ex.id);
    }
  }

  /** Where this request carries CSRF tokens, where they came from, and a binding to keep them fresh. */
  csrfFindings(exchangeId: string): CsrfFinding[] {
    const ex = this.store.getExchange(exchangeId);
    if (!ex) throw new Error('no such exchange');
    const report = this.hostReport(ex.host);
    const onHost = new Set(report.tech.filter((t) => t.status !== 'possible').map((t) => t.id));
    const patterns = [...this.byId.values()].flatMap((s) => (s.csrf ?? []).map((p) => ({ ...p, tech: s.id })));
    const knownSinks = new Set(patterns.flatMap((p) => p.sinks.map((s) => `${s.in}:${s.name.toLowerCase()}`)));
    const isCandidate = (inn: CsrfSink['in'], name: string) => knownSinks.has(`${inn}:${name.toLowerCase()}`) || GENERIC_CSRF_NAME.test(name);

    const candidates: Array<{ sink: CsrfSink; value: string }> = [];
    for (const [k, v] of ex.requestHeaders) if (isCandidate('header', k) && v.length >= 8) candidates.push({ sink: { in: 'header', name: k }, value: v });
    const u = new URL(ex.url);
    for (const [k, v] of u.searchParams) if (isCandidate('query', k) && v.length >= 8) candidates.push({ sink: { in: 'query', name: k }, value: v });
    const ct = ex.requestHeaders.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    const reqText = this.text(ex, 'request', 64 * 1024);
    if (reqText && /x-www-form-urlencoded/i.test(ct)) {
      for (const [k, v] of new URLSearchParams(reqText)) if (isCandidate('form', k) && v.length >= 8) candidates.push({ sink: { in: 'form', name: k }, value: v });
    } else if (reqText && /json/i.test(ct)) {
      try {
        const j = JSON.parse(reqText) as unknown;
        if (j && typeof j === 'object' && !Array.isArray(j)) for (const [k, v] of Object.entries(j)) if (typeof v === 'string' && isCandidate('json', k) && v.length >= 8) candidates.push({ sink: { in: 'json', name: k }, value: v });
      } catch {
        // not JSON after all
      }
    }

    const sentCookies = exchangeCookies(ex.requestHeaders, null);
    const bindings = this.bindingsFor(ex.host);
    const out: CsrfFinding[] = [];
    for (const { sink, value } of candidates) {
      const finding: CsrfFinding = { sink, value, how: 'unknown' };
      const bound = bindings.find((b) => b.sinks.some((s) => s.in === sink.in && s.name.toLowerCase() === sink.name.toLowerCase()));
      if (bound) finding.bindingId = bound.id;
      const pattern = patterns.find((p) => p.sinks.some((s) => s.in === sink.in && s.name.toLowerCase() === sink.name.toLowerCase()) && onHost.has(p.tech)) ?? patterns.find((p) => p.sinks.some((s) => s.in === sink.in && s.name.toLowerCase() === sink.name.toLowerCase()));
      if (pattern) finding.tech = pattern.tech;

      // 1. Double submit: the same value rides in a cookie.
      const echo = sentCookies.find((c) => c.value === value || safeDecode(c.value) === value);
      if (echo) {
        finding.source = { from: 'cookie', name: echo.name, ...(echo.value !== value ? { urlDecode: true } : {}) };
        finding.how = 'cookie-echo';
      }
      // 2. Find the response that handed this value out.
      if (!finding.source) {
        const found = this.findValueSource(ex, value);
        if (found) {
          finding.source = found.source;
          finding.sourceExchangeId = found.exchangeId;
          finding.how = 'value-match';
        }
      }
      // 3. Fall back to what the framework normally does.
      if (!finding.source && pattern) {
        finding.source = pattern.source;
        finding.how = 'framework-pattern';
      }
      if (finding.source && !bound) {
        const srcEx = finding.sourceExchangeId ? this.store.getSummary(finding.sourceExchangeId) : undefined;
        finding.suggestion = {
          host: ex.host.toLowerCase(),
          varName: this.freeVarName(ex.host),
          source: finding.source,
          sinks: [sink],
          ...(srcEx && SAFE_METHODS.has(srcEx.method) && srcEx.status !== null && srcEx.status < 400 ? { refreshUrl: srcEx.url } : {}),
          ...(finding.tech ? { tech: finding.tech } : {}),
        };
      }
      out.push(finding);
    }
    return out;
  }

  private freeVarName(host: string): string {
    const base = `csrf.${host.toLowerCase().replace(/[^\w.-]/g, '_')}`;
    const taken = new Set([...Object.keys(this.vars.all()), ...this.csrfBindings().map((b) => b.varName)]);
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}.${i}`)) return `${base}.${i}`;
  }

  private findValueSource(ex: Exchange, value: string): { source: CsrfSource; exchangeId: string } | undefined {
    // Search on the longest plain run of the token: HTML may carry the rest escaped (&#43; for +).
    const piece = value.split(/[^A-Za-z0-9]+/).sort((a, b) => b.length - a.length)[0] ?? '';
    if (piece.length < 6) return undefined;
    let hits: Array<{ id: string }> = [];
    try {
      hits = this.store.search(`host:${ex.host} "${piece}"`, { limit: 25, before: ex.id });
    } catch {
      return undefined;
    }
    for (const s of hits) {
      const r = this.store.getExchange(s.id);
      if (!r?.responseHeaders) continue;
      for (const c of exchangeCookies([], r.responseHeaders)) {
        if (c.value === value) return { source: { from: 'cookie', name: c.name }, exchangeId: r.id };
        if (safeDecode(c.value) === value) return { source: { from: 'cookie', name: c.name, urlDecode: true }, exchangeId: r.id };
      }
      for (const [k, v] of r.responseHeaders) if (k.toLowerCase() !== 'set-cookie' && v === value) return { source: { from: 'header', name: k }, exchangeId: r.id };
      const body = this.text(r, 'response', 1024 * 1024);
      if (!body || !body.includes(piece)) continue;
      const meta = htmlTags(body, 'meta').find((a) => a.content === value && (a.name || a.property));
      if (meta) return { source: { from: 'meta', name: meta.name ?? meta.property! }, exchangeId: r.id };
      const input = htmlTags(body, 'input').find((a) => a.value === value && a.name);
      if (input) return { source: { from: 'input', name: input.name! }, exchangeId: r.id };
      try {
        const key = jsonKeyOf(JSON.parse(body), value);
        if (key) return { source: { from: 'json', name: key }, exchangeId: r.id };
      } catch {
        // not JSON
      }
      const i = body.indexOf(value);
      if (i > 0) {
        // Anchor a regex on the 12 characters before the token.
        const before = body.slice(Math.max(0, i - 12), i).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return { source: { from: 'regex', name: `${before}([^"'<>\\s&]+)` }, exchangeId: r.id };
      }
    }
    return undefined;
  }

  /**
   * Put the current token into each place a request carries it. Only sinks
   * the request already has are touched, so nothing new is added to a request
   * that did not send a token. Returns the bindings it used.
   */
  applyCsrf(req: { method: string; url: string; headers: HeaderList; body?: Uint8Array }): { req: typeof req; used: CsrfBinding[]; missing: CsrfBinding[] } {
    const host = new URL(req.url).hostname;
    const values = this.vars.values();
    const used: CsrfBinding[] = [];
    const missing: CsrfBinding[] = [];
    let { url, headers, body } = req;
    for (const b of this.bindingsFor(host)) {
      const present = b.sinks.filter((s) => hasSink(s, { url, headers, body }));
      if (!present.length) continue;
      const v = values[b.varName];
      if (v === undefined) {
        missing.push(b);
        continue;
      }
      for (const s of present) ({ url, headers, body } = setSink(s, v, { url, headers, body }));
      if (b.source.from === 'cookie') headers = setCookieValue(headers, b.source.name, cookieJar(this.store).find((c) => c.name === b.source.name && !c.expired)?.value);
      used.push(b);
    }
    return { req: { ...req, url, headers, body }, used, missing };
  }

  /** The page to load to get a fresh token for a binding. */
  refreshUrlFor(b: CsrfBinding, requestUrl: string): string {
    if (b.refreshUrl) return b.refreshUrl;
    const fromId = this.vars.all()[b.varName]?.exchangeId;
    const from = fromId ? this.store.getSummary(fromId) : undefined;
    if (from && SAFE_METHODS.has(from.method)) return from.url;
    return new URL('/', requestUrl).href;
  }
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function jsonKeyOf(v: unknown, value: string, depth = 0): string | undefined {
  if (depth > 6 || v === null || typeof v !== 'object') return undefined;
  for (const [k, x] of Object.entries(v)) {
    if (x === value && !Array.isArray(v)) return k;
    const r = jsonKeyOf(x, value, depth + 1);
    if (r) return r;
  }
  return undefined;
}

const enc = new TextEncoder();
const textOf = (b?: Uint8Array) => (b && b.length ? bytesToString(b) : '');
const contentType = (headers: HeaderList) => headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';

function hasSink(s: CsrfSink, r: { url: string; headers: HeaderList; body?: Uint8Array }): boolean {
  const n = s.name.toLowerCase();
  switch (s.in) {
    case 'header':
      return r.headers.some(([k]) => k.toLowerCase() === n);
    case 'query':
      return new URL(r.url).searchParams.has(s.name);
    case 'form':
      return /x-www-form-urlencoded/i.test(contentType(r.headers)) && new URLSearchParams(textOf(r.body)).has(s.name);
    case 'json':
      if (!/json/i.test(contentType(r.headers))) return false;
      try {
        const j = JSON.parse(textOf(r.body)) as Record<string, unknown>;
        return !!j && typeof j === 'object' && s.name in j;
      } catch {
        return false;
      }
  }
}

function setSink(s: CsrfSink, v: string, r: { url: string; headers: HeaderList; body?: Uint8Array }): { url: string; headers: HeaderList; body?: Uint8Array } {
  const n = s.name.toLowerCase();
  switch (s.in) {
    case 'header':
      return { ...r, headers: r.headers.map(([k, x]) => [k, k.toLowerCase() === n ? v : x]) };
    case 'query': {
      const u = new URL(r.url);
      u.searchParams.set(s.name, v);
      return { ...r, url: u.href };
    }
    case 'form': {
      // Rewrite just the one field so the order and encoding of the rest stay as captured.
      const text = textOf(r.body).split('&').map((pair) => {
        const i = pair.indexOf('=');
        const k = i === -1 ? pair : pair.slice(0, i);
        return safeDecode(k.replace(/\+/g, ' ')) === s.name ? `${k}=${encodeURIComponent(v)}` : pair;
      });
      return { ...r, body: enc.encode(text.join('&')) };
    }
    case 'json': {
      const j = JSON.parse(textOf(r.body)) as Record<string, unknown>;
      j[s.name] = v;
      return { ...r, body: enc.encode(JSON.stringify(j)) };
    }
  }
}

function setCookieValue(headers: HeaderList, name: string, value: string | undefined): HeaderList {
  if (value === undefined) return headers;
  return headers.map(([k, v]) => {
    if (k.toLowerCase() !== 'cookie') return [k, v];
    return [
      k,
      v
        .split(';')
        .map((p) => {
          const i = p.indexOf('=');
          return i > 0 && p.slice(0, i).trim() === name ? `${p.slice(0, i)}=${value}` : p;
        })
        .join(';'),
    ];
  });
}
