/**
 * HTTP/2 frames (RFC 9113 section 6): the wire format, every defined type,
 * and unknown types passed through as they are. Encoding never checks the
 * rules a peer enforces, so the lab can send frames that should be refused
 * (a DATA frame on stream 0, a window over 2^31-1); the connection engine
 * does the checking on what it receives.
 */

export const FrameType = {
  DATA: 0x0,
  HEADERS: 0x1,
  PRIORITY: 0x2,
  RST_STREAM: 0x3,
  SETTINGS: 0x4,
  PUSH_PROMISE: 0x5,
  PING: 0x6,
  GOAWAY: 0x7,
  WINDOW_UPDATE: 0x8,
  CONTINUATION: 0x9,
} as const;

export const Flag = { END_STREAM: 0x1, ACK: 0x1, END_HEADERS: 0x4, PADDED: 0x8, PRIORITY: 0x20 } as const;

export const Setting = {
  HEADER_TABLE_SIZE: 0x1,
  ENABLE_PUSH: 0x2,
  MAX_CONCURRENT_STREAMS: 0x3,
  INITIAL_WINDOW_SIZE: 0x4,
  MAX_FRAME_SIZE: 0x5,
  MAX_HEADER_LIST_SIZE: 0x6,
  ENABLE_CONNECT_PROTOCOL: 0x8,
  NO_RFC7540_PRIORITIES: 0x9,
} as const;

export const H2Error = {
  NO_ERROR: 0x0,
  PROTOCOL_ERROR: 0x1,
  INTERNAL_ERROR: 0x2,
  FLOW_CONTROL_ERROR: 0x3,
  SETTINGS_TIMEOUT: 0x4,
  STREAM_CLOSED: 0x5,
  FRAME_SIZE_ERROR: 0x6,
  REFUSED_STREAM: 0x7,
  CANCEL: 0x8,
  COMPRESSION_ERROR: 0x9,
  CONNECT_ERROR: 0xa,
  ENHANCE_YOUR_CALM: 0xb,
  INADEQUATE_SECURITY: 0xc,
  HTTP_1_1_REQUIRED: 0xd,
} as const;

export const PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'latin1');

const nameOf = (table: Record<string, number>, v: number) => Object.entries(table).find(([, n]) => n === v)?.[0];
export const frameTypeName = (t: number) => nameOf(FrameType, t) ?? `UNKNOWN_0x${t.toString(16)}`;
export const settingName = (id: number) => nameOf(Setting, id) ?? `0x${id.toString(16)}`;
export const h2ErrorName = (code: number) => nameOf(H2Error, code) ?? `0x${code.toString(16)}`;
/** A name, or a code as a number (decimal or 0x hex). */
export function h2ErrorCode(v: string | number): number {
  if (typeof v === 'number') return v;
  const k = v.trim().toUpperCase() as keyof typeof H2Error;
  if (k in H2Error) return H2Error[k];
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`unknown HTTP/2 error code ${v}`);
  return n;
}

/** One frame as read off the wire (payload with padding still in it). */
export interface RawFrame {
  type: number;
  flags: number;
  stream: number;
  payload: Buffer;
  /** The reserved high bit of the stream identifier, normally 0. */
  reserved?: boolean;
}

export function encodeFrame(f: RawFrame): Buffer {
  const out = Buffer.alloc(9 + f.payload.length);
  out.writeUIntBE(f.payload.length, 0, 3);
  out[3] = f.type;
  out[4] = f.flags;
  out.writeUInt32BE(((f.stream & 0x7fffffff) | (f.reserved ? 0x80000000 : 0)) >>> 0, 5);
  f.payload.copy(out, 9);
  return out;
}

/** Splits a byte stream into frames. Frames over maxSize are reported, not dropped, so the engine can answer FRAME_SIZE_ERROR. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  constructor(public maxSize = 16_384 * 64) {}
  push(chunk: Buffer): RawFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: RawFrame[] = [];
    while (this.buf.length >= 9) {
      const len = this.buf.readUIntBE(0, 3);
      if (len > this.maxSize) throw Object.assign(new Error(`frame of ${len} bytes is over the limit`), { code: H2Error.FRAME_SIZE_ERROR });
      if (this.buf.length < 9 + len) break;
      const sid = this.buf.readUInt32BE(5);
      out.push({ type: this.buf[3]!, flags: this.buf[4]!, stream: sid & 0x7fffffff, reserved: (sid & 0x80000000) !== 0, payload: Buffer.from(this.buf.subarray(9, 9 + len)) });
      this.buf = this.buf.subarray(9 + len);
    }
    return out;
  }
  get buffered() {
    return this.buf.length;
  }
}

// --- typed frames --------------------------------------------------------

export interface PriorityInfo {
  exclusive: boolean;
  dependsOn: number;
  /** 1 to 256 (the wire carries weight - 1). */
  weight: number;
}

export type Frame =
  | { type: 'DATA'; stream: number; data: Buffer; endStream: boolean; padding?: number }
  | { type: 'HEADERS'; stream: number; block: Buffer; endStream: boolean; endHeaders: boolean; priority?: PriorityInfo; padding?: number }
  | { type: 'PRIORITY'; stream: number; priority: PriorityInfo }
  | { type: 'RST_STREAM'; stream: number; code: number }
  | { type: 'SETTINGS'; ack: boolean; settings: Array<[number, number]> }
  | { type: 'PUSH_PROMISE'; stream: number; promised: number; block: Buffer; endHeaders: boolean; padding?: number }
  | { type: 'PING'; ack: boolean; data: Buffer }
  | { type: 'GOAWAY'; lastStream: number; code: number; debug: Buffer }
  | { type: 'WINDOW_UPDATE'; stream: number; increment: number }
  | { type: 'CONTINUATION'; stream: number; block: Buffer; endHeaders: boolean }
  | { type: 'UNKNOWN'; stream: number; frameType: number; flags: number; payload: Buffer };

export class FrameError extends Error {
  constructor(
    message: string,
    readonly code: number,
    /** Set when only this stream fails, not the connection. */
    readonly stream?: number,
  ) {
    super(message);
  }
}

function unpad(f: RawFrame): { body: Buffer; padding?: number } {
  if (!(f.flags & Flag.PADDED)) return { body: f.payload };
  if (!f.payload.length) throw new FrameError('PADDED frame without a pad length', H2Error.FRAME_SIZE_ERROR);
  const pad = f.payload[0]!;
  if (pad >= f.payload.length) throw new FrameError('padding is longer than the frame', H2Error.PROTOCOL_ERROR);
  return { body: f.payload.subarray(1, f.payload.length - pad), padding: pad };
}

const readPriority = (b: Buffer): PriorityInfo => ({ exclusive: (b[0]! & 0x80) !== 0, dependsOn: b.readUInt32BE(0) & 0x7fffffff, weight: b[4]! + 1 });

/** Parse a raw frame. Size and stream-zero rules are checked here (RFC 9113 section 6); state rules are the engine's. */
export function parseFrame(f: RawFrame): Frame {
  const conn = (cond: boolean, msg: string, code: number = H2Error.PROTOCOL_ERROR) => {
    if (cond) throw new FrameError(msg, code);
  };
  switch (f.type) {
    case FrameType.DATA: {
      conn(f.stream === 0, 'DATA on stream 0');
      const { body, padding } = unpad(f);
      return { type: 'DATA', stream: f.stream, data: body, endStream: (f.flags & Flag.END_STREAM) !== 0, ...(padding !== undefined ? { padding } : {}) };
    }
    case FrameType.HEADERS: {
      conn(f.stream === 0, 'HEADERS on stream 0');
      let { body, padding } = unpad(f);
      let priority: PriorityInfo | undefined;
      if (f.flags & Flag.PRIORITY) {
        conn(body.length < 5, 'HEADERS priority is cut short', H2Error.FRAME_SIZE_ERROR);
        priority = readPriority(body);
        body = body.subarray(5);
      }
      return { type: 'HEADERS', stream: f.stream, block: body, endStream: (f.flags & Flag.END_STREAM) !== 0, endHeaders: (f.flags & Flag.END_HEADERS) !== 0, ...(priority ? { priority } : {}), ...(padding !== undefined ? { padding } : {}) };
    }
    case FrameType.PRIORITY:
      conn(f.stream === 0, 'PRIORITY on stream 0');
      if (f.payload.length !== 5) throw new FrameError('PRIORITY is not 5 bytes', H2Error.FRAME_SIZE_ERROR, f.stream);
      return { type: 'PRIORITY', stream: f.stream, priority: readPriority(f.payload) };
    case FrameType.RST_STREAM:
      conn(f.stream === 0, 'RST_STREAM on stream 0');
      conn(f.payload.length !== 4, 'RST_STREAM is not 4 bytes', H2Error.FRAME_SIZE_ERROR);
      return { type: 'RST_STREAM', stream: f.stream, code: f.payload.readUInt32BE(0) };
    case FrameType.SETTINGS: {
      conn(f.stream !== 0, 'SETTINGS on a stream');
      const ack = (f.flags & Flag.ACK) !== 0;
      conn(ack && f.payload.length > 0, 'SETTINGS ACK with a payload', H2Error.FRAME_SIZE_ERROR);
      conn(f.payload.length % 6 !== 0, 'SETTINGS length is not a multiple of 6', H2Error.FRAME_SIZE_ERROR);
      const settings: Array<[number, number]> = [];
      for (let i = 0; i < f.payload.length; i += 6) settings.push([f.payload.readUInt16BE(i), f.payload.readUInt32BE(i + 2)]);
      return { type: 'SETTINGS', ack, settings };
    }
    case FrameType.PUSH_PROMISE: {
      conn(f.stream === 0, 'PUSH_PROMISE on stream 0');
      const { body, padding } = unpad(f);
      conn(body.length < 4, 'PUSH_PROMISE is cut short', H2Error.FRAME_SIZE_ERROR);
      return { type: 'PUSH_PROMISE', stream: f.stream, promised: body.readUInt32BE(0) & 0x7fffffff, block: body.subarray(4), endHeaders: (f.flags & Flag.END_HEADERS) !== 0, ...(padding !== undefined ? { padding } : {}) };
    }
    case FrameType.PING:
      conn(f.stream !== 0, 'PING on a stream');
      conn(f.payload.length !== 8, 'PING is not 8 bytes', H2Error.FRAME_SIZE_ERROR);
      return { type: 'PING', ack: (f.flags & Flag.ACK) !== 0, data: f.payload };
    case FrameType.GOAWAY:
      conn(f.stream !== 0, 'GOAWAY on a stream');
      conn(f.payload.length < 8, 'GOAWAY is cut short', H2Error.FRAME_SIZE_ERROR);
      return { type: 'GOAWAY', lastStream: f.payload.readUInt32BE(0) & 0x7fffffff, code: f.payload.readUInt32BE(4), debug: f.payload.subarray(8) };
    case FrameType.WINDOW_UPDATE:
      conn(f.payload.length !== 4, 'WINDOW_UPDATE is not 4 bytes', H2Error.FRAME_SIZE_ERROR);
      return { type: 'WINDOW_UPDATE', stream: f.stream, increment: f.payload.readUInt32BE(0) & 0x7fffffff };
    case FrameType.CONTINUATION:
      conn(f.stream === 0, 'CONTINUATION on stream 0');
      return { type: 'CONTINUATION', stream: f.stream, block: f.payload, endHeaders: (f.flags & Flag.END_HEADERS) !== 0 };
    default:
      return { type: 'UNKNOWN', stream: f.stream, frameType: f.type, flags: f.flags, payload: f.payload };
  }
}

const pad = (body: Buffer, padding: number | undefined, extraFlags: number): { payload: Buffer; flags: number } => {
  if (padding === undefined) return { payload: body, flags: extraFlags };
  return { payload: Buffer.concat([Buffer.of(padding), body, Buffer.alloc(padding)]), flags: extraFlags | Flag.PADDED };
};
const priorityBytes = (p: PriorityInfo) => {
  const b = Buffer.alloc(5);
  b.writeUInt32BE(((p.dependsOn & 0x7fffffff) | (p.exclusive ? 0x80000000 : 0)) >>> 0, 0);
  b[4] = Math.max(1, Math.min(256, p.weight)) - 1;
  return b;
};
const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0, 0);
  return b;
};

/** A typed frame as raw bytes. */
export function serializeFrame(f: Frame): RawFrame {
  switch (f.type) {
    case 'DATA': {
      const p = pad(f.data, f.padding, f.endStream ? Flag.END_STREAM : 0);
      return { type: FrameType.DATA, stream: f.stream, ...p };
    }
    case 'HEADERS': {
      const body = f.priority ? Buffer.concat([priorityBytes(f.priority), f.block]) : f.block;
      const p = pad(body, f.padding, (f.endStream ? Flag.END_STREAM : 0) | (f.endHeaders ? Flag.END_HEADERS : 0) | (f.priority ? Flag.PRIORITY : 0));
      return { type: FrameType.HEADERS, stream: f.stream, ...p };
    }
    case 'PRIORITY':
      return { type: FrameType.PRIORITY, stream: f.stream, flags: 0, payload: priorityBytes(f.priority) };
    case 'RST_STREAM':
      return { type: FrameType.RST_STREAM, stream: f.stream, flags: 0, payload: u32(f.code) };
    case 'SETTINGS': {
      const payload = Buffer.alloc(f.settings.length * 6);
      f.settings.forEach(([id, v], i) => {
        payload.writeUInt16BE(id & 0xffff, i * 6);
        payload.writeUInt32BE(v >>> 0, i * 6 + 2);
      });
      return { type: FrameType.SETTINGS, stream: 0, flags: f.ack ? Flag.ACK : 0, payload };
    }
    case 'PUSH_PROMISE': {
      const p = pad(Buffer.concat([u32(f.promised & 0x7fffffff), f.block]), f.padding, f.endHeaders ? Flag.END_HEADERS : 0);
      return { type: FrameType.PUSH_PROMISE, stream: f.stream, ...p };
    }
    case 'PING':
      return { type: FrameType.PING, stream: 0, flags: f.ack ? Flag.ACK : 0, payload: f.data };
    case 'GOAWAY':
      return { type: FrameType.GOAWAY, stream: 0, flags: 0, payload: Buffer.concat([u32(f.lastStream & 0x7fffffff), u32(f.code), f.debug]) };
    case 'WINDOW_UPDATE':
      return { type: FrameType.WINDOW_UPDATE, stream: f.stream, flags: 0, payload: u32(f.increment) };
    case 'CONTINUATION':
      return { type: FrameType.CONTINUATION, stream: f.stream, flags: f.endHeaders ? Flag.END_HEADERS : 0, payload: f.block };
    case 'UNKNOWN':
      return { type: f.frameType, stream: f.stream, flags: f.flags, payload: f.payload };
  }
}

/** One line for the frame log. */
export function describeFrame(f: Frame): string {
  switch (f.type) {
    case 'DATA':
      return `${f.data.length} bytes${f.endStream ? ' END_STREAM' : ''}${f.padding !== undefined ? ` pad ${f.padding}` : ''}`;
    case 'HEADERS':
      return `${f.block.length} byte block${f.endStream ? ' END_STREAM' : ''}${f.endHeaders ? ' END_HEADERS' : ''}${f.priority ? ` dep ${f.priority.dependsOn} w ${f.priority.weight}${f.priority.exclusive ? ' excl' : ''}` : ''}`;
    case 'PRIORITY':
      return `dep ${f.priority.dependsOn} weight ${f.priority.weight}${f.priority.exclusive ? ' exclusive' : ''}`;
    case 'RST_STREAM':
      return h2ErrorName(f.code);
    case 'SETTINGS':
      return f.ack ? 'ACK' : f.settings.map(([id, v]) => `${settingName(id)}=${v}`).join(' ') || '(empty)';
    case 'PUSH_PROMISE':
      return `promised ${f.promised}`;
    case 'PING':
      return `${f.ack ? 'ACK ' : ''}${f.data.toString('hex')}`;
    case 'GOAWAY':
      return `last ${f.lastStream} ${h2ErrorName(f.code)}${f.debug.length ? ` "${f.debug.toString('latin1').slice(0, 80)}"` : ''}`;
    case 'WINDOW_UPDATE':
      return `+${f.increment}`;
    case 'CONTINUATION':
      return `${f.block.length} bytes${f.endHeaders ? ' END_HEADERS' : ''}`;
    case 'UNKNOWN':
      return `type 0x${f.frameType.toString(16)} flags 0x${f.flags.toString(16)} ${f.payload.length} bytes`;
  }
}
