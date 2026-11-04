/**
 * Script host: a separate Node process that runs user scripts, started by
 * ScriptEngine (scripts.ts). A sandboxed host is started with Node's
 * permission model (`--permission`), so even code that escapes the `vm`
 * context cannot read or write files, start programs or load native code.
 * A trusted host (a script with the sandbox turned off) runs without those
 * limits and gets `require` and `process`.
 *
 * Either way the core can kill the process, so a script that never returns
 * cannot freeze the proxy. Everything the script asks of the core goes over
 * IPC as an SDK call, which the core checks and answers.
 */
import { readSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deserialize, serialize } from 'node:v8';
import { executeScript, HookRunner, type HookDef, type LogLine, type WireMessage } from './scriptrt.js';

export type HostRequest =
  | { t: 'load'; hooks: HookDef[] }
  | { t: 'hook'; id: number; phase: 'request' | 'response'; req: WireMessage; res?: WireMessage; vars: Record<string, string> }
  | { t: 'exec'; code: string; name: string; extra: Record<string, unknown>; sdk: SdkShape }
  | { t: 'sdkr'; rid: number; ok: boolean; value?: unknown; error?: string };

export type HostReply =
  | { t: 'ready' }
  | { t: 'alive' }
  | { t: 'loaded'; errors: Record<string, string> }
  | { t: 'hooked'; id: number; req: WireMessage; res?: WireMessage; outcomes: import('./scriptrt.js').HookOutcome[]; setVars: Array<[string, string]>; logs: Record<string, LogLine[]> }
  | { t: 'done'; result: import('./scriptrt.js').RunResult; extra: Record<string, unknown> };

/** The SDK's shape: a function's name maps to true, a namespace to its own shape. */
export type SdkShape = { [k: string]: true | SdkShape };

const trusted = process.argv.includes('--trusted');
const extras = trusted ? { require: createRequire(import.meta.url), process, Buffer } : undefined;
const send = (m: HostReply) => process.send?.(m);

let vars: Record<string, string> = {};
let setVars: Array<[string, string]> = [];
const hooks = new HookRunner(
  {
    get: (n) => vars[n],
    set: (n, v) => {
      vars[n] = v;
      setVars.push([n, v]);
    },
  },
  extras,
);
const sentLogs = new Map<string, number>();

let nextRid = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/*
 * SDK calls are synchronous, as they are in the core: the request goes out
 * on fd 5 and this process blocks reading the answer on fd 4. When the core's
 * function returns a promise, the answer says so and the value follows over
 * IPC, so `await siq.send(...)` works and several sends can run at once.
 */
const REPLY_FD = 4;
const CALL_FD = 5;
const nap = new Int32Array(new SharedArrayBuffer(4));

function writeAll(buf: Buffer) {
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(CALL_FD, buf, off, buf.length - off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
      Atomics.wait(nap, 0, 0, 1);
    }
  }
}

function readExact(n: number): Buffer {
  const out = Buffer.alloc(n);
  let off = 0;
  while (off < n) {
    try {
      const got = readSync(REPLY_FD, out, off, n - off, null);
      if (got === 0) throw new Error('the core closed the SDK channel');
      off += got;
    } catch (e) {
      // Windows reports a closed pipe as EOF rather than a zero-length read.
      if ((e as NodeJS.ErrnoException).code === 'EOF') throw new Error('the core closed the SDK channel');
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
      Atomics.wait(nap, 0, 0, 1);
    }
  }
  return out;
}

export interface SyncReply {
  ok: boolean;
  value?: unknown;
  error?: string;
  /** The value is a promise; it arrives later as an `sdkr` message with this call's rid. */
  later?: boolean;
}

function call(path: string[], args: unknown[]): unknown {
  const rid = nextRid++;
  const body = serialize({ rid, path, args });
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  writeAll(Buffer.concat([head, body]));
  const reply = deserialize(readExact(readExact(4).readUInt32BE(0))) as SyncReply;
  if (reply.later) return new Promise((resolve, reject) => pending.set(rid, { resolve, reject }));
  if (!reply.ok) throw new Error(reply.error ?? 'SDK call failed');
  return reply.value;
}

/** Build the `siq` object: each function becomes a call to the core. */
function sdkProxy(shape: SdkShape, path: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) out[k] = v === true ? (...args: unknown[]) => call([...path, k], args) : sdkProxy(v, [...path, k]);
  return out;
}

process.on('message', async (m: HostRequest) => {
  if (m.t === 'load') {
    send({ t: 'loaded', errors: hooks.load(m.hooks) });
  } else if (m.t === 'hook') {
    vars = m.vars;
    setVars = [];
    const outcomes = hooks.run(m.phase, m.req, m.res);
    const logs: Record<string, LogLine[]> = {};
    for (const o of outcomes) {
      const all = hooks.logs.get(o.id) ?? [];
      const from = Math.min(sentLogs.get(o.id) ?? 0, all.length);
      if (all.length > from) logs[o.id] = all.slice(from);
      sentLogs.set(o.id, all.length);
    }
    send({ t: 'hooked', id: m.id, req: m.req, res: m.res, outcomes, setVars, logs });
  } else if (m.t === 'exec') {
    const result = await executeScript(m.code, m.name, sdkProxy(m.sdk), m.extra, extras);
    let extra: Record<string, unknown> = {};
    try {
      extra = structuredClone(m.extra);
    } catch {
      // the script stored something that cannot be copied back; keep the inputs
    }
    send({ t: 'done', result, extra });
  } else if (m.t === 'sdkr') {
    const p = pending.get(m.rid);
    if (!p) return;
    pending.delete(m.rid);
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(m.error ?? 'SDK call failed'));
  }
});

// A heartbeat: when it stops, the event loop is stuck and the core kills this process.
setInterval(() => send({ t: 'alive' }), 500);
process.on('disconnect', () => process.exit(0));
send({ t: 'ready' });
