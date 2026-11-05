/**
 * WebSockets (RFC 6455) without a library: a frame codec that can also write
 * frames a correct implementation never would (for testing servers), a
 * connection that works in either role over any duplex stream, and the
 * client and server handshakes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request as httpRequest, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { upstreamTls } from './upstreamtls.js';

export const OPCODES = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;
export type OpcodeName = keyof typeof OPCODES;
const NAMES: Record<number, OpcodeName> = Object.fromEntries(Object.entries(OPCODES).map(([k, v]) => [v, k as OpcodeName]));

/** Name of an opcode, or "op3" style for reserved ones. */
export const opcodeName = (op: number): string => NAMES[op] ?? `op${op}`;
export const isControl = (op: number) => op >= 8;

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const acceptKey = (key: string) => createHash('sha1').update(key + GUID).digest('base64');

export interface Frame {
  fin: boolean;
  rsv1: boolean;
  rsv2: boolean;
  rsv3: boolean;
  opcode: number;
  masked: boolean;
  mask?: Buffer;
  /** Unmasked payload. */
  payload: Buffer;
  /** Bytes the length took on the wire (1, 3 or 9): more than needed is a protocol violation. */
  lengthBytes: number;
}

/**
 * One frame to write, with every field open to tampering. Anything left out
 * is filled in the way a correct implementation would.
 */
export interface FrameSpec {
  opcode: number | OpcodeName;
  payload?: Uint8Array;
  fin?: boolean;
  rsv1?: boolean;
  rsv2?: boolean;
  rsv3?: boolean;
  /** true: random key; false: unmasked; or a 4-byte key. Default: masked when sent by a client. */
  mask?: boolean | Uint8Array;
  /** Length field size: "auto" is the minimal one; 16 and 64 force a longer (non-minimal) field. */
  lengthField?: 'auto' | 16 | 64;
  /** Claim a different payload length than the bytes that follow. */
  declaredLength?: number;
  /** Write only this many bytes of the encoded frame. */
  truncateTo?: number;
}

const opOf = (o: number | OpcodeName) => (typeof o === 'number' ? o : OPCODES[o]);

export function encodeFrame(spec: FrameSpec, defaultMask: boolean): Buffer {
  const payload = Buffer.from(spec.payload ?? new Uint8Array());
  const opcode = opOf(spec.opcode) & 0x0f;
  const len = spec.declaredLength ?? payload.length;
  const field = spec.lengthField ?? 'auto';
  const b0 = (spec.fin === false ? 0 : 0x80) | (spec.rsv1 ? 0x40 : 0) | (spec.rsv2 ? 0x20 : 0) | (spec.rsv3 ? 0x10 : 0) | opcode;
  const maskOpt = spec.mask ?? defaultMask;
  const mask = maskOpt === false ? undefined : maskOpt === true ? randomBytes(4) : Buffer.from(maskOpt).subarray(0, 4);
  const head: number[] = [b0];
  const mbit = mask ? 0x80 : 0;
  let ext = Buffer.alloc(0);
  if (field === 64 || (field === 'auto' && len > 0xffff)) {
    head.push(mbit | 127);
    ext = Buffer.alloc(8);
    ext.writeBigUInt64BE(BigInt(len));
  } else if (field === 16 || (field === 'auto' && len > 125)) {
    head.push(mbit | 126);
    ext = Buffer.alloc(2);
    ext.writeUInt16BE(Math.min(len, 0xffff));
  } else head.push(mbit | len);
  let body = payload;
  if (mask) {
    body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i]! ^= mask[i & 3]!;
  }
  const out = Buffer.concat([Buffer.from(head), ext, mask ?? Buffer.alloc(0), body]);
  return spec.truncateTo !== undefined ? out.subarray(0, Math.max(0, spec.truncateTo)) : out;
}

/** Reads frames from one direction of a connection, as tolerant as possible: problems are reported, not thrown, unless framing is lost. */
export class FrameParser {
  private buf = Buffer.alloc(0);

  constructor(private readonly maxPayload = 64 * 1024 * 1024) {}

  /** Bytes of a frame received only in part. */
  get pending(): number {
    return this.buf.length;
  }

  push(chunk: Uint8Array): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out: Frame[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      let len = b1 & 0x7f;
      let pos = 2;
      let lengthBytes = 1;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        pos = 4;
        lengthBytes = 3;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new Error(`frame of ${big} bytes is over the ${this.maxPayload} byte limit`);
        len = Number(big);
        pos = 10;
        lengthBytes = 9;
      }
      if (len > this.maxPayload) throw new Error(`frame of ${len} bytes is over the ${this.maxPayload} byte limit`);
      const masked = (b1 & 0x80) !== 0;
      const maskEnd = pos + (masked ? 4 : 0);
      if (this.buf.length < maskEnd + len) break;
      const mask = masked ? Buffer.from(this.buf.subarray(pos, maskEnd)) : undefined;
      const payload = Buffer.from(this.buf.subarray(maskEnd, maskEnd + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      out.push({ fin: (b0 & 0x80) !== 0, rsv1: (b0 & 0x40) !== 0, rsv2: (b0 & 0x20) !== 0, rsv3: (b0 & 0x10) !== 0, opcode: b0 & 0x0f, masked, mask, payload, lengthBytes });
      this.buf = this.buf.subarray(maskEnd + len);
    }
    return out;
  }
}

/** RFC 6455 rules a frame breaks, from the point of view of whoever receives it. */
export function frameViolations(f: Frame, sentBy: 'client' | 'server', inMessage: boolean): string[] {
  const v: string[] = [];
  if (sentBy === 'client' && !f.masked) v.push('unmasked client frame');
  if (sentBy === 'server' && f.masked) v.push('masked server frame');
  if (f.rsv1 || f.rsv2 || f.rsv3) v.push('reserved bits set');
  if (!NAMES[f.opcode]) v.push(`reserved opcode ${f.opcode}`);
  if (isControl(f.opcode) && f.payload.length > 125) v.push('control frame over 125 bytes');
  if (isControl(f.opcode) && !f.fin) v.push('fragmented control frame');
  if (f.opcode === 0 && !inMessage) v.push('continuation without a message');
  if ((f.opcode === 1 || f.opcode === 2) && inMessage) v.push('new message inside a fragmented one');
  const minimal = f.payload.length > 0xffff ? 9 : f.payload.length > 125 ? 3 : 1;
  if (f.lengthBytes !== minimal) v.push('non-minimal length');
  if (f.opcode === 8 && f.payload.length === 1) v.push('close payload of 1 byte');
  if (f.opcode === 8 && f.payload.length >= 2) {
    const code = f.payload.readUInt16BE(0);
    if (!validCloseCode(code)) v.push(`invalid close code ${code}`);
  }
  return v;
}

export const validCloseCode = (c: number) => (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1014) || (c >= 3000 && c <= 4999);

const utf8 = new TextDecoder('utf-8', { fatal: true });
export function isValidUtf8(b: Uint8Array): boolean {
  try {
    utf8.decode(b);
    return true;
  } catch {
    return false;
  }
}

export interface MessageInfo {
  /** Frames the message came in. */
  fragments: number;
  violations: string[];
}

export type WsEvents = {
  open: [];
  message: [Buffer, boolean, MessageInfo];
  /** Every frame as received, including control frames. */
  frame: [Frame, string[]];
  ping: [Buffer];
  pong: [Buffer];
  close: [number | undefined, string];
  error: [Error];
};

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

/**
 * One WebSocket connection over a duplex stream, in either role. It reads
 * leniently (bad frames are reported to listeners, and only a broken framing
 * layer closes the connection) and writes strictly unless asked otherwise.
 */
export class WsConnection extends EventEmitter<WsEvents> {
  readyState = OPEN;
  protocol: string;
  private parser: FrameParser;
  private partial?: { opcode: number; chunks: Buffer[]; fragments: number; violations: string[] };
  private closeSent = false;
  private closeTimer?: NodeJS.Timeout;

  constructor(
    readonly socket: Duplex,
    readonly role: 'client' | 'server',
    opts: { protocol?: string; head?: Buffer; maxPayload?: number; autoPong?: boolean } = {},
  ) {
    super();
    this.protocol = opts.protocol ?? '';
    this.parser = new FrameParser(opts.maxPayload);
    const autoPong = opts.autoPong ?? true;
    socket.on('data', (c: Buffer) => this.onData(c, autoPong));
    socket.on('error', (err) => this.emit('error', err));
    socket.once('close', () => this.finish(undefined, ''));
    // After the caller has had a chance to attach listeners.
    if (opts.head?.length) setImmediate(() => this.onData(opts.head!, autoPong));
  }

  private finish(code: number | undefined, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    clearTimeout(this.closeTimer);
    this.emit('close', code, reason);
  }

  private onData(chunk: Buffer, autoPong: boolean): void {
    let frames: Frame[];
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      this.emit('error', err as Error);
      return void this.socket.destroy();
    }
    const peer = this.role === 'server' ? 'client' : 'server';
    for (const f of frames) {
      const violations = frameViolations(f, peer, !!this.partial);
      this.emit('frame', f, violations);
      if (f.opcode === OPCODES.ping) {
        this.emit('ping', f.payload);
        if (autoPong && this.readyState === OPEN) this.sendFrame({ opcode: 'pong', payload: f.payload.subarray(0, 125) });
      } else if (f.opcode === OPCODES.pong) this.emit('pong', f.payload);
      else if (f.opcode === OPCODES.close) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : undefined;
        const reason = f.payload.length > 2 ? f.payload.subarray(2).toString('utf8') : '';
        if (!this.closeSent && this.readyState === OPEN) {
          this.readyState = CLOSING;
          this.closeSent = true;
          this.write(encodeFrame({ opcode: 'close', payload: code && validCloseCode(code) ? f.payload.subarray(0, 2) : undefined }, this.role === 'client'));
        }
        // The side that started the TCP close is the server (RFC 6455 7.1.1).
        if (this.role === 'server') this.socket.end();
        this.finish(code, reason);
      } else if (f.opcode === OPCODES.continuation && this.partial) {
        this.partial.chunks.push(f.payload);
        this.partial.fragments++;
        this.partial.violations.push(...violations);
        if (f.fin) {
          const p = this.partial;
          this.partial = undefined;
          this.deliver(p.opcode, Buffer.concat(p.chunks), { fragments: p.fragments, violations: p.violations });
        }
      } else if (f.opcode === OPCODES.text || f.opcode === OPCODES.binary || !NAMES[f.opcode]) {
        if (f.fin) this.deliver(f.opcode, f.payload, { fragments: 1, violations });
        else this.partial = { opcode: f.opcode, chunks: [f.payload], fragments: 1, violations: [...violations] };
      }
    }
  }

  private deliver(opcode: number, data: Buffer, info: MessageInfo): void {
    if (opcode === OPCODES.text && !isValidUtf8(data)) info.violations.push('invalid UTF-8 in text message');
    this.emit('message', data, opcode !== OPCODES.text, info);
  }

  private write(b: Buffer): boolean {
    if (this.socket.destroyed || !this.socket.writable) return false;
    return this.socket.write(b);
  }

  /** Write one frame exactly as specified (masked by default from a client). */
  sendFrame(spec: FrameSpec): Buffer {
    const bytes = encodeFrame(spec, this.role === 'client');
    this.write(bytes);
    return bytes;
  }

  /** Write raw bytes, framing or not. */
  sendRaw(bytes: Uint8Array): void {
    this.write(Buffer.from(bytes));
  }

  send(data: string | Uint8Array, opts: { binary?: boolean } = {}): void {
    if (this.readyState !== OPEN) return;
    const binary = opts.binary ?? typeof data !== 'string';
    this.sendFrame({ opcode: binary ? 'binary' : 'text', payload: typeof data === 'string' ? Buffer.from(data) : data });
  }

  ping(data: Uint8Array = new Uint8Array()): void {
    if (this.readyState === OPEN) this.sendFrame({ opcode: 'ping', payload: data });
  }

  /** Start the closing handshake; the TCP connection drops if the peer does not answer in time. */
  close(code?: number, reason = ''): void {
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    this.closeSent = true;
    const payload = code === undefined ? Buffer.alloc(0) : Buffer.concat([Buffer.of(code >> 8, code & 0xff), Buffer.from(reason).subarray(0, 123)]);
    this.write(encodeFrame({ opcode: 'close', payload }, this.role === 'client'));
    this.closeTimer = setTimeout(() => this.socket.destroy(), 5_000);
    this.closeTimer.unref?.();
  }

  terminate(): void {
    this.socket.destroy();
    this.finish(undefined, '');
  }
}

// --- handshakes -------------------------------------------------------------

export interface ConnectOptions {
  /** Extra request headers as pairs, sent as given (including any Sec-WebSocket-* you set yourself). */
  headers?: Array<[string, string]>;
  protocols?: string[];
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
  /** Supply the transport yourself, e.g. a tunnel through a proxy (already TLS for wss:). */
  createConnection?: () => Duplex | Promise<Duplex>;
  /** Accept a 101 whose Sec-WebSocket-Accept is wrong. */
  skipAcceptCheck?: boolean;
  maxPayload?: number;
  autoPong?: boolean;
}

export class UnexpectedResponse extends Error {
  constructor(
    readonly status: number,
    readonly headers: Array<[string, string]>,
    readonly body: Buffer,
  ) {
    super(`server answered ${status} instead of upgrading`);
  }
}

const pairs = (raw: string[]): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i]!, raw[i + 1]!]);
  return out;
};

/** Open a client connection. Resolves once the server has switched protocols. */
export function connectWebSocket(url: string | URL, opts: ConnectOptions = {}): Promise<{ ws: WsConnection; status: number; statusMessage: string; headers: Array<[string, string]> }> {
  const u = new URL(String(url).replace(/^http/, 'ws'));
  const secure = u.protocol === 'wss:';
  const user = opts.headers ?? [];
  const has = (n: string) => user.some(([k]) => k.toLowerCase() === n);
  const key = user.find(([k]) => k.toLowerCase() === 'sec-websocket-key')?.[1] ?? randomBytes(16).toString('base64');
  const headers: string[] = [];
  if (!has('host')) headers.push('Host', u.host);
  headers.push('Connection', 'Upgrade', 'Upgrade', 'websocket');
  if (!has('sec-websocket-key')) headers.push('Sec-WebSocket-Key', key);
  if (!has('sec-websocket-version')) headers.push('Sec-WebSocket-Version', '13');
  if (opts.protocols?.length && !has('sec-websocket-protocol')) headers.push('Sec-WebSocket-Protocol', opts.protocols.join(', '));
  for (const [k, v] of user) if (!/^(connection|upgrade)$/i.test(k)) headers.push(k, v);
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)({
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: headers as unknown as Record<string, string>,
      setHost: false,
      // An agent would ignore createConnection, so only use one without it.
      ...(opts.createConnection ? {} : { agent: false }),
      ...(opts.createConnection
        ? {
            createConnection: ((_o: unknown, cb: (err: Error | null, s?: Duplex) => void) => {
              Promise.resolve()
                .then(() => opts.createConnection!())
                .then((s) => cb(null, s), (e: Error) => cb(e));
              return undefined;
            }) as never,
          }
        : {}),
      ...(secure ? { ...upstreamTls(u.hostname.replace(/^\[|\]$/g, ''), opts.rejectUnauthorized === false), servername: u.hostname } : {}),
    });
    const timer = setTimeout(() => {
      req.destroy(new Error('WebSocket handshake timed out'));
    }, opts.timeoutMs ?? 15_000);
    req.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.once('response', (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.once('end', () => {
        clearTimeout(timer);
        reject(new UnexpectedResponse(res.statusCode ?? 0, pairs(res.rawHeaders), Buffer.concat(chunks)));
      });
    });
    req.once('upgrade', (res: IncomingMessage, socket: Duplex, head: Buffer) => {
      clearTimeout(timer);
      if (!opts.skipAcceptCheck && res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        return reject(new Error('server sent a wrong Sec-WebSocket-Accept'));
      }
      const ws = new WsConnection(socket, 'client', { protocol: String(res.headers['sec-websocket-protocol'] ?? ''), head, maxPayload: opts.maxPayload, autoPong: opts.autoPong });
      resolve({ ws, status: res.statusCode ?? 101, statusMessage: res.statusMessage ?? '', headers: pairs(res.rawHeaders) });
    });
    req.end();
  });
}

/** Complete a server-side upgrade. Returns undefined (and answers 400) when the request is not a valid WebSocket handshake. */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: { protocol?: string; extraHeaders?: Array<[string, string]>; maxPayload?: number } = {},
): WsConnection | undefined {
  const key = req.headers['sec-websocket-key'];
  if ((req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nSec-WebSocket-Version: 13\r\n\r\n');
    return undefined;
  }
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`];
  if (opts.protocol) lines.push(`Sec-WebSocket-Protocol: ${opts.protocol}`);
  for (const [k, v] of opts.extraHeaders ?? []) lines.push(`${k}: ${v}`);
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  return new WsConnection(socket, 'server', { protocol: opts.protocol, head, maxPayload: opts.maxPayload });
}

/**
 * Serve WebSockets on an HTTP server: like `new WebSocketServer({ server })`.
 * verify() can refuse a client (401) and protocol() picks a subprotocol.
 */
export function serveWebSockets(
  server: HttpServer,
  onConnection: (ws: WsConnection, req: IncomingMessage) => void,
  opts: { verify?: (req: IncomingMessage) => boolean; protocol?: (offered: string[], req: IncomingMessage) => string | undefined; maxPayload?: number } = {},
): { clients: Set<WsConnection> } {
  const clients = new Set<WsConnection>();
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => undefined);
    if (opts.verify && !opts.verify(req)) return void socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const ws = acceptWebSocket(req, socket, head, { protocol: opts.protocol?.(offered, req), maxPayload: opts.maxPayload });
    if (!ws) return;
    clients.add(ws);
    ws.once('close', () => clients.delete(ws));
    ws.on('error', () => undefined);
    onConnection(ws, req);
  });
  return { clients };
}

export interface AssembledMessage {
  /** text, binary, ping, pong, close, or opN for reserved opcodes. */
  opcode: string;
  payload: Buffer;
  fragments: number;
  violations: string[];
  close?: { code?: number; reason: string };
}

/**
 * Groups frames from one direction into messages for the record, without
 * judging them: a relay passes the original bytes on regardless.
 */
export class MessageAssembler {
  private partial?: { opcode: number; chunks: Buffer[]; fragments: number; violations: string[] };

  constructor(private readonly sentBy: 'client' | 'server') {}

  /** Inside a fragmented message: injecting a data frame now would break it. */
  get inMessage(): boolean {
    return !!this.partial;
  }

  push(f: Frame): AssembledMessage | undefined {
    const violations = frameViolations(f, this.sentBy, !!this.partial);
    if (isControl(f.opcode) && NAMES[f.opcode]) {
      const msg: AssembledMessage = { opcode: opcodeName(f.opcode), payload: f.payload, fragments: 1, violations };
      if (f.opcode === OPCODES.close) msg.close = { code: f.payload.length >= 2 ? f.payload.readUInt16BE(0) : undefined, reason: f.payload.length > 2 ? f.payload.subarray(2).toString('utf8') : '' };
      return msg;
    }
    if (f.opcode === OPCODES.continuation && this.partial) {
      this.partial.chunks.push(f.payload);
      this.partial.fragments++;
      this.partial.violations.push(...violations);
      if (!f.fin) return undefined;
      const p = this.partial;
      this.partial = undefined;
      return this.finish(p.opcode, Buffer.concat(p.chunks), p.fragments, p.violations);
    }
    if (!f.fin && f.opcode !== OPCODES.continuation) {
      this.partial = { opcode: f.opcode, chunks: [f.payload], fragments: 1, violations };
      return undefined;
    }
    return this.finish(f.opcode, f.payload, 1, violations);
  }

  private finish(opcode: number, payload: Buffer, fragments: number, violations: string[]): AssembledMessage {
    if (opcode === OPCODES.text && !isValidUtf8(payload)) violations = [...violations, 'invalid UTF-8 in text message'];
    return { opcode: opcode === OPCODES.continuation ? 'continuation' : opcodeName(opcode), payload, fragments, violations: [...new Set(violations)] };
  }
}
