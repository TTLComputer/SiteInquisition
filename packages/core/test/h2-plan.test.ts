// The HTTP/2 protocol-lab plan runner against node:http2.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createH2Server, createSecureServer, type Http2Server } from 'node:http2';
import { createServer as createNetServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { Core } from '@siteinquisition/core';
import { H2Connection } from '../src/h2/connection.js';
import { runH2Plan } from '../src/h2/plan.js';
import { protocolLadder } from '../src/h2/connect.js';
import { generateCA } from '../src/x509.js';

let tmp: string;
let core: Core;
let cleartext: Http2Server;
let tls: ReturnType<typeof createSecureServer>;
let plainPort: number;
let upgradeServer: Server;
let upgradePort: number;
let tlsPort: number;

function handler(stream: import('node:http2').ServerHttp2Stream, headers: import('node:http2').IncomingHttpHeaders) {
  const path = String(headers[':path']);
  stream.on('error', () => undefined);
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => {
    if (path === '/slow') return void setTimeout(() => void (!stream.destroyed && (stream.respond({ ':status': 200 }), stream.end('late'))), 150);
    if (path === '/refuse') return stream.close(0x7);
    stream.respond({ ':status': 200, 'content-type': 'application/json' }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.end(JSON.stringify({ path, bytes: Buffer.concat(chunks).length }));
  });
}

const listen = (s: Http2Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-h2plan-'));
  const cert = generateCA({ commonName: 'localhost' });
  cleartext = createH2Server();
  cleartext.on('stream', handler);
  tls = createSecureServer({ key: cert.key, cert: cert.cert });
  tls.on('stream', handler);
  plainPort = await listen(cleartext);
  // A server that accepts the HTTP/1.1 h2c upgrade (node's h2 server does prior knowledge only).
  const h2u = createH2Server();
  h2u.on('stream', handler);
  upgradeServer = createNetServer((sock) => {
    let buf = Buffer.alloc(0);
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      sock.off('data', onData);
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
      const [method, path] = lines[0]!.split(' ');
      sock.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n');
      const rest = buf.subarray(end + 4);
      // Serve the upgraded connection with our own HTTP/2 server engine.
      const conn = new H2Connection(sock, { role: 'server', prefaceRead: false });
      conn.adoptUpgradeStream([[':method', method!], [':scheme', 'http'], [':authority', 'localhost'], [':path', path!]]);
      conn.on('stream', (st, fields) => {
        const chunks: Buffer[] = [];
        st.on('data', (d: Buffer) => chunks.push(d));
        st.once('end', () => {
          st.sendHeaders([[':status', '200'], ['content-type', 'application/json']]);
          st.write(Buffer.from(JSON.stringify({ path: fields.find(([k]) => k === ':path')![1], bytes: Buffer.concat(chunks).length })));
          st.sendHeaders([['grpc-status', '0']], { endStream: true });
        });
      });
      if (rest.length) sock.unshift(rest);
      sock.resume();
    };
    sock.on('data', onData);
  });
  void h2u;
  upgradePort = await new Promise<number>((r) => upgradeServer.listen(0, '127.0.0.1', () => r((upgradeServer.address() as AddressInfo).port)));
  tlsPort = await listen(tls as unknown as Http2Server);
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd'), api: false, proxy: { ignoreUpstreamTlsErrors: true } });
  await core.setScope({ defaultAction: 'ignore', rules: [{ action: 'include', host: 'localhost' }] });
});

afterAll(async () => {
  await core?.close();
  await new Promise((r) => cleartext.close(r));
  await new Promise((r) => tls.close(r));
  await new Promise((r) => upgradeServer.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe('HTTP/2 protocol lab', () => {
  it('runs a plan over prior knowledge, recording each stream with trailers', async () => {
    const res = await runH2Plan(core.store, [
      { method: 'GET', url: `http://localhost:${plainPort}/a`, headers: [] },
      { method: 'POST', url: `http://localhost:${plainPort}/b`, headers: [], body: Buffer.alloc(5000, 1) },
    ], { connect: 'prior-knowledge' });
    const run = res.runs[0]!;
    expect(res.protocol).toBe('h2');
    expect(run.rows.every((r) => r.status === 200)).toBe(true);
    expect(run.rows[1]!.streamId).toBe(3);
    const ex = core.store.getExchange(run.rows[0]!.exchangeId)!;
    expect(ex.httpVersion).toBe('2');
    expect(ex.responseHeaders!.some(([k, v]) => k === 'grpc-status' && v === '0')).toBe(true);
    expect(run.connections[0]!.method).toBe('prior-knowledge');
  });

  it('holds a stream and releases it with a gate, keeping other streams moving', async () => {
    const res = await runH2Plan(core.store, [
      { method: 'POST', url: `http://localhost:${plainPort}/held1`, headers: [], body: Buffer.from('one'), hold: 'fin' },
      { method: 'POST', url: `http://localhost:${plainPort}/held2`, headers: [], body: Buffer.from('two'), hold: 'fin' },
      { method: 'GET', url: `http://localhost:${plainPort}/free`, headers: [] },
    ], { connect: 'prior-knowledge', gate: 'single-packet' });
    const run = res.runs[0]!;
    expect(run.rows.every((r) => r.status === 200)).toBe(true);
    expect(run.rows[0]!.timings.released).toBeGreaterThan(0);
    expect(run.connections[0]!.gateBytes).toBeGreaterThan(0);
  });

  it('records a server reset as an error without a status', async () => {
    const res = await runH2Plan(core.store, [{ method: 'GET', url: `http://localhost:${plainPort}/refuse`, headers: [] }], { connect: 'prior-knowledge' });
    const row = res.runs[0]!.rows[0]!;
    expect(row.status).toBeNull();
    expect(row.resetByServer).toBe('REFUSED_STREAM');
    expect(core.store.getExchange(row.exchangeId)!.state).toBe('error');
  });

  it('resets a stream from the plan after N bytes', async () => {
    const res = await runH2Plan(core.store, [{ method: 'POST', url: `http://localhost:${plainPort}/slow`, headers: [], body: Buffer.alloc(100), resetAfterBytes: 10 }], { connect: 'prior-knowledge' });
    const row = res.runs[0]!.rows[0]!;
    expect(row.timings.resetSent).toBeGreaterThanOrEqual(0);
  });

  it('runs over an h2c upgrade, recording the upgraded request as stream 1', async () => {
    const res = await runH2Plan(core.store, [
      { method: 'GET', url: `http://localhost:${upgradePort}/upgraded`, headers: [['x-test', 'yes']] },
      { method: 'GET', url: `http://localhost:${upgradePort}/after`, headers: [] },
    ], { connect: 'upgrade' });
    const run = res.runs[0]!;
    expect(run.rows[0]!.status).toBe(200);
    expect(run.rows[0]!.streamId).toBe(1);
    expect(run.connections[0]!.method).toBe('upgrade');
    expect(run.connections[0]!.upgradeHead).toContain('101');
  });

  it('runs over ALPN to a TLS server', async () => {
    const res = await runH2Plan(core.store, [{ method: 'GET', url: `https://localhost:${tlsPort}/tls`, headers: [] }], { connect: 'alpn', ignoreTlsErrors: true, ca: [core.ca.cert] });
    expect(res.runs[0]!.rows[0]!.status).toBe(200);
    expect(res.runs[0]!.connections[0]!.alpn).toBe('h2');
  });

  it('the ladder test reports what the server accepts', async () => {
    const plain = await protocolLadder(new URL(`http://localhost:${plainPort}/`));
    expect(plain.find((s) => s.method === 'h2c prior knowledge')!.ok).toBe(true);
    // node's h2 server does not do the upgrade; a server that does reports it.
    const up = await protocolLadder(new URL(`http://localhost:${upgradePort}/`));
    expect(up.find((s) => s.method === 'h2c upgrade')!.ok).toBe(true);
    const secure = await protocolLadder(new URL(`https://localhost:${tlsPort}/`), { ignoreTlsErrors: true });
    expect(secure.find((s) => s.method === 'TLS, ALPN h2 only')!.ok).toBe(true);
  });
});
