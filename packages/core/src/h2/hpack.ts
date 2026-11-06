/**
 * HPACK (RFC 7541): the header compression HTTP/2 uses. The encoder takes a
 * policy so the protocol lab can send what a normal client would not (no
 * Huffman, no indexing, never-indexed names, table size updates mid-stream);
 * the decoder enforces the table size it advertised and reports what each
 * field was sent as, for the frame log.
 */
import { huffmanDecode, huffmanEncode, huffmanLength } from '../quic/huffman.js';

export type Field = [name: string, value: string];

/** RFC 7541 appendix A. Index 1 is the first entry. */
export const STATIC_TABLE: readonly Field[] = [
  [':authority', ''], [':method', 'GET'], [':method', 'POST'], [':path', '/'], [':path', '/index.html'], [':scheme', 'http'], [':scheme', 'https'],
  [':status', '200'], [':status', '204'], [':status', '206'], [':status', '304'], [':status', '400'], [':status', '404'], [':status', '500'],
  ['accept-charset', ''], ['accept-encoding', 'gzip, deflate'], ['accept-language', ''], ['accept-ranges', ''], ['accept', ''],
  ['access-control-allow-origin', ''], ['age', ''], ['allow', ''], ['authorization', ''], ['cache-control', ''], ['content-disposition', ''],
  ['content-encoding', ''], ['content-language', ''], ['content-length', ''], ['content-location', ''], ['content-range', ''], ['content-type', ''],
  ['cookie', ''], ['date', ''], ['etag', ''], ['expect', ''], ['expires', ''], ['from', ''], ['host', ''], ['if-match', ''], ['if-modified-since', ''],
  ['if-none-match', ''], ['if-range', ''], ['if-unmodified-since', ''], ['last-modified', ''], ['link', ''], ['location', ''], ['max-forwards', ''],
  ['proxy-authenticate', ''], ['proxy-authorization', ''], ['range', ''], ['referer', ''], ['refresh', ''], ['retry-after', ''], ['server', ''],
  ['set-cookie', ''], ['strict-transport-security', ''], ['transfer-encoding', ''], ['user-agent', ''], ['vary', ''], ['via', ''], ['www-authenticate', ''],
];

export class HpackError extends Error {
  /** COMPRESSION_ERROR, the connection error HTTP/2 uses for a bad header block. */
  readonly code = 0x9;
}

const entrySize = (f: Field) => Buffer.byteLength(f[0]) + Buffer.byteLength(f[1]) + 32;

class Table {
  entries: Field[] = [];
  size = 0;
  constructor(public max: number) {}
  get(i: number): Field | undefined {
    if (i >= 1 && i <= STATIC_TABLE.length) return STATIC_TABLE[i - 1];
    return this.entries[i - STATIC_TABLE.length - 1];
  }
  insert(f: Field) {
    const s = entrySize(f);
    if (s > this.max) {
      this.entries = [];
      this.size = 0;
      return;
    }
    this.entries.unshift(f);
    this.size += s;
    this.evict();
  }
  resize(max: number) {
    this.max = max;
    this.evict();
  }
  private evict() {
    while (this.size > this.max && this.entries.length) this.size -= entrySize(this.entries.pop()!);
  }
}

/** Prefix integer (RFC 7541 section 5.1). */
function writeInt(out: number[], prefix: number, flags: number, v: number) {
  const max = (1 << prefix) - 1;
  if (v < max) return void out.push(flags | v);
  out.push(flags | max);
  v -= max;
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

export interface HpackPolicy {
  /** Add fields to the dynamic table (default true). */
  dynamic?: boolean;
  /** Huffman for literals: auto (when shorter), always or never. */
  huffman?: boolean | 'auto';
  /** Names sent as never-indexed literals, e.g. authorization and cookie. */
  neverIndex?: string[];
  /** Skip the static table, to send everything as literal names. */
  noStatic?: boolean;
  /** Our dynamic table size, at most the peer's SETTINGS_HEADER_TABLE_SIZE (default that maximum). */
  tableSize?: number;
}

/** How one field went on the wire, for the frame log. */
export type FieldRep = 'indexed' | 'incremental' | 'literal' | 'never-indexed' | 'size-update';

export class HpackEncoder {
  private table = new Table(4096);
  private peerMax = 4096;
  private pendingResize: number[] = [];
  policy: HpackPolicy;

  constructor(policy: HpackPolicy = {}) {
    this.policy = policy;
  }

  /** The peer's SETTINGS_HEADER_TABLE_SIZE changed. */
  setPeerMax(max: number) {
    this.peerMax = max;
    const want = Math.min(this.policy.tableSize ?? max, max);
    if (want !== this.table.max) this.queueSizeUpdate(want);
  }

  /** Put a dynamic table size update at the start of the next block (the lab may send one above the peer's limit on purpose). */
  queueSizeUpdate(size: number) {
    this.pendingResize.push(size);
  }

  get tableState() {
    return { size: this.table.size, max: this.table.max, peerMax: this.peerMax, entries: this.table.entries.length };
  }

  encode(fields: Field[]): Buffer {
    const out: number[] = [];
    for (const s of this.pendingResize) {
      writeInt(out, 5, 0x20, s);
      this.table.resize(Math.min(s, this.peerMax));
    }
    this.pendingResize = [];
    const p = this.policy;
    const never = new Set((p.neverIndex ?? []).map((n) => n.toLowerCase()));
    for (const [name, value] of fields) {
      let full = 0;
      let nameIdx = 0;
      const look = (i: number, f: Field) => {
        if (f[0] !== name) return;
        if (!nameIdx) nameIdx = i;
        if (!full && f[1] === value) full = i;
      };
      if (!p.noStatic) STATIC_TABLE.forEach((f, i) => look(i + 1, f));
      this.table.entries.forEach((f, i) => look(STATIC_TABLE.length + 1 + i, f));
      if (full && !never.has(name)) {
        writeInt(out, 7, 0x80, full);
        continue;
      }
      const n = never.has(name);
      const index = !n && p.dynamic !== false && entrySize([name, value]) <= this.table.max;
      const [prefix, flags] = n ? [4, 0x10] : index ? [6, 0x40] : [4, 0x00];
      writeInt(out, prefix, flags, nameIdx);
      if (!nameIdx) this.str(out, name);
      this.str(out, value);
      if (index) this.table.insert([name, value]);
    }
    return Buffer.from(out);
  }

  private str(out: number[], s: string) {
    const raw = Buffer.from(s, 'latin1');
    const h = this.policy.huffman ?? 'auto';
    const useHuff = h === true || (h === 'auto' && huffmanLength(raw) < raw.length);
    const data = useHuff ? huffmanEncode(raw) : raw;
    writeInt(out, 7, useHuff ? 0x80 : 0, data.length);
    for (const b of data) out.push(b);
  }
}

export interface DecodedBlock {
  fields: Field[];
  reps: FieldRep[];
}

export class HpackDecoder {
  private table = new Table(4096);
  /** The most our SETTINGS allow; size updates above it are errors. */
  private limit = 4096;

  /** We advertised this SETTINGS_HEADER_TABLE_SIZE. */
  setLimit(max: number) {
    this.limit = max;
    if (this.table.max > max) this.table.resize(max);
  }

  get tableState() {
    return { size: this.table.size, max: this.table.max, limit: this.limit, entries: this.table.entries.length };
  }

  decode(block: Uint8Array): DecodedBlock {
    const fields: Field[] = [];
    const reps: FieldRep[] = [];
    let p = 0;
    const int = (prefix: number): number => {
      const mask = (1 << prefix) - 1;
      let v = block[p++]! & mask;
      if (v < mask) return v;
      let m = 0;
      let b: number;
      do {
        if (p >= block.length) throw new HpackError('truncated integer');
        b = block[p++]!;
        v += (b & 0x7f) * 2 ** m;
        m += 7;
        if (m > 35) throw new HpackError('integer too large');
      } while (b & 0x80);
      return v;
    };
    const str = (): string => {
      if (p >= block.length) throw new HpackError('truncated string');
      const huff = (block[p]! & 0x80) !== 0;
      const n = int(7);
      if (p + n > block.length) throw new HpackError('truncated string');
      const raw = block.subarray(p, p + n);
      p += n;
      try {
        return Buffer.from(huff ? huffmanDecode(raw) : raw).toString('latin1');
      } catch (err) {
        throw new HpackError((err as Error).message);
      }
    };
    const entry = (i: number): Field => {
      const f = this.table.get(i);
      if (!f) throw new HpackError(`bad index ${i}`);
      return f;
    };
    let fieldSeen = false;
    while (p < block.length) {
      const b = block[p]!;
      if (b & 0x80) {
        const i = int(7);
        if (!i) throw new HpackError('index 0');
        fields.push(entry(i));
        reps.push('indexed');
      } else if (b & 0x40) {
        const i = int(6);
        const f: Field = [i ? entry(i)[0] : str(), str()];
        this.table.insert(f);
        fields.push(f);
        reps.push('incremental');
      } else if (b & 0x20) {
        if (fieldSeen) throw new HpackError('table size update after a field');
        const size = int(5);
        if (size > this.limit) throw new HpackError(`table size update ${size} above our limit ${this.limit}`);
        this.table.resize(size);
        reps.push('size-update');
        continue;
      } else {
        const i = int(4);
        fields.push([i ? entry(i)[0] : str(), str()]);
        reps.push(b & 0x10 ? 'never-indexed' : 'literal');
      }
      fieldSeen = true;
    }
    return { fields, reps: reps.filter((r) => r !== 'size-update') };
  }
}
