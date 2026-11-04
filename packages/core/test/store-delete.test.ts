import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@siteinquisition/devkit/test';
import { CaptureStore, Core } from '@siteinquisition/core';

let dir: string;
let store: CaptureStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'siq-del-'));
  store = CaptureStore.openProject(join(dir, 'p'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (url: string, body: string, startedAt = Date.now(), parentId?: string) => {
  const e = store.addRequest({ source: 'proxy', startedAt, method: 'POST', url, httpVersion: '1.1', headers: [], body: Buffer.from(body), parentId });
  store.completeResponse(e.id, { status: 200, headers: [], body: Buffer.from(`reply to ${body}`) });
  return e;
};
const count = (sql: string) => (store.db.prepare(sql).get() as { n: number }).n;

describe('deleting traffic', () => {
  it('removes an exchange with its messages, search rows and unshared bodies, and keeps shared ones', () => {
    const a = add('http://a.test/one', 'shared');
    const b = add('http://b.test/two', 'shared');
    const child = add('http://a.test/three', 'only-a-child', Date.now(), a.id);
    const s = store.openStream('websocket', a.id);
    store.addStreamMessage({ streamId: s, direction: 'client', opcode: 'text', at: Date.now(), payload: Buffer.from('hi') });

    expect(store.deleteExchanges([a.id, a.id])).toBe(1);
    expect(store.getExchange(a.id)).toBeUndefined();
    expect(store.search('host:a.test').map((e) => e.id)).toEqual([child.id]);
    expect(store.getExchange(child.id)!.parentId).toBeNull();
    expect(count('SELECT COUNT(*) AS n FROM stream_message')).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM exchange_fts WHERE exchange_id = '${a.id}'`)).toBe(0);
    // b still uses the request body a had.
    expect(Buffer.from(store.getBody(b.id, 'request')!).toString()).toBe('shared');
    expect(store.deleteMatching('host:b.test')).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM blob`)).toBe(2); // the child's request and response
  });

  it('clears all traffic but keeps project settings', () => {
    for (let i = 0; i < 5; i++) add(`http://c.test/${i}`, `body ${i}`);
    store.setMeta('scope', { rules: [], defaultAction: 'record' });
    expect(store.clearTraffic()).toBe(5);
    expect(store.stats().exchanges).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM blob')).toBe(0);
    expect(store.getMeta('scope')).toEqual({ rules: [], defaultAction: 'record' });
  });

  it('prunes by age, then by size, oldest first', () => {
    const old = add('http://d.test/old', 'x', Date.now() - 10 * 86_400_000);
    const recent = add('http://d.test/recent', 'y');
    expect(store.prune({ maxAgeDays: 7 })).toBe(1);
    expect(store.getExchange(old.id)).toBeUndefined();
    expect(store.getExchange(recent.id)).toBeDefined();

    const big = () => randomBytes(100_000).toString('base64'); // about 133 KB that does not compress much
    for (let i = 0; i < 20; i++) add(`http://d.test/big${i}`, big(), Date.now() - (20 - i) * 1000);
    const before = store.stats().exchanges;
    store.prune({ maxBytes: 1_500_000 });
    const after = store.search('host:d.test', { limit: 100, order: 'oldest' });
    expect(after.length).toBeLessThan(before);
    expect(after.length).toBeGreaterThan(5);
    // What is left is the newest traffic.
    expect(after.map((e) => e.url)).toContain('http://d.test/recent');
    expect(after.map((e) => e.url)).toContain('http://d.test/big19');
    expect(after.map((e) => e.url)).not.toContain('http://d.test/big0');
    expect(store.liveBytes()).toBeLessThanOrEqual(1_500_000);
  });

  // POSIX modes; on Windows the folder's ACL comes from its parent (the user's profile by default).
  it.skipIf(process.platform === 'win32')('keeps the project folder and database private to the user', () => {
    add('http://e.test/', 'x');
    expect(statSync(join(dir, 'p')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'p', 'project.sqlite')).mode & 0o077).toBe(0);
  });
});

describe('retention settings', () => {
  it('saves limits, applies them at once, and turns them off', async () => {
    store.close();
    const core = await Core.open({ projectDir: join(dir, 'p'), dataDir: join(dir, 'data'), api: false });
    try {
      core.store.addRequest({ source: 'proxy', startedAt: Date.now() - 40 * 86_400_000, method: 'GET', url: 'http://f.test/', httpVersion: '1.1', headers: [] });
      expect(core.setRetention({ maxAgeDays: 30, maxSizeMB: -1 })).toEqual({ maxAgeDays: 30, maxSizeMB: undefined });
      expect(core.store.stats().exchanges).toBe(0);
      expect(core.setRetention({})).toEqual({ maxAgeDays: undefined, maxSizeMB: undefined });
      expect(core.applyRetention()).toBe(0);
    } finally {
      await core.close();
      store = CaptureStore.openProject(join(dir, 'p'));
    }
  });
});
