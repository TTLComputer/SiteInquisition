import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import type { Readable, Writable } from 'node:stream';
import { newId } from './ids.js';
import type { HookMessage } from './rules.js';
import type { HostReply, HostRequest, SdkShape, SyncReply } from './scripthost.js';
import { HOOK_BUDGET_MS, RUN_TIMEOUT_MS, type LogLine, type RunResult, type WireMessage } from './scriptrt.js';

export { HOOK_BUDGET_MS } from './scriptrt.js';
export type { LogLine, RunResult, TestResult } from './scriptrt.js';

/**
 * JavaScript the user writes against SiteInquisition. Three kinds:
 *
 *  - hook:   defines onRequest(req) and/or onResponse(req, res); runs inline on
 *            in-scope traffic whose scope rule allows modify. Change the objects
 *            or return a new one. Each call gets a small CPU budget.
 *  - test:   test('name', async () => { ... expect(x).toBe(y) }) suites, run on demand.
 *  - script: one-off async code with the `siq` SDK, run on demand.
 *
 * Scripts never run in the core's own process. Each run gets a script host
 * process (scripthost.ts) and hooks share a long-lived one, so a script that
 * loops forever is killed instead of freezing the proxy.
 *
 * Scripts are sandboxed by default: the host runs under Node's permission
 * model, with no file system, child processes, worker threads or native
 * addons, inside a `vm` context with only the listed globals and the `siq`
 * SDK. This is a reasonable effort for code you did not write; it is not a
 * hardened boundary (network access is still possible, and anything the SDK
 * can do, the script can do). A script with `sandbox: false` is trusted: it
 * gets `require` and `process` and runs with the user's full rights.
 */
export interface Script {
  id: string;
  name: string;
  kind: 'hook' | 'test' | 'script';
  enabled?: boolean;
  /** Default true. False runs the script with full access to the computer. */
  sandbox?: boolean;
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

/** What scripts can do; Core provides the implementation. */
export type Sdk = Record<string, unknown>;

/** Whether a script runs sandboxed: always, unless it opts out and the user trusted its code. */
export type TrustCheck = (s: Pick<Script, 'sandbox' | 'code'>) => boolean;

export interface HookVars {
  values: () => Record<string, string>;
  set: (name: string, value: string) => void;
}

/** How long a host may go without a heartbeat before it counts as stuck. */
const STUCK_MS = 5_000;
/** Longest a run may take in all, tests included. */
const MAX_RUN_MS = 10 * 60_000;

const here = dirname(fileURLToPath(import.meta.url));

function packageRoot(from: string): string {
  let dir = from;
  while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

function hostEntry(): string {
  const js = join(here, 'scripthost.js');
  return existsSync(js) ? js : join(here, 'scripthost.ts');
}

/** Folders a sandboxed host may read: its own code and the codecs it imports. */
function readablePaths(): string[] {
  const out = new Set<string>();
  const add = (p: string) => {
    try {
      out.add(realpathSync(p));
    } catch {
      // missing paths are simply not granted
    }
  };
  add(packageRoot(here));
  try {
    add(packageRoot(dirname(fileURLToPath(import.meta.resolve('@siteinquisition/codecs')))));
  } catch {
    // resolved by a loader alias in development; covered below
  }
  // Under a TypeScript loader (tests, development) the host loads through it too.
  if (usesLoader()) add(resolve(packageRoot(here), '..', '..'));
  return [...out];
}

const usesLoader = () => process.execArgv.some((a) => a === '--import' || a.startsWith('--import=') || a.startsWith('--loader') || a.startsWith('--experimental-loader'));

function hostArgs(trusted: boolean): { execArgv: string[]; args: string[] } {
  // Keep loader flags (development), drop anything that would open an inspector or lift limits.
  const inherited = process.execArgv.filter((a, i, all) => !/^--(inspect|permission|allow-|experimental-permission)/.test(a) && !/^--(inspect|allow-)/.test(all[i - 1] ?? ''));
  if (trusted) return { execArgv: inherited, args: ['--trusted'] };
  // A TypeScript loader (tests, development) runs in a worker thread, so it needs workers; a built app has no loader.
  const loader = usesLoader() ? ['--allow-worker'] : [];
  return { execArgv: [...inherited, '--permission', ...loader, ...readablePaths().map((p) => `--allow-fs-read=${p.endsWith(sep) ? p : p + sep}*`)], args: [] };
}

/** One script host process and its conversation. */
class Host {
  readonly child: ChildProcess;
  private lastAlive = Date.now();
  private readonly watchdog: NodeJS.Timeout;
  private dead = false;
  readonly ready: Promise<void>;
  onMessage?: (m: HostReply) => void;
  onExit?: (reason: string) => void;

  constructor(trusted: boolean) {
    const { execArgv, args } = hostArgs(trusted);
    this.child = fork(hostEntry(), args, {
      execArgv,
      serialization: 'advanced',
      // fd 4: SDK answers to the host, fd 5: the host's SDK calls (see scripthost.ts).
      stdio: ['ignore', 'ignore', 'pipe', 'ipc', 'pipe', 'pipe'],
      // Electron's binary acts as plain Node for the host; harmless under Node.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let stderr = '';
    this.child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    this.ready = new Promise((res, rej) => {
      const first = (m: HostReply) => {
        if (m.t === 'ready') res();
      };
      this.child.once('message', first);
      this.child.once('exit', (code) => rej(new Error(`script host exited (${code}) ${stderr.trim()}`)));
    });
    this.ready.catch(() => undefined);
    this.child.on('message', (m: HostReply) => {
      this.lastAlive = Date.now();
      if (m.t !== 'alive' && m.t !== 'ready') this.onMessage?.(m);
    });
    this.child.on('exit', (code, signal) => {
      clearInterval(this.watchdog);
      if (!this.dead) this.onExit?.(signal ? `script host was stopped (${signal})` : `script host exited with code ${code}`);
      this.dead = true;
    });
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastAlive > STUCK_MS) this.kill(`the script blocked for more than ${STUCK_MS / 1000} s (an endless loop?) and was stopped`);
    }, 1000);
    this.watchdog.unref();
  }

  send(m: HostRequest): void {
    if (!this.dead) this.child.send(m);
  }

  /** Serve the host's synchronous SDK calls with `handle`. */
  serveCalls(handle: (rid: number, path: unknown, args: unknown) => SyncReply): void {
    const calls = (this.child.stdio as unknown as Array<Readable | Writable>)[5] as Readable;
    const replies = (this.child.stdio as unknown as Array<Readable | Writable>)[4] as Writable;
    let buf = Buffer.alloc(0);
    calls.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (n > 64 * 1024 * 1024) return this.kill('an SDK call was too large');
        if (buf.length < 4 + n) break;
        const frame = buf.subarray(4, 4 + n);
        buf = buf.subarray(4 + n);
        let reply: SyncReply;
        try {
          const req = deserialize(frame) as { rid: number; path: unknown; args: unknown };
          reply = handle(Number(req.rid), req.path, req.args);
        } catch (e) {
          reply = { ok: false, error: (e as Error).message };
        }
        let body: Buffer;
        try {
          body = serialize(reply);
        } catch {
          body = serialize({ ok: true, value: plain(reply.value) });
        }
        const head = Buffer.alloc(4);
        head.writeUInt32BE(body.length);
        replies.write(Buffer.concat([head, body]));
      }
    });
    calls.on('error', () => undefined);
    replies.on('error', () => undefined);
  }

  kill(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    clearInterval(this.watchdog);
    this.child.kill('SIGKILL');
    this.onExit?.(reason);
  }

  get alive(): boolean {
    return !this.dead;
  }
}

/** The SDK's functions, by path, so a host can only call what exists. */
function shapeOf(sdk: Record<string, unknown>, depth = 0): SdkShape {
  const out: SdkShape = {};
  for (const [k, v] of Object.entries(sdk)) {
    if (typeof v === 'function') out[k] = true;
    else if (v && typeof v === 'object' && depth < 3) out[k] = shapeOf(v as Record<string, unknown>, depth + 1);
  }
  return out;
}

function lookup(sdk: Record<string, unknown>, path: unknown): ((...a: unknown[]) => unknown) | undefined {
  if (!Array.isArray(path) || !path.length || path.length > 4) return undefined;
  let cur: unknown = sdk;
  for (const k of path) {
    if (typeof k !== 'string' || !cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === 'function' ? (cur as (...a: unknown[]) => unknown) : undefined;
}

/** Make a value safe to send over IPC: functions and class instances become plain data. */
function plain(v: unknown): unknown {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x)) ?? 'null');
  }
}

const toWire = (m: HookMessage): WireMessage => ({ method: m.method, url: m.url, headers: m.headers.map(([k, v]) => [k, v]), body: m.body, status: m.status, statusMessage: m.statusMessage });

function applyWire(target: HookMessage, w: WireMessage | undefined): void {
  if (!w) return;
  if (typeof w.method === 'string') target.method = w.method;
  if (typeof w.url === 'string') target.url = w.url;
  if (Array.isArray(w.headers)) target.headers = w.headers.filter((h) => Array.isArray(h) && h.length === 2).map(([k, v]) => [String(k), String(v)]);
  if (w.body instanceof Uint8Array) target.body = w.body;
  if (typeof w.status === 'number' && Number.isInteger(w.status) && w.status >= 100 && w.status <= 999) target.status = w.status;
  if (typeof w.statusMessage === 'string') target.statusMessage = w.statusMessage;
}

/** Hooks of one trust level, in one long-lived host. */
class HookPool {
  private host?: Host;
  private scripts: Script[] = [];
  private loading?: Promise<Record<string, string>>;
  private calls = new Map<number, (m: Extract<HostReply, { t: 'hooked' }> | null) => void>();
  private nextId = 1;

  constructor(
    private readonly trusted: boolean,
    private readonly onLoaded: (errors: Record<string, string>) => void,
  ) {}

  get size(): number {
    return this.scripts.length;
  }

  load(scripts: Script[]): Promise<Record<string, string>> {
    this.scripts = scripts;
    if (!scripts.length) {
      this.stop();
      this.loading = undefined;
      return Promise.resolve({});
    }
    const host = this.ensure();
    this.loading = new Promise<Record<string, string>>((res) => {
      const prev = host.onMessage;
      host.onMessage = (m) => {
        if (m.t === 'loaded') {
          host.onMessage = prev;
          res(m.errors);
        } else prev?.(m);
      };
      host.send({ t: 'load', hooks: scripts.map((s) => ({ id: s.id, name: s.name, code: s.code })) });
    }).then((errors) => {
      this.onLoaded(errors);
      return errors;
    });
    return this.loading;
  }

  private ensure(): Host {
    if (this.host?.alive) return this.host;
    const host = new Host(this.trusted);
    host.onMessage = (m) => {
      if (m.t === 'hooked') {
        const cb = this.calls.get(m.id);
        this.calls.delete(m.id);
        cb?.(m);
      }
    };
    host.onExit = () => {
      for (const cb of this.calls.values()) cb(null);
      this.calls.clear();
      if (this.host === host) this.host = undefined;
    };
    this.host = host;
    return host;
  }

  async run(phase: 'request' | 'response', req: WireMessage, res: WireMessage | undefined, vars: Record<string, string>): Promise<Extract<HostReply, { t: 'hooked' }> | null> {
    if (!this.scripts.length) return null;
    if (!this.host?.alive) await this.load(this.scripts);
    await this.loading;
    const host = this.host;
    if (!host) return null;
    const id = this.nextId++;
    // Each hook has its budget inside the host; allow for IPC on top.
    const limit = this.scripts.length * HOOK_BUDGET_MS + 500;
    return new Promise((resolveCall) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        resolveCall(null);
        host.kill('a hook did not answer in time; the hook host was restarted');
      }, limit);
      this.calls.set(id, (m) => {
        clearTimeout(timer);
        resolveCall(m);
      });
      host.send({ t: 'hook', id, phase, req, res, vars });
    });
  }

  stop(): void {
    this.host?.kill('stopped');
    this.host = undefined;
  }
}

export class ScriptEngine {
  readonly stats = new Map<string, ScriptStats>();
  readonly logs = new Map<string, LogLine[]>();
  compileErrors = new Map<string, string>();
  private hookScripts: Script[] = [];
  private readonly pools: { sandboxed: HookPool; trusted: HookPool };
  private readonly running = new Set<Host>();

  constructor(
    private readonly vars: HookVars,
    private readonly trusted: TrustCheck = () => false,
  ) {
    const merge = (ids: Script[]) => (errors: Record<string, string>) => {
      for (const s of ids) this.compileErrors.delete(s.id);
      for (const [id, e] of Object.entries(errors)) this.compileErrors.set(id, e);
    };
    this.pools = {
      sandboxed: new HookPool(false, (e) => merge(this.hookScripts.filter((s) => !this.unsandboxed(s)))(e)),
      trusted: new HookPool(true, (e) => merge(this.hookScripts.filter((s) => this.unsandboxed(s)))(e)),
    };
  }

  /** Recompile hook scripts after a change. Resolves once both hosts have compiled them. */
  async load(scripts: Script[]): Promise<void> {
    this.hookScripts = scripts.filter((s) => s.kind === 'hook' && s.enabled !== false);
    this.compileErrors.clear();
    await Promise.all([this.pools.sandboxed.load(this.hookScripts.filter((s) => !this.unsandboxed(s))), this.pools.trusted.load(this.hookScripts.filter((s) => this.unsandboxed(s)))]);
  }

  /** True when the script asked to run without the sandbox and the user trusted its code on this computer. */
  unsandboxed(s: Pick<Script, 'sandbox' | 'code'>): boolean {
    return s.sandbox === false && this.trusted(s);
  }

  get active(): boolean {
    return this.hookScripts.length > 0;
  }

  private record(id: string, ms: number, err?: string) {
    const s = this.stats.get(id) ?? { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
    s.calls++;
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    if (err) {
      s.errors++;
      s.lastError = err;
      s.lastErrorAt = Date.now();
    }
    this.stats.set(id, s);
  }

  /**
   * Run every hook's onRequest/onResponse, sandboxed hooks first. A hook that
   * throws or overruns is skipped for this message and counted in its stats.
   * Returns the names of hooks that changed the message.
   */
  async run(phase: 'request' | 'response', req: HookMessage, res?: HookMessage): Promise<string[]> {
    const applied: string[] = [];
    for (const [pool, list] of [
      [this.pools.sandboxed, this.hookScripts.filter((s) => !this.unsandboxed(s))],
      [this.pools.trusted, this.hookScripts.filter((s) => this.unsandboxed(s))],
    ] as const) {
      if (!list.length) continue;
      const t0 = performance.now();
      const out = await pool.run(phase, toWire(req), res ? toWire(res) : undefined, this.vars.values());
      if (!out) {
        for (const s of list) this.record(s.id, performance.now() - t0, 'the hook host stopped answering and was restarted');
        continue;
      }
      if (phase === 'request') applyWire(req, out.req);
      else if (res) applyWire(res, out.res);
      for (const [k, v] of out.setVars ?? []) this.vars.set(String(k), String(v));
      for (const o of out.outcomes ?? []) {
        if (!list.some((s) => s.id === o.id)) continue;
        this.record(o.id, Number(o.ms) || 0, o.error);
        if (o.changed && !o.error) applied.push(o.name);
      }
      for (const [id, lines] of Object.entries(out.logs ?? {})) {
        const all = this.logs.get(id) ?? [];
        all.push(...lines);
        if (all.length > 500) all.splice(0, all.length - 500);
        this.logs.set(id, all);
      }
    }
    return applied;
  }

  /**
   * Run a test suite or a one-off script with the full SDK, in a host of its
   * own. `extra` globals are copied in, and copied back after the run (flow
   * steps change `vars`).
   */
  async execute(script: Pick<Script, 'id' | 'name' | 'kind' | 'code' | 'sandbox'>, sdk: Sdk, extra: Record<string, unknown> = {}): Promise<RunResult> {
    const t0 = performance.now();
    const host = new Host(this.unsandboxed(script));
    this.running.add(host);
    const fail = (error: string): RunResult => ({ ok: false, error, logs: [], tests: [], ms: performance.now() - t0 });
    try {
      await host.ready;
    } catch (e) {
      this.running.delete(host);
      return fail((e as Error).message);
    }
    const result = await new Promise<RunResult>((resolveRun) => {
      const overall = setTimeout(() => host.kill(`the script ran for more than ${MAX_RUN_MS / 60_000} minutes and was stopped`), MAX_RUN_MS);
      host.onExit = (reason) => {
        clearTimeout(overall);
        resolveRun(fail(reason));
      };
      host.serveCalls((rid, path, args) => {
        const fn = lookup(sdk, path);
        if (!fn) return { ok: false, error: `siq.${Array.isArray(path) ? path.join('.') : '?'} is not a function` };
        const value = fn(...(Array.isArray(args) ? args : []));
        if (!value || typeof (value as { then?: unknown }).then !== 'function') return { ok: true, value: plain(value) };
        (value as Promise<unknown>).then(
          (v) => host.send({ t: 'sdkr', rid, ok: true, value: plain(v) }),
          (err) => host.send({ t: 'sdkr', rid, ok: false, error: (err as Error)?.message ?? String(err) }),
        );
        return { ok: true, later: true };
      });
      host.onMessage = (m) => {
        if (m.t === 'done') {
          clearTimeout(overall);
          host.onExit = undefined;
          if (m.extra && typeof m.extra === 'object') {
            for (const [k, v] of Object.entries(m.extra)) {
              const target = extra[k];
              if (target && typeof target === 'object' && v && typeof v === 'object' && !Array.isArray(target)) {
                for (const key of Object.keys(target)) delete (target as Record<string, unknown>)[key];
                Object.assign(target, v);
              }
            }
          }
          resolveRun(m.result);
          host.kill('done');
        }
      };
      host.send({ t: 'exec', code: script.code, name: script.name, extra: plain(extra) as Record<string, unknown>, sdk: shapeOf(sdk) });
    });
    this.running.delete(host);
    this.logs.set(script.id, result.logs ?? []);
    return { ...result, ms: performance.now() - t0 };
  }

  /** Stop every host (when the project closes). */
  close(): void {
    this.pools.sandboxed.stop();
    this.pools.trusted.stop();
    for (const h of this.running) h.kill('the project closed');
    this.running.clear();
  }
}

export function normalizeScript(s: Omit<Script, 'id'> & { id?: string }): Script {
  if (!s.name?.trim()) throw new Error('a script needs a name');
  if (!['hook', 'test', 'script'].includes(s.kind)) throw new Error('kind must be hook, test or script');
  if (typeof s.code !== 'string') throw new Error('code must be a string');
  const out: Script = { ...s, id: s.id ?? newId() };
  if (s.sandbox === false) out.sandbox = false;
  else delete out.sandbox;
  return out;
}

export { RUN_TIMEOUT_MS };
