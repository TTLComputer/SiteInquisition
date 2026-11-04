import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { CaptureStore, authKinds, coverage } from '@siteinquisition/core';

const dir = mkdtempSync(join(tmpdir(), 'siq-cov-'));
const store = CaptureStore.openProject(dir);
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (method: string, url: string, headers: Array<[string, string]>, body?: string) => {
  const e = store.addRequest({ source: 'proxy', startedAt: Date.now(), method, url, httpVersion: '1.1', headers, body: body ? Buffer.from(body) : undefined });
  store.completeResponse(e.id, { status: 200, headers: [] });
};

describe('endpoint coverage details', () => {
  it('names how requests authenticated', () => {
    expect(authKinds([['Authorization', 'Bearer x']])).toEqual(['bearer']);
    expect(authKinds([['authorization', 'Basic eA=='], ['Cookie', 'sid=1']])).toEqual(['basic', 'cookie']);
    expect(authKinds([['X-Api-Key', 'k']])).toEqual(['api key']);
    expect(authKinds([['Authorization', 'AWS4-HMAC-SHA256 Credential=...']])).toEqual(['sigv4']);
    expect(authKinds([['Accept', '*/*']])).toEqual(['none']);
  });

  it('collects auth per endpoint, and field types with an example, hiding secrets', () => {
    const json: Array<[string, string]> = [['Content-Type', 'application/json']];
    add('POST', 'http://c.test/api/orders?dry=1', [...json, ['Authorization', 'Bearer t']], '{"sku":"A-1","qty":2,"note":null,"password":"hunter2"}');
    add('POST', 'http://c.test/api/orders?dry=0', json, '{"sku":"B-2","qty":"3"}');
    const ep = coverage(store, 'c.test').endpoints.find((e) => e.template === '/api/orders')!;
    expect(ep.auth.sort()).toEqual(['bearer', 'none']);
    const by = Object.fromEntries(ep.params.map((p) => [`${p.in}:${p.name}`, p]));
    expect(by['query:dry']).toMatchObject({ types: ['string'], example: '0' }); // the newest call's value
    expect(by['body:qty']!.types.sort()).toEqual(['number', 'string']);
    expect(by['body:sku']!.example).toBe('B-2');
    expect(by['body:note']!.types).toEqual(['null']);
    expect(by['body:password']!.example).toBe('(hidden)');
  });
});
