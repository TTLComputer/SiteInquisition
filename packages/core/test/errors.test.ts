import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { attribute, Core, detectErrors, ERROR_SIGNATURES, requestParts, scannable } from '@siteinquisition/core';

let tmp: string;
let core: Core;
let target: Server;
let base: string;

// A deliberately broken app: it pastes input into SQL and leaks the errors.
const handler = (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    switch (url.pathname) {
      case '/search': {
        const q = url.searchParams.get('q') ?? '';
        const sql = `SELECT * FROM items WHERE name = '${q}' AND visible = 1`;
        const quotes = (sql.match(/'/g) ?? []).length;
        if (quotes % 2) {
          const at = sql.indexOf(q) + q.indexOf("'") + 1;
          res.writeHead(500, { 'content-type': 'text/html' });
          return res.end(`<b>Fatal error</b>: You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near '${sql.slice(at).replace(/'/g, '&#39;')}' at line 1`);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('[]');
      }
      case '/orders': {
        const j = JSON.parse(body || '{}') as Record<string, unknown>;
        if (typeof j.qty !== 'number') {
          res.writeHead(500, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: `java.lang.NumberFormatException: For input string: "${String(j.qty)}"\n\tat java.lang.Integer.parseInt(Integer.java:652)` }));
        }
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end('{"ok":true}');
      }
      case '/app.js':
        res.writeHead(200, { 'content-type': 'application/javascript' });
        return res.end('throw new Error("You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near \'x\' at line 1")');
      default:
        res.writeHead(404);
        res.end();
    }
  });
};

const send = (method: string, path: string, headers: Array<[string, string]> = [], body?: string, replayOf?: string) =>
  core.tools.sender.send({ method, url: `${base}${path}`, headers, body: body ? new TextEncoder().encode(body) : undefined, replayOf }, {});

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-errors-'));
  target = createServer(handler);
  const port = await new Promise<number>((r) => target.listen(0, '127.0.0.1', () => r((target.address() as AddressInfo).port)));
  base = `http://127.0.0.1:${port}`;
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd'), api: false });
});

afterAll(async () => {
  await core?.close();
  target?.closeAllConnections();
  await new Promise((r) => target?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe('error signatures', () => {
  it('are valid regexes with unique ids', () => {
    const ids = new Set<string>();
    for (const s of ERROR_SIGNATURES) {
      expect(() => new RegExp(s.pattern, s.flags ?? 'i')).not.toThrow();
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
    }
  });

  const one = (body: string) => detectErrors(body);

  it('recognizes database errors and captures what they quote', () => {
    expect(one(`ERROR:  syntax error at or near "ORDER"\nLINE 1: SELECT`)[0]).toEqual(expect.objectContaining({ sig: 'postgres-syntax', near: 'ORDER', kind: 'sql' }));
    expect(one("Unclosed quotation mark after the character string 'abc'.")[0]).toEqual(expect.objectContaining({ sig: 'mssql-quote', near: 'abc' }));
    expect(one('sqlite3.OperationalError: near "FROM": syntax error').map((h) => h.sig)).toContain('sqlite-error');
    expect(one('ORA-01756: quoted string not properly terminated')[0]!.sig).toBe('oracle-error');
    expect(one('SQLSTATE[42000]: Syntax error or access violation')[0]!.sig).toBe('sqlstate');
    expect(one('Cast to ObjectId failed for value "abc" (type string) at path "_id"')[0]).toEqual(expect.objectContaining({ near: 'abc', param: '_id', type: 'ObjectId' }));
  });

  it('recognizes stack traces and debug pages with file and line', () => {
    expect(one('Traceback (most recent call last):\n  File "/srv/app/views.py", line 42, in get\nKeyError: \'user\'').find((h) => h.sig === 'python-trace')).toEqual(expect.objectContaining({ file: '/srv/app/views.py', line: 42 }));
    expect(one('<b>Warning</b>:  include(): Failed opening \'x\' in <b>/var/www/index.php</b> on line <b>7</b>').map((h) => h.sig)).toEqual(expect.arrayContaining(['php-error', 'file-error']));
    expect(one("You're seeing this error because you have <code>DEBUG = True</code> in your Django settings")[0]!.sig).toBe('django-debug');
    expect(one('java.lang.IllegalStateException: boom\n\tat com.acme.Api.handle(Api.java:88)').find((h) => h.sig === 'java-trace')).toEqual(expect.objectContaining({ file: 'Api.java', line: 88 }));
  });

  it('ignores ordinary pages and scripts', () => {
    expect(one('<h1>Welcome</h1><p>Search our SQL tutorials.</p>')).toEqual([]);
    expect(scannable([['Content-Type', 'application/javascript']])).toBe(false);
    expect(scannable([['Content-Type', 'text/html; charset=utf-8']])).toBe(true);
  });
});

describe('attribution', () => {
  it('blames the value the error quotes', () => {
    const [hit] = detectErrors("You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'Brien' AND visible = 1' at line 1");
    const parts = requestParts({ url: "https://shop.test/search?q=O'Brien&page=2", headers: [['User-Agent', 'x']] }, null);
    const [top] = attribute(hit!, parts);
    expect(top).toEqual(expect.objectContaining({ in: 'query', name: 'q', value: "O'Brien" }));
    expect(top!.confidence).toBeGreaterThan(0.9);
    expect(top!.reasons.join(' ')).toMatch(/quotes text from this value/);
  });

  it('falls back to characters that break the interpreter, and to what changed since the original', () => {
    const [hit] = detectErrors('SQLSTATE[42000]: Syntax error');
    const now = requestParts({ url: 'https://shop.test/items?id=5;--&sort=name', headers: [] }, null);
    const was = requestParts({ url: 'https://shop.test/items?id=5&sort=name', headers: [] }, null);
    const causes = attribute(hit!, now, { original: was, similar: [] });
    expect(causes[0]).toEqual(expect.objectContaining({ name: 'id' }));
    expect(causes[0]!.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/changed from "5"/), expect.stringMatching(/statement separator/)]));
    expect(causes.some((c) => c.name === 'sort')).toBe(false);
  });

  it('reads JSON bodies as leaves', () => {
    const parts = requestParts({ url: 'https://x.test/o', headers: [['Content-Type', 'application/json']] }, '{"items":[{"qty":"ten"}],"note":"hi"}');
    expect(parts.filter((p) => p.in === 'json')).toEqual([
      { in: 'json', name: '$.items[0].qty', value: 'ten' },
      { in: 'json', name: '$.note', value: 'hi' },
    ]);
  });
});

describe('errors in captured traffic', () => {
  it('flags the exchange, finds the cause and the database', async () => {
    const ok = await send('GET', '/search?q=lamp');
    expect(ok.errors).toBeUndefined();
    const bad = await send('GET', "/search?q=lamp'", [], undefined, ok.id);
    expect(bad.status).toBe(500);
    expect(bad.errors).toEqual(['sql']);
    expect(core.store.search('error:sql').map((e) => e.id)).toEqual([bad.id]);
    expect(core.store.search('error:high').map((e) => e.id)).toEqual([bad.id]);
    expect(core.store.search('error:any -error:sql')).toEqual([]);

    const [f] = core.tools.errors.findings(bad.id);
    expect(f!.sig).toBe('mysql-syntax');
    expect(f!.causes[0]).toEqual(expect.objectContaining({ in: 'query', name: 'q', value: "lamp'" }));
    expect(f!.causes[0]!.reasons.join(' ')).toMatch(/original request, which did not error/);
    expect(core.tools.tech.hostReport('127.0.0.1').tech.find((t) => t.id === 'mysql')?.evidence).toEqual(['error: MySQL syntax error']);
    expect(core.store.errorCounts()).toEqual([{ kind: 'sql', severity: 'high', count: 1 }]);
  });

  it('blames a JSON field named in the error', async () => {
    await send('POST', '/orders', [['Content-Type', 'application/json']], '{"sku":"a1","qty":2}');
    const bad = await send('POST', '/orders', [['Content-Type', 'application/json']], '{"sku":"a1","qty":"two"}');
    const f = core.tools.errors.findings(bad.id).find((x) => x.sig === 'number-format')!;
    expect(f.near).toBe('two');
    expect(f.causes[0]).toEqual(expect.objectContaining({ in: 'json', name: '$.qty', value: 'two' }));
  });

  it('does not flag error text inside scripts', async () => {
    const js = await send('GET', '/app.js');
    expect(js.errors).toBeUndefined();
  });
});
