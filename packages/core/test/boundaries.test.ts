/**
 * Edge cases that an earlier mutation run showed no test would catch:
 * status classes in rules and search, the redirect-follow window, and how
 * technology confidence combines and crosses the "detected" threshold.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { CaptureStore, Core, DETECTED_THRESHOLD, compileSignatures, detect, statusMatches } from '@siteinquisition/core';
import { ProxyClient } from './proxy-client.js';

describe('status classes in rules', () => {
  it('matches a class only inside its hundred', () => {
    expect([399, 400, 451, 499, 500].map((s) => statusMatches('4xx', s))).toEqual([false, true, true, true, false]);
    expect(statusMatches('5XX', 503)).toBe(true);
    expect(statusMatches('6xx', 600)).toBe(false);
  });
  it('compares with each operator at the boundary', () => {
    expect([399, 400, 401].map((s) => statusMatches('>=400', s))).toEqual([false, true, true]);
    expect([399, 400, 401].map((s) => statusMatches('>400', s))).toEqual([false, false, true]);
    expect([399, 400, 401].map((s) => statusMatches('<=400', s))).toEqual([true, true, false]);
    expect([399, 400, 401].map((s) => statusMatches('<400', s))).toEqual([true, false, false]);
    expect([399, 400, 401].map((s) => statusMatches('400', s))).toEqual([false, true, false]);
    expect(statusMatches('=204', 204)).toBe(true);
  });
  it('treats no spec as any status and no status as no match', () => {
    expect(statusMatches(undefined, 200)).toBe(true);
    expect(statusMatches('2xx', undefined)).toBe(false);
    expect(statusMatches('teapot', 418)).toBe(false);
  });
});

describe('status filters in search', () => {
  let dir: string;
  let store: CaptureStore;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'siq-bound-'));
    store = CaptureStore.openProject(dir);
    for (const status of [199, 200, 299, 300, 499, 500, 599, 600]) {
      const e = store.addRequest({ source: 'proxy', startedAt: Date.now(), method: 'GET', url: `http://s.test/${status}`, httpVersion: '1.1', headers: [] });
      store.completeResponse(e.id, { status, headers: [] });
    }
  });
  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const statuses = (q: string) => store.search(q, { order: 'oldest' }).map((e) => e.status);

  it('keeps a class within its hundred', () => {
    expect(statuses('status:5xx')).toEqual([500, 599]);
    expect(statuses('status:2xx')).toEqual([200, 299]);
    expect(statuses('-status:5xx')).toEqual([199, 200, 299, 300, 499, 600]);
  });
  it('handles ranges and comparisons inclusively where they say so', () => {
    expect(statuses('status:299-499')).toEqual([299, 300, 499]);
    expect(statuses('status:>=500')).toEqual([500, 599, 600]);
    expect(statuses('status:>599')).toEqual([600]);
    expect(statuses('status:<200')).toEqual([199]);
  });
  it('rejects a filter it cannot read', () => {
    expect(() => store.search('status:abc')).toThrow(/invalid status filter/);
  });
});

describe('redirect window', () => {
  let dir: string;
  let core: Core;
  let target: Server;
  let port: number;
  let agent: ProxyClient;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'siq-redir-'));
    target = createServer((req, res) => {
      if (req.url === '/go') {
        res.writeHead(302, { location: '/landed' });
        return res.end();
      }
      res.end('ok');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    port = (target.address() as AddressInfo).port;
    core = await Core.open({ projectDir: join(dir, 'p'), dataDir: join(dir, 'd'), api: false, proxy: { port: 0, redirectWindowMs: 150 } });
    await core.setScope({ defaultAction: 'record', rules: [] });
    await core.start();
    agent = new ProxyClient({ uri: `http://127.0.0.1:${core.proxy.port}` });
  });
  afterAll(async () => {
    await core.close();
    target.closeAllConnections();
    target.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const settled = async (q: string) => {
    for (let i = 0; i < 100; i++) {
      const hit = core.store.search(q).find((e) => e.state !== 'pending');
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`nothing for ${q}`);
  };

  it('links a follow-up inside the window and not one after it', async () => {
    await agent.fetch(`http://127.0.0.1:${port}/go`, {}, 0);
    const hop = await settled('path:/go');
    await new Promise((r) => setTimeout(r, 400));
    await agent.fetch(`http://127.0.0.1:${port}/landed`, {}, 0);
    const late = await settled('path:/landed');
    expect(late.flowId).not.toBe(hop.flowId);

    await agent.fetch(`http://127.0.0.1:${port}/go`, {}, 0);
    const hop2 = (await core.store.search('path:/go')).find((e) => e.id !== hop.id)!;
    await agent.fetch(`http://127.0.0.1:${port}/landed`, {}, 0);
    for (let i = 0; i < 50 && core.store.getFlow(hop2.flowId).length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(core.store.getFlow(hop2.flowId).map((e) => e.path)).toEqual(['/go', '/landed']);
  });
});

describe('technology confidence', () => {
  const sigs = compileSignatures([
    {
      id: 'acme',
      name: 'Acme',
      category: 'framework',
      matchers: [
        { in: 'header', name: 'x-acme', weight: 0.5 },
        { in: 'cookie', name: 'acme_sid', weight: 0.5 },
        { in: 'path', match: '^/acme/' },
      ],
    },
  ] as never);
  const conf = (headers: Array<[string, string]>, path = '/') => detect({ host: 'a.test', path, requestHeaders: headers.filter(([k]) => k === 'Cookie'), responseHeaders: headers.filter(([k]) => k !== 'Cookie') }, sigs)[0]?.confidence;

  it('combines matches as 1 - product of misses, with 0.8 for an unweighted one', () => {
    expect(conf([])).toBeUndefined();
    expect(conf([['X-Acme', '1']])).toBe(0.5);
    expect(conf([['X-Acme', '1'], ['Cookie', 'acme_sid=9']])).toBe(0.75);
    expect(conf([], '/acme/home')).toBe(0.8);
    expect(conf([['X-Acme', '1'], ['Cookie', 'acme_sid=9']], '/acme/x')).toBe(0.95);
  });

  it('calls one half-weight match detected, at the threshold', () => {
    expect(DETECTED_THRESHOLD).toBe(0.5);
    expect(conf([['X-Acme', '1']])! >= DETECTED_THRESHOLD).toBe(true);
  });
});
