/**
 * HTTP/3 (RFC 9114) over our QUIC connection: control and QPACK streams,
 * SETTINGS, GOAWAY, PRIORITY_UPDATE (RFC 9218), HTTP datagrams (RFC 9297),
 * request streams for clients and servers.
 *
 * Request streams expose low-level writes (headers, data, raw frames, raw
 * bytes, reset, stop sending) so the lab can send what a normal client
 * would not.
 */
import { EventEmitter } from 'node:events';
import { Reader, Writer } from './bytes.js';
import type { Connection } from './connection.js';
import { QpackDecoder, QpackEncoder, QpackError, type EncoderPolicy, type Field } from './qpack.js';

export const H3Frame = { DATA: 0x0, HEADERS: 0x1, CANCEL_PUSH: 0x3, SETTINGS: 0x4, PUSH_PROMISE: 0x5, GOAWAY: 0x7, MAX_PUSH_ID: 0xd, PRIORITY_UPDATE: 0xf0700, PRIORITY_UPDATE_PUSH: 0xf0701 } as const;
export const H3Setting = { QPACK_MAX_TABLE_CAPACITY: 0x01, MAX_FIELD_SECTION_SIZE: 0x06, QPACK_BLOCKED_STREAMS: 0x07, ENABLE_CONNECT_PROTOCOL: 0x08, H3_DATAGRAM: 0x33 } as const;
export const H3Error = {
  NO_ERROR: 0x100,
  GENERAL_PROTOCOL_ERROR: 0x101,
  INTERNAL_ERROR: 0x102,
  STREAM_CREATION_ERROR: 0x103,
  CLOSED_CRITICAL_STREAM: 0x104,
  FRAME_UNEXPECTED: 0x105,
  FRAME_ERROR: 0x106,
  EXCESSIVE_LOAD: 0x107,
  ID_ERROR: 0x108,
  SETTINGS_ERROR: 0x109,
  MISSING_SETTINGS: 0x10a,
  REQUEST_REJECTED: 0x10b,
  REQUEST_CANCELLED: 0x10c,
  REQUEST_INCOMPLETE: 0x10d,
  MESSAGE_ERROR: 0x10e,
  CONNECT_ERROR: 0x10f,
  VERSION_FALLBACK: 0x110,
} as const;

export const errorName = (code: number): string => {
  const h3 = Object.entries(H3Error).find(([, v]) => v === code)?.[0];
  if (h3) return `H3_${h3}`;
  if (code >= 0x200 && code <= 0x202) return ['QPACK_DECOMPRESSION_FAILED', 'QPACK_ENCODER_STREAM_ERROR', 'QPACK_DECODER_STREAM_ERROR'][code - 0x200]!;
  return `0x${code.toString(16)}`;
};

export const frame = (type: number, payload: Uint8Array): Buffer => new Writer(payload.length + 16).varint(type).vvec(payload).finish();

export interface H3Settings {
  qpackMaxTableCapacity?: number;
  qpackBlockedStreams?: number;
  maxFieldSectionSize?: number;
  enableConnectProtocol?: boolean;
  h3Datagram?: boolean;
  /** Extra or deliberately invalid settings (id, value). */
  extra?: Array<[number, number]>;
}

export interface H3SessionOptions {
  /** Our SETTINGS. QPACK capacity and blocked streams also size our decoder. */
  settings?: H3Settings;
  qpack?: EncoderPolicy;
  /** Send a reserved stream type and frame type to check the peer ignores them (default true). */
  grease?: boolean;
}

export interface H3Response {
  status: number;
  headers: Field[];
  body: Buffer;
  trailers: Field[];
  /** Interim (1xx) responses. */
  informational: Array<{ status: number; headers: Field[] }>;
}

/** Times relative to performance.now(), filled in as things happen. */
export interface StreamTimings {
  opened?: number;
  headersSent?: number;
  firstDataSent?: number;
  finSent?: number;
  resetSent?: number;
  firstByte?: number;
  headersReceived?: number;
  complete?: number;
  resetReceived?: number;
}

interface ParsedFrame {
  type: number;
  payload: Buffer;
  /** Full frame length; DATA arrives in pieces, so first and last mark the ends. */
  length: number;
  first: boolean;
  last: boolean;
}

/** Incremental frame parser. DATA payloads stream through in pieces; other frames are collected whole. */
class FrameParser {
  private head: Buffer = Buffer.alloc(0);
  private cur: { type: number; length: number; left: number; parts: Buffer[]; started: boolean } | null = null;
  constructor(private readonly streamData = true) {}

  push(data: Buffer): ParsedFrame[] {
    const out: ParsedFrame[] = [];
    let buf = data;
    while (buf.length) {
      if (!this.cur) {
        this.head = this.head.length ? Buffer.concat([this.head, buf]) : buf;
        const r = new Reader(this.head);
        let type: number;
        let len: number;
        try {
          type = r.varint();
          len = r.varint();
        } catch {
          return out; // header incomplete
        }
        if (type !== H3Frame.DATA && len > 1 << 20) throw new H3StreamError(H3Error.EXCESSIVE_LOAD, `frame 0x${type.toString(16)} of ${len} bytes`);
        this.cur = { type, length: len, left: len, parts: [], started: false };
        buf = this.head.subarray(r.pos);
        this.head = Buffer.alloc(0);
        if (len === 0) {
          out.push({ type, payload: Buffer.alloc(0), length: 0, first: true, last: true });
          this.cur = null;
          continue;
        }
      }
      const c = this.cur;
      const take = Math.min(c.left, buf.length);
      const piece = buf.subarray(0, take);
      buf = buf.subarray(take);
      c.left -= take;
      if (c.type === H3Frame.DATA && this.streamData) {
        out.push({ type: c.type, payload: piece, length: c.length, first: !c.started, last: c.left === 0 });
        c.started = true;
      } else c.parts.push(piece);
      if (c.left === 0) {
        if (!(c.type === H3Frame.DATA && this.streamData)) out.push({ type: c.type, payload: Buffer.concat(c.parts), length: c.length, first: true, last: true });
        this.cur = null;
      }
    }
    return out;
  }
  get pending() {
    return this.head.length + (this.cur ? 1 : 0);
  }
}

export class H3StreamError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** One request stream, from either side. */
export class H3Stream extends EventEmitter {
  readonly timings: StreamTimings = {};
  headers: Field[] | null = null;
  trailers: Field[] = [];
  informational: Array<{ status: number; headers: Field[] }> = [];
  body: Buffer[] = [];
  bodyLength = 0;
  ended = false;
  resetCode: number | null = null;
  stopSendingCode: number | null = null;
  finished = false;
  private parser = new FrameParser();
  private decoding: Promise<void> = Promise.resolve();
  /** Frames received in order, for the frame log. */
  readonly framesIn: Array<{ t: number; type: number; length: number }> = [];

  constructor(
    readonly session: H3Session,
    readonly id: number,
  ) {
    super();
    this.timings.opened = performance.now();
  }

  get conn() {
    return this.session.conn;
  }

  /** Encode and send a HEADERS frame. */
  sendHeaders(fields: Field[], end = false): this {
    const block = this.session.encoder.encode(this.id, fields);
    this.writeRaw(frame(H3Frame.HEADERS, block), end);
    this.timings.headersSent ??= performance.now();
    return this;
  }

  sendData(data: Uint8Array, end = false): this {
    if (data.length) {
      this.writeRaw(frame(H3Frame.DATA, data), end);
      this.timings.firstDataSent ??= performance.now();
    } else if (end) this.end();
    return this;
  }

  /** Any frame, including ones that are not allowed here. */
  sendFrame(type: number, payload: Uint8Array, end = false): this {
    return this.writeRaw(frame(type, payload), end);
  }

  writeRaw(bytes: Uint8Array, end = false): this {
    this.conn.write(this.id, bytes, end);
    if (end) this.timings.finSent = performance.now();
    return this;
  }

  end(): this {
    if (!this.finished) this.conn.write(this.id, Buffer.alloc(0), true);
    this.finished = true;
    this.timings.finSent = performance.now();
    return this;
  }

  reset(code: number = H3Error.REQUEST_CANCELLED): this {
    this.conn.resetStream(this.id, code);
    this.timings.resetSent = performance.now();
    this.session.encoder.streamCancelled(this.id);
    return this;
  }

  stopSending(code: number = H3Error.REQUEST_CANCELLED): this {
    this.conn.stopSending(this.id, code);
    this.session.decoder.cancelStream(this.id);
    return this;
  }

  /** Bytes written but not yet on the wire. */
  get queued(): number {
    return this.conn.pending(this.id);
  }

  /** @internal */
  onData(data: Buffer, fin: boolean) {
    this.timings.firstByte ??= performance.now();
    let frames: ParsedFrame[];
    try {
      frames = this.parser.push(data);
    } catch (e) {
      return this.protocolError(e as H3StreamError);
    }
    for (const f of frames) this.handleFrame(f);
    if (fin) {
      this.decoding = this.decoding.then(() => {
        if (this.parser.pending) this.emit('error', new H3StreamError(H3Error.FRAME_ERROR, 'stream ended inside a frame'));
        this.ended = true;
        this.timings.complete = performance.now();
        this.emit('end');
      });
    }
  }

  private handleFrame(f: ParsedFrame) {
    const { type, payload } = f;
    if (f.first) this.framesIn.push({ t: performance.now(), type, length: f.length });
    switch (type) {
      case H3Frame.HEADERS: {
        const p = this.session.decoder.decode(this.id, payload);
        this.decodingPending++;
        this.decoding = this.decoding.then(() =>
          p.then(
            (d) => this.onFields(d.fields, d.blocked),
            (e: Error) => this.session.fail(e instanceof QpackError ? e.code : H3Error.INTERNAL_ERROR, e.message),
          ).finally(() => this.decodingPending--),
        );
        return;
      }
      case H3Frame.DATA:
        if (!payload.length) return;
        // Skip the promise chain when nothing is pending, so large bodies stay cheap.
        if (this.headers && !this.decodingPending) return this.pushBody(payload);
        this.decoding = this.decoding.then(() => {
          if (!this.headers) return this.protocolError(new H3StreamError(H3Error.FRAME_UNEXPECTED, 'DATA before HEADERS'));
          this.pushBody(payload);
        });
        return;
      case H3Frame.SETTINGS:
      case H3Frame.GOAWAY:
      case H3Frame.MAX_PUSH_ID:
      case H3Frame.CANCEL_PUSH:
        return this.session.fail(H3Error.FRAME_UNEXPECTED, `frame 0x${type.toString(16)} on a request stream`);
      default:
        // Unknown and reserved frame types are ignored.
        return;
    }
  }

  private decodingPending = 0;

  private pushBody(payload: Buffer) {
    this.body.push(payload);
    this.bodyLength += payload.length;
    this.emit('data', payload);
  }

  private onFields(fields: Field[], blocked: boolean) {
    const status = fields.find(([n]) => n === ':status');
    if (status && /^1\d\d$/.test(status[1]) && status[1] !== '101') {
      this.informational.push({ status: Number(status[1]), headers: fields });
      this.emit('informational', Number(status[1]), fields);
      return;
    }
    if (!this.headers) {
      this.headers = fields;
      this.timings.headersReceived = performance.now();
      this.emit('headers', fields, blocked);
    } else {
      this.trailers = fields;
      this.emit('trailers', fields);
    }
  }

  private protocolError(e: H3StreamError) {
    this.emit('error', e);
    this.reset(e.code);
    this.stopSending(e.code);
  }

  /** @internal */
  onReset(code: number) {
    this.resetCode = code;
    this.timings.resetReceived = performance.now();
    this.emit('reset', code);
  }

  /** @internal */
  onStopSending(code: number) {
    this.stopSendingCode = code;
    this.emit('stopSending', code);
  }

  /** The response (client side) once the stream ends or is reset. */
  response(): Promise<H3Response> {
    return new Promise((resolve, reject) => {
      const done = () => {
        const s = this.headers?.find(([n]) => n === ':status');
        if (!s) return reject(new Error('stream ended without response headers'));
        resolve({ status: Number(s[1]), headers: this.headers!.filter(([n]) => !n.startsWith(':')), body: Buffer.concat(this.body), trailers: this.trailers, informational: this.informational });
      };
      if (this.ended) return done();
      if (this.resetCode !== null) return reject(new Error(`stream reset by the server with ${errorName(this.resetCode)}`));
      this.once('end', done);
      this.once('reset', (code: number) => reject(new Error(`stream reset by the server with ${errorName(code)}`)));
      this.once('error', reject);
      this.session.once('closed', (err: { reason: string } | null) => reject(new Error(`connection closed${err?.reason ? `: ${err.reason}` : ''}`)));
    });
  }
}

/** HTTP/3 on one QUIC connection, client or server. */
export class H3Session extends EventEmitter {
  readonly encoder: QpackEncoder;
  readonly decoder: QpackDecoder;
  readonly streams = new Map<number, H3Stream>();
  peerSettings: Map<number, number> | null = null;
  goawayReceived: number | null = null;
  readonly isClient: boolean;
  private controlId = -1;
  private encoderId = -1;
  private decoderId = -1;
  private uni = new Map<number, { type: number | null; buf: Buffer; parser?: FrameParser }>();
  private peerCritical = new Set<number>();
  private started = false;
  private settingsSent: H3Settings;
  /** Frames sent and received on the control stream, for the log. */
  readonly controlLog: Array<{ t: number; dir: 'in' | 'out'; type: number; detail: string }> = [];

  constructor(
    readonly conn: Connection,
    readonly opts: H3SessionOptions = {},
  ) {
    super();
    this.isClient = conn.isClient;
    this.settingsSent = { qpackMaxTableCapacity: 4096, qpackBlockedStreams: 16, h3Datagram: true, ...opts.settings };
    this.encoder = new QpackEncoder((b) => this.encoderId >= 0 && conn.write(this.encoderId, b), opts.qpack);
    this.decoder = new QpackDecoder(this.settingsSent.qpackMaxTableCapacity ?? 0, this.settingsSent.qpackBlockedStreams ?? 0, (b) => this.decoderId >= 0 && conn.write(this.decoderId, b));
    const ev = conn.ev;
    const prev = { stream: ev.stream, data: ev.data, reset: ev.reset, stopSending: ev.stopSending, datagram: ev.datagram, close: ev.close, handshake: ev.handshake };
    ev.stream = (id) => {
      prev.stream?.(id);
      this.onPeerStream(id);
    };
    ev.data = (id, data, fin) => {
      prev.data?.(id, data, fin);
      this.onStreamData(id, data, fin);
    };
    ev.reset = (id, code, size) => {
      prev.reset?.(id, code, size);
      if (this.peerCritical.has(id)) return this.fail(H3Error.CLOSED_CRITICAL_STREAM, 'peer reset a critical stream');
      this.streams.get(id)?.onReset(code);
    };
    ev.stopSending = (id, code) => {
      prev.stopSending?.(id, code);
      this.streams.get(id)?.onStopSending(code);
    };
    ev.datagram = (d) => {
      prev.datagram?.(d);
      try {
        const r = new Reader(d);
        const q = r.varint();
        this.emit('datagram', q * 4, r.rest());
      } catch {
        this.fail(H3Error.GENERAL_PROTOCOL_ERROR, 'malformed HTTP datagram');
      }
    };
    ev.close = (err) => {
      prev.close?.(err);
      this.emit('closed', err);
    };
    ev.handshake = () => {
      prev.handshake?.();
      this.start();
    };
    if (conn.state === 'connected' || conn.earlyDataAvailable) this.start();
  }

  /** Open control and QPACK streams. Runs on handshake, or early for 0-RTT. */
  start() {
    if (this.started) return;
    const c = this.conn.openStream(false);
    const e = this.conn.openStream(false);
    const d = this.conn.openStream(false);
    if (c === null || e === null || d === null) return; // limits not known yet; retried on handshake
    this.started = true;
    this.controlId = c;
    this.encoderId = e;
    this.decoderId = d;
    const s = this.settingsSent;
    const w = new Writer();
    const put = (id: number, v: number | boolean | undefined) => {
      if (v === undefined || v === false) return;
      w.varint(id).varint(v === true ? 1 : v);
    };
    put(H3Setting.QPACK_MAX_TABLE_CAPACITY, s.qpackMaxTableCapacity);
    put(H3Setting.QPACK_BLOCKED_STREAMS, s.qpackBlockedStreams);
    put(H3Setting.MAX_FIELD_SECTION_SIZE, s.maxFieldSectionSize);
    put(H3Setting.ENABLE_CONNECT_PROTOCOL, s.enableConnectProtocol);
    put(H3Setting.H3_DATAGRAM, s.h3Datagram);
    for (const [id, v] of s.extra ?? []) w.varint(id).varint(v);
    if (this.opts.grease !== false) w.varint(0x1f * 7 + 0x21).varint(0);
    this.conn.write(c, Buffer.concat([new Writer().varint(0x00).finish(), frame(H3Frame.SETTINGS, w.finish())]));
    this.controlLog.push({ t: performance.now(), dir: 'out', type: H3Frame.SETTINGS, detail: JSON.stringify(s) });
    this.conn.write(e, Buffer.of(0x02));
    this.conn.write(d, Buffer.of(0x03));
    if (this.opts.grease !== false) {
      const g = this.conn.openStream(false);
      if (g !== null) this.conn.write(g, Buffer.concat([new Writer().varint(0x1f * 3 + 0x21).finish(), Buffer.from('grease')]), true);
    }
    this.emit('started');
  }

  /** Client: open a request stream. Returns null when the server's stream limit is reached. */
  openRequest(): H3Stream | null {
    if (!this.started) this.start();
    const id = this.conn.openStream(true);
    if (id === null) return null;
    const s = new H3Stream(this, id);
    this.streams.set(id, s);
    return s;
  }

  /** Client: a whole request in one call. */
  request(fields: Field[], body?: Uint8Array): H3Stream | null {
    const s = this.openRequest();
    if (!s) return null;
    s.sendHeaders(fields, !body?.length);
    if (body?.length) s.sendData(body, true);
    return s;
  }

  /** Client: tell the server a stream's priority changed (RFC 9218). */
  priorityUpdate(streamId: number, value: string) {
    this.controlFrame(H3Frame.PRIORITY_UPDATE, new Writer().varint(streamId).bytes(Buffer.from(value)).finish(), `stream ${streamId}: ${value}`);
  }

  goaway(id: number) {
    this.controlFrame(H3Frame.GOAWAY, new Writer().varint(id).finish(), `id ${id}`);
  }

  /** Any frame on the control stream. */
  controlFrame(type: number, payload: Buffer, detail = '') {
    if (this.controlId < 0) this.start();
    this.conn.write(this.controlId, frame(type, payload));
    this.controlLog.push({ t: performance.now(), dir: 'out', type, detail });
  }

  sendDatagram(streamId: number, data: Uint8Array): boolean {
    return this.conn.sendDatagram(Buffer.concat([new Writer().varint(Math.floor(streamId / 4)).finish(), data]));
  }

  /** Close the connection with an HTTP/3 error. */
  fail(code: number, reason: string) {
    this.emit('error', new H3StreamError(code, reason));
    this.conn.close(code, reason);
  }

  close(code: number = H3Error.NO_ERROR, reason = '') {
    this.conn.close(code, reason);
  }

  private onPeerStream(id: number) {
    if ((id & 2) === 0) {
      if (this.isClient) return; // servers cannot open bidi streams in HTTP/3
      const s = new H3Stream(this, id);
      this.streams.set(id, s);
      s.once('headers', () => this.emit('request', s));
    } else this.uni.set(id, { type: null, buf: Buffer.alloc(0) });
  }

  private onStreamData(id: number, data: Buffer, fin: boolean) {
    const req = this.streams.get(id);
    if (req) return req.onData(data, fin);
    const u = this.uni.get(id);
    if (!u) return;
    if (u.type === null) {
      u.buf = Buffer.concat([u.buf, data]);
      const r = new Reader(u.buf);
      try {
        u.type = r.varint();
      } catch {
        return;
      }
      data = Buffer.from(u.buf.subarray(r.pos));
      u.buf = Buffer.alloc(0);
      if (u.type <= 0x03) {
        if (u.type === 0x01) return this.fail(H3Error.STREAM_CREATION_ERROR, 'push stream without MAX_PUSH_ID');
        for (const other of this.uni.values()) if (other !== u && other.type === u.type) return this.fail(H3Error.STREAM_CREATION_ERROR, `second stream of type ${u.type}`);
        this.peerCritical.add(id);
      }
      if (u.type === 0x00) u.parser = new FrameParser(false);
    }
    if (fin && this.peerCritical.has(id)) {
      this.fail(H3Error.CLOSED_CRITICAL_STREAM, 'peer closed a critical stream');
      return;
    }
    switch (u.type) {
      case 0x00:
        return this.onControl(u.parser!.push(data));
      case 0x02:
        try {
          return this.decoder.encoderStream(data);
        } catch (e) {
          return this.fail((e as QpackError).code ?? H3Error.INTERNAL_ERROR, (e as Error).message);
        }
      case 0x03:
        try {
          return this.encoder.decoderStream(data);
        } catch (e) {
          return this.fail((e as QpackError).code ?? H3Error.INTERNAL_ERROR, (e as Error).message);
        }
      default:
        // Unknown stream types are ignored (and could be stopped).
        return;
    }
  }

  private onControl(frames: ParsedFrame[]) {
    for (const f of frames) {
      if (!this.peerSettings && f.type !== H3Frame.SETTINGS) return this.fail(H3Error.MISSING_SETTINGS, 'first control frame is not SETTINGS');
      switch (f.type) {
        case H3Frame.SETTINGS: {
          if (this.peerSettings) return this.fail(H3Error.FRAME_UNEXPECTED, 'second SETTINGS frame');
          const m = new Map<number, number>();
          const r = new Reader(f.payload);
          try {
            while (r.left) {
              const id = r.varint();
              const v = r.varint();
              if (id >= 0x02 && id <= 0x05) return this.fail(H3Error.SETTINGS_ERROR, `HTTP/2 setting 0x${id.toString(16)} in HTTP/3`);
              if (m.has(id)) return this.fail(H3Error.SETTINGS_ERROR, 'duplicate setting');
              m.set(id, v);
            }
          } catch {
            return this.fail(H3Error.FRAME_ERROR, 'malformed SETTINGS');
          }
          this.peerSettings = m;
          this.encoder.peerSettings(m.get(H3Setting.QPACK_MAX_TABLE_CAPACITY) ?? 0, m.get(H3Setting.QPACK_BLOCKED_STREAMS) ?? 0);
          this.controlLog.push({ t: performance.now(), dir: 'in', type: f.type, detail: JSON.stringify(Object.fromEntries([...m].map(([k, v]) => [`0x${k.toString(16)}`, v]))) });
          this.emit('settings', m);
          break;
        }
        case H3Frame.GOAWAY: {
          const id = new Reader(f.payload).varint();
          if (this.goawayReceived !== null && id > this.goawayReceived) return this.fail(H3Error.ID_ERROR, 'GOAWAY id increased');
          this.goawayReceived = id;
          this.controlLog.push({ t: performance.now(), dir: 'in', type: f.type, detail: `id ${id}` });
          this.emit('goaway', id);
          break;
        }
        case H3Frame.PRIORITY_UPDATE: {
          if (this.isClient) return this.fail(H3Error.FRAME_UNEXPECTED, 'PRIORITY_UPDATE from a server');
          const r = new Reader(f.payload);
          const id = r.varint();
          const value = r.rest().toString();
          this.controlLog.push({ t: performance.now(), dir: 'in', type: f.type, detail: `stream ${id}: ${value}` });
          this.emit('priority', id, value);
          break;
        }
        case H3Frame.DATA:
        case H3Frame.HEADERS:
        case H3Frame.PUSH_PROMISE:
          return this.fail(H3Error.FRAME_UNEXPECTED, `frame 0x${f.type.toString(16)} on the control stream`);
        default:
          this.controlLog.push({ t: performance.now(), dir: 'in', type: f.type, detail: `${f.payload.length} bytes` });
      }
    }
  }
}

/** Parse an RFC 9218 priority field value ("u=3, i"). */
export function parsePriority(v: string | undefined): { urgency: number; incremental: boolean } {
  let urgency = 3;
  let incremental = false;
  for (const part of (v ?? '').split(',')) {
    const [k, val] = part.trim().split('=');
    if (k === 'u' && val !== undefined && /^[0-7]$/.test(val)) urgency = Number(val);
    if (k === 'i') incremental = val === undefined || val === '?1';
  }
  return { urgency, incremental };
}
