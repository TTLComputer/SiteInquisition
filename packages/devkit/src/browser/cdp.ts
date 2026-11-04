import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

type Handler = (params: any) => void;

/**
 * The Chrome DevTools protocol over --remote-debugging-pipe: Chromium reads
 * commands on fd 3 and writes replies and events on fd 4, each message a JSON
 * object ended by a NUL byte. Sessions are flat, so one pipe carries the
 * browser and every attached page, told apart by sessionId.
 */
export class Connection {
  readonly proc: ChildProcess;
  private out: Writable;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private handlers = new Map<string, Set<Handler>>();
  private stderr = '';
  private closedError: Error | null = null;
  readonly exited: Promise<void>;

  constructor(exe: string, args: string[]) {
    this.proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    this.out = this.proc.stdio[3] as Writable;
    const input = this.proc.stdio[4] as Readable;
    this.proc.stderr!.on('data', (c: Buffer) => (this.stderr = (this.stderr + c.toString()).slice(-4000)));
    this.out.on('error', () => {});
    let buf = '';
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buf += chunk;
      let end: number;
      while ((end = buf.indexOf('\0')) !== -1) {
        const raw = buf.slice(0, end);
        buf = buf.slice(end + 1);
        this.dispatch(JSON.parse(raw));
      }
    });
    this.exited = new Promise((resolve) => {
      this.proc.on('error', (e) => this.fail(new Error(`Chromium failed to start: ${e.message}`)));
      this.proc.on('exit', (code, signal) => {
        this.fail(new Error(`Chromium exited (${signal ?? code})${this.stderr ? `:\n${this.stderr.trim()}` : ''}`));
        resolve();
      });
    });
  }

  private fail(err: Error) {
    this.closedError ??= err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private dispatch(msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string; data?: string }; sessionId?: string }) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else p.resolve(msg.result);
      return;
    }
    const set = this.handlers.get(`${msg.sessionId ?? ''} ${msg.method}`);
    if (set) for (const h of [...set]) h(msg.params);
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.out.write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + '\0');
    });
  }

  on(method: string, handler: Handler, sessionId = ''): () => void {
    const key = `${sessionId} ${method}`;
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  once<T = any>(method: string, sessionId = ''): Promise<T> {
    return new Promise((resolve) => {
      const off = this.on(method, (p) => {
        off();
        resolve(p);
      }, sessionId);
    });
  }
}
