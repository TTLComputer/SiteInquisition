import { describe, expect, it } from '@siteinquisition/devkit/test';
import { FrameReader, encodeFrame, parseFrame, serializeFrame, describeFrame, H2Error, type Frame } from '../src/h2/frames.js';
import { HpackDecoder, HpackEncoder, type Field } from '../src/h2/hpack.js';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// RFC 7541 appendix C.3 (no Huffman) and C.4 (Huffman): three requests on one connection.
const REQUESTS: Field[][] = [
  [[':method', 'GET'], [':scheme', 'http'], [':path', '/'], [':authority', 'www.example.com']],
  [[':method', 'GET'], [':scheme', 'http'], [':path', '/'], [':authority', 'www.example.com'], ['cache-control', 'no-cache']],
  [[':method', 'GET'], [':scheme', 'https'], [':path', '/index.html'], [':authority', 'www.example.com'], ['custom-key', 'custom-value']],
];
const C3 = ['8286 8441 0f77 7777 2e65 7861 6d70 6c65 2e63 6f6d', '8286 84be 5808 6e6f 2d63 6163 6865', '8287 85bf 400a 6375 7374 6f6d 2d6b 6579 0c63 7573 746f 6d2d 7661 6c75 65'];
const C4 = ['8286 8441 8cf1 e3c2 e5f2 3a6b a0ab 90f4 ff', '8286 84be 5886 a8eb 1064 9cbf', '8287 85bf 4088 25a8 49e9 5ba9 7d7f 8925 a849 e95b b8e8 b4bf'];

// RFC 7541 appendix C.5: three responses with a 256-byte table, so entries are evicted.
const RESPONSES: Field[][] = [
  [[':status', '302'], ['cache-control', 'private'], ['date', 'Mon, 21 Oct 2013 20:13:21 GMT'], ['location', 'https://www.example.com']],
  [[':status', '307'], ['cache-control', 'private'], ['date', 'Mon, 21 Oct 2013 20:13:21 GMT'], ['location', 'https://www.example.com']],
  [[':status', '200'], ['cache-control', 'private'], ['date', 'Mon, 21 Oct 2013 20:13:22 GMT'], ['location', 'https://www.example.com'], ['content-encoding', 'gzip'], ['set-cookie', 'foo=ASDJKHQKBZXOQWEOPIUAXQWEOIU; max-age=3600; version=1']],
];
const C5 = [
  '4803 3330 3258 0770 7269 7661 7465 611d 4d6f 6e2c 2032 3120 4f63 7420 3230 3133 2032 303a 3133 3a32 3120 474d 546e 1768 7474 7073 3a2f 2f77 7777 2e65 7861 6d70 6c65 2e63 6f6d',
  '4803 3330 37c1 c0bf',
  '88c1 611d 4d6f 6e2c 2032 3120 4f63 7420 3230 3133 2032 303a 3133 3a32 3220 474d 54c0 5a04 677a 6970 7738 666f 6f3d 4153 444a 4b48 514b 425a 584f 5157 454f 5049 5541 5851 5745 4f49 553b 206d 6178 2d61 6765 3d33 3630 303b 2076 6572 7369 6f6e 3d31',
];

describe('HPACK', () => {
  it('decodes and encodes the RFC 7541 request examples, with and without Huffman', () => {
    for (const [vectors, huffman] of [[C3, false], [C4, true]] as const) {
      const enc = new HpackEncoder({ huffman });
      const dec = new HpackDecoder();
      REQUESTS.forEach((fields, i) => {
        expect(enc.encode(fields).toString('hex')).toBe(hex(vectors[i]!).toString('hex'));
        expect(dec.decode(hex(vectors[i]!)).fields).toEqual(fields);
      });
    }
  });

  it('evicts entries from a small table (RFC 7541 C.5)', () => {
    const dec = new HpackDecoder();
    dec.setLimit(256);
    const enc = new HpackEncoder({ huffman: false });
    enc.setPeerMax(256);
    // The RFC example assumes both ends start at 256 with no size update on the wire.
    (enc as unknown as { pendingResize: number[] }).pendingResize = [];
    (enc as unknown as { table: { max: number } }).table.max = 256;
    (dec as unknown as { table: { max: number } }).table.max = 256;
    RESPONSES.forEach((fields, i) => {
      expect(dec.decode(hex(C5[i]!)).fields).toEqual(fields);
      expect(enc.encode(fields).toString('hex')).toBe(hex(C5[i]!).toString('hex'));
    });
    expect(dec.tableState.size).toBe(215);
  });

  it('follows the lab policy: never-indexed names, no dynamic table, size updates', () => {
    const enc = new HpackEncoder({ neverIndex: ['authorization'], dynamic: false, huffman: false });
    const dec = new HpackDecoder();
    enc.queueSizeUpdate(0);
    const block = enc.encode([[':method', 'GET'], ['authorization', 'secret'], ['x-a', 'b']]);
    expect(block[0]).toBe(0x20);
    const out = dec.decode(block);
    expect(out.fields).toEqual([[':method', 'GET'], ['authorization', 'secret'], ['x-a', 'b']]);
    expect(out.reps).toEqual(['indexed', 'never-indexed', 'literal']);
    expect(dec.tableState.size).toBe(0);
  });

  it('refuses bad blocks with COMPRESSION_ERROR', () => {
    const dec = new HpackDecoder();
    for (const bad of ['80', 'ff00', '41', '3fe21f'])
      expect(() => dec.decode(hex(bad))).toThrow();
    try {
      new HpackDecoder().decode(hex('be'));
    } catch (err) {
      expect((err as { code: number }).code).toBe(H2Error.COMPRESSION_ERROR);
    }
  });
});

describe('HTTP/2 frames', () => {
  it('round-trips every frame type, padding and priority included', () => {
    const frames: Frame[] = [
      { type: 'DATA', stream: 1, data: Buffer.from('hello'), endStream: true, padding: 3 },
      { type: 'HEADERS', stream: 3, block: Buffer.from([0x82]), endStream: false, endHeaders: true, priority: { exclusive: true, dependsOn: 1, weight: 200 } },
      { type: 'PRIORITY', stream: 5, priority: { exclusive: false, dependsOn: 3, weight: 16 } },
      { type: 'RST_STREAM', stream: 5, code: H2Error.CANCEL },
      { type: 'SETTINGS', ack: false, settings: [[4, 65535], [0x99, 7]] },
      { type: 'SETTINGS', ack: true, settings: [] },
      { type: 'PUSH_PROMISE', stream: 1, promised: 2, block: Buffer.from([0x82]), endHeaders: true },
      { type: 'PING', ack: true, data: Buffer.alloc(8, 7) },
      { type: 'GOAWAY', lastStream: 7, code: H2Error.ENHANCE_YOUR_CALM, debug: Buffer.from('slow down') },
      { type: 'WINDOW_UPDATE', stream: 0, increment: 1000 },
      { type: 'CONTINUATION', stream: 3, block: Buffer.from([1, 2]), endHeaders: false },
      { type: 'UNKNOWN', stream: 9, frameType: 0xfa, flags: 0x3, payload: Buffer.from('grease') },
    ];
    const reader = new FrameReader();
    const wire = Buffer.concat(frames.map((f) => encodeFrame(serializeFrame(f))));
    // Fed a byte at a time, to check frames split across reads.
    const got = [...wire].flatMap((b) => reader.push(Buffer.of(b))).map(parseFrame);
    expect(got).toEqual(frames);
    expect(describeFrame(frames[8]!)).toBe('last 7 ENHANCE_YOUR_CALM "slow down"');
  });

  it('refuses frames the RFC forbids, with the right error', () => {
    const cases: Array<[Parameters<typeof encodeFrame>[0], number]> = [
      [{ type: 0, flags: 0, stream: 0, payload: Buffer.alloc(1) }, H2Error.PROTOCOL_ERROR],
      [{ type: 4, flags: 0, stream: 0, payload: Buffer.alloc(5) }, H2Error.FRAME_SIZE_ERROR],
      [{ type: 6, flags: 0, stream: 0, payload: Buffer.alloc(4) }, H2Error.FRAME_SIZE_ERROR],
      [{ type: 0, flags: 0x8, stream: 1, payload: Buffer.of(9, 1, 2) }, H2Error.PROTOCOL_ERROR],
    ];
    for (const [raw, code] of cases) {
      let caught: { code?: number } | undefined;
      try {
        parseFrame(raw);
      } catch (err) {
        caught = err as { code?: number };
      }
      expect(caught?.code).toBe(code);
    }
  });
});
