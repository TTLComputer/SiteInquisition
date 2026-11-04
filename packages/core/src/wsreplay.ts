import { MessageAssembler, UnexpectedResponse, connectWebSocket, type WsConnection } from './websocket.js';
import { buildPlan, runPlan, validatePlan, type PlanStep, type SentStep } from './wsplan.js';
import type { CaptureStore, HeaderList } from './store.js';

/**
 * WebSocket replays: open a new connection like a captured one (same URL,
 * cookies and headers, or edited ones), then send messages or exact frame
 * plans on it and record both directions frame by frame.
 */
const SKIP = new Set(['host', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-accept', 'content-length', 'transfer-encoding']);

interface Open {
  ws: WsConnection;
  streamId: string;
  /** Plans still running, so close() can stop them. */
  running: Set<AbortController>;
}

export class WsReplays {
  private open = new Map<string, Open>();

  constructor(private readonly store: CaptureStore) {}

  async connect(req: { url: string; headers: HeaderList; replayOf?: string | null; ignoreTlsErrors?: boolean; timeoutMs?: number }): Promise<{ exchangeId: string }> {
    const url = new URL(req.url.replace(/^http/, 'ws'));
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('a WebSocket URL starts with ws:// or wss://');
    // Keep the captured headers (Origin, cookies, subprotocols, custom ones) but let the client own the handshake fields.
    const headers = req.headers.filter(([k]) => !SKIP.has(k.toLowerCase()) && !k.startsWith(':'));
    const startedAt = Date.now();
    const ex = this.store.addRequest({ source: 'replay', startedAt, method: 'GET', url: url.href, httpVersion: '1.1', headers: req.headers, isWebSocket: true, replayOf: req.replayOf ?? null });
    let result: Awaited<ReturnType<typeof connectWebSocket>>;
    try {
      // autoPong off: the record should show exactly what we sent, and plans may test pings.
      result = await connectWebSocket(url, { headers, rejectUnauthorized: !req.ignoreTlsErrors, timeoutMs: req.timeoutMs ?? 15_000, autoPong: false });
    } catch (e) {
      if (e instanceof UnexpectedResponse) {
        this.store.completeResponse(ex.id, { status: e.status, headers: e.headers, body: e.body, timings: { total: Date.now() - startedAt } });
      } else this.store.failExchange(ex.id, 'error', (e as Error).message);
      throw e;
    }
    const { ws } = result;
    this.store.completeResponse(ex.id, { status: result.status, statusMessage: result.statusMessage, headers: result.headers, timings: { responseHeaders: Date.now() - startedAt, total: Date.now() - startedAt } });
    const streamId = this.store.openStream('websocket', ex.id, startedAt);
    const conn: Open = { ws, streamId, running: new Set() };
    this.open.set(ex.id, conn);
    const asm = new MessageAssembler('server');
    ws.on('frame', (f) => {
      const m = asm.push(f);
      if (!m) return;
      const meta: Record<string, unknown> = {};
      if (m.fragments > 1) meta.fragments = m.fragments;
      if (m.violations.length) meta.violations = m.violations;
      if (m.close?.code !== undefined) meta.code = m.close.code;
      if (m.close?.reason) meta.reason = m.close.reason;
      this.store.addStreamMessage({ streamId, direction: 'server', opcode: m.opcode, at: Date.now(), payload: m.payload, ...(Object.keys(meta).length ? { meta } : {}) });
    });
    ws.on('ping', (d) => ws.sendFrame({ opcode: 'pong', payload: d.subarray(0, 125) }));
    ws.on('close', (code, reason) => {
      for (const a of conn.running) a.abort();
      this.store.closeStream(streamId, code, reason);
      this.open.delete(ex.id);
    });
    ws.on('error', () => undefined);
    // Let frames that came in with the handshake be recorded before anything is sent.
    await new Promise((r) => setImmediate(r));
    return { exchangeId: ex.id };
  }

  openIds(): string[] {
    return [...this.open.keys()];
  }

  isOpen(exchangeId: string): boolean {
    return this.open.has(exchangeId);
  }

  private get(exchangeId: string): Open {
    const c = this.open.get(exchangeId);
    if (!c) throw new Error('that WebSocket replay is not open');
    return c;
  }

  send(exchangeId: string, payload: Uint8Array, opcode: 'text' | 'binary'): void {
    const c = this.get(exchangeId);
    c.ws.send(opcode === 'text' ? Buffer.from(payload).toString('utf8') : payload, { binary: opcode === 'binary' });
    this.store.addStreamMessage({ streamId: c.streamId, direction: 'client', opcode, at: Date.now(), payload, meta: { injected: true } });
  }

  /** Send a frame plan, recording each step as it goes out. Resolves when the plan has run. */
  async sendPlan(exchangeId: string, steps: PlanStep[]): Promise<SentStep[]> {
    const c = this.get(exchangeId);
    const plan = validatePlan(steps);
    const abort = new AbortController();
    c.running.add(abort);
    const sock = c.ws.socket;
    try {
      return await runPlan(
        plan,
        { write: (b) => sock.write(b), end: () => sock.end(), destroy: () => sock.destroy(), alive: () => !sock.destroyed && sock.writable, defaultMask: true },
        (st) => {
          const step = plan[st.index]!;
          const payload = step.kind === 'frame' ? Buffer.from(step.payload, 'base64') : step.kind === 'raw' ? Buffer.from(step.bytes, 'base64') : new Uint8Array();
          this.store.addStreamMessage({
            streamId: c.streamId,
            direction: 'client',
            opcode: st.frame?.opcode ?? st.kind,
            at: st.at,
            payload,
            meta: { injected: true, step: st.index + 1, of: plan.length, ...(st.frame ? { frame: st.frame } : {}), ...(st.note ? { note: st.note } : {}) },
          });
        },
        abort.signal,
      );
    } finally {
      c.running.delete(abort);
    }
  }

  /**
   * Replay a captured conversation: open a connection like the captured one
   * and send its client messages again, optionally with the original gaps
   * (scaled by speed) and each message turned into a preset's frames.
   */
  async replaySession(
    exchangeId: string,
    opts: { ignoreTlsErrors?: boolean; timing?: 'none' | 'original'; speed?: number; preset?: string; presetOptions?: Record<string, number | string> } = {},
  ): Promise<{ exchangeId: string; sent: number }> {
    const ex = this.store.getExchange(exchangeId);
    if (!ex) throw new Error('exchange not found');
    const stream = this.store.getStreamForExchange(exchangeId);
    if (!stream || stream.protocol !== 'websocket') throw new Error('that exchange has no recorded WebSocket messages');
    const msgs = this.store.getStreamMessages(stream.id).filter((m) => m.direction === 'client' && (m.opcode === 'text' || m.opcode === 'binary'));
    const { exchangeId: id } = await this.connect({ url: ex.url, headers: ex.requestHeaders, replayOf: ex.id, ignoreTlsErrors: opts.ignoreTlsErrors });
    const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
    const steps: PlanStep[] = [];
    msgs.forEach((m, i) => {
      const gap = opts.timing === 'original' && i > 0 ? Math.round((m.at - msgs[i - 1]!.at) / speed) : 0;
      const part = buildPlan(opts.preset ?? 'single', { payload: m.payload, opcode: m.opcode as 'text' | 'binary' }, opts.presetOptions);
      if (gap > 0 && part[0]) part[0] = { ...part[0], delayMs: (part[0].delayMs ?? 0) + gap };
      steps.push(...part);
    });
    if (!steps.length) return { exchangeId: id, sent: 0 };
    void this.sendPlan(id, steps).catch(() => undefined);
    return { exchangeId: id, sent: msgs.length };
  }

  close(exchangeId: string, code = 1000, reason = 'closed from SiteInquisition'): void {
    this.open.get(exchangeId)?.ws.close(code, reason);
  }

  closeAll(): void {
    for (const c of this.open.values()) c.ws.terminate();
    this.open.clear();
  }
}
