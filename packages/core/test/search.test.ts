import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@siteinquisition/devkit/test';
import { CaptureStore, compileQuery } from '@siteinquisition/core';

// Text search over request and response bodies and headers, by side.
let dir: string;
let store: CaptureStore;
const ids: Record<string, string> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'siq-search-'));
  store = CaptureStore.openProject(dir);
  const ex = (name: string, url: string, req: { headers?: Array<[string, string]>; body?: string }, res: { headers?: Array<[string, string]>; body?: string }) => {
    const e = store.addRequest({ source: 'proxy', startedAt: Date.now(), method: req.body ? 'POST' : 'GET', url, httpVersion: '1.1', headers: req.headers ?? [], body: req.body ? Buffer.from(req.body) : undefined });
    store.completeResponse(e.id, { status: 200, headers: res.headers ?? [], body: res.body ? Buffer.from(res.body) : undefined });
    ids[name] = e.id;
  };
  ex('login', 'https://shop.test/login', { headers: [['X-Api-Key', 'k-123']], body: 'user=nick&password=hunter2' }, { headers: [['Server', 'nginx/1.25']], body: '{"token":"tok_9f8e7d"}' });
  ex('order', 'https://shop.test/api/orders', { body: '{"sku":"AB-100"}' }, { headers: [['Content-Type', 'application/json']], body: '{"order":{"number":"PO-7781"},"note":"hunter2 was here"}' });
  ex('page', 'https://shop.test/', {}, { headers: [['Server', 'Apache']], body: '<meta name="csrf-token" content="xyz">' });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const find = (q: string) =>
  store
    .search(q)
    .map((e) => Object.entries(ids).find(([, id]) => id === e.id)![0])
    .sort();

describe('text search in bodies and headers', () => {
  it('matches part of a word anywhere, ignoring case', () => {
    expect(find('PO-77')).toEqual(['order']);
    expect(find('TOK_9F')).toEqual(['login']);
    expect(find('csrf-tok')).toEqual(['page']);
    expect(find('"number":"PO')).toEqual(['order']);
    // Two characters still work, as a plain scan.
    expect(find('AB')).toEqual(['order']);
  });

  it('narrows to one side, a body or headers', () => {
    expect(find('hunter2')).toEqual(['login', 'order']);
    expect(find('reqbody:hunter2')).toEqual(['login']);
    expect(find('resbody:hunter2')).toEqual(['order']);
    expect(find('req:hunter2')).toEqual(['login']);
    expect(find('response:hunter2')).toEqual(['order']);
    expect(find('reqheader:x-api-key')).toEqual(['login']);
    expect(find('resheader:"server: nginx"')).toEqual(['login']);
    expect(find('header:server')).toEqual(['login', 'page']);
    expect(find('body:sku')).toEqual(['order']);
  });

  it('negates and combines with filters', () => {
    expect(find('-hunter2')).toEqual(['page']);
    expect(find('resheader:server -resheader:apache')).toEqual(['login']);
    expect(find('method:POST -resbody:PO-')).toEqual(['login']);
    expect(store.count('hunter2')).toBe(2);
  });

  it('reports the text it looks for, so it can be highlighted', () => {
    expect(compileQuery('host:shop.test resbody:"PO-7781" -nginx').text).toEqual([
      { value: 'PO-7781', in: ['res_body'], negate: false },
      { value: 'nginx', in: ['url', 'req_headers', 'req_body', 'res_headers', 'res_body'], negate: true },
    ]);
  });

  it('indexes traffic recorded before per-side search existed', () => {
    store.db.exec("DROP TABLE exchange_text; CREATE VIRTUAL TABLE exchange_fts USING fts5(exchange_id UNINDEXED, url, headers, body); UPDATE meta SET value = '3' WHERE key = 'schema_version'");
    store.close();
    store = CaptureStore.openProject(dir);
    expect(find('resbody:PO-77')).toEqual(['order']);
    expect(find('reqheader:k-123')).toEqual(['login']);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'exchange_fts'").get()).toEqual({ n: 0 });
  });
});
