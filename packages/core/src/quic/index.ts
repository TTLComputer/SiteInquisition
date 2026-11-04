/** Convenience client and server on top of the in-house HTTP/3 stack. */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Connection } from './connection.js';
import { QuicClient, QuicServer, type QuicConnectOptions, type QuicServerOptions } from './endpoint.js';
import { H3Session, type H3SessionOptions, type H3Stream } from './h3.js';
import type { Field } from './qpack.js';
import type { SessionTicket } from './tls.js';

export * from './connection.js';
export * from './endpoint.js';
export * from './h3.js';
export * from './qpack.js';
export type { SessionTicket } from './tls.js';

export interface H3ConnectOptions extends Omit<QuicConnectOptions, 'alpn' | 'serverName'>, H3SessionOptions {
  serverName?: string;
  alpn?: string[];
  /** Trust these CA certificates (PEM) as well as the system roots. */
  ca?: string[];
  rejectUnauthorized?: boolean;
}

export interface H3Connection {
  client: QuicClient;
  session: H3Session;
  /** Tickets the server sent, for 0-RTT on a later connection. */
  tickets: SessionTicket[];
  close(): void;
}

/** Open an HTTP/3 connection. With earlyData and a session ticket it returns before the handshake ends. */
export async function h3Connect(o: H3ConnectOptions): Promise<H3Connection> {
  const tickets: SessionTicket[] = [];
  const client = await QuicClient.connect(
    {
      ...o,
      serverName: o.serverName ?? o.host,
      alpn: o.alpn ?? ['h3'],
      tls: { ...o.tls, ca: o.ca ?? o.tls?.ca, rejectUnauthorized: o.rejectUnauthorized ?? o.tls?.rejectUnauthorized },
    },
    { ticket: (t) => tickets.push(t) },
  );
  const session = new H3Session(client.conn, o);
  if (!(o.earlyData && client.conn.earlyDataAvailable)) await client.ready;
  return { client, session, tickets, close: () => client.close(0x100) };
}

export interface H3FetchResult {
  status: number;
  headers: Field[];
  body: Buffer;
  trailers: Field[];
  stream: H3Stream;
}

/** Request fields for a URL: pseudo-headers first, connection-specific headers dropped. */
export function requestFields(method: string, url: URL, headers: Array<[string, string]>): Field[] {
  const drop = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'te', 'http2-settings']);
  const host = headers.find(([k]) => k.toLowerCase() === 'host')?.[1] ?? url.host;
  const out: Field[] = [
    [':method', method.toUpperCase()],
    [':scheme', 'https'],
    [':authority', host],
    [':path', url.pathname + url.search],
  ];
  for (const [k, v] of headers) {
    const l = k.toLowerCase();
    if (drop.has(l) || l.startsWith(':')) continue;
    out.push([l, v]);
  }
  return out;
}

export interface H3ServerOptions extends Omit<QuicServerOptions, 'tls'>, H3SessionOptions {
  cert: string | ((sni: string) => { cert: string; key: string });
  key?: string;
  acceptEarlyData?: boolean;
  alpn?: string[];
}

export interface H3ServerRequest {
  stream: H3Stream;
  session: H3Session;
  connection: Connection;
  method: string;
  path: string;
  authority: string;
  headers: Field[];
  /** Resolves with the whole request body. */
  body(): Promise<Buffer>;
  respond(status: number, headers?: Field[], body?: Uint8Array | string): void;
}

/** An HTTP/3 server for tests, mocks and the capture listener. */
export class H3Server extends EventEmitter {
  readonly quic: QuicServer;
  readonly sessions = new Set<H3Session>();

  constructor(opts: H3ServerOptions, handler?: (req: H3ServerRequest) => void) {
    super();
    this.quic = new QuicServer({
      ...opts,
      tls: { cert: opts.cert, key: opts.key, alpn: opts.alpn ?? ['h3'], ticketKey: randomBytes(32), acceptEarlyData: opts.acceptEarlyData },
    });
    if (handler) this.on('request', handler);
    this.quic.on('connection', (conn: Connection) => {
      const session = new H3Session(conn, opts);
      this.sessions.add(session);
      session.on('closed', () => this.sessions.delete(session));
      this.emit('session', session);
      session.on('request', (stream: H3Stream) => {
        const h = stream.headers ?? [];
        const get = (n: string) => h.find(([k]) => k === n)?.[1] ?? '';
        const chunks: Buffer[] = [];
        stream.on('data', (d: Buffer) => chunks.push(d));
        const ended = new Promise<Buffer>((r) => {
          if (stream.ended) return r(Buffer.concat(chunks));
          stream.once('end', () => r(Buffer.concat(chunks)));
          // A reset request resolves with what arrived; check stream.resetCode.
          stream.once('reset', () => r(Buffer.concat(chunks)));
        });
        this.emit('request', {
          stream,
          session,
          connection: conn,
          method: get(':method'),
          path: get(':path'),
          authority: get(':authority'),
          headers: h.filter(([k]) => !k.startsWith(':')),
          body: () => ended,
          respond(status, headers = [], body) {
            const b = typeof body === 'string' ? Buffer.from(body) : body;
            stream.sendHeaders([[':status', String(status)], ...headers], !b?.length);
            if (b?.length) stream.sendData(b, true);
          },
        } satisfies H3ServerRequest);
      });
    });
  }

  listen(port = 0, host = '127.0.0.1') {
    return this.quic.listen(port, host);
  }

  close() {
    return this.quic.close();
  }
}
