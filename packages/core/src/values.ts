import { bytesToString, looksLikeText } from '@siteinquisition/codecs';
import { query } from '@siteinquisition/codecs/jsonpath';
import { pathTemplate } from './coverage.js';
import type { CaptureStore, Exchange, ExchangeSummary } from './store.js';
import { TokenError } from './tokens.js';

/**
 * Values: the data an API hands out, indexed so it can be reused. Every
 * scalar field in recorded JSON bodies is filed under its endpoint and
 * JSONPath (`GET /api/products $.items[*].sku`), so a request can pick a real
 * SKU, order number or cart id instead of a made-up one, and a value seen in
 * a request can be traced back to the response that first handed it out.
 */
export interface ValueField {
  method: string;
  /** Path template, ids collapsed. */
  template: string;
  side: 'request' | 'response';
  /** JSONPath with array indexes as [*]. */
  path: string;
  /** Last key, e.g. "sku". */
  name: string;
  type: 'string' | 'number' | 'boolean';
  /** Times the field was seen. */
  count: number;
  /** Distinct values, newest first, up to 12. */
  samples: string[];
  distinct: number;
  /** Looks like an identifier (by its name or its values). */
  idLike: boolean;
  lastExchangeId: string;
  lastAt: number;
}

const ID_NAME = /(^|[_\-.])(id|ids|sku|number|num|no|code|ref|key|uuid|guid|token|slug|handle)$|[a-z0-9](Id|ID|Number|No|Num|Code|Ref|Key|Uuid|Sku)$/;
const ID_VALUE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Z]{1,6}[-_]?\d{2,}|\d{3,})$/i;

export function jsonOf(store: CaptureStore, id: string, side: 'request' | 'response'): unknown {
  const b = store.getBody(id, side, true);
  if (!b?.length || b.length > 2_000_000 || !looksLikeText(b)) return undefined;
  const t = bytesToString(b).trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

const keyPart = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `['${k.replace(/'/g, "\\'")}']`);

/** Call `fn` for every scalar leaf with its concrete and normalised ([*]) paths. */
export function walkLeaves(v: unknown, fn: (concrete: string, normal: string, name: string, value: string | number | boolean) => void, limit = 5000): void {
  let n = 0;
  const go = (x: unknown, c: string, p: string, name: string, depth: number) => {
    if (n > limit || depth > 12) return;
    if (x === null || x === undefined) return;
    if (Array.isArray(x)) {
      x.slice(0, 200).forEach((item, i) => go(item, `${c}[${i}]`, `${p}[*]`, name, depth + 1));
      return;
    }
    if (typeof x === 'object') {
      for (const [k, val] of Object.entries(x)) go(val, c + keyPart(k), p + keyPart(k), k, depth + 1);
      return;
    }
    if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') {
      n++;
      fn(c, p, name, x);
    }
  };
  go(v, '$', '$', '', 0);
}

export function valueCatalog(store: CaptureStore, opts: { host?: string; query?: string; limit?: number } = {}): ValueField[] {
  const q = [opts.host ? `host:${opts.host}` : '', opts.query ?? ''].filter(Boolean).join(' ');
  const rows = store.search(q, { limit: opts.limit ?? 1500 });
  const map = new Map<string, ValueField & { set: Set<string> }>();
  for (const e of rows) {
    if (e.isWebSocket) continue;
    const template = pathTemplate(e.path);
    for (const side of ['response', 'request'] as const) {
      if (side === 'request' && !e.reqBodySize) continue;
      if (side === 'response' && !e.resBodySize) continue;
      const json = jsonOf(store, e.id, side);
      if (json === undefined) continue;
      walkLeaves(json, (_c, path, name, value) => {
        const key = `${e.method} ${template} ${side} ${path}`;
        let f = map.get(key);
        if (!f) {
          f = { method: e.method, template, side, path, name, type: typeof value as ValueField['type'], count: 0, samples: [], distinct: 0, idLike: false, lastExchangeId: e.id, lastAt: e.startedAt, set: new Set() };
          map.set(key, f);
        }
        f.count++;
        const s = String(value);
        if (!f.set.has(s)) {
          f.set.add(s);
          if (f.samples.length < 12) f.samples.push(s);
        }
      });
    }
  }
  const out: ValueField[] = [];
  for (const { set, ...f } of map.values()) {
    f.distinct = set.size;
    f.idLike = f.type !== 'boolean' && (ID_NAME.test(f.name) || (f.samples.length > 0 && f.samples.every((s) => ID_VALUE.test(s)) && f.distinct > 1));
    out.push(f);
  }
  out.sort((a, b) => Number(b.idLike) - Number(a.idLike) || Number(a.side === 'request') - Number(b.side === 'request') || b.count - a.count || a.path.localeCompare(b.path));
  return out;
}

const scalarText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** Parse "[METHOD] /path [req|res] $.json.path". */
export function parsePickSpec(spec: string): { method?: string; path: string; side: 'request' | 'response'; jsonPath: string } {
  const m = /^\s*(?:([A-Za-z]+)\s+)?(\S+)\s+(?:(req|request|res|response)\s+)?(\$.*)$/.exec(spec);
  if (!m) throw new TokenError(`pick needs "[METHOD] /path $.field", got "${spec}"`);
  return { method: m[1]?.toUpperCase(), path: m[2]!, side: m[3]?.startsWith('req') ? 'request' : 'response', jsonPath: m[4]!.trim() };
}

/** Values of a field across the newest matching exchanges (newest exchange first). */
export function pickValues(store: CaptureStore, spec: string, opts: { exchanges?: number } = {}): string[] {
  const p = parsePickSpec(spec);
  const literal = p.path.split('{')[0]!.split('*')[0]!.split('?')[0]!;
  const want = pathTemplate(p.path.split('?')[0]!);
  const rows = store.search(`path:${literal}${p.method ? ` method:${p.method}` : ''}`, { limit: 300 });
  const out: string[] = [];
  let used = 0;
  for (const e of rows) {
    const clean = e.path.split('?')[0]!;
    if (clean !== p.path.split('?')[0] && pathTemplate(clean) !== want) continue;
    const json = jsonOf(store, e.id, p.side);
    if (json === undefined) continue;
    let hits;
    try {
      hits = query(json, p.jsonPath);
    } catch (err) {
      throw new TokenError(`bad JSONPath in pick: ${(err as Error).message}`);
    }
    const vals = hits.map((h) => h.value).filter((v) => v !== null && typeof v !== 'object');
    if (!vals.length) continue;
    for (const v of vals) if (!out.includes(scalarText(v))) out.push(scalarText(v));
    if (++used >= (opts.exchanges ?? 1)) break;
  }
  return out;
}

export function pickValue(store: CaptureStore, arg: string): string {
  // "...:random" / ":last" / ":first" select among the newest response's values.
  const m = /^(.*?)(?::(first|last|random))?$/.exec(arg.trim())!;
  const values = pickValues(store, m[1]!);
  if (!values.length) throw new TokenError(`no recorded value for pick "${m[1]}"`);
  const mode = m[2] ?? 'first';
  return mode === 'last' ? values[values.length - 1]! : mode === 'random' ? values[Math.floor(Math.random() * values.length)]! : values[0]!;
}

// ---------- tag references ----------

/** The newest exchange carrying a tag. */
export function taggedExchange(store: CaptureStore, tag: string): ExchangeSummary | undefined {
  return store.search(`tag:"${tag.replace(/"/g, '')}"`, { limit: 1 })[0];
}

/** Put a tag on one exchange only, taking it off every other. Returns the ids it was removed from. */
export function moveTag(store: CaptureStore, tag: string, toId: string): string[] {
  const t = tag.trim();
  if (!t) throw new Error('a tag is needed');
  const target = store.getSummary(toId);
  if (!target) throw new Error('no such exchange');
  const removed: string[] = [];
  for (const e of store.search(`tag:"${t.replace(/"/g, '')}"`, { limit: 10_000 })) {
    if (e.id === toId) continue;
    store.tagExchange(e.id, e.tags.filter((x) => x !== t));
    removed.push(e.id);
  }
  if (!target.tags.includes(t)) store.tagExchange(toId, [...target.tags, t]);
  return removed;
}

const header = (h: Array<[string, string]> | null | undefined, name: string) => h?.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

export function exchangeField(store: CaptureStore, ex: Exchange, side: 'request' | 'response', field: string): string | undefined {
  // @status @url @path @id @method @body read the exchange itself, never the JSON.
  const special = (name: string): string | undefined => {
    if (name === 'status') return side === 'response' && ex.status !== null ? String(ex.status) : undefined;
    if (name === 'url') return ex.url;
    if (name === 'path') return ex.path;
    if (name === 'id') return ex.id;
    if (name === 'method') return ex.method;
    if (name === 'body') {
      const b = store.getBody(ex.id, side, true);
      return b ? bytesToString(b) : undefined;
    }
    return undefined;
  };
  if (field.startsWith('@')) return special(field.slice(1));
  if (field === 'body') return special('body');
  const hm = /^(?:header|headers)\.(.+)$/i.exec(field);
  if (hm) return header(side === 'request' ? ex.requestHeaders : ex.responseHeaders, hm[1]!);
  const qm = /^query\.(.+)$/.exec(field);
  if (qm) return new URL(ex.url).searchParams.get(qm[1]!) ?? undefined;
  const json = jsonOf(store, ex.id, side);
  if (field.startsWith('$')) {
    if (json === undefined) return undefined;
    const hit = query(json, field)[0];
    return hit ? scalarText(hit.value) : undefined;
  }
  if (json !== undefined) {
    // A dotted name from the root, then the first key with that name anywhere.
    const direct = query(json, `$${field.split('.').map(keyPart).join('')}`)[0];
    if (direct) return scalarText(direct.value);
    const last = field.split('.').pop()!;
    let found: string | undefined;
    walkLeaves(json, (_c, _p, name, value) => {
      if (found === undefined && name === last) found = String(value);
    });
    if (found !== undefined) return found;
    // a key holding an object or array
    const deep = query(json, `$..${keyPart(last).replace(/^\./, '')}`)[0];
    if (deep) return scalarText(deep.value);
  }
  const fromHeader = header(side === 'request' ? ex.requestHeaders : ex.responseHeaders, field);
  if (fromHeader !== undefined) return fromHeader;
  if (side === 'request') return new URL(ex.url).searchParams.get(field) ?? special(field);
  return special(field);
}

/**
 * Resolve `$tag.field`: a field of the newest exchange with that tag. The
 * field is a JSONPath ($.order.po), a key name found anywhere in the JSON
 * (PO_number), header.Name, query.name, or @status @url @path @id @method
 * @body for the exchange itself (bare status, url... work when the JSON has
 * no such key).
 * Prefix with req. or res. to choose a side; otherwise the response is
 * tried first, then the request.
 */
export function tagValue(store: CaptureStore, ref: string): string {
  // Tags may contain dots, so try the longest tag that exists first.
  const raw = ref.trim().replace(/^\$/, '');
  const parts = raw.split('.');
  for (let cut = parts.length; cut >= 1; cut--) {
    const tag = parts.slice(0, cut).join('.');
    const ex = taggedExchange(store, tag);
    if (!ex) continue;
    let field = parts.slice(cut).join('.');
    // A JSONPath field keeps its own dots: "$tag.$.a.b" or "$tag.a.b".
    const full = store.getExchange(ex.id)!;
    if (!field) {
      const v = exchangeField(store, full, 'response', 'body');
      if (v === undefined) throw new TokenError(`the request tagged "${tag}" has no response body`);
      return v;
    }
    let sides: Array<'request' | 'response'> = ['response', 'request'];
    const sm = /^(req|request|res|response)\.(.+)$/.exec(field);
    if (sm) {
      sides = [sm[1]!.startsWith('req') ? 'request' : 'response'];
      field = sm[2]!;
    }
    for (const side of sides) {
      const v = exchangeField(store, full, side, field);
      if (v !== undefined) return v;
    }
    throw new TokenError(`no "${field}" in the request tagged "${tag}" (${full.method} ${full.path})`);
  }
  throw new TokenError(`no request is tagged "${parts[0]}"`);
}

// ---------- provenance ----------

export interface ValueOrigin {
  exchangeId: string;
  method: string;
  url: string;
  startedAt: number;
  where: 'json' | 'header' | 'body';
  /** JSONPath for json, header name for header. */
  at?: string;
}

/**
 * Where a value came from: the earliest response that contains it, before
 * `beforeId` when given. JSON fields with exactly that value win over a
 * plain text match.
 */
export function valueOrigin(store: CaptureStore, value: string, opts: { beforeId?: string; limit?: number } = {}): ValueOrigin[] {
  const v = value.trim();
  if (v.length < 2) return [];
  const before = opts.beforeId ? store.getSummary(opts.beforeId)?.startedAt : undefined;
  let rows: ExchangeSummary[];
  try {
    rows = store.search(`body:"${v.replace(/"/g, '')}"`, { limit: 400, order: 'oldest' });
  } catch {
    rows = [];
  }
  const headerRows = (() => {
    try {
      return store.search(`header:"${v.replace(/"/g, '')}"`, { limit: 100, order: 'oldest' });
    } catch {
      return [];
    }
  })();
  const seen = new Set<string>();
  const out: ValueOrigin[] = [];
  for (const e of [...rows, ...headerRows].sort((a, b) => a.startedAt - b.startedAt)) {
    if (seen.has(e.id) || e.id === opts.beforeId) continue;
    seen.add(e.id);
    if (before !== undefined && e.startedAt >= before) continue;
    const ex = store.getExchange(e.id);
    if (!ex) continue;
    const json = jsonOf(store, e.id, 'response');
    let hit: ValueOrigin | undefined;
    if (json !== undefined) {
      walkLeaves(json, (concrete, _n, _name, val) => {
        if (!hit && String(val) === v) hit = { exchangeId: e.id, method: e.method, url: e.url, startedAt: e.startedAt, where: 'json', at: concrete };
      });
    }
    if (!hit) {
      const h = ex.responseHeaders?.find(([, hv]) => hv.includes(v));
      if (h) hit = { exchangeId: e.id, method: e.method, url: e.url, startedAt: e.startedAt, where: 'header', at: h[0] };
    }
    if (!hit && json === undefined) {
      const b = store.getBody(e.id, 'response', true);
      if (b && looksLikeText(b) && new RegExp(`(^|[^\\w])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`).test(bytesToString(b))) hit = { exchangeId: e.id, method: e.method, url: e.url, startedAt: e.startedAt, where: 'body' };
    }
    if (hit) out.push(hit);
    if (out.length >= (opts.limit ?? 5)) break;
  }
  return out;
}
