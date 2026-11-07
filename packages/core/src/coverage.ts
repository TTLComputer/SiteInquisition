import { bytesToString, looksLikeText } from '@siteinquisition/codecs';
import type { CaptureStore } from './store.js';

/**
 * Endpoint coverage for one host: what has been exercised, with which
 * parameters and outcomes, and which paths the app's own pages and scripts
 * mention that nobody has requested yet. Meant for "here is an app with no
 * docs, what does it do?".
 */
export interface EndpointCoverage {
  method: string;
  /** Path with ids collapsed, e.g. /api/orders/{n}/items/{uuid}. */
  template: string;
  count: number;
  statuses: Record<string, number>;
  queryParams: string[];
  bodyParams: string[];
  contentTypes: string[];
  sources: string[];
  firstAt: number;
  lastAt: number;
  /** One exchange to open, preferably a successful one. */
  exampleId: string;
  /** Slowest duration seen, ms. */
  maxMs: number | null;
  /** How requests authenticated: "bearer", "basic", "cookie", "api key", another Authorization scheme, or "none". */
  auth: string[];
  /** Query and body fields with the JSON types seen and one example value. */
  params: ParamInfo[];
  /**
   * What it looks like: an API call, an HTML page, a static file (scripts,
   * styles, images, fonts, downloads), or a WebSocket connection. Inferred
   * from the path and the response type.
   */
  kind: EndpointKind;
}

export type EndpointKind = 'api' | 'page' | 'file' | 'websocket';

const FILE_EXT = /\.(m?js|cjs|jsx|ts|css|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|flac|pdf|zip|gz|tar|txt|wasm|webmanifest|xml|csv|docx?|xlsx?|pptx?)$/i;
const FILE_TYPE = /^(image|font|audio|video)\/|^text\/(css|javascript|csv)$|javascript|^application\/(wasm|pdf|zip|octet-stream|manifest\+json|font)/i;
const API_HINT = /\/(api|graphql|gql|rest|rpc|v\d+)(\/|$)|\.json$/i;

/** Whether a path and its response types look like an API call, a page or a static file. */
export function endpointKind(method: string, path: string, contentTypes: string[], isWebSocket = false): EndpointKind {
  if (isWebSocket) return 'websocket';
  const p = (path.split(/[?#]/)[0] ?? '/').toLowerCase();
  if (method !== 'GET' && method !== 'HEAD') return 'api';
  if (API_HINT.test(p) && !/\.(m?js|css|map)$/.test(p)) return 'api';
  if (FILE_EXT.test(p)) return 'file';
  if (contentTypes.length && contentTypes.every((t) => FILE_TYPE.test(t))) return 'file';
  if (contentTypes.some((t) => /json|xml|grpc|protobuf|msgpack|event-stream/i.test(t))) return 'api';
  if (contentTypes.some((t) => /html/i.test(t))) return 'page';
  return contentTypes.length ? 'api' : 'page';
}

/** A path seen only in references: a file by its extension, otherwise a possible endpoint. */
export const referenceKind = (path: string): 'endpoint' | 'file' => (FILE_EXT.test(path.split(/[?#]/)[0]!) && !API_HINT.test(path) ? 'file' : 'endpoint');

export interface ParamInfo {
  in: 'query' | 'body';
  name: string;
  types: string[];
  example: string;
}

const API_KEY_HEADER = /^(x-api-key|api-key|apikey|x-auth-token|x-access-token|x-session-token)$/i;

/** How a request proves who it is, from its headers. */
export function authKinds(headers: Array<[string, string]>): string[] {
  const out: string[] = [];
  for (const [k, v] of headers) {
    const name = k.toLowerCase();
    if (name === 'authorization') {
      const scheme = v.trim().split(/\s+/)[0]!.toLowerCase();
      out.push(scheme === 'bearer' ? 'bearer' : scheme === 'basic' ? 'basic' : scheme.startsWith('aws4') ? 'sigv4' : scheme || 'authorization');
    } else if (name === 'cookie' && v.trim()) out.push('cookie');
    else if (API_KEY_HEADER.test(k)) out.push('api key');
  }
  return out.length ? [...new Set(out)] : ['none'];
}

const jsonType = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const example = (v: unknown) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
};

export interface CoverageReport {
  host: string;
  scanned: number;
  endpoints: EndpointCoverage[];
  /** Paths referenced in recorded responses (HTML, JS, JSON) that match no exercised endpoint. */
  unexercised: Array<{ path: string; foundIn: string; count: number; kind: 'endpoint' | 'file' }>;
}

const SEGMENT_RULES: Array<[RegExp, string]> = [
  [/^\d+$/, '{n}'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '{uuid}'],
  [/^[0-9a-f]{16,}$/i, '{hex}'],
  [/^[0-9A-HJKMNP-TV-Z]{26}$/, '{ulid}'],
  [/^(?=.*\d)[A-Za-z0-9_-]{20,}$/, '{token}'],
  [/^[^@/]+@[^@/]+\.[a-z]{2,}$/i, '{email}'],
  // Business references like PO-7781, INV_20231, SKU12345.
  [/^[A-Za-z]{1,6}[-_]?\d{3,}$/, '{ref}'],
];

export function pathTemplate(path: string): string {
  const clean = (path.split('?')[0] ?? '/').split('#')[0]!;
  const segs = clean.split('/').map((seg) => {
    let s = seg;
    try {
      s = decodeURIComponent(seg);
    } catch {
      // keep as is
    }
    for (const [re, name] of SEGMENT_RULES) if (re.test(s)) return name;
    return seg;
  });
  return segs.join('/') || '/';
}

const templateRegex = (t: string) => new RegExp(`^${t.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[a-z]+\}/g, '[^/]+')}/?$`);

/** Body fields with a value each: JSON keys (dotted, [] for arrays, three levels deep) or form fields. */
function bodyParams(text: string, contentType: string): Array<[string, unknown]> {
  const t = text.trim();
  if (/json/i.test(contentType) || t.startsWith('{')) {
    try {
      const v = JSON.parse(t) as unknown;
      const out: Array<[string, unknown]> = [];
      const walk = (x: unknown, prefix: string, depth: number) => {
        if (depth > 3 || !x || typeof x !== 'object') return;
        if (Array.isArray(x)) return walk(x[0], `${prefix}[]`, depth + 1);
        for (const [k, val] of Object.entries(x)) {
          const name = prefix ? `${prefix}.${k}` : k;
          out.push([name, val]);
          walk(val, name, depth + 1);
        }
      };
      walk(v, '', 0);
      return out;
    } catch {
      return [];
    }
  }
  if (/x-www-form-urlencoded/i.test(contentType) || /^[\w.%[\]-]+=/.test(t)) return [...new URLSearchParams(t).entries()];
  return [];
}

/** Paths an app mentions in its own responses: hrefs, fetch/axios calls, JSON links. */
function referencedPaths(text: string, host: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    let p = raw;
    if (/^https?:\/\//i.test(p)) {
      try {
        const u = new URL(p);
        if (u.hostname !== host) return;
        p = u.pathname;
      } catch {
        return;
      }
    }
    p = p.split(/[?#]/)[0]!;
    if (!p.startsWith('/') || p.startsWith('//') || p.length < 2 || p.length > 200) return;
    if (/\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|map)$/i.test(p)) return;
    if (/[\s<>{}"'`\\]/.test(p)) return;
    out.add(p);
  };
  for (const m of text.matchAll(/(?:href|src|action)\s*=\s*["']([^"'#]+)["']/gi)) add(m[1]!);
  for (const m of text.matchAll(/["'`](\/(?:api|v\d|graphql|rest|auth|admin|internal|ajax|rpc|services?)[^"'`\s]*)["'`]/gi)) add(m[1]!);
  for (const m of text.matchAll(/["'`](https?:\/\/[^"'`\s]+)["'`]/gi)) add(m[1]!);
  return [...out];
}

export function coverage(store: CaptureStore, host: string, limit = 5000): CoverageReport {
  const rows = store.search(`host:${host}`, { limit });
  const map = new Map<string, EndpointCoverage & { bestStatus: number }>();
  const referenced = new Map<string, { foundIn: string; count: number }>();
  for (const e of rows) {
    if (e.isWebSocket && e.scheme.startsWith('mqtt')) continue;
    const template = pathTemplate(e.path);
    const key = `${e.method} ${template}`;
    let c = map.get(key);
    if (!c) {
      c = { method: e.method, template, count: 0, statuses: {}, queryParams: [], bodyParams: [], contentTypes: [], sources: [], firstAt: e.startedAt, lastAt: e.startedAt, exampleId: e.id, maxMs: null, auth: [], params: [], kind: e.isWebSocket ? 'websocket' : 'api', bestStatus: 999 };
      map.set(key, c);
    }
    c.count++;
    const st = e.status === null ? e.state : String(e.status);
    c.statuses[st] = (c.statuses[st] ?? 0) + 1;
    c.firstAt = Math.min(c.firstAt, e.startedAt);
    c.lastAt = Math.max(c.lastAt, e.startedAt);
    if (!c.sources.includes(e.source)) c.sources.push(e.source);
    if (e.durationMs !== null) c.maxMs = Math.max(c.maxMs ?? 0, e.durationMs);
    if (e.status !== null && e.status < c.bestStatus) ((c.bestStatus = e.status), (c.exampleId = e.id));
    const q = e.path.indexOf('?');
    const note = (where: 'query' | 'body', name: string, value: unknown) => {
      const ep = c!;
      let p = ep.params.find((x) => x.in === where && x.name === name);
      if (!p) ep.params.push((p = { in: where, name, types: [], example: /pass|secret|token|api.?key|credential/i.test(name) ? '(hidden)' : example(value) }));
      const t = where === 'query' ? 'string' : jsonType(value);
      if (!p.types.includes(t)) p.types.push(t);
    };
    if (q !== -1)
      for (const [k, v] of new URLSearchParams(e.path.slice(q + 1)).entries()) {
        if (!c.queryParams.includes(k)) c.queryParams.push(k);
        note('query', k, v);
      }
    if (c.count <= 50) {
      const ex = store.getExchange(e.id);
      if (!ex) continue;
      for (const a of authKinds(ex.requestHeaders)) if (!c.auth.includes(a)) c.auth.push(a);
      const reqType = ex.requestHeaders.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
      if (e.reqBodySize > 0 && e.reqBodySize < 65_536) {
        const b = store.getBody(e.id, 'request', true);
        if (b && looksLikeText(b))
          for (const [p, v] of bodyParams(bytesToString(b), reqType)) {
            if (!c.bodyParams.includes(p)) c.bodyParams.push(p);
            note('body', p, v);
          }
      }
      const resType = ex.responseHeaders?.find(([k]) => k.toLowerCase() === 'content-type')?.[1]?.split(';')[0]?.trim();
      if (resType && !c.contentTypes.includes(resType)) c.contentTypes.push(resType);
      if (resType && /html|javascript|json/i.test(resType) && (e.resBodySize ?? 0) < 2_000_000) {
        const b = store.getBody(e.id, 'response', true);
        if (b && looksLikeText(b)) {
          for (const p of referencedPaths(bytesToString(b), e.host)) {
            const r = referenced.get(p);
            if (r) r.count++;
            else referenced.set(p, { foundIn: e.id, count: 1 });
          }
        }
      }
    }
  }
  const endpoints = [...map.values()].map(({ bestStatus: _b, ...c }) => ({ ...c, kind: endpointKind(c.method, c.template, c.contentTypes, c.kind === 'websocket'), queryParams: c.queryParams.sort(), bodyParams: c.bodyParams.sort(), params: c.params.sort((a, b) => a.in.localeCompare(b.in) || a.name.localeCompare(b.name)) }));
  endpoints.sort((a, b) => a.template.localeCompare(b.template) || a.method.localeCompare(b.method));
  const patterns = endpoints.map((e) => templateRegex(e.template));
  const unexercised = [...referenced.entries()]
    .filter(([p]) => !patterns.some((re) => re.test(p)) && !patterns.some((re) => re.test(pathTemplate(p))))
    .map(([path, v]) => ({ path, ...v, kind: referenceKind(path) }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, 500);
  return { host, scanned: rows.length, endpoints, unexercised };
}
