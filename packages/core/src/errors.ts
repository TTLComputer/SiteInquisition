import { bytesToString, looksLikeText } from '@siteinquisition/codecs';
import { pathTemplate } from './coverage.js';
import { ERROR_SIGNATURES, INJECTION_KINDS, type ErrorKind, type ErrorSeverity, type ErrorSignature } from './errsigs.js';
import type { CaptureStore, Exchange, HeaderList } from './store.js';

export * from './errsigs.js';

/**
 * Recognize server errors in responses (database errors, stack traces,
 * framework debug pages, parser errors) and work out which part of the
 * request most likely caused each one.
 *
 * Attribution uses three kinds of evidence, strongest first:
 *  1. the error quotes part of the input ("near 'Brien' AND id=1'"), or names a field;
 *  2. a value differs from the original of a replay, or from similar requests to the
 *     same endpoint that did not error;
 *  3. a value holds characters that commonly break this kind of interpreter.
 */

export interface ErrorHit {
  sig: string;
  name: string;
  kind: ErrorKind;
  severity: ErrorSeverity;
  /** The matched text with a little context, at most about 300 characters. */
  excerpt: string;
  /** Named groups the pattern captured. */
  near?: string;
  param?: string;
  type?: string;
  pos?: number;
  file?: string;
  line?: number;
  tech?: string;
  hint: string;
}

export interface RequestPart {
  in: 'query' | 'path' | 'form' | 'json' | 'header' | 'cookie' | 'body';
  /** Parameter, header or cookie name; a JSONPath for JSON; "segment N" for the path. */
  name: string;
  value: string;
}

export interface ErrorCause extends RequestPart {
  /** 0 to 1. */
  confidence: number;
  reasons: string[];
}

export interface ErrorFinding extends ErrorHit {
  causes: ErrorCause[];
}

interface Compiled {
  sig: ErrorSignature;
  re: RegExp;
}

export const compileErrorSignatures = (list: ErrorSignature[] = ERROR_SIGNATURES): Compiled[] => list.map((sig) => ({ sig, re: new RegExp(sig.pattern, sig.flags ?? 'i') }));

const COMPILED = compileErrorSignatures();

/** Responses worth scanning: markup, JSON, XML and plain text. Scripts and styles quote error strings in their own code. */
export function scannable(headers: HeaderList | null): boolean {
  const ct = headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  if (!ct) return true;
  if (/javascript|ecmascript|css|wasm|image\/|font\/|audio\/|video\//i.test(ct)) return false;
  return /(text\/|json|xml|problem|html)/i.test(ct);
}

const pickGroup = (g: Record<string, string | undefined> | undefined, base: string): string | undefined => {
  if (!g) return undefined;
  for (const [k, v] of Object.entries(g)) if (v !== undefined && (k === base || new RegExp(`^${base}\\d+$`).test(k))) return v;
  return undefined;
};

const unhtml = (s: string) => s.replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Run error signatures over a response body. */
export function detectErrors(body: string, sigs: Compiled[] = COMPILED): ErrorHit[] {
  const out: ErrorHit[] = [];
  // HTML-escaped error text ("near &#39;x&#39;") matches after unescaping.
  let text = /&(#39|apos|quot|lt|gt|amp);/.test(body) ? unhtml(body) : body;
  // Errors inside JSON strings arrive escaped ("For input string: \"x\"\n\tat ...").
  if (/\\["nt\\]/.test(text)) text = text.replace(/\\(["\\/])/g, '$1').replace(/\\r?\\n/g, '\n').replace(/\\t/g, '\t');
  for (const { sig, re } of sigs) {
    const m = re.exec(text);
    if (!m) continue;
    const g = m.groups;
    const start = Math.max(0, m.index - 60);
    const excerpt = text
      .slice(start, Math.min(text.length, m.index + Math.max(m[0].length, 80) + 60))
      .replace(/<[^>]{0,200}>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    const near = pickGroup(g, 'near');
    const pos = pickGroup(g, 'pos');
    const line = pickGroup(g, 'line');
    out.push({
      sig: sig.id,
      name: sig.name,
      kind: sig.kind,
      severity: sig.severity,
      excerpt,
      ...(near !== undefined ? { near: near.replace(/''/g, "'") } : {}),
      ...(pickGroup(g, 'param') ? { param: pickGroup(g, 'param') } : {}),
      ...(pickGroup(g, 'type') ? { type: pickGroup(g, 'type')!.trim() } : {}),
      ...(pos ? { pos: Number(pos) } : {}),
      ...(pickGroup(g, 'file') ? { file: pickGroup(g, 'file') } : {}),
      ...(line ? { line: Number(line) } : {}),
      ...(sig.tech ? { tech: sig.tech } : {}),
      hint: sig.hint,
    });
  }
  return out;
}

// ---------- request parts ----------

const SKIP_HEADERS = new Set(['host', 'content-length', 'connection', 'accept', 'accept-encoding', 'accept-language', 'cache-control', 'pragma', 'upgrade-insecure-requests', 'cookie', 'te', 'priority', 'dnt', 'if-none-match', 'if-modified-since']);

function jsonLeaves(v: unknown, path: string, out: RequestPart[], depth = 0) {
  if (depth > 8 || out.length > 400) return;
  if (v === null || typeof v !== 'object') {
    out.push({ in: 'json', name: path, value: v === null ? 'null' : String(v) });
    return;
  }
  if (Array.isArray(v)) v.forEach((x, i) => jsonLeaves(x, `${path}[${i}]`, out, depth + 1));
  else for (const [k, x] of Object.entries(v)) jsonLeaves(x, /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`, out, depth + 1);
}

/** Every value a request carries, by where it sits. */
export function requestParts(req: { url: string; headers: HeaderList }, body: string | null): RequestPart[] {
  const out: RequestPart[] = [];
  const u = new URL(req.url);
  u.pathname
    .split('/')
    .slice(1)
    .forEach((seg, i) => {
      if (!seg) return;
      let v = seg;
      try {
        v = decodeURIComponent(seg);
      } catch {
        // keep it raw
      }
      out.push({ in: 'path', name: `segment ${i + 1}`, value: v });
    });
  for (const [k, v] of u.searchParams) out.push({ in: 'query', name: k, value: v });
  for (const [k, v] of req.headers) {
    const lk = k.toLowerCase();
    if (lk === 'cookie') {
      for (const part of v.split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out.push({ in: 'cookie', name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() });
      }
    } else if (!SKIP_HEADERS.has(lk) && !lk.startsWith('sec-') && !lk.startsWith(':')) out.push({ in: 'header', name: k, value: v });
  }
  if (body) {
    const ct = req.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    let parsed = false;
    if (/x-www-form-urlencoded/i.test(ct)) {
      for (const [k, v] of new URLSearchParams(body)) out.push({ in: 'form', name: k, value: v });
      parsed = true;
    } else if (/json/i.test(ct) || /^\s*[[{]/.test(body)) {
      try {
        jsonLeaves(JSON.parse(body), '$', out);
        parsed = true;
      } catch {
        parsed = false;
      }
    }
    if (!parsed) out.push({ in: 'body', name: 'body', value: body.slice(0, 64 * 1024) });
  }
  return out;
}

// ---------- attribution ----------

/** Characters that commonly break each kind of interpreter. */
const BREAKERS: Partial<Record<ErrorKind, Array<[RegExp, string]>>> = {
  sql: [
    [/'/, "a single quote (')"],
    [/"/, 'a double quote (")'],
    [/`/, 'a backtick'],
    [/;|--|\/\*|#\s*$/, 'a statement separator or comment (; -- /* #)'],
    [/\b(?:union|select|or|and|sleep|benchmark|waitfor)\b/i, 'SQL keywords'],
    [/\\$/, 'a trailing backslash'],
  ],
  nosql: [
    [/\$(?:ne|gt|gte|lt|lte|in|nin|regex|where|exists|expr)\b/, 'a MongoDB operator'],
    [/^\s*[[{]/, 'an object or array in place of a plain value'],
  ],
  template: [[/\{\{|\{%|\$\{|<%|#\{|\[\[|\*\{/, 'template syntax ({{ }}, ${ }, <% %>)']],
  xml: [
    [/<!(?:DOCTYPE|ENTITY)/i, 'a DOCTYPE or ENTITY declaration'],
    [/&[\w#]+;?|<\/?\w/, 'XML markup or an entity reference'],
  ],
  command: [[/[;|&`]|\$\(|\$\{IFS|\n/, 'shell metacharacters (; | & ` $( ))']],
  file: [
    [/\.\.[/\\]|%2e%2e/i, 'a ../ path traversal sequence'],
    [/^(?:\/|[a-z]:\\|file:|php:|https?:)/i, 'an absolute path or URL'],
    [/\0|%00/, 'a NUL byte'],
  ],
  ldap: [[/[*()&|\\]/, 'LDAP filter characters (* ( ) & |)']],
  deserialization: [[/^rO0AB|^aced0005|^O:\d+:"|^a:\d+:\{|^AAEAAAD|^\x80[\x02-\x05]|^gASV/i, 'a serialized object (Java, PHP, .NET or pickle)']],
};

const significant = (p: RequestPart) => p.value.length > 0 && p.value.length < 20_000;

function longestSharedPrefix(fragment: string, value: string): number {
  // How much of the start of the fragment appears somewhere in the value.
  let lo = 0;
  let hi = Math.min(fragment.length, 200);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (value.includes(fragment.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function baselineValues(store: CaptureStore, ex: Exchange): { original?: RequestPart[]; similar: RequestPart[][] } {
  const textOf = (e: Exchange) => {
    const b = store.getBody(e.id, 'request', true);
    return b && b.length && b.length < 256 * 1024 && looksLikeText(b) ? bytesToString(b) : null;
  };
  const ok = (e: Exchange) => !e.errors?.length && e.status !== null && e.status < 500;
  let original: RequestPart[] | undefined;
  if (ex.replayOf) {
    const o = store.getExchange(ex.replayOf);
    if (o && ok(o)) original = requestParts({ url: o.url, headers: o.requestHeaders }, textOf(o));
  }
  const tpl = pathTemplate(ex.path);
  const similar: RequestPart[][] = [];
  const cands = store.search(`host:${ex.host} method:${ex.method} path:${tpl.split('/').slice(0, 2).join('/') || '/'}`, { limit: 60, before: ex.id });
  for (const s of cands) {
    if (similar.length >= 20) break;
    if (s.id === ex.replayOf || pathTemplate(s.path) !== tpl || s.errors?.length || s.status === null || s.status >= 500) continue;
    const e = store.getExchange(s.id);
    if (e) similar.push(requestParts({ url: e.url, headers: e.requestHeaders }, textOf(e)));
  }
  return { original, similar };
}

const key = (p: RequestPart) => `${p.in}\n${p.name}`;

/** Rank the parts of a request by how likely each one caused an error. */
export function attribute(hit: ErrorHit, parts: RequestPart[], baseline: { original?: RequestPart[]; similar: RequestPart[][] } = { similar: [] }, body?: string | null): ErrorCause[] {
  const scores = new Map<string, { part: RequestPart; miss: number; reasons: string[] }>();
  const add = (p: RequestPart, s: number, reason: string) => {
    const k = key(p);
    const cur = scores.get(k) ?? { part: p, miss: 1, reasons: [] };
    cur.miss *= 1 - s;
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    scores.set(k, cur);
  };
  const candidates = parts.filter(significant);

  // 1. The error quotes input.
  const near = hit.near?.trim();
  if (near) {
    for (const p of candidates) {
      if (near.length >= 2 && p.value.includes(near)) add(p, 0.95, `the error quotes this value ("${clip(near)}")`);
      else {
        const n = longestSharedPrefix(near, p.value);
        if (n >= 6 || (n >= 3 && (n === near.length || p.value.endsWith(near.slice(0, n))))) add(p, 0.9, `the error quotes text from this value ("${clip(near.slice(0, n))}")`);
        else if (near.length >= 3 && near.includes(p.value) && p.value.length >= 3) add(p, 0.8, `this value appears in the text the error quotes ("${clip(near)}")`);
      }
    }
  }
  if (hit.param) {
    const want = hit.param.toLowerCase().split('.').pop()!;
    for (const p of candidates) {
      const last = p.name.toLowerCase().replace(/^\$\.?/, '').split(/[.[\]"]+/).filter(Boolean).pop() ?? '';
      if (last === want) add(p, 0.85, `the error names the field "${hit.param}"`);
      else if (p.value === hit.param) add(p, 0.7, `the error names "${hit.param}", which is this value`);
    }
  }
  if (hit.kind === 'parse' && body) {
    try {
      JSON.parse(body);
    } catch (e) {
      const bodyPart = candidates.find((p) => p.in === 'body') ?? { in: 'body' as const, name: 'body', value: body.slice(0, 64 * 1024) };
      add(bodyPart, 0.85, `the request body is not valid JSON (${(e as Error).message.slice(0, 80)})`);
    }
  }

  // 2. What changed compared to requests that worked.
  const orig = baseline.original ? new Map(baseline.original.map((p) => [key(p), p.value])) : undefined;
  const sims = baseline.similar.map((ps) => new Map(ps.map((p) => [key(p), p.value])));
  for (const p of candidates) {
    if (p.in === 'header' || (p.in === 'cookie' && !orig)) continue;
    if (orig) {
      const before = orig.get(key(p));
      if (before !== p.value) add(p, 0.6, before === undefined ? 'not in the original request, which did not error' : `changed from "${clip(before)}" in the original request, which did not error`);
    }
    if (sims.length >= 2 && sims.every((m) => m.get(key(p)) !== p.value)) add(p, 0.3, `differs from ${sims.length} similar requests that did not error`);
  }

  // 3. Characters that break this kind of interpreter.
  for (const [re, what] of BREAKERS[hit.kind] ?? []) {
    for (const p of candidates) {
      if (p.in === 'header' && !['user-agent', 'referer', 'x-forwarded-for'].includes(p.name.toLowerCase())) continue;
      if (re.test(p.value)) add(p, 0.45, `contains ${what}`);
    }
  }

  return [...scores.values()]
    .map(({ part, miss, reasons }) => ({ ...part, value: part.value.length > 300 ? `${part.value.slice(0, 300)}…` : part.value, confidence: Math.round((1 - miss) * 100) / 100, reasons }))
    .filter((c) => c.confidence >= 0.3 && (c.confidence >= 0.5 || INJECTION_KINDS.includes(hit.kind) || c.reasons.length > 1))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------- the service ----------

export class ErrorService {
  private compiled = COMPILED;

  constructor(private readonly store: CaptureStore) {}

  signatures(): ErrorSignature[] {
    return ERROR_SIGNATURES;
  }

  setDisabled(ids: string[]) {
    const off = new Set(ids);
    this.compiled = COMPILED.filter((c) => !off.has(c.sig.id));
  }

  private responseText(ex: Exchange): string | null {
    if (!ex.responseHeaders || !ex.resBodySize || ex.resBodySize > 8 * 1024 * 1024 || !scannable(ex.responseHeaders)) return null;
    const b = this.store.getBody(ex.id, 'response', true);
    if (!b?.length) return null;
    const cut = b.subarray(0, 512 * 1024);
    return looksLikeText(cut) ? bytesToString(cut) : null;
  }

  private requestText(ex: Exchange): string | null {
    const b = this.store.getBody(ex.id, 'request', true);
    return b && b.length && b.length < 1024 * 1024 && looksLikeText(b) ? bytesToString(b.subarray(0, 256 * 1024)) : null;
  }

  /** Detect errors in one exchange's response and record them, with their likely causes. */
  observe(ex: Exchange): ErrorFinding[] {
    const text = this.responseText(ex);
    const hits = text ? detectErrors(text, this.compiled) : [];
    if (!hits.length) {
      if (ex.errors?.length) this.store.setExchangeErrors(ex.id, []);
      return [];
    }
    const body = this.requestText(ex);
    const parts = requestParts({ url: ex.url, headers: ex.requestHeaders }, body);
    const baseline = baselineValues(this.store, ex);
    const findings = hits.map((h) => ({ ...h, causes: attribute(h, parts, baseline, body) }));
    this.store.setExchangeErrors(
      ex.id,
      findings.map((f) => ({ sig: f.sig, kind: f.kind, severity: f.severity, data: f as unknown as Record<string, unknown> })),
      ex.startedAt,
    );
    return findings;
  }

  /** The errors recorded for an exchange. */
  findings(exchangeId: string): ErrorFinding[] {
    return this.store.exchangeErrors(exchangeId).map((r) => r.data as unknown as ErrorFinding);
  }
}
