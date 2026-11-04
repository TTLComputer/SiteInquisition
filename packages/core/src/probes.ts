import { bytesToString, looksLikeText } from '@siteinquisition/codecs';
import { pathTemplate } from './coverage.js';
import type { Sender } from './send.js';
import type { CaptureStore, Exchange, HeaderList } from './store.js';
import { jsonOf } from './values.js';

/**
 * Probes that send traffic to learn how an API behaves:
 *
 *  - auth matrix: replay requests as other identities (user B, no auth) and
 *    see who can reach what;
 *  - negative tests: send each request with broken fields (missing, null,
 *    wrong type, boundary numbers, long strings) and see what the server
 *    accepts or chokes on.
 */

// ---------- shared ----------

const AUTH_HEADER = /^(authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|x-session[\w-]*|proxy-authorization)$/i;

const SKIP = new Set(['content-length', 'host', 'connection', 'transfer-encoding']);

function original(store: CaptureStore, id: string): { ex: Exchange; body?: Uint8Array } {
  const ex = store.getExchange(id);
  if (!ex) throw new Error(`no exchange ${id}`);
  const body = store.getBody(id, 'request', false);
  return { ex, body: body?.length ? body : undefined };
}

/** How alike two response bodies are, 0..1: JSON leaves when both are JSON, else lines. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const leaves = (t: string): Set<string> | null => {
    try {
      const out = new Set<string>();
      const walk = (v: unknown, p: string) => {
        if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
        else out.add(`${p}=${JSON.stringify(v)}`);
      };
      walk(JSON.parse(t), '$');
      return out;
    } catch {
      return null;
    }
  };
  const sa = leaves(a) ?? new Set(a.split('\n'));
  const sb = leaves(b) ?? new Set(b.split('\n'));
  let same = 0;
  for (const x of sa) if (sb.has(x)) same++;
  return same / Math.max(1, sa.size + sb.size - same);
}

const bodyText = (store: CaptureStore, id: string) => {
  const b = store.getBody(id, 'response', true);
  return b && looksLikeText(b) ? bytesToString(b) : '';
};

// ---------- auth matrix ----------

export interface Identity {
  name: string;
  /** Headers to set; an empty value removes the header. Tokens such as {{flow:login-b.token}} work. */
  headers: HeaderList;
  /** Remove every auth header and cookie first (the "no auth" identity). */
  anonymous?: boolean;
}

export type AuthVerdict = 'same' | 'allowed' | 'denied' | 'not-found' | 'error' | 'other';

export interface AuthCell {
  identity: string;
  exchangeId?: string;
  status: number | null;
  size: number;
  similarity: number;
  verdict: AuthVerdict;
  error?: string;
}

export interface AuthRow {
  exchangeId: string;
  method: string;
  endpoint: string;
  url: string;
  status: number | null;
  cells: AuthCell[];
  /** An identity got the same successful answer as the original: possible broken access control. */
  flagged: boolean;
}

export function applyIdentity(headers: HeaderList, id: Identity): HeaderList {
  let out = headers.filter(([k]) => !SKIP.has(k.toLowerCase()));
  if (id.anonymous) out = out.filter(([k]) => !AUTH_HEADER.test(k));
  for (const [k, v] of id.headers) {
    out = out.filter(([x]) => x.toLowerCase() !== k.toLowerCase());
    if (v !== '') out.push([k, v]);
  }
  return out;
}

export function verdictFor(origStatus: number | null, status: number | null, sim: number): AuthVerdict {
  if (status === null) return 'error';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'not-found';
  if (status >= 200 && status < 300) return origStatus !== null && origStatus < 300 && sim >= 0.9 ? 'same' : 'allowed';
  return 'other';
}

export async function runAuthMatrix(store: CaptureStore, sender: Sender, opts: { exchangeIds: string[]; identities: Identity[]; ignoreTlsErrors?: boolean }): Promise<{ runId: string; rows: AuthRow[] }> {
  const runId = `${Date.now().toString(36)}`;
  const rows: AuthRow[] = [];
  for (const id of opts.exchangeIds.slice(0, 200)) {
    const { ex, body } = original(store, id);
    const origText = bodyText(store, id);
    const row: AuthRow = { exchangeId: id, method: ex.method, endpoint: pathTemplate(ex.path), url: ex.url, status: ex.status, cells: [], flagged: false };
    for (const who of opts.identities) {
      try {
        const res = await sender.send({ method: ex.method, url: ex.url, headers: applyIdentity(ex.requestHeaders, who), body, replayOf: id }, { ignoreTlsErrors: opts.ignoreTlsErrors });
        store.tagExchange(res.id, [...new Set([...(store.getSummary(res.id)?.tags ?? []), `authmatrix:${runId}`, `as:${who.name}`])]);
        const sim = similarity(origText, bodyText(store, res.id));
        const verdict = verdictFor(ex.status, res.status, sim);
        row.cells.push({ identity: who.name, exchangeId: res.id, status: res.status, size: res.resBodySize ?? 0, similarity: Math.round(sim * 100) / 100, verdict });
        if (verdict === 'same') row.flagged = true;
      } catch (e) {
        row.cells.push({ identity: who.name, status: null, size: 0, similarity: 0, verdict: 'error', error: (e as Error).message });
      }
    }
    rows.push(row);
  }
  return { runId, rows };
}

// ---------- negative tests ----------

export interface NegativeCase {
  name: string;
  /** Where the change was made: a JSONPath, "query.name", or "body". */
  target: string;
  url: string;
  headers: HeaderList;
  body?: string;
}

export interface NegativeResult extends NegativeCase {
  exchangeId?: string;
  status: number | null;
  error?: string;
  verdict: 'rejected' | 'accepted' | 'server-error' | 'failed';
  /** Response text excerpt, for error messages that leak internals. */
  excerpt: string;
}

type Json = unknown;
const LONG = 'A'.repeat(10_000);
const SPECIAL = `'"<>%00\\\${{7*7}}../‮`;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Set or delete at a concrete path (array of keys) inside a copy of `root`. */
function mutate(root: Json, keys: Array<string | number>, op: { del?: boolean; value?: Json }): Json {
  const copy = clone(root);
  let cur = copy as Record<string | number, Json>;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]!] as Record<string | number, Json>;
  const last = keys[keys.length - 1]!;
  if (op.del) {
    if (Array.isArray(cur)) cur.splice(Number(last), 1);
    else delete cur[last];
  } else cur[last] = op.value;
  return copy;
}

const pathText = (keys: Array<string | number>) => `$${keys.map((k) => (typeof k === 'number' ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `['${k}']`)).join('')}`;

/** Broken variants of a JSON value, field by field. */
export function jsonMutations(root: Json, schema?: Record<string, unknown>, max = 120): Array<{ name: string; target: string; value: Json }> {
  const out: Array<{ name: string; target: string; value: Json }> = [];
  const add = (name: string, keys: Array<string | number>, op: { del?: boolean; value?: Json }) => {
    if (out.length < max) out.push({ name, target: pathText(keys), value: mutate(root, keys, op) });
  };
  const enumAt = (keys: Array<string | number>): unknown[] | undefined => {
    let s: unknown = schema;
    for (const k of keys) {
      if (!s || typeof s !== 'object') return undefined;
      const o = s as Record<string, unknown>;
      s = typeof k === 'number' ? o.items : (o.properties as Record<string, unknown> | undefined)?.[k];
    }
    return s && typeof s === 'object' && Array.isArray((s as Record<string, unknown>).enum) ? ((s as Record<string, unknown>).enum as unknown[]) : undefined;
  };
  const walk = (v: Json, keys: Array<string | number>, depth: number) => {
    if (depth > 5 || out.length >= max) return;
    if (keys.length) {
      add('missing', keys, { del: true });
      add('null', keys, { value: null });
    }
    if (Array.isArray(v)) {
      if (keys.length) {
        add('empty list', keys, { value: [] });
        add('object instead of list', keys, { value: {} });
      }
      if (v.length) walk(v[0], [...keys, 0], depth + 1);
      return;
    }
    if (v && typeof v === 'object') {
      if (keys.length) add('list instead of object', keys, { value: [] });
      for (const [k, x] of Object.entries(v)) walk(x, [...keys, k], depth + 1);
      return;
    }
    if (!keys.length) return;
    if (typeof v === 'string') {
      add('number instead of text', keys, { value: 12345 });
      add('empty text', keys, { value: '' });
      add('10,000 characters', keys, { value: LONG });
      add('special characters', keys, { value: SPECIAL });
      const en = enumAt(keys);
      if (en) add('not one of the allowed values', keys, { value: `${String(en[0])}_INVALID` });
    } else if (typeof v === 'number') {
      add('text instead of number', keys, { value: 'abc' });
      add('negative', keys, { value: -1 });
      add('zero', keys, { value: 0 });
      add('above 32-bit', keys, { value: 2_147_483_648 });
      add('huge', keys, { value: 1e308 });
      if (Number.isInteger(v)) add('fraction', keys, { value: v + 0.5 });
    } else if (typeof v === 'boolean') {
      add('text instead of boolean', keys, { value: 'true' });
      add('number instead of boolean', keys, { value: 1 });
    }
  };
  walk(root, [], 0);
  return out;
}

/** The cases for one recorded request: JSON body fields, query parameters, and the body as a whole. */
export function negativeCases(store: CaptureStore, id: string, schema?: Record<string, unknown>, max = 150): NegativeCase[] {
  const { ex } = original(store, id);
  const headers = ex.requestHeaders.filter(([k]) => !SKIP.has(k.toLowerCase()));
  const cases: NegativeCase[] = [];
  const json = jsonOf(store, id, 'request');
  if (json !== undefined) {
    for (const m of jsonMutations(json, schema, max)) cases.push({ name: m.name, target: m.target, url: ex.url, headers, body: JSON.stringify(m.value) });
    cases.push({ name: 'empty object', target: 'body', url: ex.url, headers, body: '{}' });
    cases.push({ name: 'broken JSON', target: 'body', url: ex.url, headers, body: '{"' });
    cases.push({ name: 'JSON sent as text/plain', target: 'body', url: ex.url, headers: [...headers.filter(([k]) => k.toLowerCase() !== 'content-type'), ['Content-Type', 'text/plain']], body: JSON.stringify(json) });
  }
  const u = new URL(ex.url);
  for (const [k] of [...u.searchParams]) {
    const variant = (name: string, value: string | null) => {
      const v = new URL(ex.url);
      if (value === null) v.searchParams.delete(k);
      else v.searchParams.set(k, value);
      cases.push({ name, target: `query.${k}`, url: v.href, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
    };
    variant('missing', null);
    variant('empty', '');
    variant('10,000 characters', LONG);
    variant('special characters', SPECIAL);
    variant('negative number', '-1');
    variant('array syntax', '[]');
  }
  // Path ids: the next and previous numbers, and something that is not an id.
  const segs = u.pathname.split('/');
  segs.forEach((seg, i) => {
    if (!/^\d+$/.test(seg)) return;
    for (const [name, rep] of [
      ['id - 1', String(Number(seg) - 1)],
      ['id + 1', String(Number(seg) + 1)],
      ['id 0', '0'],
      ['id not a number', 'abc'],
    ] as const) {
      const v = new URL(ex.url);
      const parts = [...segs];
      parts[i] = rep;
      v.pathname = parts.join('/');
      cases.push({ name, target: `path[${i}]`, url: v.href, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
    }
  });
  return cases.slice(0, max);
}

export async function runNegative(store: CaptureStore, sender: Sender, id: string, opts: { schema?: Record<string, unknown>; max?: number; ignoreTlsErrors?: boolean } = {}): Promise<{ runId: string; baseline: number | null; results: NegativeResult[] }> {
  const { ex, body } = original(store, id);
  const runId = `${Date.now().toString(36)}`;
  const results: NegativeResult[] = [];
  const raw = body && looksLikeText(body) ? bytesToString(body) : undefined;
  for (const c of negativeCases(store, id, opts.schema, opts.max)) {
    try {
      // Tokens are off: the special-characters case contains {{ on purpose.
      const res = await sender.send({ method: ex.method, url: c.url, headers: c.headers, body: c.body !== undefined ? new TextEncoder().encode(c.body) : raw !== undefined ? new TextEncoder().encode(raw) : body, replayOf: id }, { tokens: false, ignoreTlsErrors: opts.ignoreTlsErrors });
      store.tagExchange(res.id, [...new Set([...(store.getSummary(res.id)?.tags ?? []), `negative:${runId}`, `case:${c.name}`])]);
      const st = res.status;
      results.push({ ...c, exchangeId: res.id, status: st, verdict: st === null ? 'failed' : st >= 500 ? 'server-error' : st >= 400 ? 'rejected' : 'accepted', excerpt: bodyText(store, res.id).slice(0, 300) });
    } catch (e) {
      results.push({ ...c, status: null, error: (e as Error).message, verdict: 'failed', excerpt: '' });
    }
  }
  return { runId, baseline: ex.status, results };
}
