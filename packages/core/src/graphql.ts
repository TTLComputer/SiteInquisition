import { bytesToString, looksLikeText } from '@siteinquisition/codecs';
import { newId } from './ids.js';
import type { Sender } from './send.js';
import type { ApiSpec, SpecEndpoint } from './specs.js';
import type { CaptureStore, HeaderList } from './store.js';
import { jsonOf } from './values.js';

/**
 * GraphQL schema discovery, in order of preference:
 *
 *  1. Introspection (__schema), against the server under test or against
 *     another one (a beta server with introspection on) whose schema is then
 *     used to test pre-prod.
 *  2. Field suggestions: servers that answer a misspelt field with
 *     "Did you mean ...?" give their schema away a few names at a time.
 *  3. Operations the app itself sent (recorded request bodies) and query
 *     text in its JavaScript bundles, plus persisted-query hashes.
 *
 * Whatever is found becomes an ApiSpec of format "graphql": one endpoint per
 * root field, with a ready-made query.
 */
export interface GqlTypeRef {
  kind: string;
  name: string | null;
  ofType?: GqlTypeRef | null;
}
export interface GqlField {
  name: string;
  args: Array<{ name: string; type: string }>;
  type: string;
}
export interface GqlType {
  name: string;
  kind: string;
  fields?: GqlField[];
  inputFields?: GqlField[];
  enumValues?: string[];
}
export interface GqlSchema {
  queryType: string | null;
  mutationType: string | null;
  subscriptionType: string | null;
  types: Record<string, GqlType>;
  /** "introspection", "suggestions", "traffic". */
  source: string;
}

export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name } mutationType { name } subscriptionType { name }
    types {
      kind name
      fields(includeDeprecated: true) { name args { name type { ...TypeRef } } type { ...TypeRef } }
      inputFields { name type { ...TypeRef } }
      enumValues(includeDeprecated: true) { name }
    }
  }
}
fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }`;

export function typeString(t: GqlTypeRef | null | undefined): string {
  if (!t) return 'Unknown';
  if (t.kind === 'NON_NULL') return `${typeString(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${typeString(t.ofType)}]`;
  return t.name ?? 'Unknown';
}

const baseName = (t: string) => t.replace(/[[\]!]/g, '');

type Raw = Record<string, unknown>;

/** Turn an introspection result ({data:{__schema}} or {__schema}) into a compact schema. */
export function readIntrospection(result: unknown): GqlSchema {
  const r = result as Raw;
  const schema = ((r?.data as Raw | undefined)?.__schema ?? r?.__schema) as Raw | undefined;
  if (!schema) {
    const errs = (r?.errors as Array<{ message?: string }> | undefined)?.map((e) => e.message).join('; ');
    throw new Error(errs ? `introspection refused: ${errs}` : 'no __schema in the response');
  }
  const types: Record<string, GqlType> = {};
  for (const t of (schema.types as Raw[]) ?? []) {
    const name = String(t.name);
    if (name.startsWith('__')) continue;
    const fields = (list: unknown) =>
      Array.isArray(list) ? (list as Raw[]).map((f) => ({ name: String(f.name), type: typeString(f.type as GqlTypeRef), args: ((f.args as Raw[]) ?? []).map((a) => ({ name: String(a.name), type: typeString(a.type as GqlTypeRef) })) })) : undefined;
    types[name] = {
      name,
      kind: String(t.kind),
      fields: fields(t.fields),
      inputFields: fields(t.inputFields),
      enumValues: Array.isArray(t.enumValues) ? (t.enumValues as Raw[]).map((e) => String(e.name)) : undefined,
    };
  }
  const n = (k: string) => ((schema[k] as Raw | null)?.name as string | undefined) ?? null;
  return { queryType: n('queryType'), mutationType: n('mutationType'), subscriptionType: n('subscriptionType'), types, source: 'introspection' };
}

const SCALAR_EXAMPLE: Record<string, unknown> = { ID: '1', String: 'string', Int: 1, Float: 1.5, Boolean: true };

function exampleArg(schema: GqlSchema, type: string, depth = 0): unknown {
  const list = type.replace(/!$/, '').startsWith('[');
  const name = baseName(type);
  let v: unknown = SCALAR_EXAMPLE[name];
  const t = schema.types[name];
  if (v === undefined && t?.kind === 'ENUM') v = t.enumValues?.[0] ?? 'VALUE';
  if (v === undefined && t?.kind === 'INPUT_OBJECT' && depth < 4) v = Object.fromEntries((t.inputFields ?? []).filter((f) => f.type.endsWith('!') || depth === 0).map((f) => [f.name, exampleArg(schema, f.type, depth + 1)]));
  if (v === undefined) v = 'string';
  return list ? [v] : v;
}

/** A selection set: scalar fields, and objects to `depth` levels. */
export function selection(schema: GqlSchema, type: string, depth = 2, indent = '  '): string {
  const t = schema.types[baseName(type)];
  if (!t?.fields?.length) return '';
  const lines: string[] = [];
  for (const f of t.fields) {
    const ft = schema.types[baseName(f.type)];
    const leaf = !ft || ft.kind === 'SCALAR' || ft.kind === 'ENUM';
    if (f.args.some((a) => a.type.endsWith('!'))) continue;
    if (leaf) lines.push(`${indent}${f.name}`);
    else if (depth > 1) {
      const sub = selection(schema, f.type, depth - 1, `${indent}  `);
      if (sub) lines.push(`${indent}${f.name} {\n${sub}\n${indent}}`);
    }
    if (lines.length >= 40) break;
  }
  if (!lines.length && t.kind !== 'SCALAR') lines.push(`${indent}__typename`);
  return lines.join('\n');
}

/** A runnable document for one root field, with variables for its arguments. */
export function buildOperation(schema: GqlSchema, kind: 'query' | 'mutation' | 'subscription', field: GqlField, depth = 2): { query: string; variables: Record<string, unknown>; operationName: string } {
  const opName = field.name.charAt(0).toUpperCase() + field.name.slice(1);
  const vars = field.args.map((a) => `$${a.name}: ${a.type}`).join(', ');
  const args = field.args.map((a) => `${a.name}: $${a.name}`).join(', ');
  const sel = selection(schema, field.type, depth, '    ');
  const query = `${kind} ${opName}${vars ? `(${vars})` : ''} {\n  ${field.name}${args ? `(${args})` : ''}${sel ? ` {\n${sel}\n  }` : ''}\n}`;
  const variables = Object.fromEntries(field.args.map((a) => [a.name, exampleArg(schema, a.type)]));
  return { query, variables, operationName: opName };
}

/** An ApiSpec for a GraphQL endpoint; `targetUrl` is where requests go (it may differ from where the schema came from). */
export function schemaToSpec(schema: GqlSchema, opts: { targetUrl: string; name?: string; schemaFrom?: string }): ApiSpec & { graphqlSchema: GqlSchema } {
  const u = new URL(opts.targetUrl);
  const endpoints: SpecEndpoint[] = [];
  for (const [kind, root] of [
    ['query', schema.queryType],
    ['mutation', schema.mutationType],
    ['subscription', schema.subscriptionType],
  ] as const) {
    if (!root) continue;
    for (const f of schema.types[root]?.fields ?? []) {
      const op = buildOperation(schema, kind, f);
      endpoints.push({
        key: `${kind.toUpperCase()} ${f.name}`,
        method: 'POST',
        path: u.pathname,
        summary: `${kind} ${f.name}(${f.args.map((a) => `${a.name}: ${a.type}`).join(', ')}): ${f.type}`,
        tags: [kind],
        params: [],
        requestBody: { contentType: 'application/json', example: JSON.stringify({ query: op.query, variables: op.variables, operationName: op.operationName }, null, 2), required: true },
        responses: ['200'],
        security: [],
        graphql: { kind, field: f.name, args: f.args, returns: f.type },
        draft: { url: opts.targetUrl, headers: [['Content-Type', 'application/json']], body: JSON.stringify({ query: op.query, variables: op.variables, operationName: op.operationName }, null, 2) },
      });
    }
  }
  return {
    id: newId(),
    name: opts.name ?? `GraphQL ${u.host}${u.pathname}`,
    format: 'graphql',
    servers: [opts.targetUrl],
    hosts: [u.hostname],
    basePath: '',
    securitySchemes: {},
    endpoints,
    importedAt: Date.now(),
    warnings: opts.schemaFrom && opts.schemaFrom !== opts.targetUrl ? [`schema from ${opts.schemaFrom}, requests go to ${opts.targetUrl}`] : [],
    graphqlSchema: schema,
  };
}

async function post(sender: Sender, store: CaptureStore, url: string, headers: HeaderList, body: unknown, tag: string, ignoreTlsErrors?: boolean): Promise<{ id: string; json: unknown }> {
  const h: HeaderList = [...headers.filter(([k]) => k.toLowerCase() !== 'content-type'), ['Content-Type', 'application/json']];
  const res = await sender.send({ method: 'POST', url, headers: h, body: new TextEncoder().encode(JSON.stringify(body)) }, { ignoreTlsErrors });
  store.tagExchange(res.id, [...new Set([...(store.getSummary(res.id)?.tags ?? []), tag])]);
  return { id: res.id, json: jsonOf(store, res.id, 'response') };
}

export async function introspect(sender: Sender, store: CaptureStore, opts: { url: string; headers?: HeaderList; ignoreTlsErrors?: boolean }): Promise<{ schema: GqlSchema; exchangeId: string }> {
  const r = await post(sender, store, opts.url, opts.headers ?? [], { query: INTROSPECTION_QUERY, operationName: 'IntrospectionQuery' }, 'graphql:introspection', opts.ignoreTlsErrors);
  if (r.json === undefined) throw new Error('the introspection response is not JSON');
  return { schema: readIntrospection(r.json), exchangeId: r.id };
}

// ---------- field suggestions ----------

export const PROBE_WORDS = [
  'user', 'users', 'me', 'viewer', 'account', 'accounts', 'order', 'orders', 'product', 'products', 'item', 'items', 'cart', 'carts', 'customer', 'customers',
  'invoice', 'invoices', 'payment', 'payments', 'node', 'nodes', 'search', 'login', 'logout', 'register', 'createUser', 'updateUser', 'deleteUser', 'createOrder',
  'updateOrder', 'deleteOrder', 'admin', 'settings', 'config', 'session', 'token', 'refreshToken', 'file', 'files', 'upload', 'post', 'posts', 'comment', 'comments',
  'id', 'name', 'email', 'status', 'total', 'price', 'createdAt', 'updatedAt', 'role', 'roles', 'permissions', 'password', 'address', 'phone',
];

/** "Did you mean "a", "b" or "c"?" → ["a", "b", "c"] */
export function suggestionsIn(message: string): string[] {
  const m = /Did you mean (.+?)\?/.exec(message);
  if (!m) return [];
  return [...m[1]!.matchAll(/["“]([_A-Za-z][_0-9A-Za-z]*)["”]/g)].map((x) => x[1]!);
}

/**
 * Rebuild root fields (and one level below them) from error suggestions.
 * Each probe sends a query with misspelt names; nothing is created.
 */
export async function probeSuggestions(sender: Sender, store: CaptureStore, opts: { url: string; headers?: HeaderList; words?: string[]; maxRequests?: number; ignoreTlsErrors?: boolean }): Promise<{ schema: GqlSchema; requests: number; suggestionsWork: boolean }> {
  const words = opts.words ?? PROBE_WORDS;
  const max = opts.maxRequests ?? 60;
  let requests = 0;
  const found: Record<'Query' | 'Mutation', Set<string>> = { Query: new Set(), Mutation: new Set() };
  const valid = (msg: string, root: string) => {
    // "Cannot query field "x" on type "Query"" means x is not a field; any other error about x means it is.
    const m = /Cannot query field ["“](\w+)["”] on type ["“](\w+)["”]/.exec(msg);
    return m && m[2] === root ? { bad: m[1]! } : null;
  };
  const errorsOf = (json: unknown) => ((json as Raw | undefined)?.errors as Array<{ message?: string }> | undefined)?.map((e) => String(e.message ?? '')) ?? [];
  let suggestionsWork = false;
  for (const root of ['Query', 'Mutation'] as const) {
    const kw = root === 'Query' ? 'query' : 'mutation';
    for (let i = 0; i < words.length && requests < max; i += 8) {
      const batch = words.slice(i, i + 8);
      // Misspell on purpose (an extra "x") so suggestions come back.
      const doc = `${kw} { ${batch.map((w) => `${w}x: ${w}x`).join(' ')} }`;
      const r = await post(sender, store, opts.url, opts.headers ?? [], { query: doc }, 'graphql:probe', opts.ignoreTlsErrors);
      requests++;
      for (const msg of errorsOf(r.json)) {
        if (!valid(msg, root)) continue;
        const s = suggestionsIn(msg);
        if (s.length) suggestionsWork = true;
        for (const x of s) found[root].add(x);
      }
    }
    if (!suggestionsWork && root === 'Query') break;
  }
  // One level down for each query field: what does it return?
  const types: Record<string, GqlType> = {};
  const rootFields: Record<'Query' | 'Mutation', GqlField[]> = { Query: [], Mutation: [] };
  for (const root of ['Query', 'Mutation'] as const) {
    for (const f of found[root]) {
      let sub: string[] = [];
      let retType = 'Unknown';
      if (root === 'Query' && requests < max) {
        const r = await post(sender, store, opts.url, opts.headers ?? [], { query: `query { ${f} { ${words.slice(40).map((w) => `${w}x`).join(' ')} } }` }, 'graphql:probe', opts.ignoreTlsErrors);
        requests++;
        for (const msg of errorsOf(r.json)) {
          const m = /Cannot query field ["“]\w+["”] on type ["“](\w+)["”]/.exec(msg);
          if (m) retType = m[1]!;
          sub = [...new Set([...sub, ...suggestionsIn(msg)])];
        }
        if (retType !== 'Unknown') types[retType] = { name: retType, kind: 'OBJECT', fields: sub.map((s) => ({ name: s, type: 'String', args: [] })) };
      }
      rootFields[root].push({ name: f, type: retType, args: [] });
    }
  }
  types.Query = { name: 'Query', kind: 'OBJECT', fields: rootFields.Query };
  if (rootFields.Mutation.length) types.Mutation = { name: 'Mutation', kind: 'OBJECT', fields: rootFields.Mutation };
  for (const s of ['ID', 'String', 'Int', 'Float', 'Boolean']) types[s] = { name: s, kind: 'SCALAR' };
  return { schema: { queryType: 'Query', mutationType: rootFields.Mutation.length ? 'Mutation' : null, subscriptionType: null, types, source: 'suggestions' }, requests, suggestionsWork };
}

// ---------- traffic and bundles ----------

export interface SeenOperation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  rootFields: string[];
  document?: string;
  /** Persisted query hash, when the app sends hashes instead of text. */
  hash?: string;
  count: number;
  exampleId: string;
  /** "request" (sent by the app) or "bundle" (found in a script). */
  from: 'request' | 'bundle';
  url: string;
}

/** Root fields of a GraphQL document (first selection level of each operation). */
export function parseOperations(doc: string): Array<{ kind: SeenOperation['kind']; name: string | null; rootFields: string[] }> {
  const out: Array<{ kind: SeenOperation['kind']; name: string | null; rootFields: string[] }> = [];
  const src = doc.replace(/#[^\n]*/g, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const re = /\b(query|mutation|subscription)\b\s*([_A-Za-z]\w*)?\s*(\([^)]*\))?\s*(@\w+\s*)*\{|^\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const fields: string[] = [];
    let token = '';
    let parens = 0;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i]!;
      if (depth === 1 && parens === 0 && /\w/.test(c)) {
        token += c;
        continue;
      }
      if (token && depth === 1 && parens === 0 && !/^(on|fragment)$/.test(token)) {
        // "alias: field" keeps the field
        if (!src.slice(i).trimStart().startsWith(':')) fields.push(token);
      }
      token = '';
      if (c === '(') parens++;
      else if (c === ')') parens--;
      else if (parens === 0 && c === '{') depth++;
      else if (parens === 0 && c === '}') depth--;
    }
    out.push({ kind: (m[1] as SeenOperation['kind']) ?? 'query', name: m[2] ?? null, rootFields: [...new Set(fields.filter((f) => !f.startsWith('__')))] });
    re.lastIndex = i;
  }
  return out;
}

/** Operations the app sent to `url` (or any path containing "graphql"), and query text in its scripts. */
export function harvestOperations(store: CaptureStore, opts: { host?: string; limit?: number } = {}): SeenOperation[] {
  const map = new Map<string, SeenOperation>();
  const add = (o: Omit<SeenOperation, 'count'>) => {
    const key = `${o.from} ${o.hash ?? `${o.kind} ${o.name ?? ''} ${o.rootFields.join(',')}`}`;
    const cur = map.get(key);
    if (cur) cur.count++;
    else map.set(key, { ...o, count: 1 });
  };
  const rows = store.search(opts.host ? `host:${opts.host}` : '', { limit: opts.limit ?? 3000 });
  for (const e of rows) {
    if (e.tags.some((t) => t.startsWith('graphql:'))) continue;
    if (e.reqBodySize || e.path.includes('query=')) {
      let bodies: unknown[] = [];
      const json = jsonOf(store, e.id, 'request');
      if (json !== undefined) bodies = Array.isArray(json) ? json : [json];
      else if (e.method === 'GET') {
        const q = new URL(e.url).searchParams;
        if (q.get('query') || q.get('extensions')) {
          let ext: unknown;
          try {
            ext = q.get('extensions') ? JSON.parse(q.get('extensions')!) : undefined;
          } catch {
            ext = undefined;
          }
          bodies = [{ query: q.get('query') ?? undefined, operationName: q.get('operationName') ?? undefined, extensions: ext }];
        }
      }
      for (const b of bodies) {
        const r = b as Raw | undefined;
        if (!r || typeof r !== 'object') continue;
        const hash = ((r.extensions as Raw | undefined)?.persistedQuery as Raw | undefined)?.sha256Hash;
        if (typeof r.query === 'string') {
          for (const op of parseOperations(r.query)) add({ ...op, name: op.name ?? (typeof r.operationName === 'string' ? r.operationName : null), document: r.query.slice(0, 20_000), exampleId: e.id, from: 'request', url: e.url.split('?')[0]!, ...(typeof hash === 'string' ? { hash } : {}) });
        } else if (typeof hash === 'string') {
          add({ kind: 'query', name: typeof r.operationName === 'string' ? r.operationName : null, rootFields: [], hash, exampleId: e.id, from: 'request', url: e.url.split('?')[0]! });
        }
      }
    }
    const ct = store.getExchange(e.id)?.responseHeaders?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    if (/javascript/i.test(ct) && (e.resBodySize ?? 0) < 5_000_000) {
      const b = store.getBody(e.id, 'response', true);
      if (!b || !looksLikeText(b)) continue;
      const text = bytesToString(b);
      // gql`...` templates and string literals that start an operation.
      for (const m of text.matchAll(/(?:gql|graphql)\s*`([^`]{10,20000})`|["'`]\s*((?:query|mutation|subscription)\s+\w+[^"'`]{5,20000})["'`]/g)) {
        const doc = (m[1] ?? m[2] ?? '').replace(/\\n/g, '\n');
        for (const op of parseOperations(doc)) if (op.rootFields.length) add({ ...op, document: doc.slice(0, 20_000), exampleId: e.id, from: 'bundle', url: e.url });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** A minimal schema from harvested operations: root fields only. */
export function schemaFromOperations(ops: SeenOperation[]): GqlSchema {
  const q = new Set<string>();
  const mu = new Set<string>();
  for (const o of ops) for (const f of o.rootFields) (o.kind === 'mutation' ? mu : q).add(f);
  const types: Record<string, GqlType> = { Query: { name: 'Query', kind: 'OBJECT', fields: [...q].map((name) => ({ name, type: 'Unknown', args: [] })) } };
  if (mu.size) types.Mutation = { name: 'Mutation', kind: 'OBJECT', fields: [...mu].map((name) => ({ name, type: 'Unknown', args: [] })) };
  return { queryType: 'Query', mutationType: mu.size ? 'Mutation' : null, subscriptionType: null, types, source: 'traffic' };
}

/**
 * Where the server under test disagrees with a schema taken from elsewhere:
 * fields it refuses ("Cannot query field") in recorded responses to its
 * GraphQL URL.
 */
export function schemaDrift(store: CaptureStore, targetUrl: string): Array<{ field: string; type: string; count: number; exampleId: string }> {
  const u = new URL(targetUrl);
  const out = new Map<string, { field: string; type: string; count: number; exampleId: string }>();
  for (const e of store.search(`host:${u.hostname} path:${u.pathname}`, { limit: 2000 })) {
    if (e.tags.includes('graphql:probe')) continue;
    const json = jsonOf(store, e.id, 'response') as Raw | undefined;
    for (const err of (json?.errors as Array<{ message?: string }> | undefined) ?? []) {
      const m = /Cannot query field ["“](\w+)["”] on type ["“](\w+)["”]/.exec(String(err.message ?? ''));
      if (!m) continue;
      const key = `${m[2]}.${m[1]}`;
      const cur = out.get(key);
      if (cur) cur.count++;
      else out.set(key, { field: m[1]!, type: m[2]!, count: 1, exampleId: e.id });
    }
  }
  return [...out.values()];
}
