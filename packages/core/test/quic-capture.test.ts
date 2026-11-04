import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { Core, normalizeBrowserHttp3Hosts, readBrowserHttp3Hosts, writeBrowserHttp3Hosts, type ExchangeSummary } from '../src/index.js';
import { H3Server, h3Connect, requestFields, type H3Connection } from '../src/quic/index.js';
import { generateCA, LeafIssuer } from '../src/x509.js';

const upstreamCa = generateCA({ commonName: 'upstream CA' });
const leaf = new LeafIssuer(upstreamCa).issue('localhost');

describe('HTTP/3 capture for the built-in browser', () => {
  let tmp: string;
  let core: Core;
  let upstream: H3Server;
  let tcpOnly: Server;
  let h3Port = 0;
  let tcpPort = 0;
  let client: H3Connection;

  const waitFor = async (query: string): Promise<ExchangeSummary> => {
    for (let i = 0; i < 200; i++) {
      const hit = core.store.search(query).find((e) => e.state !== 'pending');
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no exchange for ${query}`);
  };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'siq-h3cap-'));
    upstream = new H3Server({ cert: leaf.cert + upstreamCa.cert, key: leaf.key }, async (req) => {
      const body = await req.body();
      req.respond(200, [['content-type', 'text/plain'], ['alt-svc', 'h3=":443"']], `h3 upstream ${req.method} ${req.path} ${body.length} ${req.headers.find(([k]) => k === 'x-test')?.[1] ?? ''}`);
    });
    h3Port = (await upstream.listen(0)).port;
    tcpOnly = createHttpsServer({ cert: leaf.cert, key: leaf.key }, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`tcp upstream ${req.method} ${req.url} ${req.httpVersion}`);
    });
    tcpPort = await new Promise<number>((r) => tcpOnly.listen(0, '127.0.0.1', () => r((tcpOnly.address() as AddressInfo).port)));

    core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd'), api: false, proxy: { ignoreUpstreamTlsErrors: true }, browserProxy: { http3: true } });
    await core.setScope({ defaultAction: 'ignore', rules: [{ action: 'include', host: 'localhost' }] });
    const { browserProxyPort } = await core.start();
    expect(core.browserProxy!.http3Port).toBe(browserProxyPort);
    client = await h3Connect({ host: '127.0.0.1', port: browserProxyPort!, serverName: 'localhost', ca: [core.ca.cert] });
  });

  afterAll(async () => {
    client?.close();
    await core?.close();
    await upstream?.close();
    tcpOnly?.closeAllConnections();
    await new Promise((r) => tcpOnly?.close(r));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('records an HTTP/3 request and forwards it over HTTP/3', async () => {
    const s = client.session.request(requestFields('POST', new URL(`https://localhost:${h3Port}/form?a=1`), [['x-test', 'yes'], ['content-type', 'text/plain']]), Buffer.from('hello'))!;
    const res = await s.response();
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('h3 upstream POST /form?a=1 5 yes');
    // The upstream's Alt-Svc is not passed on: the browser reaches this origin through the mapping.
    expect(res.headers.some(([k]) => k === 'alt-svc')).toBe(false);
    const ex = await waitFor('path:/form');
    const full = core.store.getExchange(ex.id)!;
    expect(full).toMatchObject({ source: 'browser', httpVersion: '3', method: 'POST', status: 200 });
    expect(Buffer.from(core.store.getBody(ex.id, 'request', true)!).toString()).toBe('hello');
    expect(Buffer.from(core.store.getBody(ex.id, 'response', true)!).toString()).toContain('h3 upstream');
  });

  it('falls back to HTTPS over TCP when the origin has no QUIC listener', async () => {
    const res = await client.session.request(requestFields('GET', new URL(`https://localhost:${tcpPort}/plain`), []))!.response();
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('tcp upstream GET /plain 1.1');
    const ex = await waitFor('path:/plain');
    expect(core.store.getExchange(ex.id)).toMatchObject({ source: 'browser', httpVersion: '3', status: 200 });
  }, 15_000);

  it('answers 502 when the upstream is unreachable', async () => {
    const res = await client.session.request(requestFields('GET', new URL('https://localhost:1/nothing'), []))!.response();
    expect(res.status).toBe(502);
  }, 15_000);

  it('stores the browser HTTP/3 host list for the next launch', () => {
    expect(normalizeBrowserHttp3Hosts([' https://Example.com/path ', 'api.example.com:443', 'example.com'])).toEqual(['example.com', 'api.example.com']);
    expect(() => normalizeBrowserHttp3Hosts(['*.example.com'])).toThrow(/not a host name/);
    expect(readBrowserHttp3Hosts(core.projectDir)).toEqual([]);
    writeBrowserHttp3Hosts(core.projectDir, ['shop.test']);
    expect(readBrowserHttp3Hosts(core.projectDir)).toEqual(['shop.test']);
    expect(core.info().browserHttp3Hosts).toEqual(['shop.test']);
  });
});
