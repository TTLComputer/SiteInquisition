import { describe, expect, it } from '@siteinquisition/devkit/test';
import { buildMultipart, buildPairs, decodeValue, encodeValue, parseCurl, parseMultipart, parseMultipartBytes, parsePairs, queryRows, shellWords, withQueryRows, base64Utf8, unbase64Utf8 } from '@siteinquisition/codecs';

describe('shellWords', () => {
  it('handles bash quoting, $-strings and line continuations', () => {
    expect(shellWords(`curl 'a b' "c \\"d\\"" e\\ f \\\n  $'g\\nh' i'j'"k"`)).toEqual(['curl', 'a b', 'c "d"', 'e f', 'g\nh', 'ijk']);
  });
  it('handles Chrome "Copy as cURL (cmd)" carets', () => {
    const cmd = 'curl ^"https://x.test/api?a=1^&b=2^" ^\n  -H ^"content-type: application/json^" ^\n  --data-raw ^"^{^\\^"a^\\^":1^}^"';
    expect(shellWords(cmd)).toEqual(['curl', 'https://x.test/api?a=1&b=2', '-H', 'content-type: application/json', '--data-raw', '{"a":1}']);
  });
  it('handles PowerShell backtick continuations', () => {
    expect(shellWords('curl.exe https://x.test `\n -k')).toEqual(['curl.exe', 'https://x.test', '-k']);
  });
});

describe('parseCurl', () => {
  it('imports what Chrome copies', () => {
    const r = parseCurl(`curl 'https://shop.test/api/cart' \\
  -H 'accept: application/json' \\
  -H 'cookie: session=abc; cart=42' \\
  --data-raw '{"sku":"A1","qty":2}' \\
  --compressed`);
    expect(r.method).toBe('POST');
    expect(r.url).toBe('https://shop.test/api/cart');
    expect(r.headers).toEqual([
      ['accept', 'application/json'],
      ['cookie', 'session=abc; cart=42'],
      ['Content-Type', 'application/x-www-form-urlencoded'],
    ]);
    expect(r.body).toBe('{"sku":"A1","qty":2}');
    expect(r.warnings).toEqual([]);
  });
  it('maps -X, -u, -A, -e, -b, -k, -L, --http2 and bundled short flags', () => {
    const r = parseCurl(`curl -sSLk -XPUT -u nick:pa:ss -A ua/1 -e https://ref.test -b 'a=1' --http2 example.test/x`);
    expect(r.method).toBe('PUT');
    expect(r.url).toBe('http://example.test/x');
    expect(r.headers).toEqual([
      ['Authorization', `Basic ${base64Utf8('nick:pa:ss')}`],
      ['User-Agent', 'ua/1'],
      ['Referer', 'https://ref.test'],
      ['Cookie', 'a=1'],
    ]);
    expect(r.options).toEqual({ followRedirects: true, insecure: true, protocol: 'h2' });
  });
  it('turns -G data into the query, and --data-urlencode encodes', () => {
    const r = parseCurl(`curl -G https://x.test/s?x=1 -d q=hello --data-urlencode 'name=a b&c'`);
    expect(r.method).toBe('GET');
    expect(r.url).toBe('https://x.test/s?x=1&q=hello&name=a+b%26c');
    expect(r.body).toBe('');
  });
  it('--json sets the content type and accept', () => {
    const r = parseCurl(`curl --json '{"a":1}' https://x.test/`);
    expect(r.headers).toEqual([
      ['Content-Type', 'application/json'],
      ['Accept', 'application/json'],
    ]);
  });
  it('builds multipart from -F, with files as {{file:path}} tokens', () => {
    const r = parseCurl(`curl -F name=nick -F 'avatar=@/home/me/pic.png' -F 'doc=@./a.bin;type=application/x-thing;filename=x.bin' -F 'note=<notes.txt' https://x.test/up`);
    expect(r.method).toBe('POST');
    expect(r.files).toEqual(['/home/me/pic.png', './a.bin', 'notes.txt']);
    const ct = r.headers.find(([k]) => k === 'Content-Type')![1];
    const boundary = /boundary=(\S+)/.exec(ct)![1]!;
    const parts = parseMultipart(r.body, boundary)!;
    expect(parts).toEqual([
      { name: 'name', value: 'nick' },
      { name: 'avatar', filename: 'pic.png', contentType: 'image/png', value: '{{file:/home/me/pic.png}}' },
      { name: 'doc', filename: 'x.bin', contentType: 'application/x-thing', value: '{{file:./a.bin}}' },
      { name: 'note', value: '{{file:notes.txt}}' },
    ]);
  });
  it('-T uploads a file with PUT, and @file data becomes a file token', () => {
    expect(parseCurl('curl -T ./photo.jpg https://x.test/files/')).toMatchObject({ method: 'PUT', url: 'https://x.test/files/photo.jpg', body: '{{file:./photo.jpg}}', files: ['./photo.jpg'] });
    expect(parseCurl('curl --data-binary @body.bin https://x.test/')).toMatchObject({ body: '{{file:body.bin}}', files: ['body.bin'] });
  });
  it('lists what it leaves out', () => {
    const r = parseCurl('curl --cert me.pem -x http://proxy:8080 --frobnicate https://x.test/');
    expect(r.warnings.length).toBe(3);
    expect(() => parseCurl('wget https://x')).toThrow(/curl/);
    expect(() => parseCurl('curl -k')).toThrow(/URL/);
  });
});

describe('rows', () => {
  it('keeps unedited query rows byte for byte, however they were encoded', () => {
    const url = 'https://x.test/p?a=%2541&b=x+y&flag&c=%E2%9C%93&{{var:k}}=v#frag';
    const rows = queryRows(url);
    expect(rows.map((r) => [r.name, r.value, !!r.bare])).toEqual([
      ['a', '%41', false],
      ['b', 'x y', false],
      ['', 'flag', true],
      ['c', '✓', false],
      ['{{var:k}}', 'v', false],
    ]);
    expect(withQueryRows(url, rows)).toBe(url);
    rows[1]!.value = 'x & y';
    rows.push({ name: 'id', value: '{{counter:1..3}}' });
    expect(withQueryRows(url, rows)).toBe('https://x.test/p?a=%2541&b=x%20%26%20y&flag&c=%E2%9C%93&{{var:k}}=v&id={{counter:1..3}}#frag');
  });
  it('splits a Cookie header without decoding it', () => {
    const rows = parsePairs('session=eyJhIjoxfQ%3D%3D; theme=dark', 'cookie');
    expect(rows.map((r) => [r.name, r.value])).toEqual([
      ['session', 'eyJhIjoxfQ%3D%3D'],
      ['theme', 'dark'],
    ]);
    rows[1]!.value = 'light';
    expect(buildPairs(rows, 'cookie')).toBe('session=eyJhIjoxfQ%3D%3D; theme=light');
  });
  it('form bodies use + for spaces', () => {
    expect(buildPairs([{ name: 'q', value: 'a b' }], 'form')).toBe('q=a+b');
  });
});

describe('multipart', () => {
  it('round-trips parts', () => {
    const parts = [{ name: 'a', value: 'line 1\nline 2' }, { name: 'f', filename: 'x "1".png', contentType: 'image/png', value: '{{file:x.png}}' }];
    const body = buildMultipart(parts, 'BOUND');
    expect(parseMultipart(body, 'BOUND')).toEqual([{ name: 'a', value: 'line 1\nline 2' }, { name: 'f', filename: 'x "1".png', contentType: 'image/png', value: '{{file:x.png}}' }]);
  });
  it('takes a captured body apart into text fields and binary files', () => {
    const enc = new TextEncoder();
    const bin = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xff]);
    const body = new Uint8Array([
      ...enc.encode('--B\r\nContent-Disposition: form-data; name="title"\r\n\r\nhello\r\n--B\r\nContent-Disposition: form-data; name="pic"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n'),
      ...bin,
      ...enc.encode('\r\n--B--\r\n'),
    ]);
    const parts = parseMultipartBytes(body, 'B')!;
    expect(parts[0]).toEqual({ name: 'title', text: 'hello' });
    expect(parts[1]!.filename).toBe('p.png');
    expect([...parts[1]!.bytes!]).toEqual([...bin]);
  });
});

describe('decodeValue', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  it('opens a value encoded oddly, and an untouched one goes back exactly', () => {
    const inner = { user: 'nick', meta: encodeURIComponent(JSON.stringify({ role: 'tester' })) };
    const value = encodeURIComponent(b64(JSON.stringify(inner)));
    const d = decodeValue(value)!;
    expect(d.chain).toEqual(['url', 'base64', 'json']);
    expect(d.kind).toBe('json');
    // The url-encoded JSON field inside is opened up too.
    expect(JSON.parse(d.display)).toEqual({ user: 'nick', meta: { role: 'tester' } });
    expect(encodeValue(d, d.display)).toBe(value);
    const edited = encodeValue(d, JSON.stringify({ user: 'nick', meta: { role: 'admin' } }));
    const back = JSON.parse(Buffer.from(decodeURIComponent(edited), 'base64').toString()) as { meta: string };
    expect(JSON.parse(decodeURIComponent(back.meta))).toEqual({ role: 'admin' });
  });
  it('form fields under base64 come back as form text for rows', () => {
    const d = decodeValue(b64('a=1&b=two'))!;
    expect(d).toMatchObject({ kind: 'form', display: 'a=1&b=two' });
    expect(Buffer.from(encodeValue(d, 'a=1&b=three'), 'base64').toString()).toBe('a=1&b=three');
  });
  it('text under layers, and plain values left alone', () => {
    const d = decodeValue(b64('just some text here'))!;
    expect(d).toMatchObject({ kind: 'text', display: 'just some text here', chain: ['base64'] });
    expect(decodeValue('hello')).toBe(null);
    expect(decodeValue('{{var:x}}')).toBe(null);
  });
  it('base64 helpers', () => {
    expect(unbase64Utf8(base64Utf8('nick:✓'))).toBe('nick:✓');
    expect(unbase64Utf8('%%%')).toBe(null);
  });
});
