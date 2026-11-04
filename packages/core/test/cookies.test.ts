import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@siteinquisition/devkit/test';
import { CaptureStore, cookieJar, parseSetCookie } from '@siteinquisition/core';

let dir: string;
let store: CaptureStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'siq-cookies-'));
  store = CaptureStore.openProject(dir, { actor: 'tester' });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const respond = (url: string, startedAt: number, setCookies: string[]) => {
  const ex = store.addRequest({ source: 'proxy', startedAt, method: 'GET', url, httpVersion: '1.1', headers: [] });
  store.completeResponse(ex.id, { status: 200, headers: setCookies.map((c) => ['Set-Cookie', c] as [string, string]) });
  return ex.id;
};

describe('cookie jar', () => {
  it('parses Set-Cookie attributes', () => {
    expect(parseSetCookie('sid=a=b; Path=/; HttpOnly; SameSite=Lax')).toEqual({ name: 'sid', value: 'a=b', attrs: { path: '/', httponly: true, samesite: 'Lax' } });
    expect(parseSetCookie('novalue')).toBeNull();
  });

  it('keeps the latest value per domain, path and name, like a browser', () => {
    const t = Date.UTC(2026, 10, 4, 9);
    respond('https://shop.example.com/login', t, ['session=one; Path=/; HttpOnly; Secure', 'theme=dark; Domain=.example.com; Max-Age=60']);
    const second = respond('https://shop.example.com/account/settings', t + 1000, ['session=two; Path=/', 'pref=1']);
    respond('https://shop.example.com/logout', t + 2000, ['theme=; Domain=example.com; Max-Age=0']);

    const jar = cookieJar(store, t + 5000);
    const byName = Object.fromEntries(jar.map((c) => [`${c.name}@${c.domain}${c.path}`, c]));
    expect(byName['session@shop.example.com/']).toMatchObject({ value: 'two', hostOnly: true, httpOnly: false, setBy: second, expired: false });
    expect(byName['pref@shop.example.com/account']).toMatchObject({ value: '1', expires: null });
    expect(byName['theme@example.com/']).toMatchObject({ hostOnly: false, expired: true });
    expect(jar).toHaveLength(3);
  });
});

describe('time filters', () => {
  it('filters by since and until', () => {
    const t = Date.UTC(2026, 10, 4, 9);
    respond('http://a.test/1', t, []);
    respond('http://a.test/2', t + 60_000, []);
    respond('http://a.test/3', t + 120_000, []);
    expect(store.search(`since:${t + 1} until:${t + 120_000}`).map((e) => e.path)).toEqual(['/2']);
    expect(store.search(`since:${new Date(t + 60_000).toISOString()}`)).toHaveLength(2);
    expect(() => store.search('since:yesterdayish')).toThrow(/invalid time/);
  });
});
