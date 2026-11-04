import * as vm from 'node:vm';
import * as codecs from '@siteinquisition/codecs';
import * as jp from '@siteinquisition/codecs/jsonpath';

/**
 * The part of the script engine that runs inside a script host process
 * (see scripthost.ts): globals, test helpers, hook calls and one-off runs.
 * Nothing here talks to the core directly; the host passes in an SDK whose
 * calls go back to the core over IPC.
 */

export interface LogLine {
  at: number;
  level: 'log' | 'warn' | 'error' | 'info';
  text: string;
}

export interface TestResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface RunResult {
  ok: boolean;
  value?: string;
  error?: string;
  logs: LogLine[];
  tests: TestResult[];
  ms: number;
}

/** A request or response as hooks see it. */
export interface WireMessage {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
  status?: number;
  statusMessage?: string;
}

export const HOOK_BUDGET_MS = 50;
export const RUN_TIMEOUT_MS = 60_000;

export const fmt = (v: unknown): string => {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? `<${x.length} bytes>` : typeof x === 'bigint' ? String(x) : x), 2) ?? String(v);
  } catch {
    return String(v);
  }
};

export function baseGlobals(logs: LogLine[]) {
  const push = (level: LogLine['level']) => (...a: unknown[]) => {
    logs.push({ at: Date.now(), level, text: a.map(fmt).join(' ') });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
  };
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    console: { log: push('log'), info: push('info'), warn: push('warn'), error: push('error') },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    structuredClone,
    codecs: {
      decode: (chain: string, input: string | Uint8Array) => codecs.decodeChain(chain, input),
      encode: (chain: string, value: unknown) => dec.decode(codecs.encodeChain(chain, value)),
      detect: (input: string | Uint8Array) => codecs.detectChain(input),
      text: (b: Uint8Array) => dec.decode(b),
      bytes: (s: string) => enc.encode(s),
    },
    jsonpath: { query: jp.query, bulk: jp.bulk, update: jp.update },
  };
}

class Expectation {
  constructor(
    private readonly actual: unknown,
    private readonly negate = false,
  ) {}
  get not() {
    return new Expectation(this.actual, !this.negate);
  }
  private check(ok: boolean, msg: string) {
    if (ok === this.negate) throw new Error(`expected ${fmt(this.actual)} ${this.negate ? 'not ' : ''}${msg}`);
  }
  toBe(v: unknown) {
    this.check(Object.is(this.actual, v), `to be ${fmt(v)}`);
  }
  toEqual(v: unknown) {
    this.check(JSON.stringify(this.actual) === JSON.stringify(v), `to equal ${fmt(v)}`);
  }
  toContain(v: unknown) {
    const a = this.actual as string | unknown[];
    this.check(typeof a === 'string' ? a.includes(String(v)) : Array.isArray(a) && a.some((x) => JSON.stringify(x) === JSON.stringify(v)), `to contain ${fmt(v)}`);
  }
  toMatch(re: RegExp | string) {
    this.check(new RegExp(re).test(String(this.actual)), `to match ${String(re)}`);
  }
  toBeGreaterThan(n: number) {
    this.check(Number(this.actual) > n, `to be greater than ${n}`);
  }
  toBeLessThan(n: number) {
    this.check(Number(this.actual) < n, `to be less than ${n}`);
  }
  toBeTruthy() {
    this.check(!!this.actual, 'to be truthy');
  }
}

/** The object a hook sees: plain data plus a few helpers. */
const toSandbox = (msg: WireMessage) => ({
  method: msg.method,
  url: msg.url,
  headers: msg.headers.map(([k, v]) => [k, v]),
  status: msg.status,
  statusMessage: msg.statusMessage,
  body: new TextDecoder().decode(msg.body),
  bodyBytes: msg.body,
  header(name: string) {
    return (this.headers as string[][]).find(([k]) => k!.toLowerCase() === name.toLowerCase())?.[1];
  },
  setHeader(name: string, value: string) {
    const h = (this.headers as string[][]).filter(([k]) => k!.toLowerCase() !== name.toLowerCase());
    h.push([name, String(value)]);
    this.headers = h;
  },
  removeHeader(name: string) {
    this.headers = (this.headers as string[][]).filter(([k]) => k!.toLowerCase() !== name.toLowerCase());
  },
});

type SandboxMsg = ReturnType<typeof toSandbox>;

/** Copy a hook's edits back onto the message; returns whether anything changed. */
export function fromSandbox(orig: WireMessage, s: SandboxMsg, originalBody: string): boolean {
  let changed = false;
  if (typeof s.method === 'string' && s.method !== orig.method) ((orig.method = s.method.toUpperCase()), (changed = true));
  if (typeof s.url === 'string' && s.url !== orig.url) ((orig.url = s.url), (changed = true));
  if (Array.isArray(s.headers)) {
    const h = s.headers.map((p) => [String(p[0]), String(p[1])] as [string, string]);
    if (JSON.stringify(h) !== JSON.stringify(orig.headers)) ((orig.headers = h), (changed = true));
  }
  if (typeof s.status === 'number' && s.status !== orig.status) ((orig.status = s.status), (changed = true));
  if (typeof s.body === 'string' && s.body !== originalBody) ((orig.body = new TextEncoder().encode(s.body)), (changed = true));
  else if (ArrayBuffer.isView(s.bodyBytes) && s.bodyBytes !== orig.body) ((orig.body = new Uint8Array(s.bodyBytes.buffer.slice(s.bodyBytes.byteOffset, s.bodyBytes.byteOffset + s.bodyBytes.byteLength))), (changed = true));
  return changed;
}

/** Lines that cannot follow `return`, so the console does not try to return them. */
const NOT_AN_EXPRESSION = /^(return|const|let|var|if|for|while|do|switch|function|class|throw|try|import|export|\}|test\()/;

/**
 * Compile a script as an async function whose value is its last expression,
 * like a console: try returning the final statement, and fall back to running
 * it as written when that does not parse. A last line with several
 * statements (`await x; while (...) {}`) runs as written, so nothing after a
 * semicolon is skipped.
 */
export function compileWithResult(code: string, name: string): vm.Script {
  const filename = `${name}.js`;
  const lines = code.replace(/\s+$/, '').split('\n');
  let i = lines.length - 1;
  while (i >= 0 && (!lines[i]!.trim() || lines[i]!.trim().startsWith('//'))) i--;
  const last = lines[i]?.trim().replace(/;\s*$/, '') ?? '';
  if (i >= 0 && !NOT_AN_EXPRESSION.test(last)) {
    const withReturn = [...lines.slice(0, i), `return (${last}\n)`, ...lines.slice(i + 1)].join('\n');
    try {
      return new vm.Script(`(async () => {\n${withReturn}\n})()`, { filename });
    } catch {
      // not a single expression on that line; run as written
    }
  }
  return new vm.Script(`(async () => {\n${code}\n})()`, { filename });
}

export interface TrustedExtras {
  require?: NodeJS.Require;
  process?: NodeJS.Process;
  Buffer?: typeof Buffer;
}

export interface HookDef {
  id: string;
  name: string;
  code: string;
}

interface CompiledHook {
  def: HookDef;
  context: vm.Context;
  onRequest?: (...a: unknown[]) => unknown;
  onResponse?: (...a: unknown[]) => unknown;
}

export interface HookOutcome {
  id: string;
  name: string;
  ms: number;
  changed: boolean;
  error?: string;
}

/**
 * Hook scripts, compiled once and called for each message. Every context
 * runs its microtasks inside the call (`afterEvaluate`), so a promise a hook
 * leaves behind still counts against its budget instead of running later
 * where nothing can stop it.
 */
export class HookRunner {
  private hooks: CompiledHook[] = [];
  readonly logs = new Map<string, LogLine[]>();

  constructor(
    private readonly vars: { get: (name: string) => string | undefined; set: (name: string, value: string) => void },
    private readonly trusted?: TrustedExtras,
  ) {}

  load(defs: HookDef[]): Record<string, string> {
    this.hooks = [];
    const errors: Record<string, string> = {};
    for (const def of defs) {
      const logs: LogLine[] = [];
      this.logs.set(def.id, logs);
      const siq = { getVar: (n: string) => this.vars.get(String(n)), setVar: (n: string, v: string) => this.vars.set(String(n), String(v)) };
      const context = vm.createContext({ ...baseGlobals(logs), siq, ...this.trusted }, { codeGeneration: { strings: !!this.trusted, wasm: false }, microtaskMode: 'afterEvaluate' });
      try {
        new vm.Script(def.code, { filename: `${def.name}.js` }).runInContext(context, { timeout: 500 });
        const onRequest = context.onRequest as CompiledHook['onRequest'];
        const onResponse = context.onResponse as CompiledHook['onResponse'];
        if (typeof onRequest !== 'function' && typeof onResponse !== 'function') throw new Error('a hook script must define onRequest(req) or onResponse(req, res)');
        this.hooks.push({ def, context, onRequest: typeof onRequest === 'function' ? onRequest : undefined, onResponse: typeof onResponse === 'function' ? onResponse : undefined });
      } catch (e) {
        errors[def.id] = (e as Error).message ?? String(e);
      }
    }
    return errors;
  }

  run(phase: 'request' | 'response', req: WireMessage, res?: WireMessage): HookOutcome[] {
    const out: HookOutcome[] = [];
    for (const h of this.hooks) {
      const fn = phase === 'request' ? h.onRequest : h.onResponse;
      if (!fn) continue;
      const sReq = toSandbox(req);
      const sRes = res ? toSandbox(res) : undefined;
      const reqBody = sReq.body;
      const resBody = sRes?.body ?? '';
      const t0 = performance.now();
      try {
        h.context.__args = phase === 'request' ? [sReq] : [sReq, sRes];
        h.context.__fn = fn;
        const ret = new vm.Script('__fn(...__args)').runInContext(h.context, { timeout: HOOK_BUDGET_MS }) as SandboxMsg | undefined;
        const target = phase === 'request' ? req : res!;
        const base = phase === 'request' ? reqBody : resBody;
        const changed = ret && typeof ret === 'object' && typeof (ret as { then?: unknown }).then !== 'function' ? fromSandbox(target, ret, base) : fromSandbox(target, phase === 'request' ? sReq : sRes!, base);
        out.push({ id: h.def.id, name: h.def.name, ms: performance.now() - t0, changed });
      } catch (e) {
        out.push({ id: h.def.id, name: h.def.name, ms: performance.now() - t0, changed: false, error: (e as Error)?.message ?? String(e) });
      } finally {
        delete h.context.__args;
        delete h.context.__fn;
      }
    }
    return out;
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_r, j) => setTimeout(() => j(new Error(`timed out after ${ms} ms`)), ms).unref())]);

/** Run a test suite or a one-off script with the SDK. */
export async function executeScript(code: string, name: string, sdk: unknown, extra: Record<string, unknown>, trusted?: TrustedExtras): Promise<RunResult> {
  const logs: LogLine[] = [];
  const tests: Array<{ name: string; fn: () => unknown }> = [];
  const context = vm.createContext(
    {
      ...baseGlobals(logs),
      siq: sdk,
      test: (n: string, fn: () => unknown) => tests.push({ name: String(n), fn }),
      expect: (v: unknown) => new Expectation(v),
      sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 30_000))),
      ...extra,
      ...trusted,
    },
    { codeGeneration: { strings: !!trusted, wasm: false } },
  );
  const t0 = performance.now();
  const results: TestResult[] = [];
  try {
    const value = await withTimeout(Promise.resolve(compileWithResult(code, name).runInContext(context, { timeout: 2000 })), RUN_TIMEOUT_MS);
    for (const t of tests) {
      const s = performance.now();
      try {
        await withTimeout(Promise.resolve(t.fn()), RUN_TIMEOUT_MS);
        results.push({ name: t.name, ok: true, ms: performance.now() - s });
      } catch (e) {
        results.push({ name: t.name, ok: false, ms: performance.now() - s, error: (e as Error)?.message ?? String(e) });
      }
    }
    return { ok: results.every((r) => r.ok), value: value === undefined ? undefined : fmt(value), logs, tests: results, ms: performance.now() - t0 };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e), logs, tests: results, ms: performance.now() - t0 };
  }
}
