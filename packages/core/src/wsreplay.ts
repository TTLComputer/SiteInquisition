import { WebSocket } from 'ws';
import type { CaptureStore, HeaderList } from './store.js';

/**
 * WebSocket replays: open a new connection like a captured one (same URL,
 * cookies and headers), then send frames on it and record both directions.
 * The proxy cannot add frames to a connection it is only passing through, so
 * the composer works on these replay connections instead.
 */
const SKIP = new Set(['host', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-accept', 'content-length', 'transfer-encoding']);

export class WsReplays {
  private open = new Map<string, { ws: WebSocket; streamId: string }>();

  constructor(private readonly store: CaptureStore) {}

  async connect(req: { url: string; headers: HeaderList; replayOf?: string | null; ignoreTlsErrors?: boolean; timeoutMs?: number }): Promise<{ exchangeId: string }> {
    const url = new URL(req.url.replace(/^http/, 'ws'));
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('a WebSocket URL starts with ws:// or wss://');
    const headers: Record<string, string> = {};
    let protocols: string[] | undefined;
    for (const [k, v] of req.headers) {
      const l = k.toLowerCase();
      if (SKIP.has(l) || k.startsWith(':')) continue;
      if (l === 'sec-websocket-protocol') protocols = v.split(',').map((s) => s.trim());
      else headers[k] = v;
    }
    const startedAt = Date.now();
    const ex = this.store.addRequest({ source: 'replay', startedAt, method: 'GET', url: url.href, httpVersion: '1.1', headers: req.headers, isWebSocket: true, replayOf: req.replayOf ?? null });
    const ws = new WebSocket(url, protocols, { headers, rejectUnauthorized: !req.ignoreTlsErrors, handshakeTimeout: req.timeoutMs ?? 15_000 });
    // Listen before 'open' resolves: a greeting can arrive in the same chunk as the upgrade response.
    let streamId: string | undefined;
    const early: Array<{ payload: Buffer; isBinary: boolean; at: number }> = [];
    const record = (payload: Buffer, isBinary: boolean, at: number) =>
      this.store.addStreamMessage({ streamId: streamId!, direction: 'server', opcode: isBinary ? 'binary' : 'text', at, payload });
    ws.on('message', (data, isBinary) => {
      const payload = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (streamId) record(payload, isBinary, Date.now());
      else early.push({ payload, isBinary, at: Date.now() });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('unexpected-response', (_r, res) => reject(new Error(`server answered ${res.statusCode} instead of upgrading`)));
      });
    } catch (e) {
      this.store.failExchange(ex.id, 'error', (e as Error).message);
      throw e;
    }
    this.store.markEstablished(ex.id, { responseHeaders: Date.now() - startedAt });
    streamId = this.store.openStream('websocket', ex.id, startedAt);
    const sid = streamId;
    for (const m of early.splice(0)) record(m.payload, m.isBinary, m.at);
    this.open.set(ex.id, { ws, streamId: sid });
    ws.on('close', (code, reason) => {
      this.store.closeStream(sid, code, reason.toString());
      this.open.delete(ex.id);
    });
    ws.on('error', () => undefined);
    return { exchangeId: ex.id };
  }

  openIds(): string[] {
    return [...this.open.keys()];
  }

  isOpen(exchangeId: string): boolean {
    return this.open.has(exchangeId);
  }

  send(exchangeId: string, payload: Uint8Array, opcode: 'text' | 'binary'): void {
    const c = this.open.get(exchangeId);
    if (!c) throw new Error('that WebSocket replay is not open');
    c.ws.send(opcode === 'text' ? Buffer.from(payload).toString('utf8') : payload, { binary: opcode === 'binary' });
    this.store.addStreamMessage({ streamId: c.streamId, direction: 'client', opcode, at: Date.now(), payload, meta: { injected: true } });
  }

  close(exchangeId: string): void {
    this.open.get(exchangeId)?.ws.close(1000, 'closed from SiteInquisition');
  }

  closeAll(): void {
    for (const c of this.open.values()) c.ws.terminate();
    this.open.clear();
  }
}
