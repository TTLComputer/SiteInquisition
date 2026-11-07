import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { Core, effectiveValues, rebase } from '@siteinquisition/core';

let tmp: string;
let core: Core;
let target: Server;
let base: string;
const seen: Array<{ url: string; headers: Record<string, unknown> }> = [];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-repro-'));
  target = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    req.resume();
    req.on('end', () => {
      if (req.url?.startsWith('/login')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"token":"t-1"}');
      }
      res.writeHead(req.url?.includes('fail') ? 500 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ order: { id: 42, coupon: new URL(req.url ?? '/', 'http://x').searchParams.get('c') } }));
    });
  });
  const port = await new Promise<number>((r) => target.listen(0, '127.0.0.1', () => r((target.address() as AddressInfo).port)));
  base = `http://127.0.0.1:${port}`;
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd') });
});

afterAll(async () => {
  await core?.close();
  target?.closeAllConnections();
  await new Promise((r) => target?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe('saved reproductions', () => {
  it('runs with assertions, keeps the revision each run used, and refuses a stale save', async () => {
    const r = core.tools.repros.save({
      name: 'apply coupon',
      definition: { kind: 'request', request: { method: 'GET', url: `${base}/orders?c={{var:code}}`, headers: [['Cookie', 'sid=abc']] } },
      inputs: { code: 'SAVE10' },
      assertions: [{ status: '2xx' }, { where: { in: 'json', name: '$.order.coupon', value: 'SAVE10', side: 'response' } }, { maxMs: 10_000 }],
    });
    expect(r.revision).toBe(1);
    const run1 = await core.tools.repros.run(r.id);
    expect(run1).toMatchObject({ state: 'passed', revision: 1, inputSources: { code: 'reproduction' } });
    expect(run1.assertions.map((a) => a.passed)).toEqual([true, true, true]);
    expect(core.store.getSummary(run1.exchangeIds[0]!)!.path).toBe('/orders?c=SAVE10');

    // Explicit inputs win, and a failed assertion fails the run.
    const run2 = await core.tools.repros.run(r.id, { inputs: { code: 'OTHER' } });
    expect(run2.state).toBe('failed');
    expect(run2.inputSources.code).toBe('run');
    expect(run2.assertions[1]).toMatchObject({ passed: false });
    expect(JSON.stringify(core.tools.repros.runs(r.id))).not.toContain('OTHER');

    const r2 = core.tools.repros.save({ ...r, definition: { kind: 'request', request: { method: 'GET', url: `${base}/fail`, headers: [] } } }, 1);
    expect(r2.revision).toBe(2);
    expect(() => core.tools.repros.save({ ...r, name: 'apply coupon' }, 1)).toThrow(/Nothing was saved/);
    expect(core.tools.repros.runs(r.id)[0]!.revision).toBe(1);
    expect((core.tools.repros.revisionOf(r.id, 1)!.definition as { request: { url: string } }).request.url).toContain('{{var:code}}');
    expect((await core.tools.repros.run(r.id)).state).toBe('failed');
  });

  it('takes values in order run, reproduction, profile, project, and says where each came from', () => {
    const v = effectiveValues({ a: 'project', b: 'project', c: 'project', d: 'project' }, { id: 'p', name: 'staging', values: { b: 'profile', c: 'profile', d: 'profile' } }, { inputs: { c: 'repro', d: 'repro' } }, { d: 'run' });
    expect(v.map((x) => [x.name, x.value, x.source])).toEqual([
      ['a', 'project', 'project'],
      ['b', 'profile', 'profile'],
      ['c', 'repro', 'reproduction'],
      ['d', 'run', 'run'],
    ]);
    expect(rebase('https://prod.example.com/api/x?y=1', 'https://staging.example.com/v2')).toBe('https://staging.example.com/v2/api/x?y=1');
  });

  it('runs with a session profile: its values, setup flow and destination, without carrying old credentials', async () => {
    core.tools.saveFlow({ name: 'login', steps: [{ id: 's1', kind: 'request', method: 'GET', url: `${base}/login`, extract: [{ name: 'token', from: '$.token' }] }] });
    const [p] = core.tools.repros.setProfiles([{ name: 'local', values: { code: 'PROFILE' }, setupFlow: 'login', baseUrl: base.replace('127.0.0.1', 'localhost') }]);
    const r = core.tools.repros.save({
      name: 'with profile',
      definition: { kind: 'request', request: { method: 'GET', url: `${base}/orders?c={{var:code}}`, headers: [['Cookie', 'sid=abc'], ['Authorization', 'Bearer old']] } },
      profile: p!.name,
    });
    const eff = core.tools.repros.effective(r.id);
    expect(eff.values.find((x) => x.name === 'code')).toEqual({ name: 'code', value: 'PROFILE', source: 'profile' });
    seen.length = 0;
    const run = await core.tools.repros.run(r.id);
    expect(run.state).toBe('passed');
    expect(seen.map((s) => s.url)).toEqual(['/login', '/orders?c=PROFILE']);
    expect(seen[1]!.headers.authorization).toBeUndefined();
    expect(seen[1]!.headers.cookie).toBeUndefined();
    expect(run.notes.join(' ')).toMatch(/Cookie and Authorization headers were left out/);
    await expect(core.tools.repros.run(r.id, { profile: 'nobody' })).rejects.toThrow(/no session profile/);
  });

  it('promotes a request to a flow without losing its identity, and marks unfinished runs interrupted on restart', async () => {
    const r = core.tools.repros.save({ name: 'one order', definition: { kind: 'request', request: { method: 'GET', url: `${base}/orders`, headers: [] } }, source: { exchangeId: 'ex-1' } });
    const promoted = core.tools.repros.promoteToFlow(r.id);
    expect([promoted.id, promoted.definition.kind, promoted.source?.exchangeId, promoted.revision]).toEqual([r.id, 'flow', 'ex-1', 2]);
    expect((await core.tools.repros.run(r.id, { inputs: {} })).state).toBe('passed');

    core.store.setMeta('reproductionRuns', [...core.tools.repros.runs(), { id: 'stuck', reproId: r.id, name: r.name, revision: 2, state: 'running', startedAt: 1, exchangeIds: [], assertions: [], inputSources: {}, notes: [] }]);
    await core.close();
    core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd') });
    expect(core.tools.repros.runs().find((x) => x.id === 'stuck')).toMatchObject({ state: 'interrupted' });
    expect(core.tools.repros.get('one order').revision).toBe(2);
  });
});
