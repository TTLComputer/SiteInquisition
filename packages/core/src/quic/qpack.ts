/**
 * QPACK (RFC 9204): field compression for HTTP/3 with a static table, a
 * dynamic table fed over the encoder stream, acknowledgements over the
 * decoder stream, and blocked streams.
 *
 * The encoder takes a policy so the HTTP/3 lab can choose literal vs
 * indexed lines, Huffman on or off, and whether to reference entries the
 * decoder has not acknowledged yet (which blocks the request stream).
 */
import { huffmanDecode, huffmanEncode, huffmanLength } from './huffman.js';

export type Field = [name: string, value: string];

export const STATIC_TABLE: Field[] = [
  [':authority', ''], [':path', '/'], ['age', '0'], ['content-disposition', ''], ['content-length', '0'], ['cookie', ''], ['date', ''], ['etag', ''],
  ['if-modified-since', ''], ['if-none-match', ''], ['last-modified', ''], ['link', ''], ['location', ''], ['referer', ''], ['set-cookie', ''],
  [':method', 'CONNECT'], [':method', 'DELETE'], [':method', 'GET'], [':method', 'HEAD'], [':method', 'OPTIONS'], [':method', 'POST'], [':method', 'PUT'],
  [':scheme', 'http'], [':scheme', 'https'], [':status', '103'], [':status', '200'], [':status', '304'], [':status', '404'], [':status', '503'],
  ['accept', '*/*'], ['accept', 'application/dns-message'], ['accept-encoding', 'gzip, deflate, br'], ['accept-ranges', 'bytes'],
  ['access-control-allow-headers', 'cache-control'], ['access-control-allow-headers', 'content-type'], ['access-control-allow-origin', '*'],
  ['cache-control', 'max-age=0'], ['cache-control', 'max-age=2592000'], ['cache-control', 'max-age=604800'], ['cache-control', 'no-cache'],
  ['cache-control', 'no-store'], ['cache-control', 'public, max-age=31536000'], ['content-encoding', 'br'], ['content-encoding', 'gzip'],
  ['content-type', 'application/dns-message'], ['content-type', 'application/javascript'], ['content-type', 'application/json'],
  ['content-type', 'application/x-www-form-urlencoded'], ['content-type', 'image/gif'], ['content-type', 'image/jpeg'], ['content-type', 'image/png'],
  ['content-type', 'text/css'], ['content-type', 'text/html; charset=utf-8'], ['content-type', 'text/plain'], ['content-type', 'text/plain;charset=utf-8'],
  ['range', 'bytes=0-'], ['strict-transport-security', 'max-age=31536000'], ['strict-transport-security', 'max-age=31536000; includesubdomains'],
  ['strict-transport-security', 'max-age=31536000; includesubdomains; preload'], ['vary', 'accept-encoding'], ['vary', 'origin'],
  ['x-content-type-options', 'nosniff'], ['x-xss-protection', '1; mode=block'], [':status', '100'], [':status', '204'], [':status', '206'],
  [':status', '302'], [':status', '400'], [':status', '403'], [':status', '421'], [':status', '425'], [':status', '500'], ['accept-language', ''],
  ['access-control-allow-credentials', 'FALSE'], ['access-control-allow-credentials', 'TRUE'], ['access-control-allow-headers', '*'],
  ['access-control-allow-methods', 'get'], ['access-control-allow-methods', 'get, post, options'], ['access-control-allow-methods', 'options'],
  ['access-control-expose-headers', 'content-length'], ['access-control-request-headers', 'content-type'], ['access-control-request-method', 'get'],
  ['access-control-request-method', 'post'], ['alt-svc', 'clear'], ['authorization', ''],
  ['content-security-policy', "script-src 'none'; object-src 'none'; base-uri 'none'"], ['early-data', '1'], ['expect-ct', ''], ['forwarded', ''],
  ['if-range', ''], ['origin', ''], ['purpose', 'prefetch'], ['server', ''], ['timing-allow-origin', '*'], ['upgrade-insecure-requests', '1'],
  ['user-agent', ''], ['x-forwarded-for', ''], ['x-frame-options', 'deny'], ['x-frame-options', 'sameorigin'],
];

const staticExact = new Map<string, number>();
const staticName = new Map<string, number>();
STATIC_TABLE.forEach(([n, v], i) => {
  const k = `${n}\0${v}`;
  if (!staticExact.has(k)) staticExact.set(k, i);
  if (!staticName.has(n)) staticName.set(n, i);
});

export class QpackError extends Error {
  constructor(
    /** QPACK_DECOMPRESSION_FAILED 0x200, ENCODER_STREAM_ERROR 0x201, DECODER_STREAM_ERROR 0x202. */
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
const DECOMPRESSION_FAILED = 0x200;
const ENCODER_STREAM_ERROR = 0x201;
const DECODER_STREAM_ERROR = 0x202;

// --- primitives -----------------------------------------------------------

/** Prefix integer (RFC 7541 section 5.1) with high bits `flags` in the first byte. */
export function writeInt(out: number[], prefix: number, flags: number, v: number) {
  const max = (1 << prefix) - 1;
  if (v < max) {
    out.push(flags | v);
    return;
  }
  out.push(flags | max);
  v -= max;
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

class In {
  pos = 0;
  constructor(
    readonly b: Buffer,
    readonly err: number,
  ) {}
  get left() {
    return this.b.length - this.pos;
  }
  peek() {
    if (this.pos >= this.b.length) throw new Incomplete();
    return this.b[this.pos]!;
  }
  int(prefix: number): number {
    const max = (1 << prefix) - 1;
    let v = this.peek() & max;
    this.pos++;
    if (v < max) return v;
    let m = 1;
    for (;;) {
      const byte = this.peek();
      this.pos++;
      v += (byte & 127) * m;
      m *= 128;
      if (m > 2 ** 56) throw new QpackError(this.err, 'integer too large');
      if (!(byte & 128)) return v;
    }
  }
  /** String with H bit just above a prefix of `prefix` bits. */
  str(prefix: number): string {
    const h = (this.peek() >> prefix) & 1;
    const n = this.int(prefix);
    if (this.left < n) throw new Incomplete();
    const raw = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    if (!h) return raw.toString('latin1');
    try {
      return huffmanDecode(raw).toString('latin1');
    } catch (e) {
      throw new QpackError(this.err, (e as Error).message);
    }
  }
}

/** Thrown when an instruction stream ends mid-instruction; the caller waits for more bytes. */
class Incomplete extends Error {}

function writeStr(out: number[], prefix: number, flags: number, s: string, huffman: boolean | 'auto') {
  const raw = Buffer.from(s, 'latin1');
  const useH = huffman === 'auto' ? huffmanLength(raw) < raw.length : huffman;
  const data = useH ? huffmanEncode(raw) : raw;
  writeInt(out, prefix, flags | (useH ? 1 << prefix : 0), data.length);
  for (const b of data) out.push(b);
}

const entrySize = (n: string, v: string) => Buffer.byteLength(n, 'latin1') + Buffer.byteLength(v, 'latin1') + 32;

class DynamicTable {
  /** Entries by absolute index; dropped entries are removed from the front. */
  entries: Field[] = [];
  dropped = 0;
  size = 0;
  capacity = 0;
  get inserted() {
    return this.dropped + this.entries.length;
  }
  get(abs: number): Field | undefined {
    return this.entries[abs - this.dropped];
  }
  evictTo(target: number, minKeep = Infinity): boolean {
    while (this.size > target) {
      if (this.dropped >= minKeep) return false;
      const e = this.entries.shift();
      if (!e) break;
      this.size -= entrySize(e[0], e[1]);
      this.dropped++;
    }
    return true;
  }
  insert(f: Field, minKeep = Infinity): boolean {
    const s = entrySize(f[0], f[1]);
    if (s > this.capacity) return false;
    if (!this.evictTo(this.capacity - s, minKeep)) return false;
    this.entries.push(f);
    this.size += s;
    return true;
  }
}

// --- encoder --------------------------------------------------------------

export interface EncoderPolicy {
  /** Use the dynamic table when the peer allows one (default true). */
  dynamic?: boolean;
  /** Huffman for literals: auto (when shorter), always or never. */
  huffman?: boolean | 'auto';
  /** Reference entries the decoder has not acknowledged yet, blocking the stream (default true, within the peer's limit). */
  allowBlocking?: boolean;
  /** Names sent as never-indexed literals (N bit), e.g. authorization and cookie. */
  neverIndex?: string[];
  /** Skip the static table, to send everything as literals. */
  noStatic?: boolean;
  /** Our own dynamic table capacity when the peer allows more (default: the peer's maximum, at most 4096). */
  capacity?: number;
}

export class QpackEncoder {
  private table = new DynamicTable();
  private maxCapacity = 0;
  private maxBlocked = 0;
  /** Insertions the decoder has acknowledged. */
  private knownReceived = 0;
  /** Per stream, the required insert counts of unacknowledged sections (FIFO) and lowest referenced index. */
  private outstanding = new Map<number, Array<{ ric: number; minRef: number }>>();
  private capacitySent = false;
  policy: EncoderPolicy;

  constructor(
    private readonly sendEncoderStream: (b: Buffer) => void,
    policy: EncoderPolicy = {},
  ) {
    this.policy = policy;
  }

  /** Apply the peer's SETTINGS_QPACK_MAX_TABLE_CAPACITY and SETTINGS_QPACK_BLOCKED_STREAMS. */
  peerSettings(maxCapacity: number, blockedStreams: number) {
    this.maxCapacity = maxCapacity;
    this.maxBlocked = blockedStreams;
  }

  get stats() {
    return { capacity: this.table.capacity, size: this.table.size, inserted: this.table.inserted, acknowledged: this.knownReceived, blockedStreams: this.blockedCount() };
  }

  private blockedCount(): number {
    let n = 0;
    for (const list of this.outstanding.values()) if (list.some((s) => s.ric > this.knownReceived)) n++;
    return n;
  }

  private minReferenced(): number {
    let m = Infinity;
    for (const list of this.outstanding.values()) for (const s of list) m = Math.min(m, s.minRef);
    return m;
  }

  /** Emit a Set Dynamic Table Capacity instruction (any value, for negative tests). */
  setCapacity(cap: number) {
    const out: number[] = [];
    writeInt(out, 5, 0x20, cap);
    this.table.capacity = cap;
    this.table.evictTo(cap);
    this.sendEncoderStream(Buffer.from(out));
    this.capacitySent = true;
  }

  /** Insert an entry directly (for tests that pre-load the table or block a stream). */
  insert(name: string, value: string, huffman: boolean | 'auto' = 'auto', keepFrom = Infinity): number | null {
    if (!this.capacitySent) this.setCapacity(Math.min(this.policy.capacity ?? 4096, this.maxCapacity));
    if (!this.table.insert([name, value], Math.min(keepFrom, this.minReferenced()))) return null;
    const out: number[] = [];
    const si = this.policy.noStatic ? undefined : staticName.get(name);
    if (si !== undefined) {
      writeInt(out, 6, 0xc0, si);
      writeStr(out, 7, 0, value, huffman);
    } else {
      writeStr(out, 5, 0x40, name, huffman);
      writeStr(out, 7, 0, value, huffman);
    }
    this.sendEncoderStream(Buffer.from(out));
    return this.table.inserted - 1;
  }

  /** Encode a field section for a stream. */
  encode(streamId: number, fields: Field[]): Buffer {
    const p = this.policy;
    const h = p.huffman ?? 'auto';
    const never = new Set((p.neverIndex ?? ['authorization', 'cookie', 'set-cookie', 'proxy-authorization']).map((x) => x.toLowerCase()));
    const useDynamic = (p.dynamic ?? true) && this.maxCapacity > 0;
    const canBlock = (p.allowBlocking ?? true) && (this.blockedCount() < this.maxBlocked || (this.outstanding.get(streamId)?.some((s) => s.ric > this.knownReceived) ?? false));
    const lines: Array<{ kind: 'static'; idx: number } | { kind: 'dyn'; abs: number } | { kind: 'staticName'; idx: number; value: string; n: boolean } | { kind: 'dynName'; abs: number; value: string; n: boolean } | { kind: 'literal'; name: string; value: string; n: boolean }> = [];
    let ric = 0;
    let minRef = Infinity;
    const ref = (abs: number) => {
      ric = Math.max(ric, abs + 1);
      minRef = Math.min(minRef, abs);
    };
    for (const [rawName, value] of fields) {
      const name = rawName.toLowerCase();
      const n = never.has(name);
      const se = p.noStatic ? undefined : staticExact.get(`${name}\0${value}`);
      if (se !== undefined) {
        lines.push({ kind: 'static', idx: se });
        continue;
      }
      if (useDynamic && !n) {
        const found = this.findDynamic(name, value, canBlock);
        if (found !== undefined) {
          ref(found);
          lines.push({ kind: 'dyn', abs: found });
          continue;
        }
        if (canBlock || this.policy.allowBlocking === false) {
          // Insert, then reference it (blocking) when allowed.
          const abs = name.length + value.length < 2048 ? this.insert(name, value, h, minRef) : null;
          if (abs !== null && canBlock) {
            ref(abs);
            lines.push({ kind: 'dyn', abs });
            continue;
          }
        }
      }
      const sn = p.noStatic ? undefined : staticName.get(name);
      if (sn !== undefined) lines.push({ kind: 'staticName', idx: sn, value, n });
      else lines.push({ kind: 'literal', name, value, n });
    }
    // Base = RIC: every dynamic reference is relative (below the base).
    const out: number[] = [];
    const maxEntries = Math.floor(this.maxCapacity / 32);
    writeInt(out, 8, 0, ric === 0 ? 0 : (ric % (2 * maxEntries)) + 1);
    writeInt(out, 7, 0, 0);
    const base = ric;
    for (const l of lines) {
      switch (l.kind) {
        case 'static':
          writeInt(out, 6, 0xc0, l.idx);
          break;
        case 'dyn':
          writeInt(out, 6, 0x80, base - 1 - l.abs);
          break;
        case 'staticName':
          writeInt(out, 4, 0x50 | (l.n ? 0x20 : 0), l.idx);
          writeStr(out, 7, 0, l.value, h);
          break;
        case 'dynName':
          writeInt(out, 4, 0x40 | (l.n ? 0x20 : 0), base - 1 - l.abs);
          writeStr(out, 7, 0, l.value, h);
          break;
        case 'literal':
          writeStr(out, 3, 0x20 | (l.n ? 0x10 : 0), l.name, h);
          writeStr(out, 7, 0, l.value, h);
          break;
      }
    }
    if (ric > 0) {
      const list = this.outstanding.get(streamId) ?? [];
      list.push({ ric, minRef });
      this.outstanding.set(streamId, list);
    }
    return Buffer.from(out);
  }

  private findDynamic(name: string, value: string, canBlock: boolean): number | undefined {
    const t = this.table;
    for (let i = t.entries.length - 1; i >= 0; i--) {
      const abs = t.dropped + i;
      if (!canBlock && abs >= this.knownReceived) continue;
      const [n, v] = t.entries[i]!;
      if (n === name && v === value) return abs;
    }
    return undefined;
  }

  private pending = Buffer.alloc(0);

  /** Bytes from the peer's decoder stream. */
  decoderStream(data: Buffer) {
    this.pending = Buffer.concat([this.pending, data]);
    const r = new In(this.pending, DECODER_STREAM_ERROR);
    for (;;) {
      const start = r.pos;
      try {
        if (!r.left) break;
        const b = r.peek();
        if (b & 0x80) {
          const id = r.int(7);
          const list = this.outstanding.get(id);
          const s = list?.shift();
          if (!s) throw new QpackError(DECODER_STREAM_ERROR, `section acknowledgment for stream ${id} with nothing outstanding`);
          if (!list!.length) this.outstanding.delete(id);
          this.knownReceived = Math.max(this.knownReceived, s.ric);
        } else if (b & 0x40) {
          this.outstanding.delete(r.int(6));
        } else {
          const inc = r.int(6);
          if (inc === 0 || this.knownReceived + inc > this.table.inserted) throw new QpackError(DECODER_STREAM_ERROR, 'bad insert count increment');
          this.knownReceived += inc;
        }
      } catch (e) {
        if (e instanceof Incomplete) {
          r.pos = start;
          break;
        }
        throw e;
      }
    }
    this.pending = this.pending.subarray(r.pos);
  }

  /** The stream was reset: its sections will never be acknowledged. */
  streamCancelled(id: number) {
    this.outstanding.delete(id);
  }
}

// --- decoder --------------------------------------------------------------

export interface DecodedSection {
  fields: Field[];
  requiredInsertCount: number;
  /** The section waited for encoder stream inserts. */
  blocked: boolean;
}

export class QpackDecoder {
  private table = new DynamicTable();
  private pending = Buffer.alloc(0);
  private blocked: Array<{ streamId: number; data: Buffer; ric: number; resolve: (d: DecodedSection) => void; reject: (e: Error) => void }> = [];
  private acked = 0;

  constructor(
    readonly maxCapacity: number,
    readonly maxBlocked: number,
    private readonly sendDecoderStream: (b: Buffer) => void,
  ) {}

  get stats() {
    return { capacity: this.table.capacity, size: this.table.size, inserted: this.table.inserted, blocked: this.blocked.length };
  }

  /** Bytes from the peer's encoder stream. */
  encoderStream(data: Buffer) {
    this.pending = Buffer.concat([this.pending, data]);
    const r = new In(this.pending, ENCODER_STREAM_ERROR);
    const before = this.table.inserted;
    for (;;) {
      const start = r.pos;
      try {
        if (!r.left) break;
        const b = r.peek();
        if (b & 0x80) {
          const isStatic = (b & 0x40) !== 0;
          const idx = r.int(6);
          const value = r.str(7);
          const name = isStatic ? STATIC_TABLE[idx]?.[0] : this.table.get(this.table.inserted - 1 - idx)?.[0];
          if (name === undefined) throw new QpackError(ENCODER_STREAM_ERROR, 'insert with a bad name reference');
          this.doInsert([name, value]);
        } else if (b & 0x40) {
          const name = r.str(5);
          const value = r.str(7);
          this.doInsert([name, value]);
        } else if (b & 0x20) {
          const cap = r.int(5);
          if (cap > this.maxCapacity) throw new QpackError(ENCODER_STREAM_ERROR, `table capacity ${cap} above our maximum ${this.maxCapacity}`);
          this.table.capacity = cap;
          this.table.evictTo(cap);
        } else {
          const idx = r.int(5);
          const e = this.table.get(this.table.inserted - 1 - idx);
          if (!e) throw new QpackError(ENCODER_STREAM_ERROR, 'duplicate of a missing entry');
          this.doInsert([e[0], e[1]]);
        }
      } catch (e) {
        if (e instanceof Incomplete) {
          r.pos = start;
          break;
        }
        throw e;
      }
    }
    this.pending = this.pending.subarray(r.pos);
    if (this.table.inserted > before) this.unblock();
  }

  private doInsert(f: Field) {
    if (!this.table.insert(f)) throw new QpackError(ENCODER_STREAM_ERROR, 'entry larger than the table');
  }

  private unblock() {
    const ready = this.blocked.filter((b) => b.ric <= this.table.inserted);
    this.blocked = this.blocked.filter((b) => b.ric > this.table.inserted);
    for (const b of ready) {
      try {
        b.resolve({ ...this.decodeNow(b.streamId, b.data), blocked: true });
      } catch (e) {
        b.reject(e as Error);
      }
    }
    // Acknowledge inserts that no section acknowledgment has covered.
    if (this.table.inserted > this.acked) {
      const out: number[] = [];
      writeInt(out, 6, 0x00, this.table.inserted - this.acked);
      this.acked = this.table.inserted;
      this.sendDecoderStream(Buffer.from(out));
    }
  }

  private requiredInsertCount(encoded: number): number {
    if (encoded === 0) return 0;
    const maxEntries = Math.floor(this.maxCapacity / 32);
    const full = 2 * maxEntries;
    if (encoded > full) throw new QpackError(DECOMPRESSION_FAILED, 'bad required insert count');
    const maxValue = this.table.inserted + maxEntries;
    const maxWrapped = Math.floor(maxValue / full) * full;
    let ric = maxWrapped + encoded - 1;
    if (ric > maxValue) {
      if (ric <= full) throw new QpackError(DECOMPRESSION_FAILED, 'bad required insert count');
      ric -= full;
    }
    if (ric === 0) throw new QpackError(DECOMPRESSION_FAILED, 'bad required insert count');
    return ric;
  }

  /** Decode a field section; resolves later if it is blocked on encoder stream inserts. */
  decode(streamId: number, data: Buffer): Promise<DecodedSection> {
    const r = new In(data, DECOMPRESSION_FAILED);
    let ric: number;
    try {
      ric = this.requiredInsertCount(r.int(8));
    } catch (e) {
      return Promise.reject(e instanceof Incomplete ? new QpackError(DECOMPRESSION_FAILED, 'truncated field section') : e);
    }
    if (ric > this.table.inserted) {
      if (this.blocked.length >= this.maxBlocked) return Promise.reject(new QpackError(DECOMPRESSION_FAILED, `more than ${this.maxBlocked} blocked streams`));
      return new Promise((resolve, reject) => this.blocked.push({ streamId, data, ric, resolve, reject }));
    }
    try {
      return Promise.resolve({ ...this.decodeNow(streamId, data), blocked: false });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** The request stream went away; tell the encoder. */
  cancelStream(streamId: number) {
    this.blocked = this.blocked.filter((b) => b.streamId !== streamId);
    const out: number[] = [];
    writeInt(out, 6, 0x40, streamId);
    this.sendDecoderStream(Buffer.from(out));
  }

  private decodeNow(streamId: number, data: Buffer): Omit<DecodedSection, 'blocked'> {
    const r = new In(data, DECOMPRESSION_FAILED);
    try {
      const ric = this.requiredInsertCount(r.int(8));
      const sign = (r.peek() & 0x80) !== 0;
      const delta = r.int(7);
      const base = sign ? ric - delta - 1 : ric + delta;
      if (base < 0) throw new QpackError(DECOMPRESSION_FAILED, 'negative base');
      const fields: Field[] = [];
      const dyn = (abs: number): Field => {
        if (abs >= ric) throw new QpackError(DECOMPRESSION_FAILED, 'reference past the required insert count');
        const e = this.table.get(abs);
        if (!e) throw new QpackError(DECOMPRESSION_FAILED, `dynamic table entry ${abs} is missing`);
        return e;
      };
      while (r.left) {
        const b = r.peek();
        if (b & 0x80) {
          const isStatic = (b & 0x40) !== 0;
          const idx = r.int(6);
          const e = isStatic ? STATIC_TABLE[idx] : dyn(base - 1 - idx);
          if (!e) throw new QpackError(DECOMPRESSION_FAILED, `static table index ${idx} is out of range`);
          fields.push([e[0], e[1]]);
        } else if (b & 0x40) {
          const isStatic = (b & 0x10) !== 0;
          const idx = r.int(4);
          const name = isStatic ? STATIC_TABLE[idx]?.[0] : dyn(base - 1 - idx)[0];
          if (name === undefined) throw new QpackError(DECOMPRESSION_FAILED, `static table index ${idx} is out of range`);
          fields.push([name, r.str(7)]);
        } else if (b & 0x20) {
          const name = r.str(3);
          fields.push([name, r.str(7)]);
        } else if (b & 0x10) {
          const e = dyn(base + r.int(4));
          fields.push([e[0], e[1]]);
        } else {
          const name = dyn(base + r.int(3))[0];
          fields.push([name, r.str(7)]);
        }
      }
      if (ric > 0) {
        const out: number[] = [];
        writeInt(out, 7, 0x80, streamId);
        this.acked = Math.max(this.acked, ric);
        this.sendDecoderStream(Buffer.from(out));
      }
      return { fields, requiredInsertCount: ric };
    } catch (e) {
      if (e instanceof Incomplete) throw new QpackError(DECOMPRESSION_FAILED, 'truncated field section');
      throw e;
    }
  }
}
