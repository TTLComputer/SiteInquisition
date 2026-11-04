import { describe, expect, it } from '@siteinquisition/devkit/test';
import { decodeChain, decodeGrpc, decodeProtobuf, getCodec, listCodecs } from '@siteinquisition/codecs';

const bytes = (...xs: number[]) => Uint8Array.from(xs);

describe('Schemaless protobuf', () => {
  it('reads varints, strings and nested messages', () => {
    // field 1 = varint 150, field 2 = "testing", field 3 = { field 1 = varint 42 }
    const msg = bytes(0x08, 0x96, 0x01, 0x12, 0x07, 0x74, 0x65, 0x73, 0x74, 0x69, 0x6e, 0x67, 0x1a, 0x02, 0x08, 0x2a);
    const fields = decodeProtobuf(msg);
    expect(fields[0]).toMatchObject({ field: 1, wire: 'varint', value: { kind: 'varint', int: '150' } });
    expect(fields[1]).toMatchObject({ field: 2, wire: 'len', value: { kind: 'string', text: 'testing' } });
    expect(fields[2]!.field).toBe(3);
    expect(fields[2]!.value).toMatchObject({ kind: 'message', fields: [{ field: 1, value: { int: '42' } }] });
  });

  it('keeps large varints exact and exposes the zigzag reading', () => {
    // field 1 = varint for -1 as sint (zigzag of 1) → raw 1, signed -1
    const f = decodeProtobuf(bytes(0x08, 0x01))[0]!;
    expect(f.value).toMatchObject({ kind: 'varint', int: '1', signed: '-1', bool: true });
    // A 64-bit value beyond Number.MAX_SAFE_INTEGER stays exact as a string.
    const big = decodeProtobuf(bytes(0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f))[0]!;
    expect(big.value).toMatchObject({ kind: 'varint', int: '9223372036854775807' });
  });

  it('decodes fixed32 and fixed64 fields', () => {
    // field 5 i32 = 1.0 float little-endian 00 00 80 3f
    const i32 = decodeProtobuf(bytes(0x2d, 0x00, 0x00, 0x80, 0x3f))[0]!;
    expect(i32).toMatchObject({ field: 5, wire: 'i32', value: { kind: 'i32', float: 1 } });
    // field 6 i64 double 1.0 = 00 00 00 00 00 00 f0 3f
    const i64 = decodeProtobuf(bytes(0x31, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f))[0]!;
    expect(i64).toMatchObject({ field: 6, wire: 'i64', value: { kind: 'i64', double: 1 } });
  });

  it('falls back to bytes for binary length-delimited data', () => {
    // field 1 len = 3 bytes of control characters (not a message, not text)
    const f = decodeProtobuf(bytes(0x0a, 0x03, 0x01, 0x02, 0x03))[0]!;
    expect(f.value).toMatchObject({ kind: 'bytes', hex: '010203', length: 3 });
  });

  it('is available as a codec and rejects re-encoding', () => {
    expect(listCodecs().some((c) => c.id === 'protobuf')).toBe(true);
    expect((decodeChain(['protobuf'], bytes(0x08, 0x96, 0x01)) as Array<{ field: number }>)[0]!.field).toBe(1);
    expect(() => getCodec('protobuf').encode({})).toThrow(/decode-only/);
  });
});

describe('gRPC framing', () => {
  it('splits length-prefixed frames and decodes each message', () => {
    // flag 0, length 3, message (field 1 = 150); then flag 0, length 2, (field 1 = 42)
    const framed = bytes(0x00, 0x00, 0x00, 0x00, 0x03, 0x08, 0x96, 0x01, 0x00, 0x00, 0x00, 0x00, 0x02, 0x08, 0x2a);
    const msgs = decodeGrpc(framed);
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toMatchObject({ compressed: false, length: 3 });
    expect(msgs[0]!.fields[0]).toMatchObject({ field: 1, value: { int: '150' } });
    expect(msgs[1]!.fields[0]).toMatchObject({ field: 1, value: { int: '42' } });
  });

  it('reports a compressed frame without inflating it', () => {
    const framed = bytes(0x01, 0x00, 0x00, 0x00, 0x02, 0xde, 0xad);
    const msgs = decodeGrpc(framed);
    expect(msgs[0]).toMatchObject({ compressed: true, length: 2, fields: [] });
  });
});
