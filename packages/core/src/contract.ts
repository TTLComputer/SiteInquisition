import type { ApiSpec, SpecEndpoint } from './specs.js';
import { specMatches } from './specs.js';
import type { CaptureStore, ExchangeSummary } from './store.js';
import { jsonOf } from './values.js';

/**
 * Contract checks: does what the server actually sent match the API file?
 * Each recorded response (and JSON request) is checked against the schema
 * for its endpoint and status: wrong types, missing required fields, values
 * outside an enum, statuses the spec never mentions, and fields the spec
 * does not describe (reported as warnings: undocumented, not wrong).
 */
export type IssueKind = 'type' | 'missing' | 'enum' | 'format' | 'range' | 'undocumented-field' | 'undocumented-status' | 'not-json';

export interface ContractIssue {
  side: 'request' | 'response';
  /** JSONPath of the value. */
  path: string;
  kind: IssueKind;
  severity: 'error' | 'warning';
  message: string;
}

export interface ContractResult {
  exchangeId: string;
  specId: string;
  specName: string;
  endpoint: string;
  status: number | null;
  issues: ContractIssue[];
}

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const keyPath = (p: string, k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `${p}.${k}` : `${p}['${k}']`);
const short = (v: unknown) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 40)}...` : s;
};

const FORMATS: Record<string, RegExp> = {
  'date-time': /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  uri: /^[a-z][a-z0-9+.-]*:/i,
  ipv4: /^(\d{1,3}\.){3}\d{1,3}$/,
};

/** Validate a value against a (resolved) JSON schema. */
export function validate(schema: Schema, value: unknown, path = '$', side: 'request' | 'response' = 'response', out: ContractIssue[] = []): ContractIssue[] {
  if (!isObj(schema) || out.length > 200) return out;
  const err = (kind: IssueKind, message: string, severity: 'error' | 'warning' = 'error') => out.push({ side, path, kind, severity, message });
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) validate(s as Schema, value, path, side, out);
  for (const k of ['oneOf', 'anyOf'] as const) {
    const alts = schema[k];
    if (Array.isArray(alts) && alts.length) {
      const results = alts.map((s) => validate(s as Schema, value, path, side, []));
      if (!results.some((r) => !r.some((i) => i.severity === 'error'))) {
        const typeErr = (r: ContractIssue[]) => (r.some((i) => i.kind === 'type' && i.path === path) ? 1 : 0);
        const best = results.sort((a, b) => typeErr(a) - typeErr(b) || a.length - b.length)[0]!;
        out.push(...best);
      }
    }
  }
  const actual = typeOf(value);
  let types = schema.type === undefined ? [] : Array.isArray(schema.type) ? (schema.type as string[]) : [String(schema.type)];
  if (schema.nullable === true && types.length) types = [...types, 'null'];
  if (types.length) {
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) {
      err('type', `expected ${types.join(' or ')}, got ${actual} ${short(value)}`);
      return out;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) err('enum', `${short(value)} is not one of ${schema.enum.map(short).join(', ')}`);
  if (typeof value === 'string') {
    const f = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
    if (f && !f.test(value)) err('format', `"${short(value)}" is not a valid ${String(schema.format)}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) err('range', `longer than ${schema.maxLength} characters`);
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) err('range', `shorter than ${schema.minLength} characters`);
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) err('format', `does not match ${schema.pattern}`);
      } catch {
        // a pattern JavaScript cannot read
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.maximum === 'number' && value > schema.maximum) err('range', `${value} is above the maximum ${schema.maximum}`);
    if (typeof schema.minimum === 'number' && value < schema.minimum) err('range', `${value} is below the minimum ${schema.minimum}`);
  }
  if (Array.isArray(value) && isObj(schema.items)) value.slice(0, 50).forEach((v, i) => validate(schema.items as Schema, v, `${path}[${i}]`, side, out));
  if (isObj(value)) {
    const props = isObj(schema.properties) ? schema.properties : undefined;
    if (Array.isArray(schema.required)) for (const r of schema.required) if (!(String(r) in value)) out.push({ side, path: keyPath(path, String(r)), kind: 'missing', severity: 'error', message: `required field "${String(r)}" is missing` });
    for (const [k, v] of Object.entries(value)) {
      const ps = props?.[k];
      if (isObj(ps)) validate(ps, v, keyPath(path, k), side, out);
      else if (isObj(schema.additionalProperties)) validate(schema.additionalProperties, v, keyPath(path, k), side, out);
      else if (props && schema.additionalProperties !== true && !schema.allOf && !schema.oneOf && !schema.anyOf) {
        out.push({ side, path: keyPath(path, k), kind: 'undocumented-field', severity: schema.additionalProperties === false ? 'error' : 'warning', message: `field "${k}" is not in the spec` });
      }
    }
  }
  return out;
}

export function findEndpoint(specs: ApiSpec[], ex: Pick<ExchangeSummary, 'host' | 'method' | 'path'>): { spec: ApiSpec; ep: SpecEndpoint } | undefined {
  for (const spec of specs) {
    if (spec.hosts.length && !spec.hosts.includes(ex.host)) continue;
    const ep = spec.endpoints.find((e) => !e.graphql && specMatches(spec, e, ex.method, ex.path));
    if (ep) return { spec, ep };
  }
  return undefined;
}

function schemaForStatus(ep: SpecEndpoint, status: number): { schema?: Schema; documented: boolean } {
  const r = ep.responses;
  const key = r.includes(String(status)) ? String(status) : r.find((k) => k.toUpperCase() === `${String(status)[0]}XX`) ?? (r.includes('default') ? 'default' : undefined);
  return { schema: key ? ep.responseSchemas?.[key] : undefined, documented: !!key || r.length === 0 };
}

export function checkExchange(store: CaptureStore, specs: ApiSpec[], id: string): ContractResult | null {
  const ex = store.getSummary(id);
  if (!ex) throw new Error('no such exchange');
  const hit = findEndpoint(specs, ex);
  if (!hit) return null;
  const issues: ContractIssue[] = [];
  if (hit.ep.requestSchema && ex.reqBodySize) {
    const body = jsonOf(store, id, 'request');
    if (body === undefined) issues.push({ side: 'request', path: '$', kind: 'not-json', severity: 'warning', message: 'the request body is not JSON' });
    else validate(hit.ep.requestSchema, body, '$', 'request', issues);
  }
  if (ex.status !== null) {
    const { schema, documented } = schemaForStatus(hit.ep, ex.status);
    if (!documented) issues.push({ side: 'response', path: '$', kind: 'undocumented-status', severity: 'warning', message: `status ${ex.status} is not in the spec (it lists ${hit.ep.responses.join(', ')})` });
    if (schema && ex.resBodySize) {
      const body = jsonOf(store, id, 'response');
      if (body === undefined) issues.push({ side: 'response', path: '$', kind: 'not-json', severity: 'error', message: 'the spec describes JSON, the response is not JSON' });
      else validate(schema, body, '$', 'response', issues);
    }
  }
  return { exchangeId: id, specId: hit.spec.id, specName: hit.spec.name, endpoint: hit.ep.key, status: ex.status, issues };
}

export interface ContractSummary {
  host: string;
  checked: number;
  /** By endpoint key. */
  endpoints: Array<{ endpoint: string; checked: number; failing: number; issues: Array<ContractIssue & { count: number; exampleId: string }> }>;
}

/** Check recent exchanges of a host; issues are grouped by endpoint, path and kind. */
export function contractScan(store: CaptureStore, specs: ApiSpec[], host: string, limit = 1000): ContractSummary {
  const rows = store.search(`host:${host}`, { limit });
  const map = new Map<string, ContractSummary['endpoints'][number]>();
  let checked = 0;
  for (const e of rows) {
    if (e.isWebSocket || e.state === 'pending') continue;
    const r = checkExchange(store, specs, e.id);
    if (!r) continue;
    checked++;
    let ep = map.get(r.endpoint);
    if (!ep) map.set(r.endpoint, (ep = { endpoint: r.endpoint, checked: 0, failing: 0, issues: [] }));
    ep.checked++;
    if (r.issues.some((i) => i.severity === 'error')) ep.failing++;
    for (const i of r.issues) {
      // Collapse array indexes so one bad field in a list of 50 is one row.
      const path = i.path.replace(/\[\d+\]/g, '[*]');
      const same = ep.issues.find((x) => x.path === path && x.kind === i.kind && x.side === i.side);
      if (same) same.count++;
      else ep.issues.push({ ...i, path, count: 1, exampleId: e.id });
    }
  }
  const endpoints = [...map.values()].sort((a, b) => b.failing - a.failing || a.endpoint.localeCompare(b.endpoint));
  return { host, checked, endpoints };
}
