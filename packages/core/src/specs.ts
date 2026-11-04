import { bytesToString, looksLikeText } from '@siteinquisition/codecs';
import { coverage, pathTemplate, type CoverageReport } from './coverage.js';
import { newId } from './ids.js';
import type { CaptureStore, HeaderList } from './store.js';
import { parseJsonOrYaml } from './yaml.js';

/**
 * API descriptions: OpenAPI 3.x, Swagger 2.0 and Postman v2.1 collections are
 * read into one simple model of endpoints, so they can be compared with what
 * was actually seen, opened as ready-to-send requests, and filled with values
 * from recorded traffic. HAR files go into History instead (see importHar).
 */
export type SpecFormat = 'openapi3' | 'swagger2' | 'postman';

export interface SpecParam {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  type?: string;
  example?: string;
  description?: string;
}

export interface SpecEndpoint {
  /** Stable within a spec: "GET /pets/{petId}". */
  key: string;
  method: string;
  /** Path as written in the spec, with {name} parameters. */
  path: string;
  summary?: string;
  operationId?: string;
  tags: string[];
  params: SpecParam[];
  requestBody?: { contentType: string; example: string; required: boolean };
  /** Status codes the spec lists. */
  responses: string[];
  /** Security scheme names, or "none" when the operation opts out. */
  security: string[];
  deprecated?: boolean;
  /** Postman requests are complete already: headers and body as written. */
  draft?: { url: string; headers: HeaderList; body?: string };
}

export interface ApiSpec {
  id: string;
  name: string;
  format: SpecFormat;
  version?: string;
  /** Base URLs from servers / host+basePath. */
  servers: string[];
  /** Hosts the spec applies to (from servers); empty means any host. */
  hosts: string[];
  /** Path prefix that endpoints sit under on the server (basePath or a server URL's path). */
  basePath: string;
  securitySchemes: Record<string, { type: string; name?: string; in?: string; scheme?: string }>;
  endpoints: SpecEndpoint[];
  importedAt: number;
  warnings: string[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Follow a local "#/a/b" reference. */
function deref(root: Obj, v: unknown, seen = new Set<string>()): unknown {
  if (!isObj(v) || typeof v.$ref !== 'string') return v;
  const ref = v.$ref;
  if (!ref.startsWith('#/') || seen.has(ref)) return {};
  seen.add(ref);
  let cur: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    const k = part.replace(/~1/g, '/').replace(/~0/g, '~');
    cur = isObj(cur) ? cur[k] : undefined;
  }
  return deref(root, cur ?? {}, seen);
}

/** A sample value for a JSON schema: example, default, first enum, then a typed placeholder. */
export function exampleFor(root: Obj, schema: unknown, depth = 0, seen = new Set<string>()): unknown {
  if (depth > 8) return null;
  if (isObj(schema) && typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return {};
    const next = new Set(seen).add(schema.$ref);
    return exampleFor(root, deref(root, schema), depth + 1, next);
  }
  if (!isObj(schema)) return null;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((s) => exampleFor(root, s, depth + 1, seen));
    if (parts.every(isObj)) return Object.assign({}, ...parts);
    return parts[0] ?? null;
  }
  for (const k of ['oneOf', 'anyOf'] as const) if (Array.isArray(schema[k]) && schema[k].length) return exampleFor(root, schema[k][0], depth + 1, seen);
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') ?? type[0];
  if (!type) type = isObj(schema.properties) ? 'object' : schema.items ? 'array' : undefined;
  switch (type) {
    case 'object': {
      const out: Obj = {};
      const props = isObj(schema.properties) ? schema.properties : {};
      for (const [k, v] of Object.entries(props)) {
        const p = deref(root, v);
        if (isObj(p) && p.readOnly === true) continue;
        out[k] = exampleFor(root, v, depth + 1, seen);
      }
      if (!Object.keys(props).length && isObj(schema.additionalProperties)) out.key = exampleFor(root, schema.additionalProperties, depth + 1, seen);
      return out;
    }
    case 'array':
      return [exampleFor(root, schema.items, depth + 1, seen)];
    case 'integer':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1.5;
    case 'boolean':
      return true;
    case 'string': {
      const f = String(schema.format ?? '');
      if (f === 'date-time') return '2026-01-01T00:00:00Z';
      if (f === 'date') return '2026-01-01';
      if (f === 'uuid') return '00000000-0000-4000-8000-000000000000';
      if (f === 'email') return 'user@example.com';
      if (f === 'uri' || f === 'url') return 'https://example.com/';
      if (f === 'byte') return 'c3RyaW5n';
      if (f === 'password') return 'password';
      return 'string';
    }
    case 'null':
      return null;
    default:
      return null;
  }
}

const schemaType = (root: Obj, s: unknown): string | undefined => {
  const d = deref(root, s);
  if (!isObj(d)) return undefined;
  const t = Array.isArray(d.type) ? d.type.join('|') : d.type;
  return t ? `${String(t)}${d.format ? `(${String(d.format)})` : ''}` : undefined;
};

const exampleText = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : typeof v === 'string' ? v : JSON.stringify(v));

function hostsOf(urls: string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    try {
      if (/^https?:\/\//i.test(u)) out.add(new URL(u.replace(/\{[^}]+\}/g, 'x')).hostname.toLowerCase());
    } catch {
      // relative or templated server
    }
  }
  return [...out];
}

function basePathOf(urls: string[]): string {
  for (const u of urls) {
    try {
      const p = new URL(u.replace(/\{[^}]+\}/g, 'x'), 'http://relative.invalid').pathname.replace(/\/$/, '');
      if (p) return p;
    } catch {
      // ignore
    }
  }
  return '';
}

function readParams(root: Obj, list: unknown, v2: boolean): { params: SpecParam[]; body?: SpecEndpoint['requestBody'] } {
  const params: SpecParam[] = [];
  let body: SpecEndpoint['requestBody'];
  const formFields: Obj = {};
  for (const raw of Array.isArray(list) ? list : []) {
    const p = deref(root, raw);
    if (!isObj(p) || typeof p.name !== 'string') continue;
    const where = String(p.in);
    if (v2 && where === 'body') {
      body = { contentType: 'application/json', example: JSON.stringify(exampleFor(root, p.schema), null, 2), required: !!p.required };
      continue;
    }
    if (v2 && where === 'formData') {
      formFields[p.name] = p.example ?? p.default ?? (p.type === 'integer' || p.type === 'number' ? 1 : 'string');
      continue;
    }
    if (!['path', 'query', 'header', 'cookie'].includes(where)) continue;
    const schema = v2 ? p : p.schema;
    const ex = p.example ?? (isObj(p.examples) ? (Object.values(p.examples).map((e) => deref(root, e)).find(isObj)?.value as unknown) : undefined) ?? exampleFor(root, schema);
    params.push({
      name: p.name,
      in: where as SpecParam['in'],
      required: where === 'path' ? true : !!p.required,
      type: schemaType(root, schema),
      example: exampleText(ex),
      description: typeof p.description === 'string' ? p.description.slice(0, 300) : undefined,
    });
  }
  if (Object.keys(formFields).length && !body) {
    body = { contentType: 'application/x-www-form-urlencoded', example: new URLSearchParams(Object.entries(formFields).map(([k, v]): [string, string] => [k, String(v)])).toString(), required: false };
  }
  return { params, body };
}

function fromOpenApi(doc: Obj, name: string): ApiSpec {
  const v2 = typeof doc.swagger === 'string';
  const warnings: string[] = [];
  let servers: string[] = [];
  if (v2) {
    const schemes = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes.map(String) : ['https'];
    if (typeof doc.host === 'string') servers = schemes.map((s) => `${s}://${doc.host}${typeof doc.basePath === 'string' ? doc.basePath : ''}`);
    else if (typeof doc.basePath === 'string') servers = [doc.basePath];
  } else if (Array.isArray(doc.servers)) {
    servers = doc.servers.filter(isObj).map((s) => {
      let url = String(s.url ?? '');
      // Fill server variables with their defaults.
      if (isObj(s.variables)) for (const [k, v] of Object.entries(s.variables)) if (isObj(v) && v.default !== undefined) url = url.replace(`{${k}}`, String(v.default));
      return url;
    });
  }
  const schemesRaw = v2 ? doc.securityDefinitions : isObj(doc.components) ? doc.components.securitySchemes : undefined;
  const securitySchemes: ApiSpec['securitySchemes'] = {};
  if (isObj(schemesRaw)) {
    for (const [k, raw] of Object.entries(schemesRaw)) {
      const s = deref(doc, raw);
      if (isObj(s)) securitySchemes[k] = { type: String(s.type ?? ''), name: s.name as string | undefined, in: s.in as string | undefined, scheme: s.scheme as string | undefined };
    }
  }
  const globalSecurity = Array.isArray(doc.security) ? doc.security.filter(isObj).flatMap((s) => Object.keys(s)) : [];
  const endpoints: SpecEndpoint[] = [];
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(doc, rawItem);
    if (!isObj(item)) continue;
    for (const m of METHODS) {
      const op = item[m];
      if (!isObj(op)) continue;
      const shared = readParams(doc, item.parameters, v2);
      const own = readParams(doc, op.parameters, v2);
      // Operation parameters override path-level ones with the same name and place.
      const params = [...shared.params.filter((p) => !own.params.some((o) => o.name === p.name && o.in === p.in)), ...own.params];
      let requestBody = own.body ?? shared.body;
      if (!v2 && op.requestBody) {
        const rb = deref(doc, op.requestBody);
        if (isObj(rb) && isObj(rb.content)) {
          const types = Object.keys(rb.content);
          const ct = types.find((t) => /json/i.test(t)) ?? types[0];
          if (ct) {
            const media = rb.content[ct];
            let ex: unknown;
            if (isObj(media)) {
              if (media.example !== undefined) ex = media.example;
              else if (isObj(media.examples)) ex = (Object.values(media.examples).map((e) => deref(doc, e)).find(isObj) as Obj | undefined)?.value;
              if (ex === undefined) ex = exampleFor(doc, media.schema);
            }
            let text: string;
            if (/x-www-form-urlencoded/i.test(ct) && isObj(ex)) text = new URLSearchParams(Object.entries(ex).map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : JSON.stringify(v)])).toString();
            else text = typeof ex === 'string' ? ex : JSON.stringify(ex ?? {}, null, 2);
            requestBody = { contentType: ct, example: text, required: !!rb.required };
          }
        }
      }
      const opSecurity = Array.isArray(op.security) ? op.security.filter(isObj).flatMap((s) => (Object.keys(s).length ? Object.keys(s) : ['none'])) : undefined;
      const method = m.toUpperCase();
      endpoints.push({
        key: `${method} ${path}`,
        method,
        path,
        summary: typeof op.summary === 'string' ? op.summary : typeof op.description === 'string' ? op.description.split('\n')[0]!.slice(0, 200) : undefined,
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
        params,
        requestBody,
        responses: isObj(op.responses) ? Object.keys(op.responses) : [],
        security: opSecurity ?? globalSecurity,
        deprecated: op.deprecated === true || undefined,
      });
    }
  }
  if (!endpoints.length) warnings.push('no operations found under "paths"');
  const info = isObj(doc.info) ? doc.info : {};
  return {
    id: newId(),
    name: typeof info.title === 'string' && info.title ? info.title : name,
    format: v2 ? 'swagger2' : 'openapi3',
    version: typeof info.version === 'string' ? info.version : undefined,
    servers,
    hosts: hostsOf(servers),
    basePath: basePathOf(servers),
    securitySchemes,
    endpoints,
    importedAt: Date.now(),
    warnings,
  };
}

/** Postman uses {{name}}; SiteInquisition uses {{var:name}}. Built-in dynamic variables map where they can. */
function postmanTokens(s: string): string {
  return s.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_w, name: string) => {
    if (name === '$guid' || name === '$randomUUID') return '{{uuid}}';
    if (name === '$timestamp') return '{{now:unix}}';
    if (name === '$isoTimestamp') return '{{now}}';
    if (name === '$randomInt') return '{{random:3}}';
    return `{{var:${name.replace(/[^\w.-]/g, '_')}}}`;
  });
}

function fromPostman(doc: Obj, name: string): ApiSpec {
  const info = isObj(doc.info) ? doc.info : {};
  const endpoints: SpecEndpoint[] = [];
  const warnings: string[] = [];
  const servers = new Set<string>();
  const walk = (items: unknown, folder: string[]) => {
    for (const it of Array.isArray(items) ? items : []) {
      if (!isObj(it)) continue;
      if (Array.isArray(it.item)) {
        walk(it.item, [...folder, String(it.name ?? '')]);
        continue;
      }
      const r = it.request;
      if (!r) continue;
      const req = typeof r === 'string' ? { url: r, method: 'GET' } : (r as Obj);
      const method = String(req.method ?? 'GET').toUpperCase();
      let raw = '';
      const u = req.url;
      if (typeof u === 'string') raw = u;
      else if (isObj(u)) {
        if (typeof u.raw === 'string') raw = u.raw;
        else {
          const host = Array.isArray(u.host) ? u.host.join('.') : String(u.host ?? '');
          const path = Array.isArray(u.path) ? u.path.join('/') : String(u.path ?? '');
          raw = `${u.protocol ? `${String(u.protocol)}://` : ''}${host}/${path}`;
        }
      }
      const url = postmanTokens(raw);
      const headers: HeaderList = (Array.isArray(req.header) ? req.header : [])
        .filter((h): h is Obj => isObj(h) && h.disabled !== true)
        .map((h) => [postmanTokens(String(h.key ?? '')), postmanTokens(String(h.value ?? ''))]);
      let body: string | undefined;
      const b = isObj(req.body) ? req.body : undefined;
      if (b?.mode === 'raw' && typeof b.raw === 'string') body = postmanTokens(b.raw);
      else if (b?.mode === 'urlencoded' && Array.isArray(b.urlencoded)) {
        body = new URLSearchParams(b.urlencoded.filter(isObj).filter((x) => x.disabled !== true).map((x): [string, string] => [String(x.key ?? ''), String(x.value ?? '')])).toString();
        body = postmanTokens(body.replace(/%7B%7B/g, '{{').replace(/%7D%7D/g, '}}'));
        if (!headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
      } else if (b?.mode === 'graphql' && isObj(b.graphql)) {
        body = JSON.stringify({ query: b.graphql.query, variables: typeof b.graphql.variables === 'string' && b.graphql.variables ? JSON.parse(b.graphql.variables) : undefined });
        if (!headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['Content-Type', 'application/json']);
      } else if (b?.mode && b.mode !== 'none') warnings.push(`${String(it.name)}: body mode "${String(b.mode)}" is not imported`);
      // Strip the origin, written out or as a {{baseUrl}}-style variable.
      let path = url.replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/^\{\{var:[\w.-]+\}\}/, '').split('?')[0] || '/';
      if (!path.startsWith('/')) path = `/${path}`;
      // Postman path variables (:id) become {id}; variable tokens become {name}.
      const specPath = path.replace(/\/:([\w-]+)/g, '/{$1}').replace(/\{\{var:([\w.-]+)\}\}/g, '{$1}');
      const origin = /^([a-z]+:\/\/[^/]+)/i.exec(url)?.[1];
      if (origin) servers.add(origin);
      endpoints.push({
        key: `${method} ${specPath}#${endpoints.length}`,
        method,
        path: specPath,
        summary: [...folder.filter(Boolean), String(it.name ?? '')].join(' / '),
        tags: folder.filter(Boolean),
        params: [...specPath.matchAll(/\{([\w.-]+)\}/g)].map((m) => ({ name: m[1]!, in: 'path' as const, required: true })),
        requestBody: body !== undefined ? { contentType: headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? 'text/plain', example: body, required: false } : undefined,
        responses: [],
        security: isObj(req.auth) ? [String(req.auth.type)] : [],
        draft: { url: url.replace(/\/:([\w-]+)/g, '/{{var:$1}}'), headers, body },
      });
    }
  };
  walk(doc.item, []);
  const serverList = [...servers].filter((s) => !s.includes('{{'));
  return {
    id: newId(),
    name: typeof info.name === 'string' ? info.name : name,
    format: 'postman',
    servers: serverList,
    hosts: hostsOf(serverList),
    basePath: '',
    securitySchemes: {},
    endpoints,
    importedAt: Date.now(),
    warnings,
  };
}

export function detectFormat(doc: unknown): SpecFormat | 'har' | null {
  if (!isObj(doc)) return null;
  if (typeof doc.openapi === 'string') return 'openapi3';
  if (typeof doc.swagger === 'string') return 'swagger2';
  if (isObj(doc.log) && Array.isArray(doc.log.entries)) return 'har';
  if (isObj(doc.info) && (String(doc.info.schema ?? '').includes('postman') || Array.isArray(doc.item))) return 'postman';
  if (Array.isArray(doc.item)) return 'postman';
  return null;
}

/** Parse an API description (JSON or YAML). Throws with a reason when the format is not recognised. */
export function parseSpec(text: string, name = 'Imported API'): ApiSpec {
  let doc: unknown;
  try {
    doc = parseJsonOrYaml(text);
  } catch (e) {
    throw new Error(`could not read the file as JSON or YAML: ${(e as Error).message}`);
  }
  const f = detectFormat(doc);
  if (f === 'openapi3' || f === 'swagger2') return fromOpenApi(doc as Obj, name);
  if (f === 'postman') return fromPostman(doc as Obj, name);
  if (f === 'har') throw new Error('this is a HAR file: import it into History instead');
  throw new Error('not an OpenAPI 3, Swagger 2 or Postman v2 collection');
}

// ---------- spec vs traffic ----------

const specRegex = (path: string) => new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]*\\?\}/g, '[^/]+').replace(/\{[^}]*\}/g, '[^/]+')}/?$`);

/** Does a recorded path (or a coverage template) belong to a spec endpoint? */
export function specMatches(spec: ApiSpec, ep: SpecEndpoint, method: string, path: string): boolean {
  if (ep.method !== method.toUpperCase()) return false;
  let p = (path.split('?')[0] ?? '/').replace(/\/$/, '') || '/';
  const base = spec.basePath;
  if (base && p.startsWith(base)) p = p.slice(base.length) || '/';
  return specRegex(ep.path.replace(/\/$/, '') || '/').test(p);
}

export interface SpecCoverageRow {
  specId: string;
  specName: string;
  endpoint: SpecEndpoint;
  /** Recorded calls that match. */
  count: number;
  statuses: Record<string, number>;
  exampleId?: string;
}

export interface SpecCoverage {
  host: string;
  documented: SpecCoverageRow[];
  /** Coverage endpoints (method + template) that no spec describes. */
  undocumented: string[];
}

export function specCoverage(specs: ApiSpec[], report: CoverageReport): SpecCoverage {
  const relevant = specs.filter((s) => !s.hosts.length || s.hosts.includes(report.host));
  const documented: SpecCoverageRow[] = [];
  const used = new Set<string>();
  for (const spec of relevant) {
    for (const ep of spec.endpoints) {
      const row: SpecCoverageRow = { specId: spec.id, specName: spec.name, endpoint: ep, count: 0, statuses: {} };
      for (const e of report.endpoints) {
        if (!specMatches(spec, ep, e.method, e.template)) continue;
        used.add(`${e.method} ${e.template}`);
        row.count += e.count;
        for (const [k, v] of Object.entries(e.statuses)) row.statuses[k] = (row.statuses[k] ?? 0) + v;
        row.exampleId ??= e.exampleId;
      }
      documented.push(row);
    }
  }
  const undocumented = relevant.length ? report.endpoints.map((e) => `${e.method} ${e.template}`).filter((k) => !used.has(k)) : [];
  return { host: report.host, documented, undocumented };
}

/** A ready-to-edit request for a spec endpoint, with path and query parameters filled from examples (or `values`). */
export function requestForEndpoint(spec: ApiSpec, ep: SpecEndpoint, opts: { baseUrl?: string; values?: Record<string, string> } = {}): { method: string; url: string; headers: HeaderList; body: string } {
  const values = opts.values ?? {};
  if (ep.draft) return { method: ep.method, url: ep.draft.url, headers: ep.draft.headers, body: ep.draft.body ?? '' };
  const base = (opts.baseUrl ?? spec.servers.find((s) => /^https?:/i.test(s)) ?? `https://${spec.hosts[0] ?? 'example.com'}${spec.basePath}`).replace(/\/$/, '');
  let path = ep.path;
  for (const p of ep.params.filter((x) => x.in === 'path')) path = path.replace(`{${p.name}}`, encodeURIComponent(values[p.name] ?? p.example ?? `{${p.name}}`).replace(/%7B/g, '{').replace(/%7D/g, '}'));
  const q = new URLSearchParams();
  for (const p of ep.params.filter((x) => x.in === 'query' && (x.required || values[x.name] !== undefined))) q.set(p.name, values[p.name] ?? p.example ?? '');
  const headers: HeaderList = [];
  for (const p of ep.params.filter((x) => x.in === 'header' && x.required)) headers.push([p.name, values[p.name] ?? p.example ?? '']);
  for (const name of ep.security) {
    const s = spec.securitySchemes[name];
    if (!s) continue;
    if (s.type === 'http' && /bearer/i.test(s.scheme ?? '')) headers.push(['Authorization', 'Bearer {{var:token}}']);
    else if (s.type === 'http' && /basic/i.test(s.scheme ?? '')) headers.push(['Authorization', 'Basic {{var:basic}}']);
    else if (s.type === 'oauth2' || s.type === 'openIdConnect') headers.push(['Authorization', 'Bearer {{var:token}}']);
    else if (s.type === 'apiKey' && s.in === 'header' && s.name) headers.push([s.name, `{{var:${s.name.replace(/[^\w.-]/g, '_')}}}`]);
    else if (s.type === 'apiKey' && s.in === 'query' && s.name) q.set(s.name, `{{var:${s.name.replace(/[^\w.-]/g, '_')}}}`);
    break;
  }
  if (ep.requestBody) headers.push(['Content-Type', ep.requestBody.contentType]);
  const qs = q.toString().replace(/%7B%7B/g, '{{').replace(/%7D%7D/g, '}}').replace(/%3A/g, ':');
  return { method: ep.method, url: `${base}${path}${qs ? `?${qs}` : ''}`, headers, body: ep.requestBody?.example ?? '' };
}

// ---------- OpenAPI export from traffic ----------

type Schema = Obj;

/** Infer a JSON schema from sample values, merging what each sample shows. */
export function inferSchema(samples: unknown[], depth = 0): Schema {
  const types = new Set<string>();
  for (const s of samples) types.add(s === null ? 'null' : Array.isArray(s) ? 'array' : Number.isInteger(s) ? 'integer' : typeof s);
  if (types.has('integer') && types.has('number')) types.delete('integer');
  const nullable = types.delete('null');
  const nonNull = samples.filter((s) => s !== null && s !== undefined);
  let out: Schema;
  if (types.size !== 1 || depth > 6) out = types.size ? {} : {};
  else {
    const t = [...types][0]!;
    if (t === 'object') {
      const keys = new Map<string, unknown[]>();
      for (const o of nonNull as Obj[]) for (const [k, v] of Object.entries(o)) (keys.get(k) ?? keys.set(k, []).get(k)!).push(v);
      const properties: Obj = {};
      const required: string[] = [];
      for (const [k, vals] of keys) {
        properties[k] = inferSchema(vals, depth + 1);
        if (vals.length === nonNull.length) required.push(k);
      }
      out = { type: 'object', properties, ...(required.length ? { required } : {}) };
    } else if (t === 'array') out = { type: 'array', items: inferSchema((nonNull as unknown[][]).flat().slice(0, 200), depth + 1) };
    else if (t === 'string') {
      const strs = nonNull as string[];
      out = { type: 'string' };
      if (strs.every((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s))) out.format = 'date-time';
      else if (strs.every((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s))) out.format = 'uuid';
      else if (strs.every((s) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s))) out.format = 'email';
      if (strs[0] !== undefined) out.example = strs[0];
    } else {
      out = { type: t };
      if (nonNull[0] !== undefined) out.example = nonNull[0];
    }
  }
  if (nullable) out.nullable = true;
  return out;
}

const parseJsonText = (b: Uint8Array | undefined): unknown => {
  if (!b?.length || b.length > 1_000_000 || !looksLikeText(b)) return undefined;
  try {
    return JSON.parse(bytesToString(b));
  } catch {
    return undefined;
  }
};

/** An OpenAPI 3.1 document describing what was seen for a host. */
export function exportOpenApi(store: CaptureStore, host: string, opts: { title?: string; samples?: number } = {}): Obj {
  const report = coverage(store, host);
  const perEndpoint = opts.samples ?? 20;
  const paths: Obj = {};
  const rows = store.search(`host:${host}`, { limit: 5000 });
  let scheme = 'https';
  for (const ep of report.endpoints) {
    let n = 0;
    const counts: Record<string, number> = {};
    const name = (kind: string) => {
      counts[kind] = (counts[kind] ?? 0) + 1;
      return `${kind}${counts[kind]! > 1 ? counts[kind] : ''}`;
    };
    const oaPath = ep.template.replace(/\{(n|uuid|hex|ulid|token|email)\}/g, (_w, k: string) => `{${name(k === 'n' ? 'id' : k)}}`);
    const reqSamples: unknown[] = [];
    const resSamples = new Map<string, unknown[]>();
    let reqType: string | undefined;
    for (const e of rows) {
      if (e.method !== ep.method || pathTemplate(e.path) !== ep.template || n >= perEndpoint) continue;
      n++;
      scheme = e.scheme === 'http' ? 'http' : scheme;
      const ex = store.getExchange(e.id);
      if (!ex) continue;
      reqType ??= ex.requestHeaders.find(([k]) => k.toLowerCase() === 'content-type')?.[1]?.split(';')[0];
      const rq = parseJsonText(store.getBody(e.id, 'request', true));
      if (rq !== undefined) reqSamples.push(rq);
      if (e.status !== null) {
        const rs = parseJsonText(store.getBody(e.id, 'response', true));
        const list = resSamples.get(String(e.status)) ?? [];
        if (rs !== undefined) list.push(rs);
        resSamples.set(String(e.status), list);
      }
    }
    const params: Obj[] = [];
    for (const m of oaPath.matchAll(/\{([\w]+)\}/g)) params.push({ name: m[1], in: 'path', required: true, schema: { type: /^id\d*$/.test(m[1]!) ? 'integer' : 'string' } });
    for (const q of ep.queryParams) params.push({ name: q, in: 'query', required: false, schema: { type: 'string' } });
    const responses: Obj = {};
    for (const st of Object.keys(ep.statuses).filter((s) => /^\d+$/.test(s)).sort()) {
      const samples = resSamples.get(st) ?? [];
      responses[st] = { description: `Seen ${ep.statuses[st]} times`, ...(samples.length ? { content: { 'application/json': { schema: inferSchema(samples) } } } : {}) };
    }
    if (!Object.keys(responses).length) responses.default = { description: 'No response recorded' };
    const op: Obj = { summary: `Seen ${ep.count} times`, ...(params.length ? { parameters: params } : {}), responses };
    if (reqSamples.length) op.requestBody = { content: { 'application/json': { schema: inferSchema(reqSamples) } } };
    else if (ep.bodyParams.length && reqType) op.requestBody = { content: { [reqType]: { schema: { type: 'object', properties: Object.fromEntries(ep.bodyParams.filter((p) => !p.includes('.')).map((p) => [p, { type: 'string' }])) } } } };
    const item = (paths[oaPath] as Obj | undefined) ?? {};
    item[ep.method.toLowerCase()] = op;
    paths[oaPath] = item;
  }
  return {
    openapi: '3.1.0',
    info: { title: opts.title ?? `${host} (from recorded traffic)`, version: new Date().toISOString().slice(0, 10), description: `Generated by SiteInquisition from ${report.scanned} recorded exchanges.` },
    servers: [{ url: `${scheme}://${host}` }],
    paths,
  };
}

// ---------- HAR ----------

export interface HarImport {
  imported: number;
  skipped: number;
  ids: string[];
}

/** Add the entries of a HAR 1.2 file to History, as source "import". */
export function importHar(store: CaptureStore, text: string, tag = 'har'): HarImport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`not a JSON file: ${(e as Error).message}`);
  }
  if (detectFormat(doc) !== 'har') throw new Error('not a HAR file (no log.entries)');
  const entries = ((doc as { log: { entries: unknown[] } }).log.entries ?? []).filter(isObj);
  const ids: string[] = [];
  let skipped = 0;
  const enc = new TextEncoder();
  const headersOf = (h: unknown): HeaderList =>
    (Array.isArray(h) ? h : []).filter(isObj).filter((x) => !String(x.name).startsWith(':')).map((x) => [String(x.name), String(x.value ?? '')]);
  for (const e of entries) {
    const rq = isObj(e.request) ? e.request : undefined;
    const rs = isObj(e.response) ? e.response : undefined;
    if (!rq || typeof rq.url !== 'string' || !/^(https?|wss?):/i.test(rq.url)) {
      skipped++;
      continue;
    }
    const started = Date.parse(String(e.startedDateTime ?? '')) || Date.now();
    const postData = isObj(rq.postData) ? rq.postData : undefined;
    const reqBody = typeof postData?.text === 'string' ? enc.encode(postData.text) : undefined;
    const reqHeaders = headersOf(rq.headers).filter(([k]) => k.toLowerCase() !== 'content-length');
    const s = store.addRequest({
      source: 'import',
      startedAt: started,
      method: String(rq.method ?? 'GET'),
      url: rq.url,
      httpVersion: String(rq.httpVersion ?? 'HTTP/1.1').replace(/^HTTP\//i, '') || '1.1',
      headers: reqHeaders,
      body: reqBody,
      tags: [tag],
    });
    ids.push(s.id);
    if (rs && typeof rs.status === 'number' && rs.status > 0) {
      const content = isObj(rs.content) ? rs.content : {};
      let body: Uint8Array | undefined;
      if (typeof content.text === 'string') body = content.encoding === 'base64' ? new Uint8Array(Buffer.from(content.text, 'base64')) : enc.encode(content.text);
      // The HAR body is already decoded; drop the encoding header so it is not decoded twice.
      const resHeaders = headersOf(rs.headers).filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(k.toLowerCase()));
      const total = typeof e.time === 'number' ? e.time : undefined;
      store.completeResponse(s.id, { status: rs.status, statusMessage: typeof rs.statusText === 'string' ? rs.statusText : undefined, headers: resHeaders, body, timings: total !== undefined ? { total } : undefined });
    } else store.failExchange(s.id, 'error', 'no response in the HAR file');
  }
  return { imported: ids.length, skipped, ids };
}
