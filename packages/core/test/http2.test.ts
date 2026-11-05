// HTTP/2 through the proxy, where the server always makes the call: prior
// knowledge in cleartext, the h2c upgrade, ALPN over TLS, and TLS sent
// straight to the port (transparent mode), trailers included.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as h2connect, createSecureServer, createServer as createH2Server, type ClientHttp2Session, type Http2ServerRequest, type Http2ServerResponse, type IncomingHttpHeaders } from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
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

type AnyServer = Server | ReturnType<typeof createH2Server> | ReturnType<typeof createSecureServer> | ReturnType<typeof createNetServer>;
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

/** Read an HTTP/1.1 response head off a raw socket; the bytes after it are put back. */
function readHead(s: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      s.off('data', onData);
      s.pause();
      const rest = buf.subarray(end + 4);
      if (rest.length) s.unshift(rest);
      resolve(buf.subarray(0, end).toString('latin1'));
    };
    s.on('data', onData);
    s.once('error', reject);
  });
}

const UPGRADE = (path: string, port: number) =>
  `GET http://localhost:${port}${path} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\n\r\n`;

describe('HTTP/2 through the proxy: the server decides', () => {
  it('serves cleartext HTTP/2 sent straight to the port (prior knowledge) on to an h2c server', async () => {
    const session = h2connect(`http://localhost:${h2Port}`, { createConnection: () => netConnect(proxyPort, '127.0.0.1') });
    const a = await h2get(session, '/h2c-direct?x=1', {}, 'hello');
    const b = await h2get(session, '/h2c-direct-2');
    session.close();
    expect(a.status).toBe(200);
    expect(json(a.body)).toMatchObject({ path: '/h2c-direct?x=1', version: '2.0', body: 'hello', authority: `localhost:${h2Port}` });
    expect(json(b.body).version).toBe('2.0');
    const ex = await waitFor('path:/h2c-direct');
    expect(ex).toMatchObject({ scheme: 'http', status: 200 });
    expect(core.store.getExchange(ex.id)!.httpVersion).toBe('2.0');
  });

  it('serves cleartext HTTP/2 inside a CONNECT tunnel', async () => {
    const sock = await tunnel(`http://127.0.0.1:${proxyPort}`, 'localhost', h2Port);
    const session = h2connect(`http://localhost:${h2Port}`, { createConnection: () => sock as Socket });
    const r = await h2get(session, '/h2c-tunnel');
    session.close();
    expect(json(r.body)).toMatchObject({ path: '/h2c-tunnel', version: '2.0' });
    const ex = await waitFor('path:/h2c-tunnel');
    expect(core.store.getExchange(ex.id)!.httpVersion).toBe('2.0');
  });

  it('answers 502 instead of switching to HTTP/1.1 when the server refuses prior knowledge', async () => {
    const session = h2connect(`http://localhost:${h1Port}`, { createConnection: () => netConnect(proxyPort, '127.0.0.1') });
    const r = await h2get(session, '/h2c-refused');
    session.close();
    expect(r.status).toBe(502);
    expect(r.body).toContain('did not accept HTTP/2 with prior knowledge');
    const ex = await waitFor('path:/h2c-refused');
    expect(ex.state).toBe('error');
  });

  it('relays an "Upgrade: h2c" offer the server declines, and its HTTP/1.1 answer', async () => {
    const s = netConnect(proxyPort, '127.0.0.1');
    await new Promise((r) => s.once('connect', r));
    s.write(UPGRADE('/upgrade-declined', h1Port));
    const head = await readHead(s);
    s.destroy();
    expect(head.startsWith('HTTP/1.1 200')).toBe(true);
    const ex = await waitFor('path:/upgrade-declined');
    const full = core.store.getExchange(ex.id)!;
    expect(full.httpVersion).toBe('1.1');
    expect(full.requestHeaders.some(([k, v]) => k === 'Upgrade' && v === 'h2c')).toBe(true);
  });

  it('relays an "Upgrade: h2c" the server accepts, and records the HTTP/2 streams after it', async () => {
    // A server that accepts the upgrade, then speaks HTTP/2 (node's server answers the client's streams).
    const h2 = createH2Server(handler);
    const up = createNetServer((sock) => {
      void readHead(sock).then(() => {
        sock.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n');
        h2.emit('connection', sock);
        sock.resume();
      });
    });
    servers.push(up);
    const upPort = await listen(up);
    const s = netConnect(proxyPort, '127.0.0.1');
    await new Promise((r) => s.once('connect', r));
    s.write(UPGRADE('/upgrade-accepted', upPort));
    const head = await readHead(s);
    expect(head.startsWith('HTTP/1.1 101')).toBe(true);
    const session = h2connect(`http://localhost:${upPort}`, { createConnection: () => s });
    const first = await h2get(session, '/upgrade-accepted');
    const second = await h2get(session, '/after-upgrade', {}, 'payload');
    session.close();
    expect(json(first.body).version).toBe('2.0');
    expect(json(second.body)).toMatchObject({ path: '/after-upgrade', version: '2.0', body: 'payload' });
    const upgraded = await waitFor('path:/upgrade-accepted');
    expect(upgraded.status).toBe(200);
    const after = await waitFor('path:/after-upgrade');
    const full = core.store.getExchange(after.id)!;
    expect(full).toMatchObject({ httpVersion: '2.0', status: 200, method: 'POST' });
  });

  it('gives TLS clients the protocol the server picks by ALPN', async () => {
    for (const [p, want] of [[h2SecurePort, 'h2'], [h1SecurePort, 'http/1.1']] as const) {
      const sock = await tunnel(`http://127.0.0.1:${proxyPort}`, 'localhost', p);
      const t = tlsConnect({ socket: sock as Socket, servername: 'localhost', ca: core.ca.cert, ALPNProtocols: ['h2', 'http/1.1'] });
      await new Promise((r, j) => (t.once('secureConnect', r), t.once('error', j)));
      expect(t.alpnProtocol).toBe(want);
      t.destroy();
    }
  });

  it('forwards HTTP/2 over the paired server connection, with te: trailers and trailers', async () => {
    const sock = await tunnel(`http://127.0.0.1:${proxyPort}`, 'localhost', h2SecurePort);
    const session = h2connect(`https://localhost:${h2SecurePort}`, {
      createConnection: () => tlsConnect({ socket: sock as Socket, servername: 'localhost', ca: core.ca.cert, ALPNProtocols: ['h2', 'http/1.1'] }),
    });
    const r = await h2get(session, '/grpc', { te: 'trailers', 'content-type': 'application/grpc' }, 'msg');
    session.close();
    expect(r.status).toBe(200);
    expect(json(r.body)).toMatchObject({ path: '/grpc', version: '2.0', te: 'trailers', body: 'msg' });
    expect(r.trailers).toMatchObject({ 'grpc-status': '0', 'grpc-message': 'ok' });
    expect((await waitFor('path:/grpc')).status).toBe(200);
  });

  it('takes TLS sent straight to the port (transparent mode) to the port in :authority', async () => {
    const session = h2connect(`https://localhost:${h2SecurePort}`, {
      createConnection: () => tlsConnect({ port: proxyPort, host: '127.0.0.1', servername: 'localhost', ca: core.ca.cert, ALPNProtocols: ['h2'] }),
    });
    const r = await h2get(session, '/transparent');
    session.close();
    expect(json(r.body)).toMatchObject({ path: '/transparent', authority: `localhost:${h2SecurePort}` });
    expect((await waitFor('path:/transparent')).scheme).toBe('https');
  });
});
