import { describe, expect, it } from 'vitest';
import {
  bytesToString,
  decodeChain,
  decodeContentEncoding,
  encodeChain,
  getCodec,
  looksLikeText,
  parseChain,
  transformChain,
} from '@siteinquisition/codecs';
import { gzipSync, brotliCompressSync } from 'node:zlib';

describe('codec chains', () => {
  const payload = { user: 'nick', admin: false, n: 3 };
  const wrapped = encodeURIComponent(gzipSync(JSON.stringify(payload)).toString('base64'));

  it('decodes url > base64 > gzip > json', () => {
    expect(decodeChain('url>base64>gzip>json', wrapped)).toEqual(payload);
  });

  it('round-trips an edit through the whole chain', () => {
    const out = transformChain('url>base64>gzip>json', wrapped, (v) => ({ ...(v as object), admin: true }));
    expect(decodeChain('url>base64>gzip>json', out)).toEqual({ ...payload, admin: true });
  });

  it('rejects a terminal codec that is not last', () => {
    expect(() => parseChain('json>base64')).toThrow(/must be last/);
  });

  it('rejects unknown codecs', () => {
    expect(() => parseChain('rot13')).toThrow(/unknown codec/);
  });

  it.each(['base64', 'base64url', 'hex', 'url', 'gzip', 'deflate', 'br'])('%s round-trips arbitrary text', (id) => {
    const input = 'héllo wörld / ?&= \u{1F600}';
    const c = getCodec(id);
    expect(bytesToString(c.decode(c.encode(input)) as Uint8Array)).toBe(input);
  });

  it('encodeChain is the inverse of decodeChain', () => {
    const bytes = encodeChain(['base64', 'json'], [1, 2, 3]);
    expect(bytesToString(bytes)).toBe(Buffer.from('[1,2,3]').toString('base64'));
  });
});

describe('content encoding', () => {
  const body = Buffer.from('<html>hello</html>');
  it('handles stacked encodings in header order', () => {
    const stacked = brotliCompressSync(gzipSync(body));
    expect(bytesToString(decodeContentEncoding(stacked, 'gzip, br')!)).toBe('<html>hello</html>');
  });
  it('returns undefined for corrupt data or unknown encodings', () => {
    expect(decodeContentEncoding(body, 'gzip')).toBeUndefined();
    expect(decodeContentEncoding(body, 'compress')).toBeUndefined();
  });
  it('passes identity bodies through', () => {
    expect(decodeContentEncoding(body, undefined)).toBe(body);
    expect(decodeContentEncoding(body, 'identity')).toEqual(body);
  });
});

describe('looksLikeText', () => {
  it('spots binary', () => {
    expect(looksLikeText(Buffer.from('{"a":1}'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))).toBe(false);
  });
});
