import { bytesToString, looksLikeText } from '@siteinquisition/codecs';
import { parsePath, query as jsonQuery } from '@siteinquisition/codecs/jsonpath';
import { parseOperations } from './graphql.js';
import type { HeaderList } from './store.js';

/**
 * Precise conditions for rules, mocks and breakpoints. Each condition reads
 * values from one part of the exchange and tests them; a rule applies only
 * when every condition holds.
 *
 *   { in: 'query', name: 'id', value: '42' }               ?id=42
 *   { in: 'header', name: 'x-tenant', op: 'regex', value: '^acme' }
 *   { in: 'cookie', name: 'session', op: 'exists' }
 *   { in: 'json', name: '$.user.role', value: 'admin' }
 *   { in: 'graphql', value: 'GetUser' }                     operation name
 *   { in: 'graphql', name: 'type', value: 'mutation' }
 *   { in: 'path', op: 'glob', value: '/api/* /items' }
 *
 * When a part has several values (a repeated query parameter or header, a
 * JSONPath that finds several nodes, a batched GraphQL request) the
 * condition holds when any one of them passes. `not` turns the whole
 * condition around, so `{ not: true, op: 'equals' }` means none is equal.
 */
export type MatchSource = 'path' | 'query' | 'header' | 'cookie' | 'json' | 'graphql' | 'body';
export type MatchOp = 'equals' | 'contains' | 'prefix' | 'suffix' | 'glob' | 'regex' | 'exists' | 'absent' | 'gt' | 'gte' | 'lt' | 'lte';

export interface MatchCondition {
  in: MatchSource;
  /**
   * query, header, cookie: the parameter name (headers ignore case).
   * json: a JSONPath such as $.user.role.
   * graphql: "operation" (default, the operation name), "type" (query,
   * mutation or subscription), "field" (root fields) or "hash" (persisted query hash).
   */
  name?: string;
  /** Default "equals". */
  op?: MatchOp;
  value?: string;
  /** header, cookie, json, body: read the response instead of the request. Default: the message being matched. */
  side?: 'request' | 'response';
  ignoreCase?: boolean;
  not?: boolean;
}

export const MATCH_SOURCES: MatchSource[] = ['path', 'query', 'header', 'cookie', 'json', 'graphql', 'body'];
export const MATCH_OPS: MatchOp[] = ['equals', 'contains', 'prefix', 'suffix', 'glob', 'regex', 'exists', 'absent', 'gt', 'gte', 'lt', 'lte'];
const GRAPHQL_PARTS = ['operation', 'type', 'field', 'hash'];

/** What conditions are tested against. Missing headers or bodies are "not known yet" (see `lenient`). */
export interface MatchSubject {
  method: string;
  url: string;
  status?: number;
  /** Which message is being matched; picks the default side. */
  phase?: 'request' | 'response';
  request?: { headers?: HeaderList; body?: Uint8Array };
  response?: { headers?: HeaderList; body?: Uint8Array };
}

export interface MatchOptions {
  /**
   * Conditions on parts that are not known yet pass instead of failing.
   * Used to decide early whether a response may need buffering, before its
   * headers and body exist.
   */
  lenient?: boolean;
}

/** A glob where `*` matches any run of characters, or within one path segment when `segments` is set (then `**` crosses segments). */
export function matchGlob(glob: string, text: string, opts: { segments?: boolean; ignoreCase?: boolean } = {}): boolean {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (opts.segments && glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += opts.segments ? '[^/]*' : '.*';
    } else if (c === '?') re += opts.segments ? '[^/]' : '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, opts.ignoreCase ? 'is' : 's').test(text);
}

/** How a `path` condition compares: exact, glob (`*` one segment, `**` any), regex, or template (`/users/{id}`). */
export type PathMatch = 'exact' | 'glob' | 'regex' | 'template';

/** Whether a URL path passes a `path` + `pathMatch` condition. */
export function pathMatches(spec: string, mode: PathMatch | undefined, pathname: string): boolean {
  switch (mode ?? 'exact') {
    case 'glob':
      return matchGlob(spec, pathname, { segments: true });
    case 'regex':
      try {
        return toRegExp(spec).test(pathname);
      } catch {
        return false;
      }
    case 'template':
      return matchGlob(spec.replace(/\{[^}/]*\}/g, '*'), pathname, { segments: true });
    default:
      return pathname === spec;
  }
}

/** "/pattern/flags" or a bare pattern. */
export function toRegExp(spec: string, ignoreCase = false): RegExp {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(spec);
  const flags = (m ? m[2]! : '').replace(/[gy]/g, '');
  return new RegExp(m ? m[1]! : spec, ignoreCase && !flags.includes('i') ? flags + 'i' : flags);
}

const headerValues = (headers: HeaderList, name: string) => {
  const n = name.toLowerCase();
  return headers.filter(([k]) => k.toLowerCase() === n).map(([, v]) => v);
};

/** Cookie values by name: from Cookie headers on requests, Set-Cookie headers on responses. */
function cookieValues(headers: HeaderList, name: string, side: 'request' | 'response'): string[] {
  const out: string[] = [];
  if (side === 'request') {
    for (const h of headerValues(headers, 'cookie')) {
      for (const part of h.split(';')) {
        const eq = part.indexOf('=');
        const k = (eq === -1 ? part : part.slice(0, eq)).trim();
        if (k === name) out.push(eq === -1 ? '' : part.slice(eq + 1).trim());
      }
    }
  } else {
    for (const h of headerValues(headers, 'set-cookie')) {
      const first = h.split(';')[0] ?? '';
      const eq = first.indexOf('=');
      if (eq !== -1 && first.slice(0, eq).trim() === name) out.push(first.slice(eq + 1).trim());
    }
  }
  return out;
}

const textOf = (body: Uint8Array) => (body.length && looksLikeText(body) ? bytesToString(body) : '');

const parseJson = (body: Uint8Array): { ok: true; value: unknown } | { ok: false } => {
  const t = textOf(body).trim();
  if (!t || !/^[[{"\d\-tfn]/.test(t)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false };
  }
};

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');

type Raw = Record<string, unknown>;

/** GraphQL operations a request carries: JSON bodies (single or batched), GET parameters, or an application/graphql body. */
export function graphqlOperations(url: URL, headers: HeaderList, body: Uint8Array | undefined): Array<{ name: string | null; type: string; fields: string[]; hash?: string }> {
  const out: Array<{ name: string | null; type: string; fields: string[]; hash?: string }> = [];
  const add = (r: Raw) => {
    const opName = typeof r.operationName === 'string' && r.operationName ? r.operationName : null;
    const ext = typeof r.extensions === 'string' ? safeParse(r.extensions) : r.extensions;
    const hash = ((ext as Raw | undefined)?.persistedQuery as Raw | undefined)?.sha256Hash;
    const h = typeof hash === 'string' ? { hash } : {};
    const ops = typeof r.query === 'string' ? parseOperations(r.query) : [];
    if (!ops.length) {
      if (opName || h.hash) out.push({ name: opName, type: 'query', fields: [], ...h });
      return;
    }
    // A document may hold several operations; operationName picks the one that runs.
    const chosen = opName ? ops.filter((o) => o.name === opName) : ops.length === 1 ? ops : [];
    for (const o of chosen.length ? chosen : ops) out.push({ name: o.name ?? opName, type: o.kind, fields: o.rootFields, ...h });
  };
  const q = url.searchParams;
  if (q.has('query') || q.has('operationName') || q.has('extensions')) add(Object.fromEntries(q) as Raw);
  if (body?.length) {
    const ct = headerValues(headers, 'content-type')[0] ?? '';
    if (/application\/graphql(?![-+\w])/i.test(ct)) add({ query: textOf(body) });
    else {
      const j = parseJson(body);
      if (j.ok) for (const r of Array.isArray(j.value) ? j.value : [j.value]) if (r && typeof r === 'object') add(r as Raw);
    }
  }
  return out;
}

const safeParse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** The values a condition looks at, or null when that part is not known yet. */
function valuesFor(c: MatchCondition, s: MatchSubject, url: URL): string[] | null {
  const side = c.side ?? s.phase ?? 'request';
  const part = side === 'response' ? s.response : s.request;
  switch (c.in) {
    case 'path':
      return [url.pathname];
    case 'query':
      return c.name ? url.searchParams.getAll(c.name) : url.search ? [url.search.slice(1)] : [];
    case 'header':
      return part?.headers ? headerValues(part.headers, c.name ?? '') : null;
    case 'cookie':
      return part?.headers ? cookieValues(part.headers, c.name ?? '', side) : null;
    case 'body':
      return part?.body ? [textOf(part.body)] : null;
    case 'json': {
      if (!part?.body) return null;
      const j = parseJson(part.body);
      if (!j.ok) return [];
      return jsonQuery(j.value, c.name || '$').map((m) => show(m.value));
    }
    case 'graphql': {
      // The query string may carry the operation even before the body is known.
      const body = s.request?.body;
      const ops = graphqlOperations(url, s.request?.headers ?? [], body);
      if (!ops.length && !body) return null;
      const what = c.name || 'operation';
      if (what === 'type') return ops.map((o) => o.type);
      if (what === 'field') return ops.flatMap((o) => o.fields);
      if (what === 'hash') return ops.flatMap((o) => (o.hash ? [o.hash] : []));
      return ops.flatMap((o) => (o.name ? [o.name] : []));
    }
  }
}

function testValue(c: MatchCondition, actual: string): boolean {
  const want = c.value ?? '';
  const fold = (x: string) => (c.ignoreCase ? x.toLowerCase() : x);
  switch (c.op ?? 'equals') {
    case 'equals':
      return fold(actual) === fold(want);
    case 'contains':
      return fold(actual).includes(fold(want));
    case 'prefix':
      return fold(actual).startsWith(fold(want));
    case 'suffix':
      return fold(actual).endsWith(fold(want));
    case 'glob':
      return matchGlob(want, actual, { segments: c.in === 'path', ignoreCase: c.ignoreCase });
    case 'regex':
      try {
        return toRegExp(want, c.ignoreCase).test(actual);
      } catch {
        return false;
      }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(actual);
      const b = Number(want);
      if (actual.trim() === '' || !Number.isFinite(a) || !Number.isFinite(b)) return false;
      return c.op === 'gt' ? a > b : c.op === 'gte' ? a >= b : c.op === 'lt' ? a < b : a <= b;
    }
    default:
      return false;
  }
}

/** Whether one condition holds. */
export function conditionHolds(c: MatchCondition, s: MatchSubject, url: URL, opts: MatchOptions = {}): boolean {
  const values = valuesFor(c, s, url);
  if (values === null) return opts.lenient ? true : evaluate(c, []);
  return evaluate(c, values);
}

function evaluate(c: MatchCondition, values: string[]): boolean {
  const op = c.op ?? 'equals';
  const hit = op === 'exists' ? values.length > 0 : op === 'absent' ? values.length === 0 : values.some((v) => testValue(c, v));
  return c.not ? !hit : hit;
}

/** Check a condition list when it is saved, so mistakes show up in the editor rather than as rules that never match. */
export function normalizeMatchConditions(list: unknown): MatchCondition[] | undefined {
  if (list === undefined || list === null) return undefined;
  if (!Array.isArray(list)) throw new Error('"where" must be a list of conditions');
  const out: MatchCondition[] = [];
  for (const raw of list as MatchCondition[]) {
    if (!raw || typeof raw !== 'object') throw new Error('each condition must be an object');
    const c: MatchCondition = { in: raw.in };
    if (!MATCH_SOURCES.includes(raw.in)) throw new Error(`condition source must be one of ${MATCH_SOURCES.join(', ')}`);
    const op = raw.op ?? 'equals';
    if (!MATCH_OPS.includes(op)) throw new Error(`condition op must be one of ${MATCH_OPS.join(', ')}`);
    if (raw.op && raw.op !== 'equals') c.op = raw.op;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if ((raw.in === 'header' || raw.in === 'cookie') && !name) throw new Error(`a ${raw.in} condition needs a name`);
    if (raw.in === 'json' && name) parsePath(name);
    if (raw.in === 'graphql' && name && !GRAPHQL_PARTS.includes(name)) throw new Error(`a graphql condition reads ${GRAPHQL_PARTS.join(', ')}`);
    if (name) c.name = name;
    if (raw.value !== undefined && raw.value !== null) c.value = String(raw.value);
    if (op === 'regex') toRegExp(c.value ?? '');
    if (['gt', 'gte', 'lt', 'lte'].includes(op) && !Number.isFinite(Number(c.value ?? 'x'))) throw new Error(`"${op}" compares numbers; "${c.value ?? ''}" is not one`);
    if (raw.side !== undefined) {
      if (raw.side !== 'request' && raw.side !== 'response') throw new Error('condition side must be "request" or "response"');
      if (['header', 'cookie', 'json', 'body'].includes(raw.in)) c.side = raw.side;
    }
    if (raw.ignoreCase) c.ignoreCase = true;
    if (raw.not) c.not = true;
    out.push(c);
  }
  return out.length ? out : undefined;
}

/** One-line description, for lists and tooltips: `header x-tenant ~ /^acme/`. */
export function describeCondition(c: MatchCondition): string {
  const sym: Record<MatchOp, string> = { equals: '=', contains: 'contains', prefix: 'starts with', suffix: 'ends with', glob: 'like', regex: '~', exists: 'exists', absent: 'is absent', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  const op = c.op ?? 'equals';
  const what = [c.side === 'response' ? 'response' : '', c.in, c.name ?? (c.in === 'graphql' ? 'operation' : '')].filter(Boolean).join(' ');
  const val = op === 'exists' || op === 'absent' ? '' : ` ${JSON.stringify(c.value ?? '')}`;
  return `${c.not ? 'not ' : ''}${what} ${sym[op]}${val}${c.ignoreCase ? ' (any case)' : ''}`;
}
