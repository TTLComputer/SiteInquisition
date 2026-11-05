import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { decodeFields, decodeFieldsText, encodeFields, encodeFieldsText, parseFieldSpecs } from '@siteinquisition/codecs';
import { Core, pageCsrfTokens, sharedHostGlob, skipsTlsChecks, upstreamTls } from '@siteinquisition/core';
import { generateSelfSigned } from '../src/x509.js';

let tmp: string;
let core: Core;
let http: Server;
let https: HttpsServer;
let base: string;
let httpsPort: number;
let pageToken = 'page-token-AAAAAAAA1111';
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
let lastPayload: unknown = null;

const handler = (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    switch (url.pathname) {
      case '/app':
        // No framework markers at all: a plain page that hands its token out in a meta tag.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><meta name="csrf-token" content="${pageToken}"/></head><body>app</body></html>`);
      case '/api/save': {
        const ok = req.headers['x-csrf-token'] === pageToken;
        res.writeHead(ok ? 200 : 419, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok }));
      }
      case '/api/order':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'PO-1', status: 'OPEN', items: [{ sku: 'A1', qty: 2 }], blob: b64({ secret: 's3', n: 1 }) }));
      case '/api/order2':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'PO-2', status: 'SHIPPED', blob: b64({ secret: 's4', n: 2 }) }));
      case '/api/echo': {
        try {
          const j = JSON.parse(body) as { payload?: string };
          lastPayload = j.payload ? JSON.parse(Buffer.from(j.payload, 'base64').toString()) : null;
        } catch {
          lastPayload = 'unparsable';
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(body);
      }
      default:
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('hello over tls');
    }
  });
};

const listen = (s: Server | HttpsServer) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-feedback-'));
  http = createServer(handler);
  base = `http://127.0.0.1:${await listen(http)}`;
  // A dev server's certificate: self-signed, and made for "localhost" though we connect to 127.0.0.1.
  const self = generateSelfSigned('localhost');
  https = createHttpsServer({ key: self.key, cert: self.cert }, handler);
  httpsPort = await listen(https);
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd'), api: false });
});

afterAll(async () => {
  await core?.close();
  for (const s of [http, https]) {
    s?.closeAllConnections();
    await new Promise((r) => s?.close(r));
  }
  rmSync(tmp, { recursive: true, force: true });
});

const send = (method: string, path: string, headers: Array<[string, string]> = [], body?: string, opts = {}) =>
  core.tools.sender.send({ method, url: `${base}${path}`, headers, body: body ? new TextEncoder().encode(body) : undefined }, opts);

describe('search and tags', () => {
  it('finds exact exchanges with id:a,b', async () => {
    const a = await send('GET', '/api/order');
    const b = await send('GET', '/api/order2');
    await send('GET', '/other');
    const ids = core.store.search(`id:${a.id},${b.id}`).map((e) => e.id);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
    expect(core.store.search(`-id:${a.id} path:/api/order`).map((e) => e.id)).not.toContain(a.id);
  });

  it('lists tags with counts, so the menu can tell create from move', async () => {
    const a = await send('GET', '/api/order');
    core.tools.moveTag('po', a.id);
    const t = core.store.tagCounts().find((x) => x.tag === 'po');
    expect(t).toEqual({ tag: 'po', count: 1, newestId: a.id });
  });
});

describe('glossary sources', () => {
  it('links each place a field was seen to the requests that carried it', () => {
    const g = core.tools.glossary('127.0.0.1');
    const status = g.find((x) => x.name === 'status')!;
    const where = status.sources.map((s) => s.where);
    expect(where).toContain('GET /api/order $.status');
    expect(where).toContain('GET /api/order2 $.status');
    const src = status.sources.find((s) => s.where === 'GET /api/order $.status')!;
    expect(src.exchangeIds.length).toBe(src.count);
    expect(src.count).toBeGreaterThan(1);
    // Newest first, and every id is a real exchange that has the field.
    const ids = core.store.search('path:/api/order method:GET').filter((e) => e.path === '/api/order').map((e) => e.id);
    expect(src.exchangeIds[0]).toBe(ids[0]);
    expect(src.exchangeIds.every((id) => ids.includes(id))).toBe(true);
    // A field under an array item counts once per exchange, not once per item.
    const sku = g.find((x) => x.name === 'sku')!.sources[0]!;
    expect(new Set(sku.exchangeIds).size).toBe(sku.exchangeIds.length);
  });
});

describe('CSRF tokens in page meta tags', () => {
  it('reads tokens from meta tags and hidden fields, not viewport or csp metas', () => {
    const html = '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="csp-nonce" content="abcdefgh1234"><meta name="csrf-param" content="authenticity_token"><meta name="csrf-token" content="tok-1234567890"/><input type="hidden" name="_csrf" value="hid-1234567890"><input name="q" value="not-a-token-xx">';
    const t = pageCsrfTokens(html);
    expect(t.map((x) => `${x.source.from}:${x.source.name}`)).toEqual(['meta:csrf-token', 'input:_csrf']);
    expect(t[0]!.param).toBe('authenticity_token');
    expect(t[0]!.value).toBe('tok-1234567890');
  });

  it('covers two hosts of one site with a glob, but not unrelated hosts', () => {
    expect(sharedHostGlob('www.example.com', 'api.example.com')).toBe('*.example.com');
    expect(sharedHostGlob('a.example.co.uk', 'b.example.co.uk')).toBe('*.example.co.uk');
    expect(sharedHostGlob('a.co.uk', 'b.co.uk')).toBeUndefined();
    expect(sharedHostGlob('example.com', 'example.org')).toBeUndefined();
  });

  it('finds a meta csrf-token on a site no framework signature knows, and suggests a binding', async () => {
    const page = await send('GET', '/app');
    const found = core.tools.tech.exchangePageTokens(page.id);
    expect(found.length).toBe(1);
    expect(found[0]!.source).toEqual({ from: 'meta', name: 'csrf-token' });
    expect(found[0]!.suggestion!.sinks).toEqual([{ in: 'header', name: 'X-CSRF-Token' }]);
    expect(found[0]!.suggestion!.refreshUrl).toBe(`${base}/app`);
    // The overview lists it too.
    expect(core.tools.tech.overview().csrf.some((t) => t.exchangeId === page.id)).toBe(true);
  });

  it('learns the header requests send the token back in', async () => {
    await send('GET', '/app');
    const post = await send('POST', '/api/save', [['X-CSRF-TOKEN', pageToken], ['Content-Type', 'application/json']], '{}');
    expect(post.status).toBe(200);
    const [t] = core.tools.tech.pageTokens({ host: '127.0.0.1' });
    expect(t!.suggestion!.sinks).toEqual([{ in: 'header', name: 'X-CSRF-TOKEN' }]);
  });

  it('points a request at the page token when the value has rotated, and keeps it fresh on replay', async () => {
    const stale = await send('POST', '/api/save', [['X-CSRF-Token', 'expired-token-value-0'], ['Content-Type', 'application/json']], '{}');
    expect(stale.status).toBe(419);
    const [f] = core.tools.tech.csrfFindings(stale.id);
    expect(f!.how).toBe('page-token');
    expect(f!.source).toEqual({ from: 'meta', name: 'csrf-token' });
    core.tools.tech.setCsrfBindings([...core.tools.tech.csrfBindings(), f!.suggestion!]);
    pageToken = 'page-token-BBBBBBBB2222';
    const res = await send('POST', '/api/save', [['X-CSRF-Token', 'expired-token-value-0'], ['Content-Type', 'application/json']], '{}', { csrf: true });
    expect(res.status).toBe(200);
  });
});

describe('tech overview', () => {
  it('summarizes every technology across hosts with the request that shows it', async () => {
    core.tools.tech.override('127.0.0.1', 'nginx', 'pin');
    const o = core.tools.tech.overview();
    const nginx = o.tech.find((t) => t.id === 'nginx')!;
    expect(nginx.status).toBe('pinned');
    expect(nginx.hosts.map((h) => h.host)).toEqual(['127.0.0.1']);
    expect(o.hosts).toContain('127.0.0.1');
  });
});

describe('field codecs', () => {
  const doc = { id: 1, payload: b64({ user: 'ann', roles: ['a'] }), items: [{ blob: Buffer.from('hi').toString('hex') }, { blob: Buffer.from('yo').toString('hex') }] };
  const specs = [
    { path: '$.payload', chain: ['base64', 'json'] },
    { path: '$.items[*].blob', chain: ['hex'] },
  ];

  it('decodes fields in place and encodes them back to the same bytes', () => {
    const d = decodeFields(doc, specs);
    expect(d.value).toEqual({ id: 1, payload: { user: 'ann', roles: ['a'] }, items: [{ blob: 'hi' }, { blob: 'yo' }] });
    expect(d.counts).toEqual([1, 2]);
    expect(encodeFields(d.value, specs).value).toEqual(doc);
  });

  it('reaches into a decoded field with a later spec', () => {
    const inner = { a: b64({ deep: true }) };
    const outer = { p: b64(inner) };
    const s = [
      { path: '$.p', chain: ['base64', 'json'] },
      { path: '$.p.a', chain: ['base64', 'json'] },
    ];
    const d = decodeFields(outer, s);
    expect(d.value).toEqual({ p: { a: { deep: true } } });
    expect(encodeFields(d.value, s).value).toEqual(outer);
  });

  it('works on text, leaves non-matching bodies alone and reports bad values', () => {
    expect(decodeFieldsText('{"x":1}', specs)).toBeNull();
    expect(decodeFieldsText('not json', specs)).toBeNull();
    const t = decodeFieldsText(JSON.stringify(doc), specs)!;
    expect(JSON.parse(encodeFieldsText(t.text, specs).text)).toEqual(doc);
    expect(decodeFields({ payload: '!!!' }, [{ path: '$.payload', chain: ['base64', 'json'] }]).errors.length).toBe(1);
  });

  it('parses the short form used in Replay', () => {
    expect(parseFieldSpecs('$.payload = base64>json; items[*].blob=hex')).toEqual(specs);
    expect(() => parseFieldSpecs('$.x = nosuchcodec')).toThrow();
    expect(() => parseFieldSpecs('just text')).toThrow(/write it as/);
  });

  it('saves rules per host and path, shows exchanges decoded, and encodes on send', async () => {
    const fc = core.tools.fieldCodecs;
    fc.set([{ host: '127.0.0.1', path: '/api/', side: 'both', field: 'blob', chain: ['base64', 'json'] }]);
    expect(fc.list()[0]!.field).toBe('$.blob');
    expect(fc.rulesFor(`${base}/api/order`, 'response').length).toBe(1);
    expect(fc.rulesFor(`${base}/elsewhere`, 'response').length).toBe(0);
    expect(fc.rulesFor('http://other.host/api/order', 'response').length).toBe(0);
    const ex = await send('GET', '/api/order');
    const shown = fc.decodeExchange(ex.id, 'response')!;
    expect(JSON.parse(shown.text).blob).toEqual({ secret: 's3', n: 1 });
    expect(() => fc.set([{ host: '*', side: 'both', field: '$.x', chain: [] }])).toThrow(/chain/);

    // Replay: the body is written decoded, with a token inside; the field is encoded after tokens are filled in.
    const res = await send('POST', '/api/echo', [['Content-Type', 'application/json']], JSON.stringify({ payload: { user: '{{var:who}}', n: 3 } }), { vars: { who: 'bob' }, fieldCodecs: [{ path: '$.payload', chain: ['base64', 'json'] }] });
    expect(res.status).toBe(200);
    expect(lastPayload).toEqual({ user: 'bob', n: 3 });
    expect(res.tags).toContain('fields:$.payload');
  });
});

describe('upstream certificates', () => {
  const tlsUrl = () => `https://127.0.0.1:${httpsPort}/hello`;
  const sendTls = (opts = {}) => core.tools.sender.send({ method: 'GET', url: tlsUrl(), headers: [] }, opts);

  it('refuses a self-signed dev server by default, and a per-send ignore still works', async () => {
    expect(skipsTlsChecks('127.0.0.1')).toBe(false);
    const res = await sendTls();
    expect(res.state).toBe('error');
    const ok = await sendTls({ ignoreTlsErrors: true });
    expect(ok.status).toBe(200);
  });

  it('reads the server certificate on request, and trusting it lets requests through despite the name', async () => {
    const peer = await core.upstreamTls.fetchPeer('127.0.0.1', httpsPort);
    expect(peer.selfSigned).toBe(true);
    expect(peer.problem).toMatch(/SELF_SIGNED|self/i);
    core.upstreamTls.trust(peer.cert.pem, 'dev server');
    expect(upstreamTls('127.0.0.1').ca?.length).toBeGreaterThan(1);
    const res = await sendTls();
    expect(res.status).toBe(200);
    // A different self-signed certificate on another host is still refused.
    const other = generateSelfSigned('other.test');
    const s = createHttpsServer({ key: other.key, cert: other.cert }, handler);
    const port = await listen(s);
    try {
      const r = await core.tools.sender.send({ method: 'GET', url: `https://127.0.0.1:${port}/`, headers: [] }, {});
      expect(r.state).toBe('error');
    } finally {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    core.upstreamTls.untrust(core.upstreamTls.get().trusted[0]!.id);
    expect((await sendTls()).state).toBe('error');
  });

  it('skips checks for listed hosts, or all of them, and saves the setting', async () => {
    core.upstreamTls.skipHost('127.0.0.*');
    expect(core.upstreamTls.get()).toEqual({ mode: 'hosts', hosts: ['127.0.0.*'], trusted: [] });
    expect(skipsTlsChecks('127.0.0.1')).toBe(true);
    expect(skipsTlsChecks('example.com')).toBe(false);
    expect((await sendTls()).status).toBe(200);
    core.upstreamTls.set({ mode: 'verify' });
    expect((await sendTls()).state).toBe('error');
    core.upstreamTls.set({ mode: 'all' });
    expect(skipsTlsChecks('anything.test')).toBe(true);
    core.upstreamTls.set({ mode: 'verify', hosts: [] });
    expect(() => core.upstreamTls.set({ mode: 'nope' as never })).toThrow(/mode/);
    expect(() => core.upstreamTls.trust('not a cert')).toThrow(/PEM/);
  });

  it('lets the proxy reach a trusted dev server, and says how when it cannot', async () => {
    const port = await core.proxy.start();
    // The proxy's own upstream check is what matters here.
    const { request } = await import('node:http');
    const get = () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = request({ host: '127.0.0.1', port, method: 'GET', path: `https://127.0.0.1:${httpsPort}/via-proxy` }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        });
        r.on('error', reject);
        r.end();
      });
    const refused = await get();
    expect(refused.status).toBe(502);
    expect(refused.body).toContain('Server certificates');
    const peer = await core.upstreamTls.fetchPeer('127.0.0.1', httpsPort);
    core.upstreamTls.trust(peer.cert.pem);
    expect((await get()).status).toBe(200);
    core.upstreamTls.set({ trusted: [] });
  });
});
