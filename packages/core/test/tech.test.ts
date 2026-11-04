import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { compileSignatures, Core, detect, htmlTags, readCsrfSource, SIGNATURES, validateSignature, type ExchangeSummary } from '@siteinquisition/core';

let tmp: string;
let core: Core;
let target: Server;
let base: string;
let djangoToken = 'dj-token-0000000001';
let railsToken = 'rails+token/AAAAAAAAAA==';
let issued = 0;

const handler = (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const cookie = req.headers.cookie ?? '';
    switch (url.pathname) {
      case '/form':
        djangoToken = `dj-token-${String(++issued).padStart(10, '0')}`;
        res.writeHead(200, { 'content-type': 'text/html', server: 'WSGIServer/0.2 CPython/3.12.1', 'set-cookie': [`csrftoken=${djangoToken}; Path=/`, 'AWSALB=abc123; Path=/'] });
        return res.end(`<form method="post"><input type="hidden" name="csrfmiddlewaretoken" value="${djangoToken}"></form>`);
      case '/rotate':
        djangoToken = 'dj-token-rotated-elsewhere';
        res.writeHead(204);
        return res.end();
      case '/submit': {
        const ok = req.headers['x-csrftoken'] === djangoToken && cookie.includes(`csrftoken=${djangoToken}`);
        res.writeHead(ok ? 200 : 403, { 'content-type': 'text/plain' });
        return res.end(ok ? 'saved' : 'CSRF verification failed');
      }
      case '/rails':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-runtime': '0.012345' });
        return res.end(`<html><head><meta name="csrf-param" content="authenticity_token" />\n<meta name="csrf-token" content="${railsToken.replace(/\+/g, '&#43;')}" /></head></html>`);
      case '/rails-post': {
        const ok = req.headers['x-csrf-token'] === railsToken;
        res.writeHead(ok ? 200 : 422);
        return res.end(ok ? 'ok' : 'InvalidAuthenticityToken');
      }
      case '/acme':
        res.writeHead(200, { 'x-acme-build': '42' });
        return res.end('acme');
      default:
        res.writeHead(404);
        res.end('nope');
    }
  });
};

const send = (method: string, path: string, headers: Array<[string, string]> = [], body?: string, opts = {}) =>
  core.tools.sender.send({ method, url: `${base}${path}`, headers, body: body ? new TextEncoder().encode(body) : undefined }, opts);

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-tech-'));
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

describe('signatures', () => {
  const sigs = compileSignatures(SIGNATURES);
  const ids = (input: Parameters<typeof detect>[0]) => detect(input, sigs).filter((h) => h.confidence >= 0.5).map((h) => h.tech);

  it('every built-in signature is valid and has a unique id', () => {
    const seen = new Set<string>();
    for (const s of SIGNATURES) {
      expect(() => validateSignature(s)).not.toThrow();
      expect(seen.has(s.id)).toBe(false);
      seen.add(s.id);
      for (const imp of s.implies ?? []) expect(SIGNATURES.some((x) => x.id === imp)).toBe(true);
    }
  });

  it('recognizes AWS, Cloudflare and Next.js from headers, cookies, paths and HTML', () => {
    expect(
      ids({
        host: 'abc123.execute-api.eu-west-1.amazonaws.com',
        path: '/prod/orders',
        requestHeaders: [['Authorization', 'AWS4-HMAC-SHA256 Credential=AKIA/20261104/eu-west-1/execute-api/aws4_request']],
        responseHeaders: [['x-amzn-RequestId', 'r1'], ['x-amz-apigw-id', 'g1'], ['Set-Cookie', 'AWSALB=x; Path=/']],
      }),
    ).toEqual(expect.arrayContaining(['aws', 'aws-api-gateway', 'aws-elb']));
    expect(ids({ host: 'example.com', path: '/', requestHeaders: [], responseHeaders: [['Server', 'cloudflare'], ['CF-RAY', '8abc-LHR']] })).toContain('cloudflare');
    const next = detect({ host: 'shop.test', path: '/_next/data/abc/index.json', requestHeaders: [], responseHeaders: [['x-powered-by', 'Next.js']], responseBody: '<script id="__NEXT_DATA__" type="application/json">' }, sigs).find((h) => h.tech === 'nextjs')!;
    expect(next.confidence).toBeGreaterThan(0.99);
    expect(next.evidence.join('\n')).toMatch(/x-powered-by: Next\.js/);
  });

  it('does not fire on unrelated traffic', () => {
    expect(ids({ host: 'plain.test', path: '/index.html', requestHeaders: [['Accept', '*/*']], responseHeaders: [['Content-Type', 'text/html']], responseBody: '<h1>hi</h1>' })).toEqual([]);
  });

  it('rejects malformed user signatures with a readable message', () => {
    expect(() => validateSignature({ id: 'Bad Id', name: 'x', category: 'framework', matchers: [] })).toThrow(/lower case/);
    expect(() => validateSignature({ id: 'x', name: 'x', category: 'nope', matchers: [] })).toThrow(/category/);
    expect(() => validateSignature({ id: 'x', name: 'x', category: 'server', matchers: [{ in: 'header' }] })).toThrow(/needs a name/);
    expect(() => validateSignature({ id: 'x', name: 'x', category: 'server', matchers: [{ in: 'path', match: '(' }] })).toThrow(/bad pattern/);
    expect(() => validateSignature({ id: 'x', name: 'x', category: 'server', matchers: [], checks: [{ text: 't', probe: { method: 'POST', path: '/x' } }] })).toThrow(/GET, HEAD or OPTIONS/);
  });

  it('reads tokens from meta tags, inputs, cookies and JSON', () => {
    const html = `<meta content="a&amp;b" name="csrf-token"><input value='v1' type=hidden name=_token>`;
    expect(htmlTags(html, 'meta')[0]).toEqual({ content: 'a&b', name: 'csrf-token' });
    expect(readCsrfSource({ from: 'meta', name: 'csrf-token' }, { headers: [], body: html })).toBe('a&b');
    expect(readCsrfSource({ from: 'input', name: '_token' }, { headers: [], body: html })).toBe('v1');
    expect(readCsrfSource({ from: 'cookie', name: 'XSRF-TOKEN', urlDecode: true }, { headers: [['Set-Cookie', 'XSRF-TOKEN=ab%3D%3D; Path=/']], body: null })).toBe('ab==');
    expect(readCsrfSource({ from: 'json', name: 'csrfToken' }, { headers: [], body: '{"data":{"csrfToken":"j1"}}' })).toBe('j1');
  });
});

describe('detection on captured traffic', () => {
  let form: ExchangeSummary;

  it('records what each host runs on, with evidence', async () => {
    form = await send('GET', '/form');
    const report = core.tools.tech.hostReport('127.0.0.1');
    const django = report.tech.find((t) => t.id === 'django')!;
    expect(django.status).toBe('detected');
    expect(django.evidence.join('\n')).toMatch(/cookie csrftoken/);
    expect(report.tech.find((t) => t.id === 'python')?.status).toBe('detected');
    expect(report.tech.find((t) => t.id === 'aws-elb')).toBeDefined();
    expect(core.store.search('tech:django').map((e) => e.id)).toContain(form.id);
    expect(core.store.search('tech:Django').length).toBeGreaterThan(0);
    expect(core.store.search('tech:laravel')).toEqual([]);
  });

  it('lets the user reject a wrong guess and pin a missed one', () => {
    core.tools.tech.override('127.0.0.1', 'django', 'reject');
    let report = core.tools.tech.hostReport('127.0.0.1');
    expect(report.tech.some((t) => t.id === 'django')).toBe(false);
    expect(report.rejected.map((r) => r.id)).toEqual(['django']);
    expect(core.store.search('tech:django')).toEqual([]);

    core.tools.tech.override('127.0.0.1', 'django', 'clear');
    core.tools.tech.override('127.0.0.*', 'spring', 'pin', 'the API behind it');
    report = core.tools.tech.hostReport('127.0.0.1');
    expect(report.tech.find((t) => t.id === 'django')?.status).toBe('detected');
    expect(report.tech.find((t) => t.id === 'spring')?.status).toBe('pinned');
    expect(report.tech.find((t) => t.id === 'java')?.status).toBe('implied');
    expect(core.store.search('tech:java').length).toBeGreaterThan(0);

    // An exact-host rule beats a glob.
    core.tools.tech.override('127.0.0.1', 'spring', 'reject');
    expect(core.tools.tech.hostReport('127.0.0.1').tech.some((t) => t.id === 'spring')).toBe(false);
    core.tools.tech.setOverrides([]);
  });

  it('turns signatures off per project and takes custom ones', async () => {
    core.tools.tech.setDisabled(['django']);
    expect(core.tools.tech.hostReport('127.0.0.1').tech.some((t) => t.id === 'django')).toBe(false);
    core.tools.tech.setDisabled([]);

    expect(() => core.tools.tech.setCustom([{ id: 'acme', name: 'Acme', category: 'framework', matchers: [] }, { id: 'acme', name: 'Acme 2', category: 'framework', matchers: [] }])).toThrow(/used twice/);
    core.tools.tech.setCustom([{ id: 'acme', name: 'Acme framework', category: 'framework', matchers: [{ in: 'header', name: 'x-acme-*', weight: 0.9 }], infraCookies: [] }]);
    await send('GET', '/acme');
    expect(core.tools.tech.hostReport('127.0.0.1').tech.find((t) => t.id === 'acme')?.name).toBe('Acme framework');

    const r = core.tools.tech.rescan();
    expect(r.exchanges).toBeGreaterThan(1);
    expect(core.tools.tech.hostReport('127.0.0.1').tech.some((t) => t.id === 'acme')).toBe(true);
    core.tools.tech.setCustom([]);
  });

  it('flags platform cookies, and the user can overrule it', () => {
    const alb = core.tools.tech.annotateJar().find((c) => c.name === 'AWSALB')!;
    expect(alb.infra).toMatch(/load balancer/);
    expect(core.tools.tech.annotateJar().find((c) => c.name === 'csrftoken')!.infra).toBeNull();
    core.tools.tech.setCookieOverrides([{ name: 'AWSALB', infra: false }, { name: 'csrftoken', infra: true }]);
    expect(core.tools.tech.annotateJar().find((c) => c.name === 'AWSALB')!.infra).toBeNull();
    expect(core.tools.tech.annotateJar().find((c) => c.name === 'csrftoken')!.infra).toMatch(/by you/);
    core.tools.tech.setCookieOverrides([]);
  });

  it('sends a suggested check only when asked', async () => {
    const before = core.store.search('tag:check').length;
    const res = await core.tools.runCheck(new URL(base).host, 'django', 0, 'http');
    expect(res.url).toBe(`${base}/admin/`);
    expect(core.store.search('tag:check').length).toBe(before + 1);
    await expect(core.tools.runCheck('127.0.0.1', 'nginx', 0)).rejects.toThrow(/no check/);
  });
});

describe('CSRF tokens', () => {
  it('finds a double-submit token and keeps it fresh on replay', async () => {
    await send('GET', '/form');
    const post = await send('POST', '/submit', [['X-CSRFToken', djangoToken], ['Cookie', `csrftoken=${djangoToken}`], ['Content-Type', 'application/x-www-form-urlencoded']], 'name=ada');
    expect(post.status).toBe(200);

    const [f] = core.tools.tech.csrfFindings(post.id);
    expect(f!.sink).toEqual({ in: 'header', name: 'X-CSRFToken' });
    expect(f!.how).toBe('cookie-echo');
    expect(f!.source).toEqual({ from: 'cookie', name: 'csrftoken' });
    expect(f!.tech).toBe('django');
    const [binding] = core.tools.tech.setCsrfBindings([f!.suggestion!]);
    expect(core.tools.tech.csrfFindings(post.id)[0]!.bindingId).toBe(binding!.id);

    // A new page hands out a new token; the variable follows it.
    await send('GET', '/form');
    expect(core.tools.vars.values()[binding!.varName]).toBe(djangoToken);

    const ex = core.store.getExchange(post.id)!;
    const stale = { headers: ex.requestHeaders, body: 'name=ada' };
    expect((await send('POST', '/submit', stale.headers, stale.body)).status).toBe(403);
    const fixed = await send('POST', '/submit', stale.headers, stale.body, { csrf: true });
    expect(fixed.status).toBe(200);
    expect(fixed.tags).toContain(`csrf:${binding!.varName}`);
  });

  it('loads a fresh token and retries when the server rejects the one it has', async () => {
    await fetch(`${base}/rotate`);
    const ex = core.store.search('path:/submit status:200')[0]!;
    const full = core.store.getExchange(ex.id)!;
    const res = await send('POST', '/submit', full.requestHeaders, 'name=ada', { csrf: true });
    expect(res.status).toBe(200);
    expect(res.tags).toContain('after-csrf-refresh');
    expect(core.store.search('tag:csrf-refresh').length).toBe(1);
  });

  it('traces a token back to the meta tag it came from', async () => {
    const page = await send('GET', '/rails');
    const post = await send('POST', '/rails-post', [['X-CSRF-Token', railsToken], ['Content-Type', 'application/json']], '{"a":1}');
    expect(post.status).toBe(200);
    const [f] = core.tools.tech.csrfFindings(post.id);
    expect(f!.how).toBe('value-match');
    expect(f!.source).toEqual({ from: 'meta', name: 'csrf-token' });
    expect(f!.sourceExchangeId).toBe(page.id);
    expect(f!.suggestion!.refreshUrl).toBe(`${base}/rails`);
    expect(core.tools.tech.hostReport('127.0.0.1').tech.some((t) => t.id === 'rails')).toBe(true);

    // The binding is new, so no token has been captured for it yet: one is loaded before sending.
    const [, rails] = core.tools.tech.setCsrfBindings([...core.tools.tech.csrfBindings(), f!.suggestion!]);
    railsToken = 'rails-second-token-BBBBBB';
    const refreshes = core.store.search('tag:csrf-refresh').length;
    const res = await send('POST', '/rails-post', [['X-CSRF-Token', 'old-token-value'], ['Content-Type', 'application/json']], '{"a":1}', { csrf: true });
    expect(res.status).toBe(200);
    expect(res.tags).toContain(`csrf:${rails!.varName}`);
    expect(core.store.search('tag:csrf-refresh').length).toBe(refreshes + 1);
    expect(core.tools.vars.values()[rails!.varName]).toBe(railsToken);
  });

  it('validates bindings', () => {
    expect(() => core.tools.tech.setCsrfBindings([{ host: 'x', varName: 'bad name', source: { from: 'cookie', name: 'c' }, sinks: [{ in: 'header', name: 'h' }] }])).toThrow(/invalid variable/);
    expect(() => core.tools.tech.setCsrfBindings([{ host: 'x', varName: 'v', source: { from: 'cookie', name: 'c' }, sinks: [] }])).toThrow(/at least one/);
  });
});
