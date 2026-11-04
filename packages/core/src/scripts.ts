import * as vm from 'node:vm';
import * as codecs from '@siteinquisition/codecs';
import * as jp from '@siteinquisition/codecs/jsonpath';
import { newId } from './ids.js';
import type { HookMessage } from './rules.js';

/**
 * JavaScript the user writes against SiteInquisition. Three kinds:
 *
 *  - hook:   defines onRequest(req) and/or onResponse(req, res); runs inline on
 *            in-scope traffic whose scope rule allows modify. Change the objects
 *            or return a new one. Each call gets a small CPU budget.
 *  - test:   test('name', async () => { ... expect(x).toBe(y) }) suites, run on demand.
 *  - script: one-off async code with the `siq` SDK, run on demand.
 *
 * Scripts run in a separate V8 context with only the globals listed in
 * `baseGlobals` and the SDK. That keeps mistakes contained (no require, no
 * process, no filesystem); it is not a boundary against hostile code, and
 * scripts are the project's own.
 */
export interface Script {
  id: string;
  name: string;
  kind: 'hook' | 'test' | 'script';
  enabled?: boolean;
  code: string;
}

export interface ScriptStats {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  lastError?: string;
  lastErrorAt?: number;
}

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

/** What scripts can do; Core provides the implementation. */
export type Sdk = Record<string, (...args: never[]) => unknown>;

export const HOOK_BUDGET_MS = 50;
const RUN_TIMEOUT_MS = 60_000;

const fmt = (v: unknown): string => {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? `<${x.length} bytes>` : typeof x === 'bigint' ? String(x) : x), 2) ?? String(v);
  } catch {
    return String(v);
  }
};

function baseGlobals(logs: LogLine[]) {
  const push = (level: LogLine['level']) => (...a: unknown[]) => {
    logs.push({ at: Date.now(), level, text: a.map(fmt).join(' ') });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
  };
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    console: { log: push('log'), info: push('info'), warn: push('warn'), error: push('error') },
    JSON,
    Math,
    Date,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    Promise,
    Error,
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

/** Plain objects only cross into the sandbox, so its code cannot reach host prototypes through them. */
const toSandbox = (msg: HookMessage) => ({
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

function fromSandbox(orig: HookMessage, s: SandboxMsg, originalBody: string): boolean {
  let changed = false;
  if (typeof s.method === 'string' && s.method !== orig.method) ((orig.method = s.method.toUpperCase()), (changed = true));
  if (typeof s.url === 'string' && s.url !== orig.url) ((orig.url = s.url), (changed = true));
  if (Array.isArray(s.headers)) {
    const h = s.headers.map((p) => [String(p[0]), String(p[1])] as [string, string]);
    if (JSON.stringify(h) !== JSON.stringify(orig.headers)) ((orig.headers = h), (changed = true));
  }
  if (typeof s.status === 'number' && s.status !== orig.status) ((orig.status = s.status), (changed = true));
  if (typeof s.body === 'string' && s.body !== originalBody) ((orig.body = new TextEncoder().encode(s.body)), (changed = true));
  else if (s.bodyBytes instanceof Uint8Array && s.bodyBytes !== orig.body) ((orig.body = s.bodyBytes), (changed = true));
  return changed;
}

interface CompiledHook {
  script: Script;
  context: vm.Context;
  onRequest?: (req: SandboxMsg, ctx: unknown) => unknown;
  onResponse?: (req: SandboxMsg, res: SandboxMsg, ctx: unknown) => unknown;
}

export class ScriptEngine {
  private hooks: CompiledHook[] = [];
  readonly stats = new Map<string, ScriptStats>();
  readonly logs = new Map<string, LogLine[]>();
  compileErrors = new Map<string, string>();

  constructor(private readonly hookSdk: () => Sdk) {}

  /** Recompile hook scripts after a change. */
  load(scripts: Script[]): void {
    this.hooks = [];
    this.compileErrors.clear();
    for (const s of scripts) {
      if (s.kind !== 'hook' || s.enabled === false) continue;
      const logs = this.logs.get(s.id) ?? [];
      this.logs.set(s.id, logs);
      const context = vm.createContext({ ...baseGlobals(logs), siq: this.hookSdk() }, { codeGeneration: { strings: false, wasm: false } });
      try {
        new vm.Script(s.code, { filename: `${s.name}.js` }).runInContext(context, { timeout: 500 });
        const onRequest = context.onRequest as CompiledHook['onRequest'];
        const onResponse = context.onResponse as CompiledHook['onResponse'];
        if (typeof onRequest !== 'function' && typeof onResponse !== 'function') throw new Error('a hook script must define onRequest(req) or onResponse(req, res)');
        this.hooks.push({ script: s, context, onRequest: typeof onRequest === 'function' ? onRequest : undefined, onResponse: typeof onResponse === 'function' ? onResponse : undefined });
      } catch (e) {
        this.compileErrors.set(s.id, (e as Error).message);
      }
    }
  }

  get active(): boolean {
    return this.hooks.length > 0;
  }

  private record(id: string, ms: number, err?: unknown) {
    const s = this.stats.get(id) ?? { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
    s.calls++;
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    if (err) {
      s.errors++;
      s.lastError = (err as Error).message ?? String(err);
      s.lastErrorAt = Date.now();
    }
    this.stats.set(id, s);
  }

  /**
   * Run every hook's onRequest/onResponse. Hooks run synchronously inside the
   * budget; a hook that throws or overruns is skipped for this message and
   * counted in its stats. Returns the names of hooks that changed the message.
   */
  run(phase: 'request' | 'response', req: HookMessage, res?: HookMessage): string[] {
    const applied: string[] = [];
    for (const h of this.hooks) {
      const fn = phase === 'request' ? h.onRequest : h.onResponse;
      if (!fn) continue;
      const sReq = toSandbox(req);
      const sRes = res ? toSandbox(res) : undefined;
      const reqBody = sReq.body;
      const resBody = sRes?.body ?? '';
      const t0 = performance.now();
      try {
        // Call through vm so the timeout applies to the hook's own code.
        h.context.__args = phase === 'request' ? [sReq] : [sReq, sRes];
        h.context.__fn = fn;
        const out = new vm.Script('__fn(...__args)').runInContext(h.context, { timeout: HOOK_BUDGET_MS }) as SandboxMsg | undefined;
        this.record(h.script.id, performance.now() - t0);
        const target = phase === 'request' ? req : res!;
        const changed = out && typeof out === 'object' ? fromSandbox(target, out, phase === 'request' ? reqBody : resBody) : fromSandbox(target, phase === 'request' ? sReq : sRes!, phase === 'request' ? reqBody : resBody);
        if (changed) applied.push(h.script.name);
      } catch (e) {
        this.record(h.script.id, performance.now() - t0, e);
      }
    }
    return applied;
  }

  /** Run a test suite or a one-off script with the full SDK. */
  async execute(script: Pick<Script, 'id' | 'name' | 'kind' | 'code'>, sdk: Sdk): Promise<RunResult> {
    const logs: LogLine[] = [];
    const tests: Array<{ name: string; fn: () => unknown }> = [];
    const context = vm.createContext(
      {
        ...baseGlobals(logs),
        siq: sdk,
        test: (name: string, fn: () => unknown) => tests.push({ name: String(name), fn }),
        expect: (v: unknown) => new Expectation(v),
        sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 30_000))),
      },
      { codeGeneration: { strings: false, wasm: false } },
    );
    const t0 = performance.now();
    const withTimeout = <T>(p: Promise<T>, ms: number) =>
      Promise.race([p, new Promise<never>((_r, j) => setTimeout(() => j(new Error(`timed out after ${ms} ms`)), ms))]);
    const results: TestResult[] = [];
    try {
      // Wrap so top-level await and a final expression value both work.
      const wrapped = `(async () => {\n${script.code}\n})()`;
      const value = await withTimeout(Promise.resolve(new vm.Script(wrapped, { filename: `${script.name}.js` }).runInContext(context, { timeout: 2000 })), RUN_TIMEOUT_MS);
      for (const t of tests) {
        const s = performance.now();
        try {
          await withTimeout(Promise.resolve(t.fn()), RUN_TIMEOUT_MS);
          results.push({ name: t.name, ok: true, ms: performance.now() - s });
        } catch (e) {
          results.push({ name: t.name, ok: false, ms: performance.now() - s, error: (e as Error).message ?? String(e) });
        }
      }
      this.logs.set(script.id, logs);
      return { ok: results.every((r) => r.ok), value: value === undefined ? undefined : fmt(value), logs, tests: results, ms: performance.now() - t0 };
    } catch (e) {
      this.logs.set(script.id, logs);
      return { ok: false, error: (e as Error).message ?? String(e), logs, tests: results, ms: performance.now() - t0 };
    }
  }
}

export function normalizeScript(s: Omit<Script, 'id'> & { id?: string }): Script {
  if (!s.name?.trim()) throw new Error('a script needs a name');
  if (!['hook', 'test', 'script'].includes(s.kind)) throw new Error('kind must be hook, test or script');
  if (typeof s.code !== 'string') throw new Error('code must be a string');
  return { ...s, id: s.id ?? newId() };
}
