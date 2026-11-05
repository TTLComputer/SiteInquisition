import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { connect as h2connect } from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { connectWebSocket, serveWebSockets } from '../src/websocket.js';
import { Core, type ExchangeSummary } from '@siteinquisition/core';
import { parseClientHello } from '../src/interceptor.js';
import { LeafIssuer, generateCA } from '../src/x509.js';
import { ProxyClient, tunnel } from './proxy-client.js';

let tmp: string;
let core: Core;
let proxyPort: number;
let target: Server;
let secureTarget: Server;
let port: number;
let securePort: number;

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/stream') {
    // First chunk now, the rest only after the client says it saw the first one.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: one\n\n');
    streamRelease = () => res.end('data: two\n\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'x-target': 'yes' });
  res.end(JSON.stringify({ path: url.pathname + url.search, method: req.method, host: req.headers.host }));
};
let streamRelease: (() => void) | undefined;

async function waitFor(query: string, pred: (e: ExchangeSummary) => boolean = (e) => e.state !== 'pending'): Promise<ExchangeSummary> {
  for (let i = 0; i < 100; i++) {
    const hit = core.store.search(query).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for "${query}"`);
}

/** Open a SOCKS5 connection to host:port through the proxy. */
function socks5(host: string, p: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = netConnect(proxyPort, '127.0.0.1');
    let stage = 0;
    s.once('error', reject);
    s.on('data', function onData(d: Buffer) {
      if (stage === 0) {
        expect([...d]).toEqual([5, 0]);
        const name = Buffer.from(host);
        const req = Buffer.concat([Buffer.of(5, 1, 0, 3, name.length), name, Buffer.of(p >> 8, p & 0xff)]);
        stage = 1;
        s.write(req);
      } else {
        s.off('data', onData);
        if (d[1] !== 0) return reject(new Error(`SOCKS reply ${d[1]}`));
        resolve(s);
      }
    });
    s.write(Buffer.of(5, 1, 0));
  });
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-icpt-'));
  target = createHttpServer(handler);
  serveWebSockets(target, (ws) => ws.on('message', (d, bin) => ws.send(bin ? d : `echo:${d.toString()}`)), { protocol: (offered) => (offered.includes('chat') ? 'chat' : undefined) });
  port = await listen(target);
  const cert = generateCA({ commonName: 'localhost' });
  secureTarget = createHttpsServer({ key: cert.key, cert: cert.cert }, handler);
  securePort = await listen(secureTarget);
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd'), api: false, proxy: { ignoreUpstreamTlsErrors: true } });
  await core.setScope({ defaultAction: 'ignore', rules: [{ action: 'include', host: '127.0.0.1' }, { action: 'include', host: 'localhost' }] });
  ({ proxyPort } = await core.start());
});

afterAll(async () => {
  await core?.close();
  target?.closeAllConnections();
  secureTarget?.closeAllConnections();
  await new Promise((r) => target?.close(r));
  await new Promise((r) => secureTarget?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe('certificates', () => {
  it('issues leaf certificates for names and IPs that chain to the CA', () => {
    const ca = generateCA({ commonName: 'Test, CA', organizationName: 'SiteInquisition' });
    const root = new X509Certificate(ca.cert);
    expect(root.ca).toBe(true);
    const issuer = new LeafIssuer(ca);
    for (const [host, san] of [
      ['api.example.com', 'DNS:api.example.com'],
      ['10.0.0.7', 'IP Address:10.0.0.7'],
      ['fe80::1', 'IP Address:FE80:0:0:0:0:0:0:1'],
    ]) {
      const leaf = new X509Certificate(issuer.issue(host!).cert);
      expect(leaf.subjectAltName).toBe(san);
      expect(leaf.checkIssued(root)).toBe(true);
      expect(leaf.verify(root.publicKey)).toBe(true);
      expect(leaf.ca).toBe(false);
    }
    expect(issuer.issue('api.example.com')).toBe(issuer.issue('api.example.com'));
  });
});

describe('interceptor', () => {
  it('reads SNI from a ClientHello and rejects other bytes', async () => {
    const hello = await new Promise<Buffer>((resolve) => {
      const srv = createHttpServer();
      srv.on('connection', (s: Socket) => s.once('data', (d: Buffer) => (resolve(d), s.destroy())));
      void listen(srv).then((p) => {
        const c = tlsConnect({ port: p, host: '127.0.0.1', servername: 'device.example.net' });
        c.on('error', () => srv.close());
      });
    });
    expect(parseClientHello(hello)).toEqual({ sni: 'device.example.net', complete: true });
    expect(parseClientHello(hello.subarray(0, 20)).complete).toBe(false);
    expect(() => parseClientHello(Buffer.from('GET / HTTP/1.1'))).toThrow();
  });

  it('gives a client offering h2 the protocol the server picks inside a decrypted tunnel', async () => {
    // The target is HTTPS without HTTP/2: offered both, the client gets http/1.1, as it would directly.
    const sock = await tunnel(`http://127.0.0.1:${proxyPort}`, 'localhost', securePort);
    const tls = tlsConnect({ socket: sock as Socket, servername: 'localhost', ca: core.ca.cert, ALPNProtocols: ['h2', 'http/1.1'] });
    const reply = await new Promise<string>((resolve, reject) => {
      tls.once('secureConnect', () => {
        expect(tls.alpnProtocol).toBe('http/1.1');
        tls.write(`GET /h2?x=1 HTTP/1.1\r\nHost: localhost:${securePort}\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      tls.on('data', (c: Buffer) => (data += c.toString()));
      tls.on('end', () => resolve(data));
      tls.on('error', reject);
    });
    expect(reply).toContain('"path":"/h2?x=1"');
    const ex = await waitFor('path:/h2?x=1');
    expect(ex).toMatchObject({ scheme: 'https', status: 200 });
    expect(core.store.getExchange(ex.id)!.httpVersion).toBe('1.1');
    // Offered only h2, the handshake fails, as it does against the server itself.
    const sock2 = await tunnel(`http://127.0.0.1:${proxyPort}`, 'localhost', securePort);
    const err = await new Promise<Error>((resolve) => {
      const t = tlsConnect({ socket: sock2 as Socket, servername: 'localhost', ca: core.ca.cert, ALPNProtocols: ['h2'] });
      t.once('secureConnect', () => resolve(new Error('connected')));
      t.once('error', resolve);
    });
    expect(err.message).toMatch(/no application protocol/i);
  });

  it('accepts SOCKS5 for plain HTTP and for TLS', async () => {
    const plain = await socks5('127.0.0.1', port);
    const reply = await new Promise<string>((resolve) => {
      let got = '';
      plain.on('data', (d) => (got += d.toString()));
      plain.on('end', () => resolve(got));
      plain.write(`GET /via-socks HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    expect(reply).toMatch(/^HTTP\/1.1 200/);
    expect(await waitFor('path:/via-socks')).toMatchObject({ scheme: 'http', status: 200 });

    const raw = await socks5('localhost', securePort);
    const secure = tlsConnect({ socket: raw, servername: 'localhost', ca: core.ca.cert });
    await new Promise((r) => secure.once('secureConnect', r));
    const text = await new Promise<string>((resolve) => {
      let got = '';
      secure.on('data', (d) => (got += d.toString()));
      secure.on('end', () => resolve(got));
      secure.write(`GET /via-socks-tls HTTP/1.1\r\nHost: localhost:${securePort}\r\nConnection: close\r\n\r\n`);
    });
    expect(text).toMatch(/^HTTP\/1.1 200/);
    expect(await waitFor('path:/via-socks-tls')).toMatchObject({ scheme: 'https', status: 200 });
  });

  it('streams responses instead of waiting for the whole body', async () => {
    const sock = await tunnel(`http://127.0.0.1:${proxyPort}`, '127.0.0.1', port);
    const chunks: string[] = [];
    await new Promise<void>((resolve) => {
      sock.on('data', (d: Buffer) => {
        chunks.push(d.toString());
        if (chunks.join('').includes('data: one') && streamRelease) {
          streamRelease();
          streamRelease = undefined;
        }
        if (chunks.join('').includes('data: two')) resolve();
      });
      sock.write(`GET /stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    });
    sock.destroy();
    const ex = await waitFor('path:/stream');
    expect(Buffer.from(core.store.getBody(ex.id, 'response')!).toString()).toBe('data: one\n\ndata: two\n\n');
  });

  it('answers 502 and records an error when the server cannot be reached', async () => {
    const res = await new ProxyClient({ uri: `http://127.0.0.1:${proxyPort}` }).fetch('http://127.0.0.1:1/nothing-here');
    expect(res.status).toBe(502);
    const ex = await waitFor('path:/nothing-here', (e) => e.state === 'error');
    expect(core.store.getExchange(ex.id)!.error).toMatch(/ECONNREFUSED/);
  });

  it('records clients that refuse our certificate', async () => {
    const sock = await tunnel(`http://127.0.0.1:${proxyPort}`, 'localhost', securePort);
    // No CA given: the client rejects the leaf, like an app that pins its certificate.
    const c = tlsConnect({ socket: sock as Socket, servername: 'localhost' });
    await new Promise((r) => c.once('error', r));
    for (let i = 0; i < 50 && !core.store.tlsFailureSummary().some((f) => /cert-rejected|closed|reset/.test(f.cause)); i++) await new Promise((r) => setTimeout(r, 20));
    const failures = core.store.tlsFailureSummary();
    expect(failures).toEqual(expect.arrayContaining([expect.objectContaining({ host: 'localhost', cause: expect.stringMatching(/cert-rejected|closed|reset/) })]));
  });

  it('passes the WebSocket subprotocol and frames through', async () => {
    const proxy = `http://127.0.0.1:${proxyPort}`;
    const { ws } = await connectWebSocket(`ws://127.0.0.1:${port}/proto`, { protocols: ['chat'], createConnection: () => tunnel(proxy, '127.0.0.1', port) });
    expect(ws.protocol).toBe('chat');
    const reply = new Promise<string>((r) => ws.once('message', (d) => r(d.toString())));
    ws.send('hi');
    expect(await reply).toBe('echo:hi');
    ws.close(4001, 'bye');
    await new Promise((r) => ws.once('close', r));
    const ex = await waitFor('ws:true path:/proto');
    let stream = core.store.getStreamForExchange(ex.id)!;
    for (let i = 0; i < 50 && stream.closedAt === null; i++) {
      await new Promise((r) => setTimeout(r, 20));
      stream = core.store.getStreamForExchange(ex.id)!;
    }
    expect(stream).toMatchObject({ closeCode: 4001 });
  });
});
