// HTTP/2 through the proxy: cleartext with prior knowledge, the h2c upgrade
// offer, TLS sent straight to the port (transparent mode), and HTTP/2 on to
// servers that speak it, trailers included.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as h2connect, createSecureServer, createServer as createH2Server, type ClientHttp2Session, type Http2ServerRequest, type Http2ServerResponse, type IncomingHttpHeaders } from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { Core, type ExchangeSummary } from '@siteinquisition/core';
import { generateCA } from '../src/x509.js';
import { tunnel } from './proxy-client.js';

let tmp: string;
let core: Core;
let proxyPort: number;
const servers: Array<{ close(cb: () => void): void; closeAllConnections?: () => void }> = [];
let h1Port: number;
let h1SecurePort: number;
let h2Port: number;
let h2SecurePort: number;

type AnyServer = Server | ReturnType<typeof createH2Server> | ReturnType<typeof createSecureServer>;
const listen = (s: AnyServer) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

/** Says which protocol the request came in on; /grpc answers with trailers like a gRPC server. */
function handler(req: IncomingMessage | Http2ServerRequest, res: ServerResponse | Http2ServerResponse) {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    const info = { path: url.pathname + url.search, version: req.httpVersion, te: req.headers.te ?? null, body, authority: req.headers[':authority'] ?? req.headers.host };
    if (url.pathname === '/grpc') {
      (res as Http2ServerResponse).writeHead(200, { 'content-type': 'application/grpc' });
      res.write(JSON.stringify(info));
      (res as Http2ServerResponse).addTrailers({ 'grpc-status': '0', 'grpc-message': 'ok' });
      return void res.end();
    }
    (res as Http2ServerResponse).writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(info));
  });
}

async function waitFor(query: string, pred: (e: ExchangeSummary) => boolean = (e) => e.state !== 'pending'): Promise<ExchangeSummary> {
  for (let i = 0; i < 100; i++) {
    const hit = core.store.search(query).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for "${query}"`);
}

/** One HTTP/2 request on a session: status, body and trailers. */
function h2get(session: ClientHttp2Session, path: string, extra: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; body: string; trailers: IncomingHttpHeaders | undefined }>((resolve, reject) => {
    session.once('error', reject);
    const req = session.request({ ':path': path, ':method': body ? 'POST' : 'GET', ...extra });
    let status = 0;
    let data = '';
    let trailers: IncomingHttpHeaders | undefined;
    req.on('response', (h) => (status = Number(h[':status'])));
    req.on('trailers', (t) => (trailers = t));
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => resolve({ status, body: data, trailers }));
    req.on('error', reject);
    req.end(body);
  });
}

const json = (s: string) => JSON.parse(s) as { path: string; version: string; te: string | null; body: string; authority: string };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-h2-'));
  const cert = generateCA({ commonName: 'localhost' });
  const h1 = createHttpServer(handler);
  const h1s = createHttpsServer({ key: cert.key, cert: cert.cert }, handler);
  const h2 = createH2Server(handler);
  const h2s = createSecureServer({ key: cert.key, cert: cert.cert, allowHTTP1: true }, handler);
  servers.push(h1, h1s, h2, h2s);
  [h1Port, h1SecurePort, h2Port, h2SecurePort] = await Promise.all([listen(h1), listen(h1s), listen(h2), listen(h2s)]);
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd'), api: false, proxy: { ignoreUpstreamTlsErrors: true } });
  await core.setScope({ defaultAction: 'ignore', rules: [{ action: 'include', host: '127.0.0.1' }, { action: 'include', host: 'localhost' }] });
  ({ proxyPort } = await core.start());
});

afterAll(async () => {
  await core?.close();
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('HTTP/2 through the proxy', () => {
  it('serves cleartext HTTP/2 sent straight to the port (prior knowledge) and records it', async () => {
    const session = h2connect(`http://localhost:${h1Port}`, { createConnection: () => netConnect(proxyPort, '127.0.0.1') });
    const r = await h2get(session, '/h2c-direct?x=1');
    session.close();
    expect(r.status).toBe(200);
    // The server only speaks HTTP/1.1, so the proxy fell back to it upstream.
    expect(json(r.body)).toMatchObject({ path: '/h2c-direct?x=1', version: '1.1', authority: `localhost:${h1Port}` });
    const ex = await waitFor('path:/h2c-direct');
    expect(ex).toMatchObject({ scheme: 'http', status: 200 });
    expect(core.store.getExchange(ex.id)!.httpVersion).toBe('2.0');
  });

  it('serves cleartext HTTP/2 inside a CONNECT tunnel', async () => {
    const sock = await tunnel(`http://127.0.0.1:${proxyPort}`, 'localhost', h1Port);
    const session = h2connect(`http://localhost:${h1Port}`, { createConnection: () => sock as Socket });
    const r = await h2get(session, '/h2c-tunnel');
    session.close();
    expect(json(r.body)).toMatchObject({ path: '/h2c-tunnel' });
    const ex = await waitFor('path:/h2c-tunnel');
    expect(core.store.getExchange(ex.id)!.httpVersion).toBe('2.0');
  });

  it('forwards cleartext HTTP/2 as HTTP/2 to a server that speaks it', async () => {
    const session = h2connect(`http://localhost:${h2Port}`, { createConnection: () => netConnect(proxyPort, '127.0.0.1') });
    const a = await h2get(session, '/h2c-up', {}, 'hello');
    const b = await h2get(session, '/h2c-up-2');
    session.close();
    expect(json(a.body)).toMatchObject({ path: '/h2c-up', version: '2.0', body: 'hello', authority: `localhost:${h2Port}` });
    expect(json(b.body).version).toBe('2.0');
    expect((await waitFor('path:/h2c-up')).status).toBe(200);
  });

  it('answers an "Upgrade: h2c" offer over HTTP/1.1 instead of dropping the connection', async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      const s = netConnect(proxyPort, '127.0.0.1', () => {
        s.write(
          `GET http://localhost:${h1Port}/upgrade-offer HTTP/1.1\r\nHost: localhost:${h1Port}\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\nX-Kept: yes\r\n\r\n`,
        );
      });
      let data = '';
      s.on('data', (c: Buffer) => {
        data += c.toString();
        if (data.includes('}')) {
          s.destroy();
          resolve(data);
        }
      });
      s.on('error', reject);
      s.on('close', () => resolve(data));
    });
    expect(reply.startsWith('HTTP/1.1 200')).toBe(true);
    expect(reply).toContain('"path":"/upgrade-offer"');
    const ex = await waitFor('path:/upgrade-offer');
    const full = core.store.getExchange(ex.id)!;
    expect(full.httpVersion).toBe('1.1');
    expect(full.requestHeaders.some(([k]) => k.toLowerCase() === 'upgrade')).toBe(false);
    expect(full.requestHeaders.some(([k, v]) => k === 'X-Kept' && v === 'yes')).toBe(true);
  });

  it('takes TLS sent straight to the port (transparent mode) to the port in :authority, over HTTP/2 with trailers', async () => {
    const session = h2connect(`https://localhost:${h2SecurePort}`, {
      createConnection: () => tlsConnect({ port: proxyPort, host: '127.0.0.1', servername: 'localhost', ca: core.ca.cert, ALPNProtocols: ['h2'] }),
    });
    const r = await h2get(session, '/grpc', { te: 'trailers', 'content-type': 'application/grpc' }, 'msg');
    session.close();
    expect(r.status).toBe(200);
    expect(json(r.body)).toMatchObject({ path: '/grpc', version: '2.0', te: 'trailers', body: 'msg', authority: `localhost:${h2SecurePort}` });
    expect(r.trailers).toMatchObject({ 'grpc-status': '0', 'grpc-message': 'ok' });
    const ex = await waitFor('path:/grpc');
    expect(ex).toMatchObject({ scheme: 'https', status: 200 });
  });

  it('falls back to HTTP/1.1 upstream when the TLS server does not offer h2', async () => {
    const session = h2connect(`https://localhost:${h1SecurePort}`, {
      createConnection: () => tlsConnect({ port: proxyPort, host: '127.0.0.1', servername: 'localhost', ca: core.ca.cert, ALPNProtocols: ['h2'] }),
    });
    const a = await h2get(session, '/alpn-h1');
    const b = await h2get(session, '/alpn-h1-again');
    session.close();
    expect(json(a.body)).toMatchObject({ path: '/alpn-h1', version: '1.1', authority: `localhost:${h1SecurePort}` });
    expect(json(b.body).version).toBe('1.1');
  });

  it('keeps HTTP/1.1 clients on HTTP/1.1 upstream', async () => {
    const sock = await tunnel(`http://127.0.0.1:${proxyPort}`, 'localhost', h2SecurePort);
    const tls = tlsConnect({ socket: sock as Socket, servername: 'localhost', ca: core.ca.cert, ALPNProtocols: ['http/1.1'] });
    const reply = await new Promise<string>((resolve, reject) => {
      tls.once('secureConnect', () => tls.write(`GET /h1-client HTTP/1.1\r\nHost: localhost:${h2SecurePort}\r\nConnection: close\r\n\r\n`));
      let data = '';
      tls.on('data', (c: Buffer) => (data += c.toString()));
      tls.on('end', () => resolve(data));
      tls.on('error', reject);
    });
    expect(reply).toContain('"version":"1.1"');
  });
});
