import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateCACertificate } from 'mockttp';
import { ProxyAgent, fetch } from 'undici';
import { WebSocket, WebSocketServer } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Core, sendReplay, type ExchangeSummary } from '@siteinquisition/core';

let tmp: string;
let core: Core;
let proxyUrl: string;
let httpTarget: Server;
let httpsTarget: Server;
let httpPort: number;
let httpsPort: number;
let agent: ProxyAgent;

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/hello') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(gzipSync(JSON.stringify({ hello: 'world', q: url.searchParams.get('q') })));
  } else if (url.pathname === '/redirect') {
    res.writeHead(302, { location: '/hello?q=redirected' });
    res.end();
  } else if (url.pathname === '/echo') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'text/plain' });
      res.end(Buffer.concat(chunks));
    });
  } else {
    res.writeHead(404);
    res.end('nope');
  }
};

/** Wait until the store reports an exchange matching the query has finished. */
async function waitFor(query: string, count = 1): Promise<ExchangeSummary[]> {
  for (let i = 0; i < 100; i++) {
    const hits = core.store.search(query, { order: 'oldest' }).filter((e) => e.state !== 'pending');
    if (hits.length >= count) return hits;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${count} x "${query}"`);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-proxy-'));
  httpTarget = createHttpServer(handler);
  const wss = new WebSocketServer({ server: httpTarget });
  wss.on('connection', (ws) => ws.on('message', (data, isBinary) => ws.send(isBinary ? data : `echo:${data.toString()}`)));
  httpPort = await listen(httpTarget);
  const targetCert = await generateCACertificate({ subject: { commonName: 'localhost' } });
  httpsTarget = createHttpsServer({ key: targetCert.key, cert: targetCert.cert }, handler);
  httpsPort = await listen(httpsTarget);

  core = await Core.open({
    projectDir: join(tmp, 'project'),
    dataDir: join(tmp, 'data'),
    api: false,
    proxy: { ignoreUpstreamTlsErrors: true },
  });
  await core.setScope({
    defaultAction: 'ignore',
    rules: [
      { action: 'exclude', host: '127.0.0.1', pathPrefix: '/echo' },
      { action: 'include', host: '127.0.0.1' },
      { action: 'include', host: 'localhost' },
    ],
  });
  const { proxyPort } = await core.start();
  proxyUrl = `http://127.0.0.1:${proxyPort}`;
  agent = new ProxyAgent({ uri: proxyUrl, requestTls: { ca: core.ca.cert } });
});

afterAll(async () => {
  await agent?.close();
  await core?.close();
  httpTarget?.closeAllConnections();
  httpsTarget?.closeAllConnections();
  await new Promise((r) => httpTarget?.close(r));
  await new Promise((r) => httpsTarget?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe('proxy capture', () => {
  it('records plain HTTP with decoded, searchable bodies', async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/hello?q=plain`, { dispatcher: agent });
    expect(await res.json()).toEqual({ hello: 'world', q: 'plain' });
    const [ex] = await waitFor('path:/hello?q=plain');
    const full = core.store.getExchange(ex!.id)!;
    expect(full).toMatchObject({ method: 'GET', status: 200, scheme: 'http', source: 'proxy', clientAddr: expect.stringContaining('127.0.0.1') });
    expect(full.timings.total).toBeGreaterThanOrEqual(0);
    expect(Buffer.from(core.store.getBody(ex!.id, 'response', true)!).toString()).toContain('"q":"plain"');
    expect(core.store.search('"world" host:127.0.0.1').map((e) => e.id)).toContain(ex!.id);
  });

  it('decrypts in-scope HTTPS with the project CA', async () => {
    const res = await fetch(`https://localhost:${httpsPort}/hello?q=tls`, { dispatcher: agent });
    expect(res.status).toBe(200);
    const [ex] = await waitFor('host:localhost path:/hello?q=tls');
    expect(ex).toMatchObject({ scheme: 'https', port: httpsPort, status: 200 });
  });

  it('links a redirect and the request that follows it into one flow', async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/redirect`, { dispatcher: agent });
    expect(await res.json()).toMatchObject({ q: 'redirected' });
    const [hop] = await waitFor('path:/redirect');
    const flow = core.store.getFlow(hop!.flowId);
    expect(flow.map((e) => [e.path, e.status])).toEqual([
      ['/redirect', 302],
      ['/hello?q=redirected', 200],
    ]);
    expect(flow[1]!.parentId).toBe(hop!.id);
  });

  it('passes excluded traffic through without recording it', async () => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/echo`, { method: 'POST', body: 'secret', dispatcher: agent });
    expect(await res.text()).toBe('secret');
    await new Promise((r) => setTimeout(r, 100));
    expect(core.store.search('path:/echo')).toEqual([]);
  });

  it('records WebSocket upgrades and every frame in both directions', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/socket`, { agent: new HttpsProxyAgent(proxyUrl) });
    await new Promise((r, j) => ws.once('open', r).once('error', j));
    const replies: string[] = [];
    ws.on('message', (d) => replies.push(d.toString()));
    ws.send('ping');
    ws.send(Buffer.from([1, 2, 3]));
    await new Promise<void>((r) => {
      const t = setInterval(() => replies.length >= 2 && (clearInterval(t), r()), 10);
    });
    ws.close(1000, 'done');
    await new Promise((r) => ws.once('close', r));

    const [ex] = await waitFor('ws:true path:/socket');
    expect(ex).toMatchObject({ status: 101, scheme: 'ws', isWebSocket: true });
    let msgs: ReturnType<typeof core.store.getStreamMessages> = [];
    for (let i = 0; i < 50 && msgs.length < 4; i++) {
      await new Promise((r) => setTimeout(r, 20));
      msgs = core.store.getStreamMessages(core.store.getStreamForExchange(ex!.id)!.id);
    }
    expect(msgs.map((m) => [m.direction, m.opcode, Buffer.from(m.payload).toString('hex')])).toEqual(
      expect.arrayContaining([
        ['client', 'text', Buffer.from('ping').toString('hex')],
        ['server', 'text', Buffer.from('echo:ping').toString('hex')],
        ['client', 'binary', '010203'],
        ['server', 'binary', '010203'],
      ]),
    );
  });

  it('restarts with new TLS scope when decrypted hosts change', async () => {
    const port = core.proxy.port;
    await core.setScope({ defaultAction: 'ignore', rules: [{ action: 'include', host: '127.0.0.1' }] });
    expect(core.proxy.port).toBe(port);
    expect(core.info().decryptHosts).toEqual(['127.0.0.1']);
    // localhost is no longer decrypted, so the client sees the target's own cert and the request is not recorded.
    const before = core.store.search('host:localhost').length;
    const plain = new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: false } });
    const res = await fetch(`https://localhost:${httpsPort}/hello?q=tunnel`, { dispatcher: plain });
    expect(res.status).toBe(200);
    await plain.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(core.store.search('host:localhost').length).toBe(before);
    expect(core.seenNotInScope()).toEqual(expect.arrayContaining([expect.objectContaining({ host: 'localhost', kinds: ['tls'] })]));
  });
});

describe('replay', () => {
  it('sends an edited request, fixes Content-Length and links it to the original', async () => {
    const [orig] = await waitFor('path:/hello?q=plain');
    const res = await sendReplay(core.store, {
      method: 'POST',
      url: `http://127.0.0.1:${httpPort}/echo`,
      headers: [['X-Test', 'Kept-Case'], ['Content-Length', '999'], ['Connection', 'keep-alive']],
      body: Buffer.from('edited body'),
      replayOf: orig!.id,
    });
    expect(res).toMatchObject({ source: 'replay', status: 201, state: 'complete', replayOf: orig!.id });
    const full = core.store.getExchange(res.id)!;
    expect(full.requestHeaders).toEqual([['Host', `127.0.0.1:${httpPort}`], ['X-Test', 'Kept-Case'], ['Content-Length', '11']]);
    expect(Buffer.from(core.store.getBody(res.id, 'response')!).toString()).toBe('edited body');
    expect(core.store.search(`replayof:${orig!.id}`).map((e) => e.id)).toEqual([res.id]);
  });

  it('replays HTTPS, optionally ignoring certificate errors', async () => {
    const req = { method: 'GET', url: `https://localhost:${httpsPort}/hello?q=replayed`, headers: [] as Array<[string, string]> };
    expect(await sendReplay(core.store, req)).toMatchObject({ state: 'error' });
    expect(await sendReplay(core.store, { ...req, ignoreTlsErrors: true })).toMatchObject({ state: 'complete', status: 200 });
  });

  it('records connection failures as errors', async () => {
    const res = await sendReplay(core.store, { method: 'GET', url: 'http://127.0.0.1:1/', headers: [] });
    expect(core.store.getExchange(res.id)).toMatchObject({ state: 'error', error: expect.stringMatching(/ECONNREFUSED/) });
  });
});

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

describe('client restriction', () => {
  it.skipIf(!lanAddress)('drops non-loopback clients unless allowLan is set', async () => {
    const closedWithoutReply = await new Promise<boolean>((resolve) => {
      const sock = connect(core.proxy.port, lanAddress!, () => sock.write('GET http://127.0.0.1/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
      let got = '';
      sock.on('data', (d) => (got += d.toString()));
      sock.on('close', () => resolve(got === ''));
      sock.on('error', () => undefined);
    });
    expect(closedWithoutReply).toBe(true);
  });
});
