/**
 * A schemaless protobuf wire-format reader, and gRPC message framing. Without
 * a .proto you cannot name the fields, but the wire format carries each
 * field's number and type, so the raw shape is recoverable: this turns an
 * opaque protobuf or gRPC body into a tree of {field, type, value} so it can
 * be read in the Inspector and searched. Length-delimited fields are decoded
 * as a nested message when they parse cleanly, otherwise as text or bytes.
 *
 * No Node imports, so the renderer can use it directly.
 */

import type { Codec } from './index.js';

const dec = new TextDecoder('utf-8', { fatal: true });

export type ProtoWire = 'varint' | 'i64' | 'len' | 'i32' | 'group';

export interface ProtoField {
  field: number;
  wire: ProtoWire;
  value: ProtoValue;
}

export type ProtoValue =
  | { kind: 'varint'; int: string; signed: string; bool: boolean }
  | { kind: 'i64'; hex: string; double: number; int: string }
  | { kind: 'i32'; hex: string; float: number; int: number }
  | { kind: 'string'; text: string }
  | { kind: 'bytes'; hex: string; length: number }
  | { kind: 'message'; fields: ProtoField[] }
  | { kind: 'packed'; items: ProtoValue[] };

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array) {}
  get done(): boolean {
    return this.pos >= this.b.length;
  }
  /** A base-128 varint, as a BigInt so 64-bit values survive. */
  varint(): bigint {
    let shift = 0n;
    let out = 0n;
    for (;;) {
      if (this.pos >= this.b.length) throw new Error('truncated varint');
      const byte = this.b[this.pos++]!;
      out |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return out;
      shift += 7n;
      if (shift > 70n) throw new Error('varint too long');
    }
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.b.length) throw new Error('truncated field');
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** ZigZag decode, for sint32/sint64 display. */
const zigzag = (v: bigint): bigint => (v >> 1n) ^ -(v & 1n);

const asFixed64 = (b: Uint8Array): ProtoValue => {
  const dv = new DataView(b.buffer, b.byteOffset, 8);
  return { kind: 'i64', hex: toHex(b), double: dv.getFloat64(0, true), int: dv.getBigUint64(0, true).toString() };
};

const asFixed32 = (b: Uint8Array): ProtoValue => {
  const dv = new DataView(b.buffer, b.byteOffset, 4);
  return { kind: 'i32', hex: toHex(b), float: dv.getFloat32(0, true), int: dv.getUint32(0, true) };
};

/** True when a byte run parses as a complete protobuf message (used to decide nesting). */
function looksLikeMessage(b: Uint8Array): boolean {
  if (b.length === 0) return false;
  try {
    const fields = readMessage(b, 0);
    return fields.length > 0;
  } catch {
    return false;
  }
}

function interpretLen(b: Uint8Array): ProtoValue {
  if (b.length === 0) return { kind: 'string', text: '' };
  if (looksLikeMessage(b)) return { kind: 'message', fields: readMessage(b) };
  try {
    const text = dec.decode(b);
    // Printable-ish: no control characters other than tab/newline/return.
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(text)) return { kind: 'string', text };
  } catch {
    /* not utf-8 */
  }
  return { kind: 'bytes', hex: toHex(b), length: b.length };
}

function readMessage(b: Uint8Array, depth = 0): ProtoField[] {
  if (depth > 100) throw new Error('nested too deep');
  const r = new Reader(b);
  const out: ProtoField[] = [];
  while (!r.done) {
    const tag = r.varint();
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field === 0) throw new Error('field 0 is invalid');
    if (wire === 0) {
      const v = r.varint();
      out.push({ field, wire: 'varint', value: { kind: 'varint', int: v.toString(), signed: zigzag(v).toString(), bool: v === 1n } });
    } else if (wire === 1) {
      out.push({ field, wire: 'i64', value: asFixed64(r.bytes(8)) });
    } else if (wire === 2) {
      const len = Number(r.varint());
      out.push({ field, wire: 'len', value: interpretLen(r.bytes(len).slice()) });
    } else if (wire === 5) {
      out.push({ field, wire: 'i32', value: asFixed32(r.bytes(4)) });
    } else if (wire === 3 || wire === 4) {
      // Groups are deprecated; skip a start group by scanning to its end.
      if (wire === 4) throw new Error('unexpected end-group');
      const start = field;
      const inner: ProtoField[] = [];
      for (;;) {
        if (r.done) throw new Error('unterminated group');
        const t2 = r.varint();
        const f2 = Number(t2 >> 3n);
        const w2 = Number(t2 & 7n);
        if (w2 === 4) {
          if (f2 !== start) throw new Error('mismatched end-group');
          break;
        }
        inner.push(...readOne(r, f2, w2, depth));
      }
      out.push({ field, wire: 'group', value: { kind: 'message', fields: inner } });
    } else {
      throw new Error(`unknown wire type ${wire}`);
    }
  }
  return out;
}

function readOne(r: Reader, field: number, wire: number, depth: number): ProtoField[] {
  if (wire === 0) {
    const v = r.varint();
    return [{ field, wire: 'varint', value: { kind: 'varint', int: v.toString(), signed: zigzag(v).toString(), bool: v === 1n } }];
  }
  if (wire === 1) return [{ field, wire: 'i64', value: asFixed64(r.bytes(8)) }];
  if (wire === 2) {
    const len = Number(r.varint());
    return [{ field, wire: 'len', value: interpretLen(r.bytes(len).slice()) }];
  }
  if (wire === 5) return [{ field, wire: 'i32', value: asFixed32(r.bytes(4)) }];
  throw new Error(`unhandled wire type ${wire} in group`);
}

/** Parse a protobuf message without a schema into a field tree. */
export function decodeProtobuf(b: Uint8Array): ProtoField[] {
  return readMessage(b);
}

export interface GrpcMessage {
  compressed: boolean;
  length: number;
  fields: ProtoField[];
}

/**
 * Parse one or more gRPC-framed messages: a 1-byte compression flag and a
 * 4-byte big-endian length prefix each. A compressed message is reported but
 * not inflated (the codec cannot know the algorithm without the header).
 */
export function decodeGrpc(b: Uint8Array): GrpcMessage[] {
  const out: GrpcMessage[] = [];
  let pos = 0;
  while (pos + 5 <= b.length) {
    const compressed = b[pos]! === 1;
    const dv = new DataView(b.buffer, b.byteOffset + pos + 1, 4);
    const length = dv.getUint32(0, false);
    pos += 5;
    if (pos + length > b.length) throw new Error('truncated gRPC frame');
    const body = b.subarray(pos, pos + length);
    pos += length;
    out.push({ compressed, length, fields: compressed ? [] : decodeProtobuf(body.slice()) });
  }
  if (pos !== b.length) throw new Error('trailing bytes after gRPC frames');
  return out;
}

export const PROTOBUF_CODEC_DEFS: Codec[] = [
  {
    id: 'protobuf',
    label: 'Protobuf (schemaless)',
    terminal: true,
    decode: (b) => decodeProtobuf(b),
    encode: () => {
      throw new Error('protobuf is decode-only without a schema');
    },
  },
  {
    id: 'grpc',
    label: 'gRPC frames',
    terminal: true,
    decode: (b) => decodeGrpc(b),
    encode: () => {
      throw new Error('gRPC is decode-only without a schema');
    },
  },
];

export const PROTOBUF_CODECS = PROTOBUF_CODEC_DEFS.map((c) => c.id);
