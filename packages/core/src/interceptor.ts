/**
 * The intercepting proxy server, on Node's own net, tls, http and http2.
 *
 * One listening port takes:
 *  - plain HTTP proxy requests (`GET http://host/path`) and direct requests
 *  - CONNECT tunnels, from HTTPS clients and WebSocket clients
 *  - SOCKS5 (CONNECT command, no auth)
 *  - TLS straight to the port, routed by SNI, and plain HTTP straight to
 *    the port (transparent mode: DNS or a firewall redirect sends traffic here)
 *
 * Inside a tunnel (or straight to the port) the first bytes decide: a TLS
 * ClientHello for a host we decrypt is terminated with a leaf certificate
 * from our CA (HTTP/2 or HTTP/1.1 by ALPN); TLS for any other host is passed
 * through untouched; the HTTP/2 connection preface is served as cleartext
 * HTTP/2 (h2c with prior knowledge); anything else is read as HTTP/1.1.
 *
 * Whether a connection is HTTP/2 is always the server's call, so a developer
 * sees their server's HTTP/2 support as it is: over TLS the client is offered
 * the protocol the server picked by ALPN; an "Upgrade: h2c" goes to the
 * server, and if it accepts, the bytes are relayed untouched and read on the
 * side for the record; prior knowledge goes on as prior knowledge, and a
 * server that refuses it gets the client a 502, never a quiet HTTP/1.1.
 *
 * Requests are buffered (so hooks can see and change them) and forwarded,
 * HTTP/2 on the server connection paired with the client's (trailers and
 * gRPC work), HTTP/1.1 otherwise. Responses are streamed back unless a hook
 * needs the whole body. Events report each step so the engine can record it.
 */
import { EventEmitter } from 'node:events';
import { STATUS_CODES, createServer as createHttpServer, request as httpRequest, Agent as HttpAgent, type IncomingMessage, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import {
  connect as h2Connect,
  createServer as createH2Server,
  type ClientHttp2Session,
  type Http2Session,
  type IncomingHttpHeaders as H2Headers,
  type Http2ServerRequest,
  type Http2ServerResponse,
  type OutgoingHttpHeaders,
} from 'node:http2';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { connect as netConnect, createServer as createNetServer, isIP, type AddressInfo, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { Duplex, type Readable, type Writable } from 'node:stream';
import { connect as tlsConnect, createServer as createTlsServer, type TLSSocket } from 'node:tls';
import * as zlib from 'node:zlib';
import { FrameParser, MessageAssembler, encodeFrame, isControl, OPCODES, type AssembledMessage, type Frame } from './websocket.js';
import { H2Tap } from './h2tap.js';
import { runPlan, type PlanStep, type SentStep } from './wsplan.js';
import type { LeafIssuer } from './x509.js';
import { CERT_REFUSED, upstreamTls } from './upstreamtls.js';

export type HeaderPairs = Array<[string, string]>;

export interface Timings {
  requestBody?: number;
  responseHeaders?: number;
  total?: number;
}

export interface ProxiedRequest {
  id: string;
  method: string;
  url: string;
  httpVersion: string;
  headers: HeaderPairs;
  /** The body as received, still content-encoded (the first maxCaptureBytes when it was streamed). */
  body: Buffer;
  /** The full body size when `body` holds only its start; -1 when the size is not known. */
  bodySize?: number;
  remoteAddress: string | null;
  /** Epoch milliseconds. */
  startTime: number;
  hostname: string;
}

export interface ProxiedResponse {
  id: string;
  status: number;
  statusMessage?: string;
  headers: HeaderPairs;
  /** The body as sent to the client, still content-encoded (the first maxCaptureBytes of a large one). */
  body: Buffer;
  /** The full body size when `body` holds only its start. */
  bodySize?: number;
  timings: Timings;
}

export interface WsMessage {
  id: string;
  /** "client" means from the client to the server. */
  from: 'client' | 'server';
  /** text, binary, ping, pong, close, opN, or raw / socket for injected steps. */
  opcode: string;
  data: Buffer;
  at: number;
  /** Fragment count, protocol violations, close code, injection details. */
  meta?: Record<string, unknown>;
}

/** What a request hook may do: change the request, answer it, or close the connection. */
export type RequestAction =
  | { close: true }
  | { respond: { status: number; statusMessage?: string; headers: HeaderPairs; body: Uint8Array } }
  | { replace: { method: string; url: string; headers: HeaderPairs; body?: Uint8Array } };

export type ResponseAction = { close: true } | { replace: { status: number; statusMessage?: string; headers: HeaderPairs; body?: Uint8Array } };

/** One complete WebSocket data message offered to the wsMessage hook before it is passed on. */
export interface WsHookMessage {
  /** The proxy's id for the connection (the websocket-request id). */
  id: string;
  url: string;
  from: 'client' | 'server';
  opcode: string;
  payload: Buffer;
  fragments: number;
}

/** Nothing (pass it on as it came), drop it, or send this instead as one frame. */
export type WsMessageAction = { drop: true } | { replace: { opcode: 'text' | 'binary'; payload: Uint8Array } };

export interface InterceptorHooks {
  /** Whether hooks run for this URL. Hooked exchanges are buffered in full. */
  wants(url: string): boolean;
  /**
   * Whether this WebSocket's messages should go through wsMessage. Asked at
   * each message boundary, so a breakpoint added mid-connection takes effect
   * on the next message; when it says no, bytes are relayed untouched.
   */
  wantsWsMessages?(url: string): boolean;
  wsMessage?(msg: WsHookMessage): Promise<WsMessageAction | void>;
  /** Called with the decoded body. */
  request?(req: ProxiedRequest, decodedBody: Buffer): Promise<RequestAction | void>;
  response?(req: ProxiedRequest, res: { status: number; statusMessage?: string; headers: HeaderPairs; decodedBody: Buffer }): Promise<ResponseAction | void>;
  /** Whether response() needs this response; if not it streams through. Missing means always. */
  wantsResponse?(req: ProxiedRequest, status: number): boolean;
}

export interface InterceptorOptions {
  issuer: LeafIssuer;
  /** Terminate TLS for this host (SNI, or the tunnel's target)? */
  shouldDecrypt(host: string): boolean;
  /** Skip upstream certificate checks for this host? */
  ignoreUpstreamTlsErrors(host: string): boolean;
  /** Return false to drop a client before any byte is read. */
  acceptClient?(socket: Socket): boolean;
  hooks?: InterceptorHooks;
  /** Bytes of each body kept for the record; the rest is passed on but not kept. Default 10 MB. */
  maxCaptureBytes?: number;
  /**
   * Largest body held whole so hooks can see and change it. A bigger one
   * skips the hooks and streams through. Default 64 MB.
   */
  maxBufferBytes?: number;
  /**
   * While a request or response is held at a breakpoint, send PING frames on
   * the HTTP/2 connections (both the client's and the paired upstream one)
   * every this-many ms, so neither side times the connection out while the
   * user is composing an edit. Returns 0 or undefined to leave it off. Read
   * each time a hook is about to wait, so the setting takes effect live.
   */
  keepAlivePausedMs?(): number | undefined;
}

export type InterceptorEvents = {
  request: [ProxiedRequest];
  response: [ProxiedResponse];
  /** The exchange ended without a complete response. kind "error" is an upstream failure. */
  abort: [{ id: string; kind: 'aborted' | 'error'; message: string; timings: Timings }];
  'websocket-request': [ProxiedRequest];
  'websocket-accepted': [ProxiedResponse];
  'websocket-message': [WsMessage];
  'websocket-close': [{ id: string; code?: number; reason?: string }];
  'tls-passthrough': [{ host: string; remoteAddress: string | null }];
  'tls-client-error': [{ host: string | null; remoteAddress: string | null; cause: string }];
  error: [Error];
};

// --- small helpers ------------------------------------------------------

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'http2-settings']);

const pairsOf = (raw: string[]): HeaderPairs => {
  const out: HeaderPairs = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i]!, raw[i + 1]!]);
  return out;
};

const flat = (pairs: HeaderPairs): string[] => pairs.flatMap(([k, v]) => [k, v]);

const getHeader = (pairs: HeaderPairs, name: string) => pairs.find(([k]) => k.toLowerCase() === name)?.[1];

/** Header pairs minus hop-by-hop ones, including any named in Connection. */
function endToEnd(pairs: HeaderPairs): HeaderPairs {
  const named = new Set((getHeader(pairs, 'connection') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return pairs.filter(([k]) => {
    const l = k.toLowerCase();
    return !HOP_BY_HOP.has(l) && !named.has(l) && !l.startsWith(':');
  });
}

/** HTTP/2 header object to pairs, without pseudo-headers. */
const pairsOfH2 = (h: H2Headers): HeaderPairs => {
  const out: HeaderPairs = [];
  for (const [k, v] of Object.entries(h)) {
    if (k.startsWith(':') || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) out.push([k, String(one)]);
  }
  return out;
};

const toObject = (pairs: HeaderPairs): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of pairs) {
    const l = k.toLowerCase();
    const cur = out[l];
    out[l] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
};

type Codec = { decode(b: Buffer): Buffer; encode(b: Buffer): Buffer };
// zstd arrived in Node 22.15; older 22.x builds simply do not get it.
const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer; zstdCompressSync?: (b: Buffer) => Buffer };
const CODECS: Record<string, Codec> = {
  gzip: { decode: zlib.gunzipSync, encode: zlib.gzipSync },
  'x-gzip': { decode: zlib.gunzipSync, encode: zlib.gzipSync },
  deflate: {
    // Some servers send raw deflate under this name.
    decode: (b) => {
      try {
        return zlib.inflateSync(b);
      } catch {
        return zlib.inflateRawSync(b);
      }
    },
    encode: zlib.deflateSync,
  },
  br: { decode: zlib.brotliDecompressSync, encode: zlib.brotliCompressSync },
  ...(z.zstdDecompressSync && z.zstdCompressSync ? { zstd: { decode: z.zstdDecompressSync, encode: z.zstdCompressSync } } : {}),
};

const encodings = (pairs: HeaderPairs) =>
  (getHeader(pairs, 'content-encoding') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && e !== 'identity');

/** Undo Content-Encoding. Returns undefined when it is unknown or the body is corrupt. */
export function decodeBody(body: Buffer, headers: HeaderPairs): Buffer | undefined {
  let out = body;
  try {
    for (const e of encodings(headers).reverse()) {
      const c = CODECS[e];
      if (!c) return undefined;
      out = c.decode(out);
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Apply Content-Encoding to a decoded body; unknown encodings are dropped from the headers. */
function encodeBody(body: Buffer, headers: HeaderPairs): { body: Buffer; headers: HeaderPairs } {
  const list = encodings(headers);
  if (list.some((e) => !CODECS[e])) return { body, headers: headers.filter(([k]) => k.toLowerCase() !== 'content-encoding') };
  let out = body;
  for (const e of list) out = CODECS[e]!.encode(out);
  return { body: out, headers };
}

/** Replace Content-Length with the real one, and drop Transfer-Encoding: the body is complete. */
const withLength = (headers: HeaderPairs, length: number, always: boolean): HeaderPairs => {
  const had = headers.some(([k]) => k.toLowerCase() === 'content-length');
  const out = headers.filter(([k]) => !/^(content-length|transfer-encoding)$/i.test(k));
  if (had || always || length > 0) out.push(['content-length', String(length)]);
  return out;
};

const DEFAULT_CAPTURE = 10 * 1024 * 1024;
const DEFAULT_BUFFER = 64 * 1024 * 1024;

/**
 * Read a stream until it ends or `limit` bytes have arrived. On the limit the
 * stream is left paused with what was read so far, for the caller to send on
 * and pipe the rest.
 */
function readUpTo(stream: NodeJS.ReadableStream | Readable, limit: number): Promise<{ chunks: Buffer[]; size: number; ended: boolean } | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.off('aborted', onError);
    };
    const onData = (c: Buffer | string) => {
      const b = typeof c === 'string' ? Buffer.from(c) : c;
      chunks.push(b);
      size += b.length;
      if (size > limit) {
        stream.pause();
        cleanup();
        resolve({ chunks, size, ended: false });
      }
    };
    const onEnd = () => {
      cleanup();
      resolve({ chunks, size, ended: true });
    };
    const onError = () => {
      cleanup();
      resolve(undefined);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('aborted', onError);
  });
}

/** A whole (small) body, or undefined when the stream failed or ran past the buffer limit. */
const readAll = async (stream: NodeJS.ReadableStream | Readable): Promise<Buffer> => {
  const r = await readUpTo(stream, DEFAULT_BUFFER);
  if (!r?.ended) throw new Error('body too large or cut off');
  return Buffer.concat(r.chunks);
};

/** Keeps the first `limit` bytes of a stream for the record and counts the rest. */
class Capture {
  private chunks: Buffer[] = [];
  private kept = 0;
  size = 0;
  constructor(private readonly limit: number) {}
  add(c: Buffer) {
    this.size += c.length;
    if (this.kept >= this.limit) return;
    const part = this.kept + c.length > this.limit ? c.subarray(0, this.limit - this.kept) : c;
    this.chunks.push(part);
    this.kept += part.length;
  }
  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }
  get truncated(): boolean {
    return this.size > this.kept;
  }
}

/** Wait for the next chunk from a stream and pause it again, so nothing is lost before it is wrapped. */
function readChunk(socket: Duplex): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      cleanup();
      socket.pause();
      resolve(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(undefined);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onEnd);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    socket.once('error', onEnd);
    socket.resume();
  });
}

/** Facts about a connection that every wrapper of it carries: who connected, and where to (from CONNECT, SOCKS or SNI). */
interface ConnInfo {
  remote: string | null;
  target?: Target;
  /**
   * The server connection paired with an HTTP/2 client connection: opened
   * when TLS was negotiated (the server's ALPN answer), or at the first
   * cleartext request. `key` says which origin it is for.
   */
  upstream?: { key: string; session: Promise<ClientHttp2Session | undefined> };
  /** The client's HTTP/2 session, closed when the paired server one closes. */
  clientSession?: Http2Session;
}
const INFO = Symbol('siq.conn');
type Tagged = { [INFO]?: ConnInfo };
const infoOf = (s: unknown): ConnInfo | undefined => (s as Tagged | undefined)?.[INFO];
const tag = (s: unknown, info: ConnInfo) => ((s as Tagged)[INFO] = info);

/**
 * A duplex over a socket that first replays bytes already read from it.
 * Socket-only calls (timeouts, addresses) are forwarded, so http and tls
 * can use it like the socket itself.
 */
class Prefixed extends Duplex {
  constructor(
    readonly inner: Duplex,
    prefix: Buffer,
  ) {
    super({ allowHalfOpen: true });
    const info = infoOf(inner);
    if (info) tag(this, { ...info });
    this.push(prefix);
    inner.on('data', (c: Buffer) => {
      if (!this.push(c)) inner.pause();
    });
    inner.once('end', () => this.push(null));
    inner.once('error', (err) => this.destroy(err));
    inner.once('close', () => this.destroy());
  }

  override _read(): void {
    this.inner.resume();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.inner.destroyed) return cb(new Error('socket closed'));
    this.inner.write(chunk, cb);
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.inner.end();
    cb();
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.inner.destroy();
    cb(err);
  }

  private get sock(): Partial<Socket> {
    return this.inner as unknown as Partial<Socket>;
  }

  get remoteAddress() {
    return this.sock.remoteAddress;
  }
  get remotePort() {
    return this.sock.remotePort;
  }
  get localAddress() {
    return this.sock.localAddress;
  }
  get localPort() {
    return this.sock.localPort;
  }
  setTimeout(ms: number, cb?: () => void) {
    this.sock.setTimeout?.(ms, cb);
    return this;
  }
  setNoDelay(v?: boolean) {
    this.sock.setNoDelay?.(v);
    return this;
  }
  setKeepAlive(v?: boolean, ms?: number) {
    this.sock.setKeepAlive?.(v, ms);
    return this;
  }
  ref() {
    this.sock.ref?.();
    return this;
  }
  unref() {
    this.sock.unref?.();
    return this;
  }
}

/** SNI (null when there is none) and the ALPN offer from a TLS ClientHello record. Throws when the bytes are not a ClientHello. */
export function parseClientHello(buf: Buffer): { sni: string | null; complete: boolean; alpn?: string[] } {
  if (buf[0] !== 0x16 || buf[1] !== 0x03) throw new Error('not a TLS handshake');
  if (buf.length < 5) return { sni: null, complete: false };
  const recordEnd = 5 + buf.readUInt16BE(3);
  if (buf.length < recordEnd) return { sni: null, complete: false };
  let p = 5;
  let sni: string | null = null;
  let alpn: string[] | undefined;
  if (buf[p] !== 0x01) throw new Error('not a ClientHello');
  p += 4 + 2 + 32; // handshake header, version, random
  p += 1 + buf[p]!; // session id
  p += 2 + buf.readUInt16BE(p); // cipher suites
  p += 1 + buf[p]!; // compression methods
  if (p + 2 > recordEnd) return { sni: null, complete: true };
  const extEnd = Math.min(recordEnd, p + 2 + buf.readUInt16BE(p));
  p += 2;
  while (p + 4 <= extEnd) {
    const type = buf.readUInt16BE(p);
    const size = buf.readUInt16BE(p + 2);
    p += 4;
    if (type === 0 && size >= 5) {
      // server_name list: list length, then name type 0 (host_name), length, name
      if (buf[p + 2] === 0) sni = buf.toString('ascii', p + 5, p + 5 + buf.readUInt16BE(p + 3));
    } else if (type === 16 && size >= 2) {
      // application_layer_protocol_negotiation: list length, then length-prefixed names
      alpn = [];
      const end = Math.min(p + 2 + buf.readUInt16BE(p), p + size);
      for (let q = p + 2; q < end; q += 1 + buf[q]!) alpn.push(buf.toString('ascii', q + 1, q + 1 + buf[q]!));
    }
    p += size;
  }
  return { sni, complete: true, ...(alpn ? { alpn } : {}) };
}

/** Map a client-side handshake failure to a short cause. "cert-rejected", "closed" and "reset" usually mean the client refuses our CA. */
function tlsCause(err: (Error & { code?: string }) | undefined): string {
  if (!err) return 'closed';
  const m = err.message.toLowerCase();
  if (/disconnected before secure tls connection|socket hang up/.test(m)) return 'closed';
  if (/certificate unknown|bad certificate|unknown ca|certificate_unknown|bad_certificate|unknown_ca/.test(m)) return 'cert-rejected';
  if (err.code === 'ECONNRESET') return 'reset';
  if (/no shared cipher|no_shared_cipher/.test(m)) return 'no-shared-cipher';
  if (/unsupported protocol|wrong version|version too low/.test(m)) return 'unsupported-protocol';
  if (/no application protocol|no_application_protocol/.test(m)) return 'no-alpn-match';
  return 'unknown';
}

/** What the response handler needs from an HTTP/1.1 IncomingMessage or an HTTP/2 client stream. */
type UpstreamResponse = Readable & { statusCode?: number; statusMessage?: string; rawHeaders: string[] };

/** Where a connection is headed, known from CONNECT, SOCKS or SNI. */
interface Target {
  host: string;
  port: number;
  secure: boolean;
  /**
   * The port is a default, not known: TLS sent straight to the port (routed
   * by SNI) has no CONNECT line to say where it was headed, so the request's
   * Host or :authority port wins.
   */
  portGuessed?: boolean;
}

/** The HTTP/2 connection preface a client sends first with prior knowledge. */
const H2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'latin1');

const hostPort = (host: string, port: number, secure: boolean) => {
  const h = isIP(host) === 6 ? `[${host}]` : host;
  return port === (secure ? 443 : 80) ? h : `${h}:${port}`;
};

function splitHostPort(s: string, defPort: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
  if (!m) return { host: s, port: defPort };
  return { host: m[1]!, port: m[2] ? Number(m[2]) : defPort };
}

// --- the server ---------------------------------------------------------

export class Interceptor extends EventEmitter<InterceptorEvents> {
  private net: Server;
  private http = createHttpServer();
  private sockets = new Set<Duplex>();
  private seq = 0;
  private httpAgent = new HttpAgent({ keepAlive: true });
  private httpsAgents = new Map<boolean, HttpsAgent>();
  /** Open HTTP/2 sessions to servers, and connects in flight, by origin and TLS check setting. */
  private h2Sessions = new Map<string, Promise<ClientHttp2Session | undefined>>();
  /** Origins that answered without HTTP/2; their requests go over HTTP/1.1. */
  private h1Only = new Set<string>();

  constructor(private readonly opts: InterceptorOptions) {
    super();
    this.net = createNetServer((socket) => this.onConnection(socket));
    // Requests may come in over keep-alive connections for a long time.
    this.http.keepAliveTimeout = 60_000;
    this.http.requestTimeout = 0;
    this.http.on('request', (req, res) => void this.onRequest(req, res));
    this.http.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.onConnect(req, socket, head));
    this.http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.onUpgrade(req, socket, head));
    this.http.on('clientError', (_err, socket: Duplex) => {
      if ((socket as Partial<Socket>).writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
  }

  get port(): number {
    return (this.net.address() as AddressInfo).port;
  }

  /** Listen on `host` (all interfaces when undefined). */
  listen(port: number, host?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.net.once('error', reject);
      this.net.listen(port, host, () => {
        this.net.off('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.httpAgent.destroy();
    for (const a of this.httpsAgents.values()) a.destroy();
    const sessions = [...this.h2Sessions.values()];
    this.h2Sessions.clear();
    for (const p of sessions) void p.then((s) => s?.destroy());
    await new Promise<void>((r) => this.net.close(() => r()));
  }

  private track(s: Duplex): void {
    this.sockets.add(s);
    s.once('close', () => this.sockets.delete(s));
    s.on('error', () => undefined);
  }

  private onConnection(socket: Socket): void {
    if (this.opts.acceptClient && !this.opts.acceptClient(socket)) return void socket.destroy();
    this.track(socket);
    tag(socket, { remote: socket.remoteAddress ?? null });
    void this.route(socket, undefined, undefined);
  }

  /**
   * Decide what a byte stream is and hand it on. `target` is set inside a
   * CONNECT or SOCKS tunnel; without it, TLS is routed by SNI and HTTP by
   * request line.
   */
  private async route(socket: Duplex, target: Omit<Target, 'secure'> | undefined, head: Buffer | undefined): Promise<void> {
    let first = head?.length ? head : await readChunk(socket);
    if (!first) return void socket.destroy();
    let hello: ReturnType<typeof parseClientHello> | undefined;
    if (first[0] === 0x16) {
      // Wait for the whole ClientHello (usually already here) to read SNI.
      try {
        hello = parseClientHello(first);
        while (!hello.complete && first.length < 16_384) {
          const more = await readChunk(socket);
          if (!more) return void socket.destroy();
          first = Buffer.concat([first, more]);
          hello = parseClientHello(first);
        }
      } catch {
        return void socket.destroy();
      }
    } else if (first[0] === H2_PREFACE[0]) {
      // Possibly the HTTP/2 preface, which can arrive split across reads.
      while (first.length < H2_PREFACE.length && H2_PREFACE.subarray(0, first.length).equals(first)) {
        const more = await readChunk(socket);
        if (!more) return void socket.destroy();
        first = Buffer.concat([first, more]);
      }
    }
    const h2Preface = first.length >= H2_PREFACE.length && first.subarray(0, H2_PREFACE.length).equals(H2_PREFACE);
    const stream = new Prefixed(socket, first);
    this.track(stream);
    const remote = infoOf(socket)?.remote ?? null;
    if (first[0] === 0x05 && !target) return this.socks(stream);
    if (hello) {
      const host = (hello.sni ?? target?.host ?? '').toLowerCase();
      const port = target?.port ?? 443;
      if (!host) return void stream.destroy();
      if (this.opts.shouldDecrypt(host)) return this.terminateTls(stream, { host, port, secure: true, ...(target ? {} : { portGuessed: true }) }, remote, hello.alpn);
      return this.passthrough(stream, target?.host ?? host, port, remote);
    }
    const conn: ConnInfo = { remote, target: target ? { ...target, secure: false } : undefined };
    tag(stream, conn);
    if (h2Preface) return this.serveH2(stream, conn);
    this.http.emit('connection', stream);
  }

  /**
   * HTTP/2 on a cleartext stream (prior knowledge) or a decrypted one, on its
   * own (never listening) server so requests know their connection.
   */
  private serveH2(stream: Duplex, conn: ConnInfo): void {
    const server = createH2Server();
    server.on('session', (session) => (conn.clientSession = session));
    server.on('request', (req: Http2ServerRequest, res: Http2ServerResponse) => void this.onRequest(req, res, conn));
    server.on('sessionError', () => undefined);
    server.emit('connection', stream);
  }

  /**
   * Await a hook, pinging the HTTP/2 connections while it waits so a held
   * breakpoint does not let either side time the connection out. The ping
   * interval is read when the wait starts; most hooks return at once and the
   * timer never fires. HTTP/1.1 keeps its sockets alive on its own.
   */
  private async whilePaused<T>(p: Promise<T>, conn: ConnInfo | undefined, h2: boolean): Promise<T> {
    const ms = h2 && conn ? this.opts.keepAlivePausedMs?.() : undefined;
    if (!ms || ms <= 0) return p;
    const ping = (s: Http2Session | undefined) => {
      if (!s || s.destroyed) return;
      try {
        s.ping(() => undefined);
      } catch {
        // A ping can be refused (backpressure, closing); the next tick tries again.
      }
    };
    const timer = setInterval(() => {
      ping(conn!.clientSession);
      void conn!.upstream?.session.then(ping).catch(() => undefined);
    }, Math.max(1000, ms));
    timer.unref();
    try {
      return await p;
    } finally {
      clearInterval(timer);
    }
  }

  private passthrough(stream: Duplex, host: string, port: number, remoteAddress: string | null): void {
    this.emit('tls-passthrough', { host, remoteAddress });
    const upstream = netConnect({ host, port });
    this.track(upstream);
    upstream.once('error', () => stream.destroy());
    stream.once('error', () => upstream.destroy());
    stream.once('close', () => upstream.destroy());
    upstream.once('close', () => stream.destroy());
    stream.pipe(upstream);
    upstream.pipe(stream);
  }

  /**
   * Terminate TLS with a leaf for the host. The protocol offered to the
   * client is the one the server picks: when the client offers h2, the
   * proxy first connects to the server with the client's offer and lets its
   * ALPN answer decide (so a server without HTTP/2 shows up as HTTP/1.1, as
   * it would without the proxy). An h2 server connection is kept and paired
   * with this client connection. Decrypted HTTP/1.1 goes to the shared
   * HTTP/1.1 server and HTTP/2 to a per-connection one, both knowing the
   * tunnel the requests came through.
   */
  private async terminateTls(stream: Duplex, target: Target, remoteAddress: string | null, alpn?: string[]): Promise<void> {
    const conn: ConnInfo = { remote: remoteAddress, target };
    let offer: string[] = (alpn ?? []).filter((p) => p === 'h2' || p === 'http/1.1');
    if (offer.includes('h2')) {
      const insecure = this.opts.ignoreUpstreamTlsErrors(target.host);
      const probe = await this.probeAlpn(target, insecure, alpn!);
      if (probe && 'refused' in probe) {
        // The server accepts none of the client's protocols: offer one the client did not
        // ask for, so its handshake fails with the same no_application_protocol alert.
        offer = [offer.includes('http/1.1') ? 'x-siq-none' : 'http/1.1'];
      } else if (probe) {
        offer = probe.protocol && offer.includes(probe.protocol) ? [probe.protocol] : [];
        if (probe.protocol === 'h2') conn.upstream = { key: this.originKey(target, insecure), session: this.openH2(target, probe.socket, conn) };
        else probe.socket.destroy();
      }
      // When the server cannot be reached, the client's offer stands; its requests then report why.
      if (stream.destroyed) return;
    }
    const leaf = this.opts.issuer.issue(target.host);
    const server = createTlsServer({
      // Clients without SNI (IP addresses) get the certificate for the target.
      key: leaf.key,
      cert: leaf.cert,
      ...(offer.length ? { ALPNProtocols: offer } : {}),
      SNICallback: (name, cb) => {
        try {
          cb(null, this.opts.issuer.issue((name || target.host).toLowerCase()).context);
        } catch (err) {
          cb(err as Error);
        }
      },
    });
    let secured = false;
    server.on('secureConnection', (sock: TLSSocket) => {
      secured = true;
      this.track(sock);
      tag(sock, conn);
      if (sock.alpnProtocol === 'h2') this.serveH2(sock, conn);
      else {
        void conn.upstream?.session.then((s) => s?.close());
        conn.upstream = undefined;
        this.http.emit('connection', sock);
      }
    });
    server.on('tlsClientError', (err: Error) => {
      if (!secured) this.emit('tls-client-error', { host: target.host, remoteAddress, cause: tlsCause(err) });
      void conn.upstream?.session.then((s) => s?.destroy());
    });
    server.emit('connection', stream);
  }

  /** Connect to the server with the client's ALPN offer and report its choice; undefined when it cannot be reached. */
  private probeAlpn(target: Target, insecure: boolean, alpn: string[]): Promise<{ protocol: string | false; socket: TLSSocket } | { refused: true } | undefined> {
    return new Promise((resolve) => {
      const sock = tlsConnect({
        host: target.host,
        port: target.port,
        servername: isIP(target.host) ? undefined : target.host,
        ALPNProtocols: alpn,
        ...upstreamTls(target.host, insecure),
      });
      this.track(sock);
      const timer = setTimeout(() => sock.destroy(new Error('timed out')), 10_000);
      sock.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve(/NO_APPLICATION_PROTOCOL/i.test(`${err.code ?? ''} ${err.message}`) ? { refused: true } : undefined);
      });
      sock.once('secureConnect', () => {
        clearTimeout(timer);
        sock.removeAllListeners('error');
        sock.on('error', () => undefined);
        resolve({ protocol: sock.alpnProtocol ?? false, socket: sock });
      });
    });
  }

  private originKey(target: Target, insecure: boolean): string {
    return `${target.secure ? 'https' : 'http'}://${hostPort(target.host, target.port, target.secure)}|${insecure ? 'insecure' : 'verify'}`;
  }

  /**
   * An HTTP/2 client session over `sock`, ready once the server's SETTINGS
   * arrive; undefined when the server does not speak HTTP/2 there. With
   * `pair`, closing the server session also closes that client connection's
   * session, as it would have closed without the proxy.
   */
  private openH2(target: Target, sock: Duplex, pair?: ConnInfo): Promise<ClientHttp2Session | undefined> {
    const authority = `${target.secure ? 'https' : 'http'}://${hostPort(target.host, target.port, target.secure)}`;
    return new Promise((resolve) => {
      const session = h2Connect(authority, { createConnection: () => sock });
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) return resolve(session);
        session.destroy();
        resolve(undefined);
      };
      const timer = setTimeout(() => settle(false), 10_000);
      session.once('remoteSettings', () => settle(true));
      session.on('error', () => settle(false));
      session.once('close', () => {
        settle(false);
        pair?.clientSession?.close();
      });
      // Idle sessions close after a minute, like the HTTP/1.1 keep-alive agents.
      session.setTimeout(60_000, () => session.close());
    });
  }

  private onConnect(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const { host, port } = splitHostPort(req.url ?? '', 443);
    if (!host || !port) return void socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    this.track(socket);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    void this.route(socket, { host: host.toLowerCase(), port }, head);
  }

  /** SOCKS5, CONNECT only, no authentication (RFC 1928). */
  private socks(stream: Duplex): void {
    let buf = Buffer.alloc(0);
    let stage: 'greeting' | 'request' = 'greeting';
    const fail = (code: number) => {
      stream.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2 || buf.length < 2 + buf[1]!) return;
        const methods = buf.subarray(2, 2 + buf[1]!);
        buf = buf.subarray(2 + buf[1]!);
        if (!methods.includes(0)) {
          stream.off('data', onData);
          return void stream.end(Buffer.of(5, 0xff));
        }
        stream.write(Buffer.of(5, 0));
        stage = 'request';
      }
      if (buf.length < 5) return;
      const atyp = buf[3];
      const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + buf[4]! : -1;
      if (addrLen < 0) {
        stream.off('data', onData);
        return fail(8);
      }
      if (buf.length < 4 + addrLen + 2) return;
      stream.off('data', onData);
      if (buf[1] !== 1) return fail(7);
      const addr = buf.subarray(4, 4 + addrLen);
      const host =
        atyp === 1
          ? [...addr].join('.')
          : atyp === 3
            ? addr.subarray(1).toString('ascii')
            : (addr.toString('hex').match(/.{4}/g) ?? []).map((w) => w.replace(/^0+(?=.)/, '')).join(':');
      const port = buf.readUInt16BE(4 + addrLen);
      const rest = buf.subarray(4 + addrLen + 2);
      stream.pause();
      stream.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      void this.route(stream, { host: host.toLowerCase(), port }, rest.length ? rest : undefined);
    };
    stream.on('data', onData);
  }

  /** The URL a request is for, from its absolute-form target or the connection's target and Host. */
  private urlOf(req: IncomingMessage | Http2ServerRequest, ws = false, conn?: ConnInfo): { url: URL; target: Target } {
    const raw = req.url ?? '/';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      const url = new URL(raw);
      const secure = url.protocol === 'https:' || url.protocol === 'wss:';
      if (ws) url.protocol = secure ? 'wss:' : 'ws:';
      return { url, target: { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || (secure ? 443 : 80), secure } };
    }
    const tagged = (conn ?? this.connOf(req))?.target;
    const authority = (req.headers[':authority'] as string | undefined) ?? req.headers.host;
    const secure = tagged?.secure ?? false;
    const fromHost = authority ? splitHostPort(authority, tagged?.port ?? (secure ? 443 : 80)) : undefined;
    const host = fromHost?.host ?? tagged?.host ?? 'localhost';
    const port = fromHost?.port ?? tagged?.port ?? (secure ? 443 : 80);
    const scheme = ws ? (secure ? 'wss' : 'ws') : secure ? 'https' : 'http';
    const url = new URL(`${scheme}://${hostPort(host.replace(/^\[|\]$/g, ''), port, secure)}${raw.startsWith('/') ? raw : `/${raw}`}`);
    // Connect to the tunnel's target, which may differ from Host (e.g. a mapped port).
    // Without a tunnel the port is only a guess, so Host's port wins.
    const targetPort = tagged && !tagged.portGuessed ? tagged.port : port;
    return { url, target: { host: tagged?.host ?? host.replace(/^\[|\]$/g, ''), port: targetPort, secure } };
  }

  private connOf(req: IncomingMessage | Http2ServerRequest): ConnInfo | undefined {
    return infoOf((req as Http2ServerRequest).stream?.session?.socket ?? req.socket);
  }

  private newRequest(req: IncomingMessage | Http2ServerRequest, url: URL, body: Buffer, startTime: number, conn?: ConnInfo): ProxiedRequest {
    return {
      id: `r${++this.seq}`,
      method: req.method ?? 'GET',
      url: url.href,
      httpVersion: req.httpVersion,
      headers: pairsOf(req.rawHeaders),
      body,
      remoteAddress: (conn ?? this.connOf(req))?.remote ?? null,
      startTime,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
    };
  }

  private upstreamAgent(secure: boolean, insecure: boolean): HttpAgent | HttpsAgent {
    if (!secure) return this.httpAgent;
    let a = this.httpsAgents.get(insecure);
    if (!a) {
      a = new HttpsAgent({ keepAlive: true, rejectUnauthorized: !insecure });
      this.httpsAgents.set(insecure, a);
    }
    return a;
  }

  /**
   * A shared HTTP/2 session to the target, for requests a rule sent
   * somewhere other than the client connection's own server. Undefined when
   * the server does not speak HTTP/2 (then HTTP/1.1 is used) or cannot be
   * reached (which the HTTP/1.1 attempt then reports). TLS asks for h2 or
   * http/1.1 by ALPN; cleartext tries prior knowledge.
   */
  private upstreamH2(target: Target, insecure: boolean): Promise<ClientHttp2Session | undefined> {
    const key = this.originKey(target, insecure);
    if (this.h1Only.has(key)) return Promise.resolve(undefined);
    const known = this.h2Sessions.get(key);
    if (known) return known;
    const pending: Promise<ClientHttp2Session | undefined> = (target.secure ? this.probeAlpn(target, insecure, ['h2', 'http/1.1']) : this.connectPlain(target)).then(async (r) => {
      if (!r || 'refused' in r) return undefined;
      const sock = 'protocol' in r ? r.socket : r;
      if ('protocol' in r && r.protocol !== 'h2') {
        this.h1Only.add(key);
        sock.destroy();
        return undefined;
      }
      const session = await this.openH2(target, sock);
      if (!session) this.h1Only.add(key);
      else session.once('close', () => forget());
      return session;
    });
    const forget = () => {
      if (this.h2Sessions.get(key) === pending) this.h2Sessions.delete(key);
    };
    void pending.then((s) => s ?? forget());
    this.h2Sessions.set(key, pending);
    return pending;
  }

  private connectPlain(target: Target): Promise<Socket | undefined> {
    return new Promise((resolve) => {
      const sock = netConnect({ host: target.host, port: target.port });
      this.track(sock);
      sock.once('error', () => resolve(undefined));
      sock.once('connect', () => {
        sock.removeAllListeners('error');
        sock.on('error', () => undefined);
        resolve(sock);
      });
    });
  }

  private async onRequest(req: IncomingMessage | Http2ServerRequest, res: ServerResponse | Http2ServerResponse, conn?: ConnInfo): Promise<void> {
    const startTime = Date.now();
    const t0 = performance.now();
    const rel = () => Math.round((performance.now() - t0) * 1000) / 1000;
    const timings: Timings = {};
    const h2 = req.httpVersion.startsWith('2');
    let id: string | undefined;
    let finished = false;
    const abort = (kind: 'aborted' | 'error', message: string) => {
      if (finished || !id) return;
      finished = true;
      timings.total = rel();
      this.emit('abort', { id, kind, message, timings });
    };
    res.once('close', () => abort('aborted', 'connection closed'));

    let url: URL;
    let target: Target;
    try {
      ({ url, target } = this.urlOf(req, false, conn));
    } catch {
      res.statusCode = 400;
      return void res.end('bad request target');
    }
    const maxCapture = this.opts.maxCaptureBytes ?? DEFAULT_CAPTURE;
    const read = await readUpTo(req, this.opts.maxBufferBytes ?? DEFAULT_BUFFER);
    if (!read) return;
    // A body bigger than the buffer limit streams through: hooks are skipped and only its start is recorded.
    const streamingUpload = !read.ended;
    const reqCapture = new Capture(maxCapture);
    for (const c of read.chunks) reqCapture.add(c);
    const body = streamingUpload ? reqCapture.body : Buffer.concat(read.chunks);
    if (read.ended) timings.requestBody = rel();
    const preq = this.newRequest(req, url, body, startTime, conn);
    if (streamingUpload) {
      const declared = Number(req.headers['content-length']);
      preq.bodySize = Number.isFinite(declared) && declared > 0 ? declared : -1;
    }
    id = preq.id;
    this.emit('request', preq);

    const hooks = !streamingUpload && this.opts.hooks?.wants(preq.url) ? this.opts.hooks : undefined;
    let method = preq.method;
    let outUrl = url;
    let headers = endToEnd(preq.headers);
    let outBody = body;
    let bodyChanged = false;

    let trailers: Record<string, string | string[]> | undefined;
    // Trailers from an HTTP/2 server go on to an HTTP/2 client (an HTTP/1.1 client's response is not chunked for them).
    const finish = (data?: Buffer) => {
      if (h2 && trailers) (res as Http2ServerResponse).addTrailers(trailers as unknown as Record<string, string>);
      if (data) res.end(data);
      else res.end();
    };
    const send = (status: number, statusMessage: string | undefined, hdrs: HeaderPairs, data: Buffer | undefined) => {
      const clean = endToEnd(hdrs);
      if (h2) (res as Http2ServerResponse).writeHead(status, toObject(clean) as IncomingHttpHeaders);
      else (res as ServerResponse).writeHead(status, statusMessage ?? STATUS_CODES[status] ?? '', flat(clean));
      timings.responseHeaders = rel();
      finish(data);
      return clean;
    };
    const done = (status: number, statusMessage: string | undefined, hdrs: HeaderPairs, data: Buffer, bodySize?: number) => {
      res.once('finish', () => {
        if (finished) return;
        finished = true;
        timings.total = rel();
        this.emit('response', { id: preq.id, status, statusMessage, headers: hdrs, body: data, ...(bodySize !== undefined ? { bodySize } : {}), timings });
      });
    };

    if (hooks?.request) {
      try {
        const action = await this.whilePaused(hooks.request(preq, decodeBody(body, preq.headers) ?? body), conn, h2);
        if (action && 'close' in action) {
          finished = true;
          timings.total = rel();
          this.emit('abort', { id: preq.id, kind: 'aborted', message: 'closed by a rule', timings });
          return void (h2 ? (req as Http2ServerRequest).stream.close(0x8) : req.socket.destroy());
        }
        if (action && 'respond' in action) {
          const r = action.respond;
          const data = Buffer.from(r.body);
          const hdrs = withLength(r.headers, data.length, true);
          done(r.status, r.statusMessage, hdrs, data);
          send(r.status, r.statusMessage, hdrs, data);
          return;
        }
        if (action && 'replace' in action) {
          method = action.replace.method;
          outUrl = new URL(action.replace.url);
          headers = endToEnd(action.replace.headers);
          if (action.replace.body) {
            const enc = encodeBody(Buffer.from(action.replace.body), headers);
            outBody = enc.body;
            headers = enc.headers;
            bodyChanged = true;
          }
          const secure = outUrl.protocol === 'https:';
          if (outUrl.host !== url.host || outUrl.protocol !== url.protocol)
            target = { host: outUrl.hostname.replace(/^\[|\]$/g, ''), port: Number(outUrl.port) || (secure ? 443 : 80), secure };
        }
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (!streamingUpload) headers = withLength(headers, outBody.length, false);
    const insecure = this.opts.ignoreUpstreamTlsErrors(target.host);
    // An HTTP/2 client goes upstream on the server connection paired with its own:
    // the one whose ALPN answer gave it h2, or, for prior knowledge in cleartext, one
    // opened the same way. A server that refuses that gets a 502 rather than a quiet
    // switch to HTTP/1.1, so the client sees the server's HTTP/2 support as it is.
    // Requests a rule sent elsewhere use a shared session, or HTTP/1.1.
    let session: ClientHttp2Session | undefined;
    if (h2) {
      const c = conn ?? this.connOf(req);
      const key = this.originKey(target, insecure);
      if (c && !c.upstream && !target.secure && req.headers[':scheme'] === 'http' && !(c.target && this.originKey({ ...c.target, secure: false }, insecure) !== key)) {
        c.upstream = { key, session: this.connectPlain(target).then((sock) => (sock ? this.openH2(target, sock, c) : undefined)) };
      }
      if (c?.upstream?.key === key) {
        session = await c.upstream.session;
        if (!session || session.closed || session.destroyed) {
          const why = session ? 'closed its HTTP/2 connection' : target.secure ? 'agreed to HTTP/2 by ALPN but its HTTP/2 connection failed' : 'did not accept HTTP/2 with prior knowledge (cleartext)';
          if (!res.headersSent) {
            res.statusCode = 502;
            res.end(`SiteInquisition: ${target.host}:${target.port} ${why}.`);
          }
          return abort('error', `server ${why}`);
        }
      } else if (target.secure || req.headers[':scheme'] === 'http') session = await this.upstreamH2(target, insecure);
    }
    let upstreamReq: Writable;
    let onUpstreamResponse: (cb: (up: UpstreamResponse) => void) => void;
    if (session) {
      const out: OutgoingHttpHeaders = { ':method': method, ':scheme': target.secure ? 'https' : 'http', ':authority': outUrl.host, ':path': outUrl.pathname + outUrl.search };
      for (const [k, v] of headers) {
        const l = k.toLowerCase();
        if (l === 'host') continue;
        const cur = out[l];
        out[l] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [String(cur), v];
      }
      // "te: trailers" is the one TE value HTTP/2 allows, and gRPC servers require it.
      if (/\btrailers\b/i.test(getHeader(preq.headers, 'te') ?? '')) out.te = 'trailers';
      // No body: END_STREAM goes on the HEADERS frame, as the client sent it.
      const stream = session.request(out, { endStream: !streamingUpload && outBody.length === 0 });
      upstreamReq = stream;
      stream.once('trailers', (t: H2Headers) => (trailers = toObject(pairsOfH2(t))));
      onUpstreamResponse = (cb) =>
        stream.once('response', (hdrs: H2Headers) => cb(Object.assign(stream, { statusCode: Number(hdrs[':status']) || 502, statusMessage: undefined, rawHeaders: flat(pairsOfH2(hdrs)) })));
    } else {
      // HTTP/1.1 upstream: needs Host, and a length for the buffered body (a streamed one keeps the client's, or goes chunked).
      if (!headers.some(([k]) => k.toLowerCase() === 'host')) headers.unshift(['host', outUrl.host]);
      else headers = headers.map(([k, v]) => (k.toLowerCase() === 'host' ? [k, h2 || bodyChanged ? outUrl.host : v] : [k, v]));
      const r = (target.secure ? httpsRequest : httpRequest)({
        host: target.host,
        port: target.port,
        method,
        path: outUrl.pathname + outUrl.search,
        headers: flat(headers) as unknown as Record<string, string>,
        setHost: false,
        agent: this.upstreamAgent(target.secure, insecure),
        ...(target.secure ? { servername: isIP(target.host) ? undefined : target.host, ...upstreamTls(target.host, insecure) } : {}),
      });
      upstreamReq = r;
      onUpstreamResponse = (cb) => r.once('response', cb);
    }
    upstreamReq.once('error', (err) => {
      if (finished) return;
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end(`SiteInquisition could not reach ${target.host}:${target.port}: ${err.message}${CERT_REFUSED.test(`${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}`) ? '\n\nThe server\'s certificate is not trusted (dev servers often use self-signed ones). Trust it or skip checks for this host in SiteInquisition, Settings, Server certificates, or from this request in History.' : ''}`);
      } else res.destroy();
      abort('error', err.message);
    });
    res.once('close', () => {
      if (!finished) upstreamReq.destroy();
    });
    if (streamingUpload) {
      for (const c of read.chunks) upstreamReq.write(c);
      req.on('data', (c: Buffer) => {
        reqCapture.add(c);
        if (!upstreamReq.write(c)) {
          req.pause();
          upstreamReq.once('drain', () => req.resume());
        }
      });
      req.once('end', () => {
        timings.requestBody = rel();
        upstreamReq.end();
      });
      req.resume();
    } else if (!upstreamReq.writableEnded) upstreamReq.end(outBody);

    onUpstreamResponse(async (up) => {
      if (finished) return void up.destroy();
      const upHeaders = pairsOf(up.rawHeaders);
      const status = up.statusCode ?? 502;
      const resCapture = new Capture(maxCapture);
      // Chunks already read when a body turned out too big for hooks; they are sent first.
      let early: Buffer[] = [];
      if (hooks?.response && (hooks.wantsResponse?.(preq, status) ?? true)) {
        const got = await readUpTo(up, this.opts.maxBufferBytes ?? DEFAULT_BUFFER);
        if (!got) return abort('error', 'upstream closed mid-response');
        if (got.ended) {
          let data: Buffer = Buffer.concat(got.chunks);
          let st = status;
          let msg = up.statusMessage;
          let hdrs = upHeaders;
          try {
            const action = await this.whilePaused(hooks.response(preq, { status, statusMessage: up.statusMessage, headers: upHeaders, decodedBody: decodeBody(data, upHeaders) ?? data }), conn, h2);
            if (action && 'close' in action) {
              finished = true;
              timings.total = rel();
              this.emit('abort', { id: preq.id, kind: 'aborted', message: 'closed by a rule', timings });
              return void (h2 ? (req as Http2ServerRequest).stream.close(0x8) : req.socket.destroy());
            }
            if (action && 'replace' in action) {
              st = action.replace.status;
              msg = action.replace.statusMessage;
              hdrs = action.replace.headers;
              if (action.replace.body) {
                const enc = encodeBody(Buffer.from(action.replace.body), hdrs);
                data = enc.body;
                hdrs = enc.headers;
              }
            }
          } catch (err) {
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
          }
          hdrs = withLength(endToEnd(hdrs), data.length, method !== 'HEAD' && st !== 204 && st !== 304);
          const kept = data.length > maxCapture ? data.subarray(0, maxCapture) : data;
          done(st, msg, hdrs, kept, data.length > maxCapture ? data.length : undefined);
          send(st, msg, hdrs, method === 'HEAD' ? undefined : data);
          return;
        }
        early = got.chunks;
      }
      // Stream through, keeping the start of the body for the record.
      const outHeaders = endToEnd(upHeaders);
      if (h2) (res as Http2ServerResponse).writeHead(status, toObject(outHeaders) as IncomingHttpHeaders);
      else (res as ServerResponse).writeHead(status, up.statusMessage ?? '', flat(outHeaders));
      timings.responseHeaders = rel();
      const forward = (c: Buffer) => {
        resCapture.add(c);
        if (!(res as ServerResponse).write(c)) {
          up.pause();
          res.once('drain', () => up.resume());
        }
      };
      for (const c of early) forward(c);
      up.on('data', forward);
      up.once('end', () => {
        done(status, up.statusMessage, outHeaders, resCapture.body, resCapture.truncated ? resCapture.size : undefined);
        finish();
      });
      up.once('error', () => {
        res.destroy();
        abort('error', 'upstream closed mid-response');
      });
      up.once('aborted', () => {
        res.destroy();
        abort('error', 'upstream closed mid-response');
      });
      up.resume();
    });
  }

  private wsLive = new Map<string, LiveWebSocket>();

  /** Proxied WebSocket connections that are open now, by request id. */
  liveWebSockets(): string[] {
    return [...this.wsLive.keys()];
  }

  /**
   * Write a frame plan into a live proxied connection: "server" sends it to
   * the server as if from the client (masked by default), "client" to the
   * client as if from the server. Each step waits until no frame from the
   * side being impersonated is half-forwarded, so the streams stay framed.
   */
  async injectWebSocket(id: string, to: 'server' | 'client', steps: PlanStep[]): Promise<SentStep[]> {
    const live = this.wsLive.get(id);
    if (!live) throw new Error('that WebSocket connection is no longer open');
    const dest = to === 'server' ? live.upstream : live.client;
    const parser = to === 'server' ? live.fromClient : live.fromServer;
    const asm = to === 'server' ? live.clientMsgs : live.serverMsgs;
    const idle = async () => {
      for (let i = 0; i < 200 && (parser.pending || asm.inMessage); i++) await new Promise((r) => setTimeout(r, 10));
    };
    return runPlan(
      steps,
      {
        write: (b) => dest.write(b),
        end: () => dest.end(),
        destroy: () => dest.destroy(),
        alive: () => !dest.destroyed,
        defaultMask: to === 'server',
      },
      undefined,
      undefined,
      idle,
    ).then((sent) => {
      for (const st of sent) {
        const step = steps[st.index]!;
        const payload = step.kind === 'frame' ? Buffer.from(step.payload, 'base64') : step.kind === 'raw' ? Buffer.from(step.bytes, 'base64') : Buffer.alloc(0);
        this.emit('websocket-message', {
          id,
          from: to === 'server' ? 'client' : 'server',
          opcode: st.frame?.opcode ?? st.kind,
          data: payload,
          at: st.at,
          meta: { injected: true, ...(st.frame ? { frame: st.frame } : {}), ...(st.note ? { note: st.note } : {}) },
        });
      }
      return sent;
    });
  }

  /**
   * Relay an "Upgrade: h2c" request to the server and let it decide. When it
   * answers normally, that answer goes back over HTTP/1.1. When it answers 101,
   * the connection is HTTP/2 on both sides: the proxy relays the bytes
   * untouched and reads them on the side (h2tap) to record each stream, with
   * the upgraded request's answer on stream 1. Rules and breakpoints do not
   * apply on such a connection, since nothing is held or rewritten.
   */
  private async relayH2cUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, conn?: ConnInfo): Promise<void> {
    const startTime = Date.now();
    const t0 = performance.now();
    const rel = () => Math.round((performance.now() - t0) * 1000) / 1000;
    let url: URL;
    let target: Target;
    try {
      ({ url, target } = this.urlOf(req, false, conn));
    } catch {
      return void socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
    // A body (rare on an upgrade) is read whole before the request goes on.
    const length = Number(req.headers['content-length']) || 0;
    let rest = head;
    while (rest.length < length) {
      const more = await readChunk(socket);
      if (!more) return void socket.destroy();
      rest = Buffer.concat([rest, more]);
    }
    const body = rest.subarray(0, length);
    rest = rest.subarray(length);
    const preq = this.newRequest(req, url, body, startTime, conn);
    this.emit('request', preq);
    let done = false;
    const fail = (message: string) => {
      if (done) return;
      done = true;
      this.emit('abort', { id: preq.id, kind: 'error', message, timings: { total: rel() } });
    };
    const insecure = this.opts.ignoreUpstreamTlsErrors(target.host);
    const fwd = preq.headers.filter(([k]) => !['proxy-connection', 'proxy-authorization', 'keep-alive'].includes(k.toLowerCase()));
    const upReq = (target.secure ? httpsRequest : httpRequest)({
      host: target.host,
      port: target.port,
      method: req.method,
      path: url.pathname + url.search,
      headers: flat(fwd) as unknown as Record<string, string>,
      setHost: false,
      agent: false,
      ...(target.secure ? { servername: isIP(target.host) ? undefined : target.host, ...upstreamTls(target.host, insecure) } : {}),
    });
    socket.once('close', () => {
      if (!done) upReq.destroy();
    });
    upReq.once('error', (err) => {
      if (done) return;
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      fail(err.message);
    });
    upReq.once('response', (r) => {
      // The server stayed on HTTP/1.1: relay its answer as it is.
      void readAll(r).catch(() => Buffer.alloc(0)).then((data) => {
        if (done) return;
        done = true;
        const hdrs = pairsOf(r.rawHeaders);
        const sent = withLength(endToEnd(hdrs), data.length, true);
        socket.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage ?? ''}\r\n${sent.map(([k, v]) => `${k}: ${v}\r\n`).join('')}Connection: close\r\n\r\n`);
        socket.end(data);
        this.emit('response', { id: preq.id, status: r.statusCode ?? 502, statusMessage: r.statusMessage, headers: hdrs, body: data, timings: { responseHeaders: rel(), total: rel() } });
      });
    });
    upReq.once('upgrade', (r: IncomingMessage, upstream: Duplex, upHead: Buffer) => {
      if (done) return void upstream.destroy();
      done = true;
      this.track(upstream);
      const hdrs = pairsOf(r.rawHeaders);
      socket.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage ?? 'Switching Protocols'}\r\n${hdrs.map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
      const record = this.recordH2Streams(preq, url, conn ?? infoOf(socket), t0);
      const fromClient = new H2Tap(true, record.client);
      const fromServer = new H2Tap(false, record.server);
      const relay = (from: Duplex, to: Duplex, tap: H2Tap) => {
        from.on('data', (c: Buffer) => {
          tap.push(c);
          if (!to.write(c)) {
            from.pause();
            to.once('drain', () => from.resume());
          }
        });
        from.once('end', () => to.end());
      };
      if (upHead.length) {
        fromServer.push(upHead);
        socket.write(upHead);
      }
      if (rest.length) {
        fromClient.push(rest);
        upstream.write(rest);
      }
      relay(socket, upstream, fromClient);
      relay(upstream, socket, fromServer);
      const close = () => {
        socket.destroy();
        upstream.destroy();
        record.closed();
      };
      socket.once('close', close);
      upstream.once('close', close);
      socket.resume();
      upstream.resume();
    });
    upReq.end(body);
  }

  /** Turns the frames read off an upgraded HTTP/2 connection into request, response and abort events. */
  private recordH2Streams(first: ProxiedRequest, base: URL, conn: ConnInfo | undefined, t0: number) {
    const maxCapture = this.opts.maxCaptureBytes ?? DEFAULT_CAPTURE;
    interface Rec {
      req?: ProxiedRequest;
      head?: HeaderPairs;
      reqBody: Capture;
      sent: boolean;
      status?: number;
      resHeaders?: HeaderPairs;
      resBody: Capture;
      start: number;
      timings: Timings;
      over: boolean;
    }
    const now = () => performance.now();
    const streams = new Map<number, Rec>();
    const rec = (id: number): Rec => {
      let r = streams.get(id);
      if (!r) {
        r = { reqBody: new Capture(maxCapture), resBody: new Capture(maxCapture), sent: false, start: id === 1 ? t0 : now(), timings: {}, over: false };
        if (id === 1) Object.assign(r, { req: first, sent: true });
        streams.set(id, r);
      }
      return r;
    };
    const ms = (r: Rec) => Math.round((now() - r.start) * 1000) / 1000;
    const sendRequest = (r: Rec) => {
      if (r.sent || !r.head) return;
      r.sent = true;
      const h = (n: string) => r.head!.find(([k]) => k === n)?.[1];
      let url: URL;
      try {
        url = new URL(h(':path') ?? '/', `${h(':scheme') ?? base.protocol.replace(':', '')}://${h(':authority') ?? base.host}`);
      } catch {
        url = base;
      }
      r.req = {
        id: `r${++this.seq}`,
        method: h(':method') ?? 'GET',
        url: url.href,
        httpVersion: '2.0',
        headers: r.head,
        body: r.reqBody.body,
        ...(r.reqBody.truncated ? { bodySize: r.reqBody.size } : {}),
        remoteAddress: conn?.remote ?? null,
        startTime: Date.now() - Math.round(now() - r.start),
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
      };
      this.emit('request', r.req);
    };
    const finish = (r: Rec) => {
      if (r.over || !r.req) return;
      r.over = true;
      r.timings.total = ms(r);
      this.emit('response', { id: r.req.id, status: r.status ?? 0, headers: r.resHeaders ?? [], body: r.resBody.body, ...(r.resBody.truncated ? { bodySize: r.resBody.size } : {}), timings: r.timings });
    };
    const abort = (r: Rec, message: string) => {
      sendRequest(r);
      if (r.over || !r.req) return;
      r.over = true;
      r.timings.total = ms(r);
      this.emit('abort', { id: r.req.id, kind: 'aborted', message, timings: r.timings });
    };
    rec(1);
    return {
      client: {
        headers: (id: number, fields: HeaderPairs, end: boolean) => {
          const r = rec(id);
          if (!r.head && !r.sent) r.head = fields;
          if (end) {
            r.timings.requestBody = ms(r);
            sendRequest(r);
          }
        },
        data: (id: number, data: Buffer, end: boolean) => {
          const r = rec(id);
          r.reqBody.add(data);
          if (end) {
            r.timings.requestBody = ms(r);
            sendRequest(r);
          }
        },
        reset: (id: number, code: number) => abort(rec(id), `client reset the stream (code ${code})`),
      },
      server: {
        headers: (id: number, fields: HeaderPairs, end: boolean) => {
          const r = rec(id);
          sendRequest(r);
          const status = Number(fields.find(([k]) => k === ':status')?.[1]);
          if (r.status === undefined && status >= 200) {
            r.status = status;
            r.resHeaders = fields.filter(([k]) => !k.startsWith(':'));
            r.timings.responseHeaders = ms(r);
          }
          if (end) finish(r);
        },
        data: (id: number, data: Buffer, end: boolean) => {
          const r = rec(id);
          r.resBody.add(data);
          if (end) finish(r);
        },
        reset: (id: number, code: number) => abort(rec(id), `server reset the stream (code ${code})`),
      },
      closed: () => {
        for (const r of streams.values()) abort(r, 'connection closed');
      },
    };
  }

  /**
   * Relay a WebSocket byte for byte: the client's handshake goes upstream
   * (minus compression offers, so frames stay readable), the server's answer
   * comes back as is, and afterwards both directions are piped untouched
   * while copies are parsed into messages for the record. Fragmentation,
   * masks and even malformed frames reach the other side exactly as sent.
   */
  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, conn?: ConnInfo): void {
    this.track(socket);
    const offers = (req.headers.upgrade ?? '').split(',').map((p) => p.trim().toLowerCase());
    if (!offers.includes('websocket')) {
      if (offers.includes('h2c')) return void this.relayH2cUpgrade(req, socket, head, conn);
      return void socket.destroy();
    }
    const startTime = Date.now();
    const t0 = performance.now();
    const rel = () => Math.round((performance.now() - t0) * 1000) / 1000;
    let url: URL;
    let target: Target;
    try {
      ({ url, target } = this.urlOf(req, true, conn));
    } catch {
      return void socket.destroy();
    }
    const preq = this.newRequest(req, url, Buffer.alloc(0), startTime, conn);
    this.emit('websocket-request', preq);
    const insecure = this.opts.ignoreUpstreamTlsErrors(target.host);
    const fwd = preq.headers.filter(([k]) => {
      const l = k.toLowerCase();
      return !l.startsWith(':') && l !== 'sec-websocket-extensions' && l !== 'proxy-connection' && l !== 'proxy-authorization' && l !== 'keep-alive';
    });
    let done = false;
    const fail = (kind: 'aborted' | 'error', message: string) => {
      if (done) return;
      done = true;
      this.emit('abort', { id: preq.id, kind, message, timings: { total: rel() } });
    };
    const upReq = (target.secure ? httpsRequest : httpRequest)({
      host: target.host,
      port: target.port,
      method: req.method,
      path: url.pathname + url.search,
      headers: flat(fwd) as unknown as Record<string, string>,
      setHost: false,
      agent: false,
      ...(target.secure ? { servername: isIP(target.host) ? undefined : target.host, ...upstreamTls(target.host, insecure) } : {}),
    });
    socket.once('close', () => {
      if (!done) upReq.destroy();
      fail('aborted', 'connection closed');
    });
    upReq.once('error', (err) => {
      if (done) return;
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      fail('error', err.message);
    });
    upReq.once('response', (r) => {
      // The server refused the upgrade: relay its answer as a normal response.
      void readAll(r).catch(() => Buffer.alloc(0)).then((data) => {
        if (done) return;
        done = true;
        const hdrs = pairsOf(r.rawHeaders);
        const sent = withLength(endToEnd(hdrs), data.length, true);
        socket.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage ?? ''}\r\n${sent.map(([k, v]) => `${k}: ${v}\r\n`).join('')}Connection: close\r\n\r\n`);
        socket.end(data);
        this.emit('response', { id: preq.id, status: r.statusCode ?? 502, statusMessage: r.statusMessage, headers: hdrs, body: data, timings: { responseHeaders: rel(), total: rel() } });
      });
    });
    upReq.once('upgrade', (r: IncomingMessage, upstream: Duplex, upHead: Buffer) => {
      if (done) return void upstream.destroy();
      done = true;
      this.track(upstream);
      const hdrs = pairsOf(r.rawHeaders);
      socket.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage ?? 'Switching Protocols'}\r\n${hdrs.map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
      this.emit('websocket-accepted', { id: preq.id, status: r.statusCode ?? 101, statusMessage: r.statusMessage ?? 'Switching Protocols', headers: hdrs, body: Buffer.alloc(0), timings: { responseHeaders: rel(), total: rel() } });

      const live: LiveWebSocket = {
        client: socket,
        upstream,
        fromClient: new FrameParser(),
        fromServer: new FrameParser(),
        clientMsgs: new MessageAssembler('client'),
        serverMsgs: new MessageAssembler('server'),
      };
      this.wsLive.set(preq.id, live);
      let recording = true;
      let closeFrame: { code?: number; reason: string } | undefined;
      const record = (from: 'client' | 'server', m: AssembledMessage, extra: Record<string, unknown> = {}, payload: Buffer = m.payload, opcode = m.opcode) => {
        if (m.close && !closeFrame) closeFrame = m.close;
        const meta: Record<string, unknown> = {};
        if (m.fragments > 1) meta.fragments = m.fragments;
        if (m.violations.length) meta.violations = m.violations;
        if (m.close) Object.assign(meta, m.close.code !== undefined ? { code: m.close.code } : {}, m.close.reason ? { reason: m.close.reason } : {});
        Object.assign(meta, extra);
        this.emit('websocket-message', { id: preq.id, from, opcode, data: payload, at: Date.now(), ...(Object.keys(meta).length ? { meta } : {}) });
      };
      const hooks = this.opts.hooks;
      const gate = () => {
        if (!hooks?.wsMessage || !hooks.wantsWsMessages) return false;
        try {
          return hooks.wants(url.href) && hooks.wantsWsMessages(url.href);
        } catch {
          return false;
        }
      };
      /**
       * One direction of the relay. Normally bytes pass straight through and a
       * copy is parsed for the record. While a message breakpoint covers the
       * connection it switches (at a frame boundary) to forwarding message by
       * message: each data message's frames are held until the hook has looked
       * at it, then sent on exactly as received, replaced, or dropped. Control
       * frames other than close are not held, so pings still get answered.
       */
      const relay = (from: 'client' | 'server', src: Duplex, dest: Duplex, parser: FrameParser, asm: MessageAssembler) => {
        let gated = false;
        let held: Buffer[] = [];
        let inFlight = 0;
        let queue: Promise<void> = Promise.resolve();
        const enqueue = (job: () => Promise<void> | void) => {
          inFlight++;
          queue = queue.then(job).then(() => undefined, (err: Error) => void this.emit('error', new Error(`WebSocket breakpoint on ${url.href}: ${err.message}`))).finally(() => void inFlight--);
        };
        const write = (b: Buffer) => {
          if (!dest.destroyed) dest.write(b);
        };
        return (chunk: Buffer) => {
          if (!gated && recording && parser.pending === 0 && !asm.inMessage && gate()) gated = true;
          else if (gated && parser.pending === 0 && !asm.inMessage && !held.length && !inFlight && !gate()) gated = false;
          if (!gated) {
            if (recording) {
              try {
                for (const f of parser.push(chunk)) {
                  const m = asm.push(f);
                  if (m) record(from, m);
                }
              } catch (err) {
                // Framing is lost for the record only; the bytes still flow.
                recording = false;
                this.emit('error', new Error(`WebSocket recording stopped for ${url.href}: ${(err as Error).message}`));
              }
            }
            if (!dest.write(chunk)) src.pause();
            return;
          }
          let frames: Frame[];
          try {
            frames = parser.push(chunk);
          } catch (err) {
            // Held bytes cannot be passed on faithfully any more: end the connection rather than corrupt it.
            this.emit('error', new Error(`WebSocket relay stopped for ${url.href}: ${(err as Error).message}`));
            src.destroy();
            dest.destroy();
            return;
          }
          for (const f of frames) {
            const raw = reencode(f);
            const m = asm.push(f);
            if (isControl(f.opcode) && f.opcode !== OPCODES.close) {
              if (m) record(from, m);
              write(raw);
              continue;
            }
            if (f.opcode === OPCODES.close) {
              enqueue(() => {
                if (m) record(from, m);
                write(raw);
              });
              continue;
            }
            held.push(raw);
            if (!m) continue;
            const frameBytes = Buffer.concat(held);
            held = [];
            enqueue(async () => {
              const verdict = await hooks!.wsMessage!({ id: preq.id, url: url.href, from, opcode: m.opcode, payload: m.payload, fragments: m.fragments });
              if (verdict && 'drop' in verdict) return record(from, m, { dropped: true });
              if (verdict && 'replace' in verdict) {
                const payload = Buffer.from(verdict.replace.payload);
                write(encodeFrame({ opcode: verdict.replace.opcode, payload }, from === 'client'));
                return record(from, { ...m, fragments: 1, violations: [] }, { edited: true, originalBase64: m.payload.subarray(0, 64 * 1024).toString('base64') }, payload, verdict.replace.opcode);
              }
              write(frameBytes);
              record(from, m);
            });
          }
        };
      };
      const fromClient = relay('client', socket, upstream, live.fromClient, live.clientMsgs);
      const fromServer = relay('server', upstream, socket, live.fromServer, live.serverMsgs);
      socket.on('data', fromClient);
      upstream.on('drain', () => socket.resume());
      upstream.on('data', fromServer);
      socket.on('drain', () => upstream.resume());
      socket.once('end', () => upstream.end());
      upstream.once('end', () => socket.end());
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        this.wsLive.delete(preq.id);
        socket.destroy();
        upstream.destroy();
        this.emit('websocket-close', { id: preq.id, code: closeFrame?.code, reason: closeFrame?.reason || undefined });
      };
      socket.once('close', finish);
      upstream.once('close', finish);
      upstream.on('error', () => undefined);
      if (head.length) fromClient(head);
      if (upHead.length) fromServer(upHead);
    });
    upReq.end();
  }
}

/** A parsed frame's exact bytes again (same mask, same length field). */
function reencode(f: Frame): Buffer {
  return encodeFrame(
    { opcode: f.opcode, payload: f.payload, fin: f.fin, rsv1: f.rsv1, rsv2: f.rsv2, rsv3: f.rsv3, mask: f.masked ? f.mask! : false, lengthField: f.lengthBytes === 9 ? 64 : f.lengthBytes === 3 ? 16 : 'auto' },
    false,
  );
}

interface LiveWebSocket {
  client: Duplex;
  upstream: Duplex;
  fromClient: FrameParser;
  fromServer: FrameParser;
  clientMsgs: MessageAssembler;
  serverMsgs: MessageAssembler;
}
