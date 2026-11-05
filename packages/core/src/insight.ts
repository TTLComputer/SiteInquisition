import { bytesToString, looksLikeText } from '@siteinquisition/codecs';
import { coverage, pathTemplate } from './coverage.js';
import type { ApiSpec } from './specs.js';
import { specMatches } from './specs.js';
import type { CaptureStore, HeaderList } from './store.js';

/**
 * Reading aids built from recorded traffic: a JSON-aware diff of any two
 * exchanges, a create/read/update/delete map per resource, and a glossary of
 * every field name with the types, values and ranges seen.
 */

// ---------- diff ----------

export interface JsonChange {
  path: string;
  kind: 'added' | 'removed' | 'changed' | 'type';
  before?: unknown;
  after?: unknown;
}

const kp = (p: string, k: string | number) => (typeof k === 'number' ? `${p}[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `${p}.${k}` : `${p}['${k}']`);
const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

export function jsonDiff(a: unknown, b: unknown, path = '$', out: JsonChange[] = [], max = 500): JsonChange[] {
  if (out.length >= max) return out;
  if (kind(a) !== kind(b)) {
    out.push({ path, kind: 'type', before: a, after: b });
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) out.push({ path: kp(path, i), kind: 'added', after: b[i] });
      else if (i >= b.length) out.push({ path: kp(path, i), kind: 'removed', before: a[i] });
      else jsonDiff(a[i], b[i], kp(path, i), out, max);
    }
    return out;
  }
  if (a && b && typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      if (!(k in bo)) out.push({ path: kp(path, k), kind: 'removed', before: ao[k] });
      else if (!(k in ao)) out.push({ path: kp(path, k), kind: 'added', after: bo[k] });
      else jsonDiff(ao[k], bo[k], kp(path, k), out, max);
    }
    return out;
  }
  if (!Object.is(a, b)) out.push({ path, kind: 'changed', before: a, after: b });
  return out;
}

export interface HeaderChange {
  name: string;
  before?: string;
  after?: string;
}

export function headerDiff(a: HeaderList, b: HeaderList): HeaderChange[] {
  const ma = new Map<string, string>();
  const mb = new Map<string, string>();
  for (const [k, v] of a) ma.set(k.toLowerCase(), ma.has(k.toLowerCase()) ? `${ma.get(k.toLowerCase())}, ${v}` : v);
  for (const [k, v] of b) mb.set(k.toLowerCase(), mb.has(k.toLowerCase()) ? `${mb.get(k.toLowerCase())}, ${v}` : v);
  const out: HeaderChange[] = [];
  for (const k of [...new Set([...ma.keys(), ...mb.keys()])].sort()) if (ma.get(k) !== mb.get(k)) out.push({ name: k, before: ma.get(k), after: mb.get(k) });
  return out;
}

export interface SideDiff {
  headers: HeaderChange[];
  /** JSON changes when both bodies are JSON. */
  json: JsonChange[] | null;
  /** Both bodies as text, for a line diff when they are not JSON. */
  textA: string | null;
  textB: string | null;
}

export interface ExchangeDiff {
  a: { id: string; method: string; url: string; status: number | null };
  b: { id: string; method: string; url: string; status: number | null };
  request: SideDiff;
  response: SideDiff;
  urlChanged: boolean;
  /** Query parameters that differ. */
  query: HeaderChange[];
}

const textOf = (store: CaptureStore, id: string, side: 'request' | 'response'): string | null => {
  const b = store.getBody(id, side, true);
  if (!b?.length) return '';
  return looksLikeText(b) ? bytesToString(b).slice(0, 500_000) : null;
};

const parse = (t: string | null): unknown => {
  if (t === null) return undefined;
  const s = t.trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

export function diffExchanges(store: CaptureStore, aId: string, bId: string): ExchangeDiff {
  const a = store.getExchange(aId);
  const b = store.getExchange(bId);
  if (!a || !b) throw new Error('no such exchange');
  const side = (s: 'request' | 'response'): SideDiff => {
    const ta = textOf(store, aId, s);
    const tb = textOf(store, bId, s);
    const ja = parse(ta);
    const jb = parse(tb);
    const ha = (s === 'request' ? a.requestHeaders : a.responseHeaders) ?? [];
    const hb = (s === 'request' ? b.requestHeaders : b.responseHeaders) ?? [];
    return { headers: headerDiff(ha, hb), json: ja !== undefined && jb !== undefined ? jsonDiff(ja, jb) : null, textA: ta, textB: tb };
  };
  const qa = new URL(a.url).searchParams;
  const qb = new URL(b.url).searchParams;
  const query: HeaderChange[] = [];
  for (const k of new Set([...qa.keys(), ...qb.keys()])) if (qa.getAll(k).join(',') !== qb.getAll(k).join(',')) query.push({ name: k, before: qa.has(k) ? qa.getAll(k).join(',') : undefined, after: qb.has(k) ? qb.getAll(k).join(',') : undefined });
  const pick = (e: typeof a) => ({ id: e.id, method: e.method, url: e.url, status: e.status });
  return { a: pick(a), b: pick(b), request: side('request'), response: side('response'), urlChanged: a.url !== b.url || a.method !== b.method, query };
}

// ---------- resource lifecycle ----------

export type LifecycleOp = 'list' | 'create' | 'read' | 'replace' | 'update' | 'delete';

export interface LifecycleCell {
  op: LifecycleOp;
  method: string;
  template: string;
  seen: number;
  /** At least one 2xx/3xx. */
  succeeded: boolean;
  statuses: Record<string, number>;
  documented: boolean;
  exampleId?: string;
}

export interface Resource {
  /** Collection path, e.g. /api/orders or /api/cart/{n}/items. */
  collection: string;
  /** Item path, e.g. /api/orders/{ref}, when one was seen or documented. */
  item: string | null;
  cells: LifecycleCell[];
  /** Operations that were neither seen nor documented. */
  missing: LifecycleOp[];
}

const OPS: Array<{ op: LifecycleOp; method: string; on: 'collection' | 'item' }> = [
  { op: 'list', method: 'GET', on: 'collection' },
  { op: 'create', method: 'POST', on: 'collection' },
  { op: 'read', method: 'GET', on: 'item' },
  { op: 'replace', method: 'PUT', on: 'item' },
  { op: 'update', method: 'PATCH', on: 'item' },
  { op: 'delete', method: 'DELETE', on: 'item' },
];

const isParam = (seg: string) => /^\{[^}]+\}$/.test(seg);

export function lifecycle(store: CaptureStore, specs: ApiSpec[], host: string): Resource[] {
  const report = coverage(store, host);
  const relevant = specs.filter((s) => s.format !== 'graphql' && (!s.hosts.length || s.hosts.includes(host)));
  type Seen = { method: string; template: string; count: number; statuses: Record<string, number>; exampleId?: string; documented: boolean };
  const all: Seen[] = report.endpoints.map((e) => ({ method: e.method, template: e.template, count: e.count, statuses: e.statuses, exampleId: e.exampleId, documented: false }));
  for (const spec of relevant) {
    for (const ep of spec.endpoints) {
      const tpl = `${spec.basePath}${ep.path}`.replace(/\{[^}]+\}/g, '{id}');
      const hit = all.find((s) => s.method === ep.method && specMatches(spec, ep, s.method, s.template));
      if (hit) hit.documented = true;
      else all.push({ method: ep.method, template: tpl, count: 0, statuses: {}, documented: true });
    }
  }
  const norm = (t: string) => t.replace(/\{[^}]+\}/g, '{id}');
  const byCollection = new Map<string, { collection: string; item: string | null; seen: Seen[] }>();
  for (const s of all) {
    const segs = s.template.split('/');
    const last = segs[segs.length - 1] ?? '';
    const isItem = isParam(last);
    const collection = isItem ? segs.slice(0, -1).join('/') || '/' : s.template;
    const key = norm(collection);
    let r = byCollection.get(key);
    if (!r) byCollection.set(key, (r = { collection, item: null, seen: [] }));
    if (isItem) r.item ??= s.template;
    r.seen.push(s);
  }
  const out: Resource[] = [];
  for (const r of byCollection.values()) {
    // Only things that look like resources: an item path, or something besides a single GET.
    if (!r.item && !r.seen.some((s) => s.method !== 'GET')) continue;
    const cells: LifecycleCell[] = [];
    const missing: LifecycleOp[] = [];
    for (const o of OPS) {
      if (o.on === 'item' && !r.item) {
        missing.push(o.op);
        continue;
      }
      const target = o.on === 'item' ? norm(r.item!) : norm(r.collection);
      const s = r.seen.find((x) => x.method === o.method && norm(x.template) === target);
      if (!s) {
        missing.push(o.op);
        continue;
      }
      cells.push({ op: o.op, method: o.method, template: s.template, seen: s.count, succeeded: Object.keys(s.statuses).some((k) => /^[23]/.test(k)), statuses: s.statuses, documented: s.documented, exampleId: s.exampleId });
    }
    if (cells.length) out.push({ collection: r.collection, item: r.item, cells, missing });
  }
  return out.sort((a, b) => a.collection.localeCompare(b.collection));
}

// ---------- field glossary ----------

export interface GlossaryEntry {
  name: string;
  types: string[];
  nullable: boolean;
  count: number;
  distinct: number;
  /** Distinct values when there are few of them (an enum in all but name). */
  values?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  /** Where it appears: "GET /api/orders/{ref} $.status". */
  seenIn: string[];
  /** The same places with the exchanges that carried the field, newest first (up to 20 each). */
  sources: GlossarySource[];
}

export interface GlossarySource {
  /** "GET /api/orders/{ref} $.status", as in seenIn. */
  where: string;
  /** Exchanges this field was seen in at that place, newest first. */
  exchangeIds: string[];
  /** How many exchanges in all, when there were more than exchangeIds holds. */
  count: number;
}

const FORMAT_TESTS: Array<[string, RegExp]> = [
  ['date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/],
  ['date', /^\d{4}-\d{2}-\d{2}$/],
  ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ['email', /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i],
  ['url', /^https?:\/\//],
  ['currency amount', /^\d+\.\d{2}$/],
];

export function glossary(store: CaptureStore, opts: { host?: string; limit?: number } = {}): GlossaryEntry[] {
  const rows = store.search(opts.host ? `host:${opts.host}` : '', { limit: opts.limit ?? 1500 });
  type Acc = GlossaryEntry & { set: Set<string>; strings: string[]; srcMap: Map<string, GlossarySource> };
  const map = new Map<string, Acc>();
  for (const e of rows) {
    if (e.isWebSocket || !e.resBodySize) continue;
    const json = parse(textOf(store, e.id, 'response'));
    if (json === undefined) continue;
    const where = `${e.method} ${pathTemplate(e.path)}`;
    let n = 0;
    const walk = (v: unknown, name: string, path: string, depth: number) => {
      if (depth > 10 || n++ > 4000) return;
      if (Array.isArray(v)) return v.slice(0, 100).forEach((x) => walk(x, name, `${path}[*]`, depth + 1));
      if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, k, kp(path, k), depth + 1);
        return;
      }
      if (!name) return;
      let a = map.get(name);
      if (!a) map.set(name, (a = { name, types: [], nullable: false, count: 0, distinct: 0, seenIn: [], sources: [], set: new Set(), strings: [], srcMap: new Map() }));
      a.count++;
      const t = v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v;
      if (t === 'null') a.nullable = true;
      else if (!a.types.includes(t)) a.types.push(t);
      const loc = `${where} ${path}`;
      if (a.seenIn.length < 12 && !a.seenIn.includes(loc)) a.seenIn.push(loc);
      let src = a.srcMap.get(loc);
      if (!src && a.srcMap.size < 50) a.srcMap.set(loc, (src = { where: loc, exchangeIds: [], count: 0 }));
      if (src && src.exchangeIds[src.exchangeIds.length - 1] !== e.id) {
        src.count++;
        if (src.exchangeIds.length < 20) src.exchangeIds.push(e.id);
      }
      if (v === null) return;
      const s = String(v);
      if (a.set.size < 200) a.set.add(s);
      if (typeof v === 'number') {
        a.min = a.min === undefined ? v : Math.min(a.min, v);
        a.max = a.max === undefined ? v : Math.max(a.max, v);
      } else if (typeof v === 'string') {
        a.minLength = a.minLength === undefined ? s.length : Math.min(a.minLength, s.length);
        a.maxLength = a.maxLength === undefined ? s.length : Math.max(a.maxLength, s.length);
        if (a.strings.length < 50) a.strings.push(s);
      }
    };
    walk(json, '', '$', 0);
  }
  const out: GlossaryEntry[] = [];
  for (const { set, strings, srcMap, ...g } of map.values()) {
    g.distinct = set.size;
    g.sources = [...srcMap.values()];
    if (g.types.length === 1 && g.types[0] === 'string' && set.size <= 8 && g.count >= 3 && set.size < g.count) g.values = [...set];
    if (g.types.length === 1 && g.types[0] === 'boolean') g.values = [...set];
    if (strings.length) g.format = FORMAT_TESTS.find(([, re]) => strings.every((x) => re.test(x)))?.[0];
    out.push(g);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
