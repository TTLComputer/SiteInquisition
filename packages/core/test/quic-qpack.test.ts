import { describe, expect, it } from '@siteinquisition/devkit/test';
import { huffmanDecode, huffmanEncode } from '../src/quic/huffman.js';
import { QpackDecoder, QpackEncoder, STATIC_TABLE, type Field } from '../src/quic/qpack.js';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('Huffman (RFC 7541 appendix C)', () => {
  const cases: Array<[string, string]> = [
    ['www.example.com', 'f1e3 c2e5 f23a 6ba0 ab90 f4ff'],
    ['no-cache', 'a8eb 1064 9cbf'],
    ['custom-key', '25a8 49e9 5ba9 7d7f'],
    ['custom-value', '25a8 49e9 5bb8 e8b4 bf'],
    ['302', '6402'],
    ['private', 'aec3 771a 4b'],
    ['Mon, 21 Oct 2013 20:13:21 GMT', 'd07a be94 1054 d444 a820 0595 040b 8166 e082 a62d 1bff'],
    ['https://www.example.com', '9d29 ad17 1863 c78f 0b97 c8e9 ae82 ae43 d3'],
    ['foo=ASDJKHQKBZXOQWEOPIUAXQWEOIU; max-age=3600; version=1', '94e7 821d d7f2 e6c7 b335 dfdf cd5b 3960 d5af 2708 7f36 72c1 ab27 0fb5 291f 9587 3160 65c0 03ed 4ee5 b106 3d50 07'],
  ];
  it('encodes and decodes the RFC examples', () => {
    for (const [text, h] of cases) {
      expect(huffmanEncode(Buffer.from(text)).toString('hex')).toBe(hex(h).toString('hex'));
      expect(huffmanDecode(hex(h)).toString()).toBe(text);
    }
  });
  it('round-trips every byte value and rejects bad padding', () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    expect(huffmanDecode(huffmanEncode(all)).equals(all)).toBe(true);
    expect(() => huffmanDecode(Buffer.from([0x00]))).toThrow(/padding/);
  });
});

describe('QPACK', () => {
  it('has the 99-entry static table', () => {
    expect(STATIC_TABLE).toHaveLength(99);
    expect(STATIC_TABLE[17]).toEqual([':method', 'GET']);
    expect(STATIC_TABLE[98]).toEqual(['x-frame-options', 'sameorigin']);
  });

  function pair(policy = {}, cap = 4096, blocked = 16) {
    const toDecoder: Buffer[] = [];
    const toEncoder: Buffer[] = [];
    const enc = new QpackEncoder((b) => toDecoder.push(b), policy);
    const dec = new QpackDecoder(cap, blocked, (b) => toEncoder.push(b));
    enc.peerSettings(cap, blocked);
    return {
      enc,
      dec,
      flushEncoder: () => toDecoder.splice(0).forEach((b) => dec.encoderStream(b)),
      flushDecoder: () => toEncoder.splice(0).forEach((b) => enc.decoderStream(b)),
      pendingEncoder: () => toDecoder.length,
    };
  }
  const headers: Field[] = [
    [':method', 'GET'],
    [':scheme', 'https'],
    [':authority', 'api.example.test'],
    [':path', '/v1/cart?x=1'],
    ['user-agent', 'SiteInquisition'],
    ['x-request-id', 'abc123'],
    ['authorization', 'Bearer secret'],
  ];

  it('round-trips with static references only', async () => {
    const p = pair({ dynamic: false });
    const out = await p.dec.decode(0, p.enc.encode(0, headers));
    expect(out.fields).toEqual(headers);
    expect(out.requiredInsertCount).toBe(0);
  });

  it('uses the dynamic table, blocks until inserts arrive, then reuses entries', async () => {
    const p = pair();
    const first = p.enc.encode(0, headers);
    const pending = p.dec.decode(0, first);
    let done = false;
    void pending.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    expect(p.dec.stats.blocked).toBe(1);
    p.flushEncoder();
    const out = await pending;
    expect(out.fields).toEqual(headers);
    expect(out.blocked).toBe(true);
    p.flushDecoder();
    const second = p.enc.encode(4, headers);
    expect(second.length).toBeLessThanOrEqual(first.length);
    expect(p.pendingEncoder()).toBe(0);
    expect((await p.dec.decode(4, second)).fields).toEqual(headers);
  });

  it('never blocks when blocking is off', async () => {
    const p = pair({ allowBlocking: false });
    const first = p.enc.encode(0, headers);
    const out = await p.dec.decode(0, first);
    expect(out.requiredInsertCount).toBe(0);
    p.flushEncoder();
    p.flushDecoder();
    const second = await p.dec.decode(4, p.enc.encode(4, headers));
    expect(second.fields).toEqual(headers);
    expect(second.requiredInsertCount).toBeGreaterThan(0);
  });

  it('evicts under a small table and keeps decoding', async () => {
    const p = pair({}, 256);
    for (let i = 0; i < 50; i++) {
      const h: Field[] = [[':method', 'GET'], ['x-n', `value-${i}`], ['x-same', 'same']];
      const pr = p.dec.decode(i * 4, p.enc.encode(i * 4, h));
      p.flushEncoder();
      expect((await pr).fields).toEqual(h);
      p.flushDecoder();
    }
    expect(p.dec.stats.size).toBeLessThanOrEqual(256);
  });

  it('rejects a capacity above the maximum', () => {
    const p = pair({}, 100);
    p.enc.setCapacity(4096);
    expect(() => p.flushEncoder()).toThrow(/above our maximum/);
  });
});
