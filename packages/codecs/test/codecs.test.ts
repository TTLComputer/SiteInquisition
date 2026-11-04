import { describe, expect, it } from '@siteinquisition/devkit/test';
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
import { detectChain, replaceThroughChain } from '@siteinquisition/codecs';
import * as jp from '../src/jsonpath';
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

describe('detectChain', () => {
  const wrap = (v: unknown) => encodeURIComponent(Buffer.from(gzipSync(JSON.stringify(v))).toString('base64'));
  it('unwraps url > base64 > gzip > json', () => {
    expect(detectChain(wrap({ cart: 42 }))).toEqual(['url', 'base64', 'gzip', 'json']);
  });
  it('spots JWTs, hex, base64url and form bodies', () => {
    const jwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"sub":"nick"}').toString('base64url')}.sig`;
    expect(detectChain(jwt)).toEqual(['jwt']);
    expect(decodeChain('jwt', jwt)).toEqual({ header: { alg: 'HS256' }, payload: { sub: 'nick' }, signature: 'sig' });
    expect(detectChain(Buffer.from('{"abc":123}').toString('hex'))).toEqual(['hex', 'json']);
    expect(detectChain('a=1&b=two')).toEqual(['form']);
    expect(decodeChain('form', 'a=1&a=2&b=x%20y')).toEqual({ a: ['1', '2'], b: 'x y' });
  });
  it('leaves plain words and binary alone', () => {
    expect(detectChain('hello world')).toEqual([]);
    expect(detectChain('password')).toEqual([]);
    expect(detectChain(new Uint8Array([0, 1, 2, 250]))).toEqual([]);
  });
});

describe('replaceThroughChain', () => {
  const chain = 'base64>json';
  const input = Buffer.from(JSON.stringify({ csrf: '3b9a0c11', user: { id: 7, csrfToken: 'x' } })).toString('base64');
  it('replaces values in the innermost layer and re-encodes', () => {
    const r = replaceThroughChain(chain, input, { find: '3b9a0c11', replace: '{{var:csrf}}' });
    expect(decodeChain(chain, r.output)).toEqual({ csrf: '{{var:csrf}}', user: { id: 7, csrfToken: 'x' } });
    expect(r.counts).toEqual([0, 0, 1]);
  });
  it('renames keys only when asked, and replaces whole numbers', () => {
    const r = replaceThroughChain(chain, input, { find: 'csrf', replace: 'xsrf', keys: true, matchCase: true });
    expect(decodeChain(chain, r.output)).toEqual({ xsrf: '3b9a0c11', user: { id: 7, xsrfToken: 'x' } });
    const n = replaceThroughChain(chain, input, { find: '^7$', replace: '8', regex: true });
    expect((decodeChain(chain, n.output) as { user: { id: number } }).user.id).toBe(8);
  });
  it('with scope "all" also replaces in outer text layers', () => {
    const r = replaceThroughChain('url', 'a%3Db&a=c', { find: 'a', replace: 'z', scope: 'all', matchCase: true });
    expect(new TextDecoder().decode(r.output)).toBe('z%3Db%26z%3Dc');
    expect(r.counts[1]).toBe(2);
  });
});

describe('jsonpath', () => {
  const doc = { user: { id: 7, admin: false, name: 'n' }, items: [{ sku: 'A1', qty: 1, price: 5 }, { sku: 'B2', qty: 3, price: '9' }], 'odd key': true };
  it('queries keys, indexes, wildcards, recursion and filters', () => {
    expect(jp.query(doc, '$.user.id').map((m) => m.value)).toEqual([7]);
    expect(jp.query(doc, "$['odd key']").map((m) => m.value)).toEqual([true]);
    expect(jp.query(doc, '$.items[-1].sku').map((m) => m.value)).toEqual(['B2']);
    expect(jp.query(doc, '$.items[*].price').map((m) => m.value)).toEqual([5, '9']);
    expect(jp.query(doc, '$..sku').map((m) => jp.formatPath(m.path))).toEqual(['$.items[0].sku', '$.items[1].sku']);
    expect(jp.query(doc, '$.items[?(@.qty>1)].sku').map((m) => m.value)).toEqual(['B2']);
    expect(jp.query(doc, "$.items[?(@.sku=='A1')].qty").map((m) => m.value)).toEqual([1]);
  });
  it('runs bulk operations without touching the input', () => {
    expect((jp.bulk(doc, '$.items[*].qty', 'increment', 2).value as typeof doc).items.map((i) => i.qty)).toEqual([3, 5]);
    expect((jp.bulk(doc, '$.items[*].price', 'swap-type').value as typeof doc).items.map((i) => i.price)).toEqual(['5', 9]);
    expect((jp.bulk(doc, '$.user.admin', 'flip').value as typeof doc).user.admin).toBe(true);
    expect((jp.bulk(doc, '$.items', 'append', { sku: 'C3' }).value as typeof doc).items).toHaveLength(3);
    expect((jp.bulk(doc, '$.items[0]', 'delete').value as typeof doc).items.map((i) => i.sku)).toEqual(['B2']);
    expect(jp.bulk(doc, '$..id', 'set', '{{var:uid}}')).toMatchObject({ count: 1, value: { user: { id: '{{var:uid}}' } } });
    expect(doc.user.admin).toBe(false);
  });
});
