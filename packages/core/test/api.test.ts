import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { Core, readRuntimeInfo, type Change } from '@siteinquisition/core';

let tmp: string;
let core: Core;
let ws: WebSocket;
let nextId = 1;
const pending = new Map<number, (msg: { result?: unknown; error?: { code: number; message: string } }) => void>();
const notifications: Change[] = [];

const call = <T = unknown>(method: string, params?: object) =>
  new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : resolve(m.result as T)));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-api-'));
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd'), browserProxy: true });
  await core.start();
  const info = readRuntimeInfo(join(tmp, 'p'))!;
  ws = new WebSocket(`ws://127.0.0.1:${info.apiPort}/?token=${info.token}`);
  // Node's built-in client, so the in-house server is checked against an independent implementation.
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.method === 'change') notifications.push(msg.params);
    else pending.get(msg.id)?.(msg);
  });
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
});

afterAll(async () => {
  ws?.close();
  await core?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('core API', () => {
  it('rejects connections without the token', async () => {
    const { connectWebSocket, UnexpectedResponse } = await import('../src/websocket.js');
    const err = await connectWebSocket(`ws://127.0.0.1:${core.api!.port}/?token=wrong`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnexpectedResponse);
    expect((err as InstanceType<typeof UnexpectedResponse>).status).toBe(401);
    // The built-in client refuses too.
    const bad = new WebSocket(`ws://127.0.0.1:${core.api!.port}/?token=wrong`);
    const failed = await new Promise<boolean>((r) => bad.addEventListener('error', () => r(true), { once: true }));
    expect(failed).toBe(true);
  });

  it('reports core info', async () => {
    const info = await call<{ proxyPort: number; ca: { fingerprint: string } }>('core.info');
    expect(info.proxyPort).toBe(core.proxy.port);
    expect(info.ca.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('serves search, get and body, and pushes change notifications', async () => {
    await call('events.subscribe');
    const ex = core.store.addRequest({ source: 'script', startedAt: Date.now(), method: 'PUT', url: 'http://a.test/item', httpVersion: '1.1', headers: [], body: Buffer.from('payload') });
    expect(await call<Array<{ id: string }>>('traffic.search', { query: 'method:PUT' })).toEqual([expect.objectContaining({ id: ex.id })]);
    expect(await call('traffic.get', { id: ex.id })).toMatchObject({ id: ex.id, url: 'http://a.test/item', stream: null });
    const body = await call<{ base64: string }>('traffic.body', { id: ex.id, side: 'request' });
    expect(Buffer.from(body.base64, 'base64').toString()).toBe('payload');
    await call('traffic.tag', { id: ex.id, tags: ['bug-123'] });
    expect(await call<Array<{ id: string }>>('traffic.search', { query: 'tag:bug-123' })).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(notifications.map((n) => n.kind)).toEqual(expect.arrayContaining(['exchange.request', 'exchange.tags']));
  });

  it('persists scope changes', async () => {
    const config = await call<{ rules: Array<{ id: string; host: string }> }>('scope.set', { config: { defaultAction: 'ignore', rules: [{ action: 'include', host: '*.a.test' }] } });
    expect(config.rules[0]).toMatchObject({ host: '*.a.test', id: expect.any(String) });
    expect(core.store.getMeta('scope')).toEqual(config);
  });

  it('records the built-in browser listener as source "browser", and serves the cookie jar', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'set-cookie': 'sid=abc; Path=/; HttpOnly' });
      res.end('ok');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as AddressInfo).port;
    try {
      await call('scope.set', { config: { defaultAction: 'ignore', rules: [{ action: 'include', host: '127.0.0.1', port }] } });
      const info = await call<{ browserProxyPort: number }>('core.info');
      expect(info.browserProxyPort).toBe(core.browserProxy!.port);
      expect(await call('scope.evaluate', { url: `http://127.0.0.1:${port}/x` })).toMatchObject({ record: true });
      expect(await call('scope.evaluate', { url: 'http://elsewhere.test/' })).toMatchObject({ record: false });
      await new Promise<void>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: info.browserProxyPort, path: `http://127.0.0.1:${port}/page`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.end();
      });
      await new Promise((r) => setTimeout(r, 100));
      const [ex] = await call<Array<{ source: string; path: string }>>('traffic.search', { query: 'source:browser' });
      expect(ex).toMatchObject({ source: 'browser', path: '/page' });
      expect(await call('cookies.list')).toEqual([expect.objectContaining({ name: 'sid', value: 'abc', domain: '127.0.0.1', httpOnly: true })]);
    } finally {
      upstream.close();
    }
  });

  it('returns JSON-RPC errors', async () => {
    await expect(call('nope')).rejects.toMatchObject({ code: -32601 });
    await expect(call('traffic.get', { id: 'missing' })).rejects.toMatchObject({ code: 404 });
    await expect(call('traffic.get', {})).rejects.toMatchObject({ code: -32602 });
  });
});
