/** Byte reader and writer with QUIC variable-length integers (RFC 9000 section 16). */

export class QuicError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly frameType = 0,
  ) {
    super(message);
  }
}

/** Transport error codes (RFC 9000 section 20.1). */
export const TransportError = {
  NO_ERROR: 0x0,
  INTERNAL_ERROR: 0x1,
  CONNECTION_REFUSED: 0x2,
  FLOW_CONTROL_ERROR: 0x3,
  STREAM_LIMIT_ERROR: 0x4,
  STREAM_STATE_ERROR: 0x5,
  FINAL_SIZE_ERROR: 0x6,
  FRAME_ENCODING_ERROR: 0x7,
  TRANSPORT_PARAMETER_ERROR: 0x8,
  CONNECTION_ID_LIMIT_ERROR: 0x9,
  PROTOCOL_VIOLATION: 0xa,
  INVALID_TOKEN: 0xb,
  APPLICATION_ERROR: 0xc,
  CRYPTO_BUFFER_EXCEEDED: 0xd,
  KEY_UPDATE_ERROR: 0xe,
  AEAD_LIMIT_REACHED: 0xf,
  NO_VIABLE_PATH: 0x10,
  /** 0x0100 + TLS alert. */
  CRYPTO_ERROR: 0x100,
} as const;

export const MAX_VARINT = 2 ** 62 - 1;

export function varintLength(v: number): number {
  if (v < 0 || !Number.isInteger(v)) throw new RangeError(`bad varint ${v}`);
  if (v < 0x40) return 1;
  if (v < 0x4000) return 2;
  if (v < 0x40000000) return 4;
  if (v <= MAX_VARINT) return 8;
  throw new RangeError(`varint too large ${v}`);
}

export class Reader {
  pos = 0;
  constructor(
    readonly buf: Buffer,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }
  get left(): number {
    return this.end - this.pos;
  }
  private need(n: number) {
    if (this.pos + n > this.end) throw new QuicError(TransportError.FRAME_ENCODING_ERROR, 'truncated');
  }
  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u24(): number {
    this.need(3);
    const v = this.buf.readUIntBE(this.pos, 3);
    this.pos += 3;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  bytes(n: number): Buffer {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  rest(): Buffer {
    return this.bytes(this.left);
  }
  varint(): number {
    this.need(1);
    const first = this.buf[this.pos]!;
    const len = 1 << (first >> 6);
    this.need(len);
    let v = first & 0x3f;
    for (let i = 1; i < len; i++) v = v * 256 + this.buf[this.pos + i]!;
    this.pos += len;
    return v;
  }
  /** Length-prefixed (1, 2 or 3 byte length) vector as used by TLS. */
  vec(lenBytes: 1 | 2 | 3): Buffer {
    const n = lenBytes === 1 ? this.u8() : lenBytes === 2 ? this.u16() : this.u24();
    return this.bytes(n);
  }
  vvec(): Buffer {
    return this.bytes(this.varint());
  }
}

export class Writer {
  private chunks: Buffer[] = [];
  private cur: Buffer;
  private off = 0;
  length = 0;
  constructor(size = 256) {
    this.cur = Buffer.allocUnsafe(size);
  }
  private room(n: number) {
    if (this.off + n <= this.cur.length) return;
    this.chunks.push(this.cur.subarray(0, this.off));
    this.cur = Buffer.allocUnsafe(Math.max(n, this.cur.length * 2));
    this.off = 0;
  }
  u8(v: number): this {
    this.room(1);
    this.cur[this.off++] = v & 0xff;
    this.length++;
    return this;
  }
  u16(v: number): this {
    this.room(2);
    this.cur.writeUInt16BE(v & 0xffff, this.off);
    this.off += 2;
    this.length += 2;
    return this;
  }
  u24(v: number): this {
    this.room(3);
    this.cur.writeUIntBE(v, this.off, 3);
    this.off += 3;
    this.length += 3;
    return this;
  }
  u32(v: number): this {
    this.room(4);
    this.cur.writeUInt32BE(v >>> 0, this.off);
    this.off += 4;
    this.length += 4;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.room(b.length);
    this.cur.set(b, this.off);
    this.off += b.length;
    this.length += b.length;
    return this;
  }
  varint(v: number, forceLen?: 1 | 2 | 4 | 8): this {
    const len = forceLen ?? varintLength(v);
    if (len < varintLength(v)) throw new RangeError(`varint ${v} does not fit ${len} bytes`);
    this.room(len);
    const prefix = { 1: 0, 2: 1, 4: 2, 8: 3 }[len]!;
    let x = v;
    for (let i = len - 1; i >= 0; i--) {
      this.cur[this.off + i] = x % 256;
      x = Math.floor(x / 256);
    }
    this.cur[this.off] = this.cur[this.off]! | (prefix << 6);
    this.off += len;
    this.length += len;
    return this;
  }
  vec(lenBytes: 1 | 2 | 3, b: Uint8Array): this {
    if (lenBytes === 1) this.u8(b.length);
    else if (lenBytes === 2) this.u16(b.length);
    else this.u24(b.length);
    return this.bytes(b);
  }
  vvec(b: Uint8Array): this {
    return this.varint(b.length).bytes(b);
  }
  /** Write a TLS vector whose body is produced by fn. */
  nested(lenBytes: 1 | 2 | 3, fn: (w: Writer) => void): this {
    const w = new Writer();
    fn(w);
    return this.vec(lenBytes, w.finish());
  }
  finish(): Buffer {
    return this.chunks.length ? Buffer.concat([...this.chunks, this.cur.subarray(0, this.off)]) : Buffer.from(this.cur.subarray(0, this.off));
  }
}

export const encodeVarint = (v: number, forceLen?: 1 | 2 | 4 | 8): Buffer => new Writer(8).varint(v, forceLen).finish();
