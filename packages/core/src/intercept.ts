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
  /** "messages" pauses WebSocket messages on matching connections, one at a time. */
  phase: 'request' | 'response' | 'both' | 'messages';
  /** Messages only: which side's messages pause. Default both. */
  direction?: 'client' | 'server' | 'both';
  /** Messages only: pause only messages containing this text, or matching /regex/flags. Empty pauses every one. */
  match?: string;
}

/** One WebSocket message held at a breakpoint. */
export interface PausedWsMessage {
  /** The recorded exchange of the connection, when it is recorded. */
  exchangeId?: string;
  /** "client" means on its way from the client to the server. */
  direction: 'client' | 'server';
  /** text, binary, or opN. */
  opcode: string;
  fragments: number;
}

export interface Paused {
  id: string;
  phase: 'request' | 'response' | 'message';
  source: ExchangeSource;
  pausedAt: number;
  /** The request (for request pauses) or the response with its request URL and method. */
  message: Omit<HookMessage, 'body'> & { bodyBase64: string };
  breakpointId: string;
  /** For phase "message": the WebSocket side of it. The URL is the connection's; bodyBase64 is the payload. */
  ws?: PausedWsMessage;
}

export interface Resolution {
  action: 'forward' | 'drop' | 'forward-pause-response';
  /** Replacements for the paused message; omitted fields stay as they were. */
  edits?: Partial<Omit<HookMessage, 'body'>> & { bodyBase64?: string; /** WebSocket messages: send as text or binary instead. */ opcode?: 'text' | 'binary' };
}

/** A breakpoint's message filter: plain text (any case) or /regex/flags. */
export function messageMatches(match: string | undefined, payload: Uint8Array): boolean {
  if (!match) return true;
  const text = Buffer.from(payload).toString('utf8');
  const re = /^\/(.+)\/([a-z]*)$/s.exec(match);
  if (re) {
    try {
      return new RegExp(re[1]!, re[2]!.replace(/[gy]/g, '')).test(text);
    } catch {
      return false;
    }
  }
  return text.toLowerCase().includes(match.toLowerCase());
}

const isHttpPhase = (b: Breakpoint, phase: 'request' | 'response') => b.phase === phase || b.phase === 'both';

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
  /** Whether check() could pause this response, so the proxy knows to buffer it rather than stream it. */
  wouldPauseResponse(msg: { method: string; url: string; status?: number }, requestKey: string): boolean {
    return this.pauseResponse.has(requestKey) || this.breakpoints().some((b) => b.enabled !== false && isHttpPhase(b, 'response') && conditionsMatch(b, msg));
  }

  async check(phase: 'request' | 'response', msg: HookMessage, source: ExchangeSource, requestKey: string): Promise<Resolution | undefined> {
    const forced = phase === 'response' && this.pauseResponse.delete(requestKey);
    const bp = forced
      ? ({ id: 'forward-pause-response', phase: 'response' } as Breakpoint)
      : this.breakpoints().find((b) => b.enabled !== false && isHttpPhase(b, phase) && conditionsMatch(b, { method: msg.method, url: msg.url, status: msg.status }));
    if (!bp) return undefined;
    const item: Paused = {
      id: newId(),
      phase,
      source,
      pausedAt: Date.now(),
      breakpointId: bp.id,
      message: { method: msg.method, url: msg.url, headers: msg.headers, status: msg.status, statusMessage: msg.statusMessage, bodyBase64: Buffer.from(msg.body).toString('base64') },
    };
    const res = await this.hold(item);
    if (res.action === 'forward-pause-response' && phase === 'request') this.pauseResponse.add(requestKey);
    return res;
  }

  private hold(item: Paused): Promise<Resolution> {
    return new Promise<Resolution>((resolve) => {
      const timer = setTimeout(() => this.resolve(item.id, { action: 'forward' }), this.timeoutMs);
      this.waiting.set(item.id, { item, resolve, timer });
      this.emit('paused', item);
    });
  }

  /** Whether any message breakpoint covers this WebSocket URL, so the relay knows to forward message by message. */
  wantsWsMessages(url: string): boolean {
    return this.breakpoints().some((b) => b.enabled !== false && b.phase === 'messages' && conditionsMatch({ host: b.host, pathPrefix: b.pathPrefix }, { method: 'GET', url }));
  }

  /** Pause a WebSocket data message if a message breakpoint matches it. */
  async checkWs(url: string, msg: PausedWsMessage & { payload: Uint8Array }, source: ExchangeSource): Promise<Resolution | undefined> {
    const bp = this.breakpoints().find(
      (b) =>
        b.enabled !== false &&
        b.phase === 'messages' &&
        (!b.direction || b.direction === 'both' || b.direction === msg.direction) &&
        conditionsMatch({ host: b.host, pathPrefix: b.pathPrefix }, { method: 'GET', url }) &&
        messageMatches(b.match, msg.payload),
    );
    if (!bp) return undefined;
    const { payload, ...ws } = msg;
    return this.hold({
      id: newId(),
      phase: 'message',
      source,
      pausedAt: Date.now(),
      breakpointId: bp.id,
      ws,
      message: { method: 'GET', url, headers: [], bodyBase64: Buffer.from(payload).toString('base64') },
    });
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
  if (!['request', 'response', 'both', 'messages'].includes(b.phase)) throw new Error('phase must be request, response, both or messages');
  if (b.direction !== undefined && !['client', 'server', 'both'].includes(b.direction)) throw new Error('direction must be client, server or both');
  const out: Breakpoint = { ...b, id: b.id ?? newId() };
  if (b.phase !== 'messages') {
    delete out.direction;
    delete out.match;
  }
  return out;
}
