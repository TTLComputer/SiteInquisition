import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProxyClient } from './proxy-client.js';
import { serveWebSockets } from '../src/websocket.js';
import { Core, batchPlan, coverage, parseSigV4, pathTemplate, readRuntimeInfo, resolveTokens, runRace, signSigV4, type ExchangeSummary } from '@siteinquisition/core';

let tmp: string;
let core: Core;
let target: Server;
let port: number;
let base: string;
let agent: ProxyClient;
let mcpUrl: string;
let token: string;

const handler = (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    switch (url.pathname) {
      case '/headers':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(req.headers));
      case '/echo':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(body);
      case '/profile':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ user: { name: 'ada', role: 'user' } }));
      case '/login':
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=ok; Path=/' });
        return res.end(JSON.stringify({ token: 'tok-123' }));
      case '/private':
        if (!/session=ok/.test(req.headers.cookie ?? '')) {
          res.writeHead(401);
          return res.end('log in');
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('secret');
      case '/app':
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<a href="/items/7">item</a><script>fetch("/api/v1/orders/42/cancel")</script><img src="/logo.png">');
      default:
        if (url.pathname.startsWith('/items/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end('{"ok":true}');
        }
        res.writeHead(404);
        res.end('nope');
    }
  });
};

async function waitFor(query: string, count = 1): Promise<ExchangeSummary[]> {
  for (let i = 0; i < 150; i++) {
    const hits = core.store.search(query, { order: 'oldest' }).filter((e) => e.state !== 'pending');
    if (hits.length >= count) return hits;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${count} x "${query}"`);
}

const until = async <T>(fn: () => T | undefined, what: string): Promise<T> => {
  for (let i = 0; i < 150; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const mcp = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: res.status === 200 ? ((await res.json()) as Record<string, any>) : null };
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-tools-'));
  target = createServer(handler);
  serveWebSockets(target, (ws, req) => {
    ws.send(`hello ${req.headers.cookie ?? 'anon'}`);
    ws.on('message', (d) => ws.send(`echo:${d.toString()}`));
  });
  port = await new Promise<number>((r) => target.listen(0, '127.0.0.1', () => r((target.address() as AddressInfo).port)));
  base = `http://127.0.0.1:${port}`;
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd') });
  await core.setScope({ defaultAction: 'ignore', rules: [{ action: 'include', host: '127.0.0.1' }] });
  const { proxyPort } = await core.start();
  agent = new ProxyClient({ uri: `http://127.0.0.1:${proxyPort}` });
  const info = readRuntimeInfo(join(tmp, 'p'))!;
  mcpUrl = `http://127.0.0.1:${info.apiPort}/mcp`;
  token = info.token;
});

afterAll(async () => {
  agent?.close();
  await core?.close();
  target?.closeAllConnections();
  await new Promise((r) => target?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe('tokens', () => {
  const ctx = {
    url: 'https://app.test/api',
    cookies: () => [{ name: 'sid', value: 'abc', domain: 'app.test', hostOnly: true, path: '/', expires: null, httpOnly: true, secure: true, sameSite: null, setBy: 'x', setAt: 1, expired: false }],
    vars: () => ({ user: 'ada' }),
  };

  it('resolves cookies, variables and generators, and leaves escaped tokens alone', () => {
    const out = resolveTokens('{{cookie:sid}} {{var:user}} {{uuid}} {{random:4}} \\{{var:user}}', ctx as never);
    expect(out).toMatch(/^abc ada [0-9a-f-]{36} \S{4} \{\{var:user\}\}$/);
    expect(() => resolveTokens('{{cookie:nope}}', ctx as never)).toThrow(/no cookie "nope"/);
  });

  it('zips counters and lists into one send per value', () => {
    const dir = join(tmp, 'lists');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'names.txt'), 'x\ny\nz\n');
    const plan = batchPlan(['/u/{{counter:1..3}}', 'name={{list:names.txt}}'], dir);
    expect(plan.map((m) => [...m.values()])).toEqual([
      ['1', 'x'],
      ['2', 'y'],
      ['3', 'z'],
    ]);
    expect(resolveTokens('/u/{{counter:1..3}}', { ...ctx, batch: plan[1] } as never)).toBe('/u/2');
  });
});

describe('SigV4', () => {
  it('matches the S3 GET Object example from the AWS docs', () => {
    const headers = signSigV4(
      { method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: [['Range', 'bytes=0-9']] },
      { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      { region: 'us-east-1', service: 's3' },
      new Date('2013-05-24T00:00:00Z'),
    );
    const auth = headers.find(([k]) => k === 'Authorization')![1];
    expect(auth).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(parseSigV4(auth)).toMatchObject({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', region: 'us-east-1', service: 's3', date: '20130524' });
  });
});

describe('proxy hooks', () => {
  it('applies request header rules, response body rules and mocks, and tags what ran', async () => {
    core.tools.setReplaceRules([
      { name: 'add-debug', phase: 'request', target: 'header', header: 'X-Debug', action: 'set', replace: '{{var:dbg}}', host: '127.0.0.1' },
      { name: 'make-admin', phase: 'response', target: 'body', chain: 'json', jsonPath: '$.user.role', replace: 'admin', pathPrefix: '/profile' },
    ]);
    core.tools.setMocks([{ name: 'fake-flags', pathPrefix: '/flags', status: 200, headers: [['content-type', 'application/json']], body: '{"beta":true}' }]);
    core.tools.vars.set('dbg', 'on', 'manual');

    const h = (await (await agent.fetch(`${base}/headers`)).json()) as Record<string, string>;
    expect(h['x-debug']).toBe('on');
    expect(await (await agent.fetch(`${base}/profile`)).json()).toEqual({ user: { name: 'ada', role: 'admin' } });
    const flags = await agent.fetch(`${base}/flags`);
    expect([flags.status, await flags.json()]).toEqual([200, { beta: true }]);

    const [p] = await waitFor('path:/profile');
    expect(p!.tags).toEqual(expect.arrayContaining(['rule:add-debug', 'rule:make-admin']));
    const [f] = await waitFor('path:/flags');
    expect(f!.tags).toContain('mock:fake-flags');
    expect(core.tools.ruleHits()[core.tools.replaceRules()[1]!.id]).toBeGreaterThan(0);
    core.tools.setReplaceRules([]);
    core.tools.setMocks([]);
  });

  it('pauses on a breakpoint and forwards the edited request', async () => {
    core.tools.setBreakpoints([{ phase: 'request', pathPrefix: '/echo' }]);
    const pending = agent.fetch(`${base}/echo`, { method: 'POST', body: 'original' });
    const paused = await until(() => core.tools.intercept.list()[0], 'a paused request');
    expect(paused).toMatchObject({ phase: 'request', message: { method: 'POST' } });
    expect(Buffer.from(paused.message.bodyBase64, 'base64').toString()).toBe('original');
    core.tools.intercept.resolve(paused.id, { action: 'forward', edits: { bodyBase64: Buffer.from('edited').toString('base64') } });
    expect(await (await pending).text()).toBe('edited');
    core.tools.setBreakpoints([]);
  });

  it('runs hook scripts on responses and test scripts with the SDK', async () => {
    core.tools.setScripts([{ name: 'stamp', kind: 'hook', code: 'function onResponse(req, res) { res.setHeader("x-stamped", "yes"); }' }]);
    const res = await agent.fetch(`${base}/items/3`);
    expect(res.headers.get('x-stamped')).toBe('yes');
    await res.text();
    const [ex] = await waitFor('path:/items/3');
    expect(ex!.tags).toContain('script:stamp');
    core.tools.setScripts([]);

    const run = await core.tools.runScript({
      id: 't',
      name: 'suite',
      kind: 'test',
      code: `
        test('items answer ok', async () => {
          const hits = siq.search('path:/items/');
          expect(hits.length).toBeGreaterThan(0);
          const r = await siq.send({ method: 'GET', url: '${base}/items/9', headers: [] });
          expect(r.status).toBe(200);
        });
        test('fails visibly', () => expect(1).toBe(2));
        console.log('done');
      `,
    });
    expect(run.tests.map((t) => [t.name, t.ok])).toEqual([
      ['items answer ok', true],
      ['fails visibly', false],
    ]);
    expect(run.logs.map((l) => l.text)).toContain('done');
  });
});

describe('sending', () => {
  it('runs the login macro on a 401 and sends again with fresh cookies', async () => {
    core.tools.setMacros([{ name: 'login', host: '127.0.0.1', steps: [{ method: 'POST', url: `${base}/login`, headers: [] }] }]);
    core.tools.vars.setExtractors([{ name: 'apiToken', from: 'json', key: '$.token', pathPrefix: '/login' }]);
    const res = await core.tools.sender.send({ method: 'GET', url: `${base}/private`, headers: [] }, { loginMacro: true });
    expect(res.status).toBe(200);
    expect(res.tags).toEqual(expect.arrayContaining(['after-login:login']));
    expect(core.tools.vars.values().apiToken).toBe('tok-123');
  });

  it('sends one request per counter value and tags them as one batch', async () => {
    const out = await core.tools.sender.sendBatch({ method: 'GET', url: `${base}/items/{{counter:10..12}}`, headers: [] }, { concurrency: 2 });
    expect(out.errors).toEqual([]);
    expect(out.sends.map((s) => s.path).sort()).toEqual(['/items/10', '/items/11', '/items/12']);
    expect(core.store.search(`tag:batch:${out.batchId}`)).toHaveLength(3);
  });

  it('races requests with last-byte sync and records each run as one flow', async () => {
    const reqs = [0, 0, 5].map((offsetMs, i) => ({ method: 'POST', url: `${base}/echo`, headers: [['content-type', 'text/plain']] as [string, string][], body: Buffer.from(`r${i}`), offsetMs }));
    const result = await runRace(core.store, reqs, { sync: 'last-byte', repeat: 2 });
    expect(result.runs).toHaveLength(2);
    for (const run of result.runs) {
      expect(run.sends.map((s) => s.status)).toEqual([200, 200, 200]);
      expect(new Set(run.sends.map((s) => core.store.getSummary(s.exchangeId)!.flowId))).toEqual(new Set([run.flowId]));
    }
    expect(core.store.search(`tag:race:${result.id}`)).toHaveLength(6);
  });

  it('opens a WebSocket replay, sends frames on it and records both directions', async () => {
    await core.tools.sender.send({ method: 'GET', url: `${base}/login`, headers: [] }, {});
    const { exchangeId } = await core.tools.ws.connect({ url: `ws://127.0.0.1:${port}/live`, headers: [['Cookie', 'session=ok']] });
    core.tools.ws.send(exchangeId, Buffer.from('hi'), 'text');
    const stream = core.store.getStreamForExchange(exchangeId)!;
    const msgs = await until(() => {
      const m = core.store.getStreamMessages(stream.id);
      return m.length >= 3 ? m : undefined;
    }, 'three frames');
    expect(msgs.map((m) => `${m.direction}:${Buffer.from(m.payload).toString()}`)).toEqual(['server:hello session=ok', 'client:hi', 'server:echo:hi']);
    core.tools.ws.close(exchangeId);
    await until(() => !core.tools.ws.isOpen(exchangeId) || undefined, 'close');
  });
});

describe('coverage', () => {
  it('collapses ids into templates', () => {
    expect(pathTemplate('/api/orders/42/items/3f2b8c1e-1d2c-4b5a-9e8f-0a1b2c3d4e5f?x=1')).toBe('/api/orders/{n}/items/{uuid}');
    expect(pathTemplate('/u/ada%40example.com')).toBe('/u/{email}');
  });

  it('lists exercised endpoints and paths the app references that nobody requested', async () => {
    await (await agent.fetch(`${base}/app`)).text();
    await waitFor('path:/app');
    const report = coverage(core.store, '127.0.0.1');
    const items = report.endpoints.find((e) => e.method === 'GET' && e.template === '/items/{n}')!;
    expect(items.count).toBeGreaterThanOrEqual(4);
    expect(items.statuses['200']).toBe(items.count);
    expect(report.endpoints.find((e) => e.template === '/echo' && e.method === 'POST')).toBeTruthy();
    const paths = report.unexercised.map((u) => u.path);
    expect(paths).toContain('/api/v1/orders/42/cancel');
    expect(paths).not.toContain('/items/7');
    expect(paths).not.toContain('/logo.png');
  });
});

describe('MCP over HTTP', () => {
  it('refuses calls without the token or from a web page', async () => {
    expect((await fetch(mcpUrl, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('initializes, lists tools and runs a read tool', async () => {
    const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(init.json!.result).toMatchObject({ serverInfo: { name: 'siteinquisition' }, capabilities: { tools: {} } });
    expect((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = list.json!.result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    expect(tools.find((t) => t.name === 'search_traffic')!.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'replay_request')!.annotations.readOnlyHint).toBe(false);
    const found = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_traffic', arguments: { query: 'path:/profile' } } });
    expect(JSON.parse(found.json!.result.content[0].text)[0]).toMatchObject({ method: 'GET', status: 200 });
  });

  it('holds write tools until the user approves, and reports a denial', async () => {
    const [ex] = await waitFor('path:/profile');
    const call = (id: number) => mcp({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'tag_exchange', arguments: { id: ex!.id, tags: ['from-agent'] } } });

    const first = call(4);
    const approval = await until(() => core.tools.mcp.approvals()[0], 'an approval');
    expect(approval.summary).toContain('from-agent');
    core.tools.mcp.decide(approval.id, 'once');
    expect((await first).json!.result.isError).toBeUndefined();
    expect(core.store.getSummary(ex!.id)!.tags).toEqual(['from-agent']);

    const second = call(5);
    core.tools.mcp.decide((await until(() => core.tools.mcp.approvals()[0], 'an approval')).id, 'deny');
    expect((await second).json!.result).toMatchObject({ isError: true });
    expect(core.tools.mcp.activity.map((a) => a.outcome).slice(-2)).toEqual(['ok', 'denied']);
  });
});
