import { bytesToString, looksLikeText } from '@siteinquisition/codecs';
import { cookiesFromResponse } from './cookies.js';
import { pathTemplate } from './coverage.js';
import { newId } from './ids.js';
import { globToRegExp } from './scope.js';
import type { RunResult } from './scripts.js';
import type { SendOptions, Sender } from './send.js';
import type { CaptureStore, Exchange, HeaderList } from './store.js';
import { exchangeField, jsonOf, moveTag, walkLeaves } from './values.js';

/**
 * Flows: named, repeatable setup. Each step sends a request (with tokens)
 * or runs a script, and can pull values out of its response into the
 * flow's variables. A later step uses them as {{var:name}}, and any request
 * can run a flow for itself with {{flow:name.var}} so every send gets, say,
 * a brand-new purchase order.
 */
export interface FlowExtract {
  /** Variable to set. */
  name: string;
  /**
   * What to read from the response: a JSONPath ($.order.number), a key name
   * found anywhere in the JSON (number), header.Name, cookie.Name, status,
   * body, or req.<field> for the request side.
   */
  from: string;
  /** Optional regex; group 1 (or the whole match) is kept. */
  regex?: string;
}

export interface FlowStep {
  id: string;
  name?: string;
  kind: 'request' | 'script';
  method?: string;
  url?: string;
  headers?: HeaderList;
  body?: string;
  /** Encode the body with this codec chain after tokens are resolved (body is written decoded). */
  bodyChain?: string[];
  extract?: FlowExtract[];
  /** Fail the flow unless the status matches: "2xx", "201", "200,201,204". */
  expect?: string;
  /** Move this tag onto the step's exchange, so {{$tag.field}} references follow the newest run. */
  tag?: string;
  /** Script step: JavaScript with `vars` (this flow's variables) and the siq SDK. */
  code?: string;
}

export interface ApiFlow {
  id: string;
  name: string;
  description?: string;
  /** Default values for variables a caller may override. */
  inputs?: Record<string, string>;
  steps: FlowStep[];
  /** Also copy the flow's variables into project variables after a successful run. */
  saveVars?: boolean;
  /** Run automatically when a send to this host gets one of these statuses (a login flow). */
  onAuthFail?: { host: string; statuses?: number[] };
  enabled?: boolean;
}

export interface FlowStepResult {
  index: number;
  name: string;
  exchangeId?: string;
  status: number | null;
  extracted: Record<string, string>;
  error?: string;
  logs?: RunResult['logs'];
  ms: number;
}

export interface FlowRunResult {
  runId: string;
  ok: boolean;
  flowId: string;
  name: string;
  vars: Record<string, string>;
  steps: FlowStepResult[];
  ms: number;
  error?: string;
}

export const MAX_FLOW_DEPTH = 4;

export function statusOk(expect: string | undefined, status: number | null): boolean {
  if (!expect?.trim()) return status !== null;
  if (status === null) return false;
  return expect.split(',').some((p) => {
    const t = p.trim().toLowerCase();
    if (/^\dxx$/.test(t)) return Math.floor(status / 100) === Number(t[0]);
    return Number(t) === status;
  });
}

export function normalizeFlow(f: Omit<ApiFlow, 'id'> & { id?: string }): ApiFlow {
  if (!f.name?.trim()) throw new Error('a flow needs a name');
  if (!/^[\w.-]+$/.test(f.name.trim())) throw new Error(`flow name "${f.name}" can only use letters, digits, _ . - (it is used in {{flow:${f.name}.var}})`);
  if (!Array.isArray(f.steps) || !f.steps.length) throw new Error('a flow needs at least one step');
  const steps = f.steps.map((s) => {
    if (s.kind === 'script') {
      if (typeof s.code !== 'string') throw new Error('a script step needs code');
    } else if (!s.method || !s.url) throw new Error('a request step needs a method and a URL');
    for (const e of s.extract ?? []) {
      if (!/^[\w.-]+$/.test(e.name)) throw new Error(`invalid variable name "${e.name}"`);
      if (e.regex) new RegExp(e.regex);
    }
    return { ...s, kind: s.kind ?? 'request', id: s.id ?? newId() } as FlowStep;
  });
  return { ...f, name: f.name.trim(), steps, id: f.id ?? newId() };
}

/** Read one extraction from a finished exchange. */
export function extractValue(store: CaptureStore, ex: Exchange, e: FlowExtract): string | undefined {
  let field = e.from.trim();
  let side: 'request' | 'response' = 'response';
  const sm = /^(req|request|res|response)\.(.+)$/.exec(field);
  if (sm) {
    side = sm[1]!.startsWith('req') ? 'request' : 'response';
    field = sm[2]!;
  }
  let v: string | undefined;
  const cm = /^cookie\.(.+)$/i.exec(field);
  if (cm) v = cookiesFromResponse({ id: ex.id, host: ex.host, path: ex.path, startedAt: ex.startedAt, headers: ex.responseHeaders ?? [] }).find((c) => c.name === cm[1])?.value;
  else v = exchangeField(store, ex, side, field);
  if (v === undefined || !e.regex) return v;
  const m = new RegExp(e.regex).exec(v);
  return m ? (m[1] ?? m[0]) : undefined;
}

export interface FlowDeps {
  store: CaptureStore;
  sender: () => Sender;
  flows: () => ApiFlow[];
  /** Run a script step; it may change `vars`. */
  runScript: (code: string, name: string, vars: Record<string, string>) => Promise<RunResult>;
  globalVars: () => Record<string, string>;
  setGlobalVar: (name: string, value: string, source: string) => void;
}

export class FlowRunner {
  constructor(private readonly d: FlowDeps) {}

  find(nameOrId: string): ApiFlow | undefined {
    const list = this.d.flows();
    return list.find((f) => f.id === nameOrId) ?? list.find((f) => f.name === nameOrId) ?? list.find((f) => f.name.toLowerCase() === nameOrId.toLowerCase());
  }

  /** A login flow that wants to run when `host` answers `status`. */
  authFlowFor(host: string, status: number): ApiFlow | undefined {
    return this.d.flows().find((f) => f.enabled !== false && f.onAuthFail && globToRegExp(f.onAuthFail.host).test(host) && (f.onAuthFail.statuses ?? [401, 403]).includes(status));
  }

  async run(nameOrId: string | ApiFlow, inputs: Record<string, string> = {}, depth = 0, opts: Pick<SendOptions, 'ignoreTlsErrors' | 'timeoutMs'> = {}): Promise<FlowRunResult> {
    const flow = typeof nameOrId === 'string' ? this.find(nameOrId) : nameOrId;
    if (!flow) throw new Error(`no flow "${String(nameOrId)}"`);
    if (depth > MAX_FLOW_DEPTH) throw new Error(`flows nest more than ${MAX_FLOW_DEPTH} deep (does "${flow.name}" refer to itself?)`);
    const t0 = Date.now();
    const runId = newId();
    const vars: Record<string, string> = { ...(flow.inputs ?? {}), ...inputs };
    const steps: FlowStepResult[] = [];
    const finish = (error?: string): FlowRunResult => {
      const ok = !error;
      if (ok && flow.saveVars) for (const [k, v] of Object.entries(vars)) this.d.setGlobalVar(k, v, `flow:${flow.name}`);
      return { runId, ok, flowId: flow.id, name: flow.name, vars, steps, ms: Date.now() - t0, ...(error ? { error } : {}) };
    };
    for (let i = 0; i < flow.steps.length; i++) {
      const s = flow.steps[i]!;
      const label = s.name || (s.kind === 'script' ? `script ${i + 1}` : `${s.method} ${s.url}`);
      const st = Date.now();
      if (s.kind === 'script') {
        const res = await this.d.runScript(s.code ?? '', `${flow.name}-${i + 1}`, vars);
        for (const [k, v] of Object.entries(vars)) if (typeof v !== 'string') vars[k] = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        steps.push({ index: i, name: label, status: null, extracted: {}, logs: res.logs, ms: Date.now() - st, ...(res.ok ? {} : { error: res.error ?? res.tests.find((t) => !t.ok)?.error ?? 'script failed' }) });
        if (!res.ok) return finish(`step ${i + 1} (${label}): ${steps[steps.length - 1]!.error}`);
        continue;
      }
      try {
        const res = await this.d.sender().send(
          { method: s.method!, url: s.url!, headers: s.headers ?? [], body: s.body ? new TextEncoder().encode(s.body) : undefined },
          { refreshCookies: true, vars, bodyChain: s.bodyChain, flowDepth: depth + 1, ignoreTlsErrors: opts.ignoreTlsErrors, timeoutMs: opts.timeoutMs },
        );
        const tags = [`flow:${flow.name}`, `flowrun:${runId}`];
        this.d.store.tagExchange(res.id, [...new Set([...(this.d.store.getSummary(res.id)?.tags ?? []), ...tags])]);
        if (s.tag) moveTag(this.d.store, s.tag, res.id);
        const ex = this.d.store.getExchange(res.id)!;
        const extracted: Record<string, string> = {};
        const missing: string[] = [];
        for (const e of s.extract ?? []) {
          const v = extractValue(this.d.store, ex, e);
          if (v === undefined) missing.push(e.name);
          else extracted[e.name] = vars[e.name] = v;
        }
        const result: FlowStepResult = { index: i, name: label, exchangeId: res.id, status: res.status, extracted, ms: Date.now() - st };
        steps.push(result);
        if (!statusOk(s.expect, res.status)) {
          result.error = res.status === null ? (ex.error ?? 'no response') : `status ${res.status}, expected ${s.expect || 'a response'}`;
          return finish(`step ${i + 1} (${label}): ${result.error}`);
        }
        if (missing.length) {
          result.error = `could not extract ${missing.join(', ')}`;
          return finish(`step ${i + 1} (${label}): ${result.error}`);
        }
      } catch (e) {
        steps.push({ index: i, name: label, status: null, extracted: {}, error: (e as Error).message, ms: Date.now() - st });
        return finish(`step ${i + 1} (${label}): ${(e as Error).message}`);
      }
    }
    return finish();
  }
}

// ---------- make a flow from recorded exchanges ----------

export interface WiringNote {
  /** Step that produced the value. */
  fromStep: number;
  toStep: number;
  variable: string;
  value: string;
  /** Where it was read: a JSONPath or header.Name. */
  from: string;
  /** Where it was used: url, header Name, body. */
  usedIn: string[];
}

export interface FlowDraft {
  flow: Omit<ApiFlow, 'id'>;
  wiring: WiringNote[];
  /** Values replaced by generators ({{uuid}}). */
  generated: Array<{ step: number; value: string; token: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIP_HEADERS = new Set(['host', 'content-length', 'cookie', 'connection', 'accept-encoding', 'transfer-encoding', 'te', 'keep-alive', 'proxy-connection', 'upgrade', 'http2-settings']);
const skippable = (k: string) => SKIP_HEADERS.has(k.toLowerCase()) || k.startsWith(':');

/** Values worth wiring: long enough, not booleans, not tiny numbers. */
const wireable = (v: string) => v.length >= 3 && !/^(true|false|null|ok|yes|no|GET|POST|PUT|json|text|html)$/i.test(v) && !/^\d{1,2}$/.test(v) && v.length <= 4096;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace whole-token occurrences of `value` in `text`. */
function replaceValue(text: string, value: string, token: string): { text: string; n: number } {
  let n = 0;
  const re = new RegExp(`(?<![\\w-])${escapeRe(value)}(?![\\w-])`, 'g');
  const out = text.replace(re, () => (n++, token));
  if (n) return { text: out, n };
  // URL-encoded uses (a value with spaces or symbols inside a query string)
  const enc = encodeURIComponent(value);
  if (enc !== value) {
    const re2 = new RegExp(`(?<![\\w-])${escapeRe(enc)}(?![\\w-])`, 'g');
    const out2 = text.replace(re2, () => (n++, `${token.slice(0, -2)} | url}}`));
    return { text: out2, n };
  }
  return { text, n: 0 };
}

function niceName(path: string, used: Set<string>, template: string): string {
  const keys = path.match(/[A-Za-z_][\w]*/g) ?? ['value'];
  let base = keys[keys.length - 1]!;
  if (/^(id|uuid|number|no|code|key|ref)$/i.test(base)) {
    // "id" alone says little: prefix with the parent key or the resource name from the path.
    const parent = keys.length > 1 ? keys[keys.length - 2]! : (template.split('/').filter((s) => s && !s.startsWith('{')).pop() ?? '').replace(/s$/, '');
    if (parent && !/^(data|result|items|body|response)$/i.test(parent)) base = `${parent.replace(/[^\w]/g, '_')}_${base}`;
  }
  base = base.replace(/[^\w.-]/g, '_').slice(0, 40) || 'value';
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}${i}`;
  used.add(name);
  return name;
}

/**
 * Turn exchanges made by hand (login, create cart, add item, create PO) into
 * a flow: requests become steps, and values an earlier response handed out
 * that a later request sent back are replaced by variables, with an
 * extraction on the step that produced them. Cookies are left to the jar.
 */
export function draftFlow(store: CaptureStore, exchangeIds: string[], name = 'new-flow'): FlowDraft {
  const exs = exchangeIds
    .map((id) => store.getExchange(id))
    .filter((e): e is Exchange => !!e)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (!exs.length) throw new Error('select one or more recorded requests');
  const used = new Set<string>();
  const steps: FlowStep[] = exs.map((ex) => {
    const b = store.getBody(ex.id, 'request', true);
    return {
      id: newId(),
      name: `${ex.method} ${pathTemplate(ex.path)}`,
      kind: 'request',
      method: ex.method,
      url: ex.url,
      headers: ex.requestHeaders.filter(([k]) => !skippable(k)),
      body: b?.length && looksLikeText(b) ? bytesToString(b) : undefined,
      extract: [],
      expect: ex.status !== null ? `${Math.floor(ex.status / 100)}xx` : undefined,
    };
  });
  // Values each response produced: concrete JSONPath, plus useful headers.
  const produced = exs.map((ex) => {
    const out: Array<{ value: string; from: string }> = [];
    const json = jsonOf(store, ex.id, 'response');
    if (json !== undefined) walkLeaves(json, (concrete, _n, _name, v) => out.push({ value: String(v), from: concrete }));
    for (const [k, v] of ex.responseHeaders ?? []) {
      const lk = k.toLowerCase();
      if (lk === 'location') {
        const id = v.split('?')[0]!.split('/').filter(Boolean).pop();
        if (id) out.push({ value: id, from: `header.${k}` });
      } else if (/token|csrf|xsrf|request-id|etag|auth/i.test(lk) && !/^set-cookie$/i.test(lk)) out.push({ value: v, from: `header.${k}` });
    }
    // Longest first so "8812-A" is wired before "8812".
    return out.filter((p) => wireable(p.value)).sort((a, b) => b.value.length - a.value.length);
  });
  const wiring: WiringNote[] = [];
  const generated: FlowDraft['generated'] = [];
  const varFor = new Map<string, string>();
  for (let j = 1; j < steps.length; j++) {
    const step = steps[j]!;
    for (let i = j - 1; i >= 0; i--) {
      for (const p of produced[i]!) {
        const token = () => {
          const key = `${i} ${p.from}`;
          let v = varFor.get(key);
          if (!v) {
            v = niceName(p.from, used, pathTemplate(exs[i]!.path));
            varFor.set(key, v);
            steps[i]!.extract!.push({ name: v, from: p.from });
          }
          return `{{var:${v}}}`;
        };
        const usedIn: string[] = [];
        // Check before creating a variable, so unused values make no extractions.
        const inUrl = replaceValue(step.url!, p.value, '{{x}}').n;
        const inHeaders = step.headers!.filter(([, v]) => replaceValue(v, p.value, '{{x}}').n);
        const inBody = step.body ? replaceValue(step.body, p.value, '{{x}}').n : 0;
        if (!inUrl && !inHeaders.length && !inBody) continue;
        const t = token();
        if (inUrl) ((step.url = replaceValue(step.url!, p.value, t).text), usedIn.push('url'));
        step.headers = step.headers!.map(([k, v]) => {
          const r = replaceValue(v, p.value, t);
          if (r.n) usedIn.push(`header ${k}`);
          return [k, r.text];
        });
        if (inBody) ((step.body = replaceValue(step.body!, p.value, t).text), usedIn.push('body'));
        wiring.push({ fromStep: i, toStep: j, variable: t.slice(6, -2), value: p.value, from: p.from, usedIn });
      }
    }
  }
  // UUIDs a request made up itself (idempotency keys, client ids) get a fresh one each run.
  steps.forEach((step, j) => {
    const fields = [step.url ?? '', ...(step.headers ?? []).map(([, v]) => v), step.body ?? ''];
    const seen = new Set<string>();
    for (const f of fields) for (const m of f.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) if (UUID.test(m[0])) seen.add(m[0]);
    for (const u of seen) {
      const fromEarlier = produced.slice(0, j).some((list) => list.some((p) => p.value === u));
      if (fromEarlier) continue;
      step.url = step.url!.split(u).join('{{uuid}}');
      step.headers = step.headers!.map(([k, v]) => [k, v.split(u).join('{{uuid}}')]);
      if (step.body) step.body = step.body.split(u).join('{{uuid}}');
      generated.push({ step: j, value: u, token: '{{uuid}}' });
    }
  });
  // The last step's response values are the flow's outputs: extract the id-like ones.
  const last = exs[exs.length - 1]!;
  const lastJson = jsonOf(store, last.id, 'response');
  if (lastJson !== undefined && lastJson && typeof lastJson === 'object') {
    walkLeaves(lastJson, (concrete, _n, key) => {
      if (/^\$\.[\w]+$|^\$\.(data|result|order|item)\.[\w]+$/.test(concrete) && /(id|number|no|code|ref|key|uuid)$/i.test(key) && steps[steps.length - 1]!.extract!.length < 6) {
        const v = niceName(concrete, used, pathTemplate(last.path));
        steps[steps.length - 1]!.extract!.push({ name: v, from: concrete });
      }
    });
  }
  return { flow: { name: name.replace(/[^\w.-]/g, '-'), steps }, wiring, generated };
}
