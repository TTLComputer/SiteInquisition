import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaptureStore, compileQuery, type Change } from '@siteinquisition/core';

let dir: string;
let store: CaptureStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'siq-store-'));
  store = CaptureStore.openProject(dir, { actor: 'tester', maxBodyBytes: 64 });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (url: string, method = 'GET', body?: string, headers: Array<[string, string]> = []) =>
  store.addRequest({ source: 'proxy', startedAt: Date.now(), method, url, httpVersion: '1.1', headers, body: body ? Buffer.from(body) : undefined });

describe('CaptureStore', () => {
  it('stores a request and response and logs both changes', () => {
    const changes: Change[] = [];
    store.on('change', (c) => changes.push(c));
    const ex = add('https://api.example.com:8443/v1/users?id=7', 'post', '{"name":"a"}', [['Content-Type', 'application/json']]);
    expect(ex).toMatchObject({ method: 'POST', host: 'api.example.com', port: 8443, path: '/v1/users?id=7', state: 'pending', scheme: 'https' });
    store.completeResponse(ex.id, {
      status: 200,
      headers: [['Content-Encoding', 'gzip']],
      body: gzipSync('{"ok":true}'),
      timings: { total: 12.5 },
    });
    const full = store.getExchange(ex.id)!;
    expect(full).toMatchObject({ status: 200, state: 'complete', durationMs: 12.5, createdBy: 'tester' });
    expect(full.requestHeaders).toEqual([['Content-Type', 'application/json']]);
    expect(Buffer.from(store.getBody(ex.id, 'response', true)!).toString()).toBe('{"ok":true}');
    expect(store.getBody(ex.id, 'response', false)![0]).toBe(0x1f);
    expect(changes.map((c) => c.kind)).toEqual(['exchange.request', 'exchange.response']);
    expect(store.changesSince(changes[0]!.id).map((c) => c.kind)).toEqual(['exchange.response']);
  });

  it('dedupes and truncates bodies', () => {
    const big = 'x'.repeat(100);
    const a = add('http://a.test/1', 'POST', big);
    const b = add('http://a.test/2', 'POST', big);
    expect(store.getExchange(a.id)!.requestBodyTruncated).toBe(true);
    expect(a.reqBodySize).toBe(100);
    expect(store.getBody(a.id, 'request')!.byteLength).toBe(64);
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM blob').get() as { n: number }).n).toBe(1);
    expect(b.reqBodySize).toBe(100);
  });

  it('searches with filters and full text over decoded bodies', () => {
    const a = add('https://api.example.com/login', 'POST', 'user=nick');
    store.completeResponse(a.id, { status: 401, headers: [['Content-Encoding', 'gzip']], body: gzipSync('session expired') });
    const b = add('https://cdn.example.com/app.js');
    store.completeResponse(b.id, { status: 200, headers: [], body: Buffer.from('console.log(1)') });
    const c = add('https://other.test/api/items', 'DELETE');
    store.completeResponse(c.id, { status: 204, headers: [] });

    const ids = (q: string) => store.search(q).map((e) => e.id);
    expect(ids('host:*.example.com')).toEqual([b.id, a.id]);
    expect(ids('status:4xx')).toEqual([a.id]);
    expect(ids('status:>=200 status:<300')).toEqual([c.id, b.id]);
    expect(ids('"session expired"')).toEqual([a.id]);
    expect(ids('body:nick')).toEqual([a.id]);
    expect(ids('method:delete path:/api/')).toEqual([c.id]);
    expect(ids('-host:*.example.com')).toEqual([c.id]);
    expect(ids('-console')).toEqual([c.id, a.id]);
    expect(store.search('', { order: 'oldest', limit: 2 }).map((e) => e.id)).toEqual([a.id, b.id]);
    expect(store.search('', { before: c.id }).map((e) => e.id)).toEqual([b.id, a.id]);
  });

  it('builds a site map and stats', () => {
    add('https://a.test/api/users?id=1');
    add('https://a.test/api/orders');
    add('https://a.test/login?next=/');
    add('https://b.test/');
    expect(store.siteMap()).toEqual([
      { host: 'a.test', count: 3, paths: [{ segment: '/api', count: 2 }, { segment: '/login', count: 1 }] },
      { host: 'b.test', count: 1, paths: [{ segment: '/', count: 1 }] },
    ]);
    expect(store.stats()).toMatchObject({ exchanges: 4, databaseBytes: expect.any(Number) });
  });

  it('links redirect chains into one flow', () => {
    const first = add('http://a.test/old');
    const second = store.addRequest({ source: 'proxy', startedAt: Date.now(), method: 'GET', url: 'http://a.test/new', httpVersion: '1.1', headers: [], flowId: first.flowId, parentId: first.id });
    expect(store.getFlow(first.flowId).map((e) => e.id)).toEqual([first.id, second.id]);
    expect((store.db.prepare('SELECT kind FROM flow WHERE id = ?').get(first.flowId) as { kind: string }).kind).toBe('redirect');
  });

  it('keeps WebSocket messages in a stream', () => {
    const ex = add('ws://a.test/socket');
    const stream = store.openStream('websocket', ex.id);
    store.addStreamMessage({ streamId: stream, direction: 'client', opcode: 'text', at: 1, payload: Buffer.from('hi') });
    store.addStreamMessage({ streamId: stream, direction: 'server', opcode: 'binary', at: 2, payload: Buffer.from([1, 2]) });
    store.closeStream(stream, 1000, 'bye');
    const msgs = store.getStreamMessages(stream);
    expect(msgs.map((m) => [m.direction, m.opcode, m.size])).toEqual([
      ['client', 'text', 2],
      ['server', 'binary', 2],
    ]);
    expect(store.getStreamForExchange(ex.id)).toMatchObject({ id: stream, closeCode: 1000 });
  });

  it('rolls back failed transactions without emitting changes', () => {
    const changes: Change[] = [];
    store.on('change', (c) => changes.push(c));
    expect(() => store.completeResponse('nope', { status: 200, headers: [] })).toThrow(/no exchange/);
    expect(changes).toEqual([]);
  });
});

describe('schema migration', () => {
  it('upgrades a version 1 project to the current schema', () => {
    store.db.exec("DROP INDEX exchange_replay_of; ALTER TABLE exchange DROP COLUMN replay_of; ALTER TABLE stream_message DROP COLUMN meta; UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    store.close();
    store = CaptureStore.openProject(dir);
    const cols = (store.db.prepare('PRAGMA table_info(stream_message)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('meta');
    expect((store.db.prepare('PRAGMA table_info(exchange)').all() as Array<{ name: string }>).map((c) => c.name)).toContain('replay_of');
    expect((store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('3');
  });

  it('refuses projects from a newer version', () => {
    store.db.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    store.close();
    expect(() => CaptureStore.openProject(dir)).toThrow(/newer SiteInquisition/);
  });
});

describe('compileQuery', () => {
  it('rejects bad status filters', () => {
    expect(() => compileQuery('status:abc')).toThrow(/invalid status/);
  });
  it('treats unknown keys as text', () => {
    expect(compileQuery('foo:bar').match).toBe('"foo:bar"');
  });
});
