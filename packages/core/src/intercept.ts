import { EventEmitter } from 'node:events';
import { newId } from './ids.js';
import { conditionsMatch, type HookMessage, type RuleConditions } from './rules.js';
import type { ExchangeSource } from './store.js';

/**
 * Breakpoints pause matching traffic until someone forwards, edits or drops
 * it. Paused items wait in memory; after `timeoutMs` they are forwarded
 * unchanged so a forgotten breakpoint cannot hang a device forever.
 */
export interface Breakpoint extends RuleConditions {
  id: string;
  enabled?: boolean;
  phase: 'request' | 'response' | 'both';
}

export interface Paused {
  id: string;
  phase: 'request' | 'response';
  source: ExchangeSource;
  pausedAt: number;
  /** The request (for request pauses) or the response with its request URL and method. */
  message: Omit<HookMessage, 'body'> & { bodyBase64: string };
  breakpointId: string;
}

export interface Resolution {
  action: 'forward' | 'drop' | 'forward-pause-response';
  /** Replacements for the paused message; omitted fields stay as they were. */
  edits?: Partial<Omit<HookMessage, 'body'>> & { bodyBase64?: string };
}

export class Intercept extends EventEmitter<{ paused: [Paused]; resolved: [string] }> {
  private waiting = new Map<string, { item: Paused; resolve: (r: Resolution) => void; timer: NodeJS.Timeout }>();
  /** Requests whose response should also pause, by the hook's request id. */
  private pauseResponse = new Set<string>();

  constructor(
    private readonly breakpoints: () => Breakpoint[],
    private readonly timeoutMs = 5 * 60_000,
  ) {
    super();
  }

  list(): Paused[] {
    return [...this.waiting.values()].map((w) => w.item);
  }

  /** Pause if a breakpoint matches; resolves with what to do. `requestKey` links a request to its response. */
  async check(phase: 'request' | 'response', msg: HookMessage, source: ExchangeSource, requestKey: string): Promise<Resolution | undefined> {
    const forced = phase === 'response' && this.pauseResponse.delete(requestKey);
    const bp = forced
      ? ({ id: 'forward-pause-response', phase: 'response' } as Breakpoint)
      : this.breakpoints().find((b) => b.enabled !== false && (b.phase === phase || b.phase === 'both') && conditionsMatch(b, { method: msg.method, url: msg.url, status: msg.status }));
    if (!bp) return undefined;
    const item: Paused = {
      id: newId(),
      phase,
      source,
      pausedAt: Date.now(),
      breakpointId: bp.id,
      message: { method: msg.method, url: msg.url, headers: msg.headers, status: msg.status, statusMessage: msg.statusMessage, bodyBase64: Buffer.from(msg.body).toString('base64') },
    };
    const res = await new Promise<Resolution>((resolve) => {
      const timer = setTimeout(() => this.resolve(item.id, { action: 'forward' }), this.timeoutMs);
      this.waiting.set(item.id, { item, resolve, timer });
      this.emit('paused', item);
    });
    if (res.action === 'forward-pause-response' && phase === 'request') this.pauseResponse.add(requestKey);
    return res;
  }

  resolve(id: string, r: Resolution): boolean {
    const w = this.waiting.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiting.delete(id);
    w.resolve(r);
    this.emit('resolved', id);
    return true;
  }

  /** Forward everything that is waiting, e.g. "Forward all" or on shutdown. */
  releaseAll(): number {
    const ids = [...this.waiting.keys()];
    for (const id of ids) this.resolve(id, { action: 'forward' });
    return ids.length;
  }
}

/** Apply a resolution's edits to a message in place. */
export function applyEdits(msg: HookMessage, r: Resolution): void {
  const e = r.edits;
  if (!e) return;
  if (e.method) msg.method = e.method;
  if (e.url) msg.url = e.url;
  if (e.headers) msg.headers = e.headers;
  if (e.status !== undefined) msg.status = e.status;
  if (e.statusMessage !== undefined) msg.statusMessage = e.statusMessage;
  if (e.bodyBase64 !== undefined) msg.body = new Uint8Array(Buffer.from(e.bodyBase64, 'base64'));
}

export function normalizeBreakpoint(b: Omit<Breakpoint, 'id'> & { id?: string }): Breakpoint {
  if (!['request', 'response', 'both'].includes(b.phase)) throw new Error('phase must be request, response or both');
  return { ...b, id: b.id ?? newId() };
}
