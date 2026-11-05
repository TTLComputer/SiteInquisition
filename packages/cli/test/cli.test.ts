/**
 * The siq command line, run as a real process against a scratch project:
 * the commands people script against, with and without a running core.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { CaptureStore, Core } from '@siteinquisition/core';
import { parseMqttSpec } from '../src/cli-spec.js';

const MAIN = resolve(import.meta.dirname, '../src/main.ts');

let dir: string;
let project: string;
const env = () => ({ ...process.env, SIQ_DATA_DIR: join(dir, 'config', 'siteinquisition'), SIQ_KEYRING: 'none', NO_COLOR: '1' });

function siq(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [...process.execArgv, MAIN, '-p', project, ...args], { env: env(), timeout: 60_000 }, (e, out, err) =>
      done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: String(out), err: String(err) }),
    );
  });
}

function seed() {
  const s = CaptureStore.openProject(project);
  const day = 86_400_000;
  const add = (url: string, status: number, ageDays: number) => {
    const e = s.addRequest({ source: 'proxy', startedAt: Date.now() - ageDays * day, method: 'GET', url, httpVersion: '1.1', headers: [] });
    s.completeResponse(e.id, { status, headers: [['content-type', 'application/json']], body: Buffer.from(`{"url":"${url}"}`) });
    return e.id;
  };
  const ids = [add('http://shop.test/api/cart', 200, 0), add('http://shop.test/api/login', 401, 1), add('http://ads.test/pixel', 200, 20), add('http://ads.test/track', 204, 40)];
  s.close();
  return ids;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'siq-cli-'));
  project = join(dir, 'p');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('siq with no core running', () => {
  let ids: string[];
  beforeAll(() => {
    ids = seed();
  }, 90_000);

  it('prints its version and help', async () => {
    expect((await siq('--version')).out.trim()).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
    const help = await siq('--help');
    for (const c of ['proxy', 'search', 'show', 'scope', 'delete', 'clear', 'prune', 'lan', 'ca', 'mcp']) expect(help.out).toContain(c);
  }, 90_000);

  it('searches with the filter language and shows one exchange', async () => {
    const found = await siq('search', 'host:shop.test', 'status:4xx');
    expect(found.code).toBe(0);
    expect(found.out).toContain('http://shop.test/api/login');
    expect(found.out).not.toContain('/api/cart');
    const shown = await siq('show', ids[1]!);
    expect(shown.out).toContain('401');
    expect((await siq('search', 'status:abc')).code).not.toBe(0);
  }, 90_000);

  it('edits scope rules', async () => {
    expect((await siq('scope', 'add', '*.shop.test')).out).toContain('added include *.shop.test');
    expect((await siq('scope', 'add', 'cdn.shop.test', '--exclude', '--no-record')).code).toBe(0);
    const list = (await siq('scope')).out;
    expect(list).toMatch(/1\. include \*\.shop\.test/);
    expect(list).toMatch(/2\. exclude cdn\.shop\.test/);
    expect((await siq('scope', 'remove', '1')).code).toBe(0);
    expect((await siq('scope', 'remove', '1')).code).toBe(0);
    expect((await siq('scope')).out).not.toContain('*.shop.test');
    expect((await siq('scope', 'default', 'sometimes')).code).not.toBe(0);
  }, 90_000);

  it('deletes by query, prunes by age and saves retention', async () => {
    expect((await siq('delete', 'host:nowhere.test')).out).toContain('nothing matches');
    expect((await siq('delete', 'path:/pixel', '--yes')).out).toContain('deleted 1');
    expect((await siq('prune', '--older-than', '30', '--keep')).out).toContain('deleted 1');
    expect((await siq('prune')).out).toContain('older than 30 days');
    expect((await siq('prune', '--older-than=-3')).err).toMatch(/positive/);
    expect((await siq('prune', '--off')).out).toContain('retention off');
    const left = (await siq('search', '')).out;
    expect(left).toContain('/api/cart');
    expect(left).not.toContain('ads.test');
  }, 90_000);

  it('refuses to clear without --yes when not at a terminal', async () => {
    const r = await siq('clear');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--yes/);
    expect((await siq('clear', '--yes')).out).toContain('deleted 2');
    expect((await siq('search', '')).out.trim()).toBe('');
  }, 90_000);

  it('keeps a LAN allow list', async () => {
    expect((await siq('lan', 'allow', '192.168.1.0/24')).code).toBe(0);
    expect((await siq('lan')).out).toContain('192.168.1.0/24');
    expect((await siq('lan', 'allow', 'not-an-ip')).err).toMatch(/not an IP/);
    await siq('lan', 'remove', '192.168.1.0/24');
    expect((await siq('lan')).out).toContain('nothing yet');
  }, 90_000);

  it('shows, rotates and removes the CA', async () => {
    const shown = await siq('ca');
    expect(shown.out).toMatch(/sha256\s+([0-9A-F]{2}:){31}[0-9A-F]{2}/);
    expect(shown.out).toContain('plain file');
    expect((await siq('ca', '--pem')).out).toMatch(/^-----BEGIN CERTIFICATE-----/);
    const before = /sha256\s+(\S+)/.exec(shown.out)![1];
    const rotated = await siq('ca', 'rotate', '--yes');
    expect(/sha256\s+(\S+)/.exec(rotated.out)![1]).not.toBe(before);
    expect((await siq('ca', 'remove', '--yes')).out).toContain('CA deleted');
  }, 90_000);

  it('sets the agent write mode', async () => {
    expect((await siq('agent-writes', 'allow')).out).toContain('without asking');
    expect((await siq('agent-writes', 'maybe')).code).not.toBe(0);
    const s = CaptureStore.openProject(project);
    expect(s.getMeta('mcpSettings')).toEqual({ writeMode: 'allow' });
    s.close();
  }, 90_000);
});

describe('siq with a core running', () => {
  let core: Core;
  beforeAll(async () => {
    core = await Core.open({ projectDir: project, dataDir: join(dir, 'config', 'siteinquisition'), api: { port: 0 }, proxy: { port: 0, allowLan: true }, keyring: null });
    await core.start();
  }, 90_000);
  afterAll(() => core.close());

  it('sends changes to the running core so its view stays current', async () => {
    const e = core.store.addRequest({ source: 'proxy', startedAt: Date.now(), method: 'GET', url: 'http://live.test/x', httpVersion: '1.1', headers: [] });
    expect((await siq('delete', 'host:live.test', '--yes')).out).toContain('deleted 1');
    expect(core.store.getExchange(e.id)).toBeUndefined();
    await siq('lan', 'allow', '10.0.0.5');
    expect(core.lan.allowed).toContain('10.0.0.5');
    expect((await siq('lan')).out).toContain('10.0.0.5');
    await siq('prune', '--max-size', '500', '--keep');
    expect(core.retention()).toEqual({ maxAgeDays: undefined, maxSizeMB: 500 });
    await siq('agent-writes', 'ask');
    expect(core.tools.mcpSettings()).toEqual({ writeMode: 'ask' });
  }, 90_000);
});

describe('MQTT listener specs', () => {
  it('parses ports, brokers and flags, and rejects the rest', () => {
    expect(parseMqttSpec('1883=broker.local', false)).toEqual({ port: 1883, upstreamHost: 'broker.local', upstreamPort: undefined, upstreamTls: false, listenTls: false, ignoreUpstreamTlsErrors: false, allowLan: false });
    expect(parseMqttSpec('8883=[fd00::1]:8884,tls,listen-tls,insecure', true)).toMatchObject({ upstreamHost: 'fd00::1', upstreamPort: 8884, upstreamTls: true, listenTls: true, ignoreUpstreamTlsErrors: true, allowLan: true });
    expect(() => parseMqttSpec('broker.local', false)).toThrow(/invalid --mqtt/);
    expect(() => parseMqttSpec('1883=b,fast', false)).toThrow(/unknown --mqtt flag/);
  }, 90_000);
});
