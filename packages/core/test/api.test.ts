import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
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
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd') });
  await core.start();
  const info = readRuntimeInfo(join(tmp, 'p'))!;
  ws = new WebSocket(`ws://127.0.0.1:${info.apiPort}/?token=${info.token}`);
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === 'change') notifications.push(msg.params);
    else pending.get(msg.id)?.(msg);
  });
  await new Promise((r, j) => ws.once('open', r).once('error', j));
});

afterAll(async () => {
  ws?.close();
  await core?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('core API', () => {
  it('rejects connections without the token', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${core.api!.port}/?token=wrong`);
    const err = await new Promise<Error>((r) => bad.once('error', r));
    expect(err.message).toMatch(/401/);
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

  it('returns JSON-RPC errors', async () => {
    await expect(call('nope')).rejects.toMatchObject({ code: -32601 });
    await expect(call('traffic.get', { id: 'missing' })).rejects.toMatchObject({ code: 404 });
    await expect(call('traffic.get', {})).rejects.toMatchObject({ code: -32602 });
  });
});
