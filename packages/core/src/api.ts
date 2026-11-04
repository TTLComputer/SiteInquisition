import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Core } from './core.js';
import type { Change } from './store.js';

/**
 * The core API: JSON-RPC 2.0 over a WebSocket on 127.0.0.1, guarded by a
 * random token. The UI, CLI, MCP server and scripts all talk to the core
 * through this one surface, and live changes are pushed as `change`
 * notifications to clients that call `events.subscribe`.
 */

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (params: Record<string, unknown>, client: WebSocket) => unknown;

const b64 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');

const str = (p: Record<string, unknown>, k: string, required = true): string | undefined => {
  const v = p[k];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string') throw new RpcError(-32602, `param "${k}" must be a string`);
  return v;
};
const num = (p: Record<string, unknown>, k: string): number | undefined => {
  const v = p[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'number') throw new RpcError(-32602, `param "${k}" must be a number`);
  return v;
};

export class CoreApiServer {
  readonly token: string;
  private wss?: WebSocketServer;
  private subscribers = new Set<WebSocket>();
  private readonly handlers: Record<string, Handler>;
  private readonly onChange = (c: Change) => {
    const msg = JSON.stringify({ jsonrpc: '2.0', method: 'change', params: c });
    for (const ws of this.subscribers) if (ws.readyState === ws.OPEN) ws.send(msg);
  };

  constructor(
    private readonly core: Core,
    token?: string,
  ) {
    this.token = token ?? randomBytes(24).toString('hex');
    const store = core.store;
    this.handlers = {
      'core.info': () => core.info(),
      'traffic.search': (p) =>
        store.search(str(p, 'query', false) ?? '', {
          limit: num(p, 'limit'),
          before: str(p, 'before', false),
          order: p.order === 'oldest' ? 'oldest' : 'newest',
        }),
      'traffic.get': (p) => {
        const ex = store.getExchange(str(p, 'id')!);
        if (!ex) throw new RpcError(404, 'exchange not found');
        return { ...ex, stream: store.getStreamForExchange(ex.id) ?? null };
      },
      'traffic.body': (p) => {
        const side = p.side === 'request' ? 'request' : 'response';
        const body = store.getBody(str(p, 'id')!, side, p.decoded === true);
        if (!body) throw new RpcError(404, 'exchange not found');
        return { size: body.byteLength, base64: b64(body) };
      },
      'traffic.flow': (p) => store.getFlow(str(p, 'flowId')!),
      'traffic.streamMessages': (p) => {
        const stream = store.getStreamForExchange(str(p, 'exchangeId')!);
        if (!stream) return [];
        return store
          .getStreamMessages(stream.id, { after: str(p, 'after', false), limit: num(p, 'limit') })
          .map(({ payload, ...m }) => ({ ...m, base64: b64(payload) }));
      },
      'traffic.tag': (p) => {
        if (!Array.isArray(p.tags) || !p.tags.every((t) => typeof t === 'string')) throw new RpcError(-32602, 'tags must be strings');
        store.tagExchange(str(p, 'id')!, p.tags as string[]);
        return true;
      },
      'traffic.notes': (p) => {
        store.setNotes(str(p, 'id')!, (str(p, 'notes', false) ?? null) as string | null);
        return true;
      },
      'scope.get': () => core.scope.get(),
      'scope.set': async (p) => {
        await core.setScope(p.config as never);
        return core.scope.get();
      },
      'changes.since': (p) => store.changesSince(str(p, 'after', false) ?? null, num(p, 'limit')),
      'tls.failures': () => store.tlsFailureSummary(),
      'events.subscribe': (_p, client) => {
        this.subscribers.add(client);
        return true;
      },
      'events.unsubscribe': (_p, client) => {
        this.subscribers.delete(client);
        return true;
      },
    };
  }

  get port(): number {
    const addr = this.wss?.address() as AddressInfo | undefined;
    if (!addr) throw new Error('api server is not running');
    return addr.port;
  }

  async start(port = 0): Promise<number> {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port,
      maxPayload: 32 * 1024 * 1024,
      verifyClient: ({ req }: { req: IncomingMessage }) => {
        const supplied = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? req.headers['x-siq-token'];
        if (typeof supplied !== 'string') return false;
        const a = Buffer.from(supplied);
        const b = Buffer.from(this.token);
        return a.length === b.length && timingSafeEqual(a, b);
      },
    });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => void this.handle(ws, data.toString()));
      ws.on('close', () => this.subscribers.delete(ws));
    });
    this.core.store.on('change', this.onChange);
    this.wss = wss;
    return this.port;
  }

  async stop(): Promise<void> {
    this.core.store.off('change', this.onChange);
    const wss = this.wss;
    this.wss = undefined;
    if (!wss) return;
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    this.subscribers.clear();
  }

  private async handle(ws: WebSocket, raw: string): Promise<void> {
    let req: RpcRequest;
    try {
      req = JSON.parse(raw) as RpcRequest;
    } catch {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    const reply = (body: object) => {
      if (req.id !== undefined && req.id !== null) ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
    };
    const handler = this.handlers[req.method];
    if (!handler) return reply({ error: { code: -32601, message: `unknown method ${req.method}` } });
    try {
      reply({ result: await handler(req.params ?? {}, ws) });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32000;
      reply({ error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}
