import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { ProxyClient } from './proxy-client.js';
import { Core, excerpt, parseEndpointKey, type ExchangeSummary } from '@siteinquisition/core';

let tmp: string;
let core: Core;
let target: Server;
let base: string;
let agent: ProxyClient;

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

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-overrides-'));
  target = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url?.startsWith('/echo') ? Buffer.concat(chunks) : JSON.stringify({ path: req.url, role: 'user' }));
    });
  });
  const port = await new Promise<number>((r) => target.listen(0, '127.0.0.1', () => r((target.address() as AddressInfo).port)));
  base = `http://127.0.0.1:${port}`;
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd') });
  await core.setScope({ defaultAction: 'ignore', rules: [{ action: 'include', host: '127.0.0.1' }] });
  const { proxyPort } = await core.start();
  agent = new ProxyClient({ uri: `http://127.0.0.1:${proxyPort}` });
});

afterAll(async () => {
  agent?.close();
  await core?.close();
  target?.closeAllConnections();
  await new Promise((r) => target?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe('transformation explanations', () => {
  it('records what each rule and mock did, with the rule revision', async () => {
    const [rule] = core.tools.setReplaceRules([{ name: 'make-admin', phase: 'response', target: 'body', chain: 'json', jsonPath: '$.role', replace: 'admin', pathPrefix: '/users' }]);
    core.tools.setMocks([{ name: 'fake-flags', pathPrefix: '/flags', status: 418, headers: [], body: 'mocked' }]);
    await (await agent.fetch(`${base}/users/7`)).text();
    await (await agent.fetch(`${base}/flags`)).text();
    await (await agent.fetch(`${base}/plain`)).text();
    const [u] = await waitFor('path:/users');
    const t = await until(() => core.store.transforms(u!.id)[0], 'a transform');
    expect(t).toMatchObject({ phase: 'response', kind: 'replace', ruleId: rule!.id, name: 'make-admin', outcome: 'changed', target: 'body' });
    expect(t.before).toContain('"user"');
    expect(t.after).toContain('admin');
    expect(t.revision).toMatch(/^[0-9a-f]{12}$/);
    const [f] = await waitFor('path:/flags');
    expect(core.store.transforms(f!.id)).toMatchObject([{ kind: 'mock', name: 'fake-flags', outcome: 'answered' }]);
    const [p] = await waitFor('path:/plain');
    expect(core.store.transforms(p!.id)).toEqual([]);
    core.tools.setReplaceRules([]);
    core.tools.setMocks([]);
  });

  it('keeps a large change to a short excerpt around the difference', () => {
    const a = 'x'.repeat(5000) + 'old' + 'y'.repeat(5000);
    const b = 'x'.repeat(5000) + 'new' + 'y'.repeat(5000);
    const e = excerpt(a, b);
    expect(e.truncated).toBe(true);
    expect(e.before.length).toBeLessThan(500);
    expect(e.before).toContain('old');
    expect(e.after).toContain('new');
  });
});

describe('suspending overrides', () => {
  it('stops mocks and rules without changing their own switches, and survives reopening', async () => {
    core.tools.setMocks([{ name: 'm', pathPrefix: '/flags', status: 418, headers: [], body: 'mocked' }]);
    expect((await agent.fetch(`${base}/flags`)).status).toBe(418);
    core.tools.overrides.setSuspended(true);
    const live = await agent.fetch(`${base}/flags`);
    expect(live.status).toBe(200);
    await live.text();
    expect(core.tools.mocks()[0]!.enabled).not.toBe(false);
    const hits = await waitFor('path:/flags', 3);
    expect(hits.at(-1)!.tags).toContain('overrides:suspended');
    expect(core.store.getMeta<{ suspended: boolean }>('overridesSuspended')).toMatchObject({ suspended: true });
    core.tools.overrides.setSuspended(false);
    expect((await agent.fetch(`${base}/flags`)).status).toBe(418);
    core.tools.setMocks([]);
  });

  it('leaves traffic already paused at a breakpoint paused, and pauses nothing new', async () => {
    core.tools.setBreakpoints([{ phase: 'request', pathPrefix: '/echo' }]);
    const pending = agent.fetch(`${base}/echo`, { method: 'POST', body: 'held' });
    const paused = await until(() => core.tools.intercept.list()[0], 'a paused request');
    core.tools.overrides.setSuspended(true);
    expect(core.tools.intercept.list().map((p) => p.id)).toEqual([paused.id]);
    expect(await (await agent.fetch(`${base}/echo`, { method: 'POST', body: 'free' })).text()).toBe('free');
    core.tools.intercept.resolve(paused.id, { action: 'forward' });
    expect(await (await pending).text()).toBe('held');
    core.tools.overrides.setSuspended(false);
    core.tools.setBreakpoints([]);
  });
});

describe('override groups', () => {
  it('turns members on and off together, reports shared members, and refuses a group with a missing member', () => {
    const [m1, m2] = core.tools.setMocks([
      { name: 'a', pathPrefix: '/a', status: 200, headers: [], body: '', enabled: false },
      { name: 'b', pathPrefix: '/b', status: 200, headers: [], body: '', enabled: false },
    ]);
    const [r] = core.tools.setReplaceRules([{ name: 'r', phase: 'request', target: 'url', find: 'x', replace: 'y', enabled: false }]);
    const [g1, g2] = core.tools.overrides.setGroups([
      { name: 'Checkout outage', members: [{ kind: 'mock', id: m1!.id }, { kind: 'replace', id: r!.id }] },
      { name: 'Other', members: [{ kind: 'mock', id: m1!.id }, { kind: 'mock', id: m2!.id }] },
    ]);
    const dry = core.tools.overrides.applyGroup(g1!.id, true, { dryRun: true });
    expect(dry.changed).toHaveLength(2);
    expect(dry.shared).toEqual([{ kind: 'mock', id: m1!.id, groups: ['Other'] }]);
    expect(core.tools.mocks()[0]!.enabled).toBe(false);
    core.tools.overrides.applyGroup(g1!.id, true);
    expect([core.tools.mocks()[0]!.enabled, core.tools.mocks()[1]!.enabled, core.tools.replaceRules()[0]!.enabled]).toEqual([true, false, true]);
    // Remove b: the second group now names something missing, and nothing changes.
    core.tools.setMocks([core.tools.mocks()[0]!]);
    expect(() => core.tools.overrides.applyGroup(g2!.id, false)).toThrow(/Nothing was changed/);
    expect(core.tools.mocks()[0]!.enabled).toBe(true);
    core.tools.setMocks([]);
    core.tools.setReplaceRules([]);
    core.tools.overrides.setGroups([]);
  });
});

describe('endpoint detail', () => {
  it('brings observations, notes, related overrides and flows together under one reference', async () => {
    await (await agent.fetch(`${base}/orders/41`)).text();
    await (await agent.fetch(`${base}/orders/42`)).text();
    await waitFor('path:/orders', 2);
    const host = new URL(base).hostname;
    const key = `${host} GET /orders/{n}`;
    expect(parseEndpointKey(key)).toEqual({ host, method: 'GET', template: '/orders/{n}' });
    core.tools.setEndpointNote(`${host} GET /orders/{id}`, 'owned by checkout');
    core.tools.setEndpointAlias(`${host} GET /orders/{id}`, key);
    core.tools.setMocks([{ name: 'orders-down', pathPrefix: '/orders', status: 503, headers: [], body: '', enabled: false }, { name: 'elsewhere', pathPrefix: '/cart', status: 200, headers: [], body: '' }]);
    core.tools.saveFlow({ name: 'buy', steps: [{ id: 's1', kind: 'request', method: 'GET', url: `${base}/orders/{{var:id}}` }] });

    const d = core.tools.endpoint(`${host} GET /orders/{id}`);
    expect(d.key).toBe(key);
    expect(d.aliases).toEqual([`${host} GET /orders/{id}`]);
    expect(d.observed?.count).toBe(2);
    expect(d.recent).toHaveLength(2);
    expect(d.documented).toEqual([]);
    expect(d.notes?.notes).toBe('owned by checkout');
    expect(d.related.mocks).toEqual([{ id: expect.any(String), name: 'orders-down', enabled: false }]);
    expect(d.related.flows).toMatchObject([{ name: 'buy', steps: [0] }]);

    const none = core.tools.endpoint(`${host} DELETE /orders/{n}`);
    expect([none.observed, none.recent.length]).toEqual([null, 0]);
    expect(() => core.tools.setEndpointAlias(key, `${host} GET /orders/{id}`)).toThrow(/loop/);
    core.tools.setMocks([]);
  });
});
