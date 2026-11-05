import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { Core, McpServer, ScriptEngine } from '@siteinquisition/core';


const msg = () => ({ method: 'GET', url: 'http://example.test/', headers: [] as Array<[string, string]>, body: new Uint8Array() });

describe('script sandbox', () => {
  const vars: Record<string, string> = {};
  let trusted = false;
  const engine = new ScriptEngine({ values: () => vars, set: (k, v) => (vars[k] = v) }, () => trusted);
  afterAll(() => engine.close());

  const run = (code: string, sdk: Record<string, unknown> = {}, sandbox?: boolean) => engine.execute({ id: 'x', name: 'x', kind: 'script', code, ...(sandbox === false ? { sandbox } : {}) }, sdk);

  it('stops code that escapes the vm context from starting programs or reading files', async () => {
    const programs = await run("const p = console.log.constructor('return process')(); p.getBuiltinModule('node:child_process').execSync('id').toString()");
    expect(programs.ok).toBe(false);
    expect(programs.error).toMatch(/restricted/);
    const files = await run("const p = console.log.constructor('return process')(); p.getBuiltinModule('node:fs').readFileSync('/etc/hostname', 'utf8')");
    expect(files.ok).toBe(false);
    expect(files.error).toMatch(/restricted/);
  });

  it('kills a script that blocks after an await, without blocking the caller', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 100);
    const r = await run('await null\nwhile (true) {}');
    clearInterval(timer);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/blocked/);
    expect(ticks).toBeGreaterThan(10);
  });

  it('gives scripts synchronous SDK calls and async ones that run at once', async () => {
    const sdk = {
      add: (a: number, b: number) => a + b,
      ns: { hi: () => 'hi' },
      slow: async (x: number) => {
        await new Promise((r) => setTimeout(r, 500));
        return x * 2;
      },
      boom: () => {
        throw new Error('nope');
      },
    };
    expect((await run("siq.add(2, 3) + siq.ns.hi()", sdk)).value).toBe('5hi');
    // Time the calls inside the script, so a slow machine starting the script
    // process doesn't count: run one after the other they would take 1000 ms.
    const both = await run('await (async () => { const t0 = Date.now(); const r = await Promise.all([siq.slow(1), siq.slow(2)]); return r.join(",") + " " + (Date.now() - t0) })()', sdk);
    const [values, ms] = String(both.value).split(' ');
    expect(values).toBe('2,4');
    expect(Number(ms)).toBeLessThan(900);
    const err = await run("let out\ntry { siq.boom() } catch (e) { out = 'caught ' + e.message }\nout", sdk);
    expect(err.value).toBe('caught nope');
    expect((await run('typeof siq.missing', sdk)).value).toBe('undefined');
  });

  it('copies extra globals back after the run', async () => {
    const extra = { vars: { a: '1' } as Record<string, string> };
    const r = await engine.execute({ id: 'f', name: 'flow-step', kind: 'script', code: 'vars.b = vars.a + "2"' }, {}, extra);
    expect(r.ok).toBe(true);
    expect(extra.vars).toEqual({ a: '1', b: '12' });
  });

  it('runs a script without the sandbox only when the user trusted it', async () => {
    const code = "typeof require === 'function' && require('node:path').sep";
    trusted = false;
    const untrusted = await run(code, {}, false);
    expect(untrusted.value).toBe('false');
    trusted = true;
    const full = await run(code, {}, false);
    expect(full.value).toBe(sep);
    trusted = false;
  });

  it('keeps a hook that leaves a busy promise behind inside its budget, and runs the next hook', async () => {
    await engine.load([
      { id: 'busy', name: 'busy', kind: 'hook', code: 'function onRequest(r) { Promise.resolve().then(() => { while (true) {} }); }' },
      { id: 'stamp', name: 'stamp', kind: 'hook', code: 'function onRequest(r) { r.setHeader("x-v", siq.getVar("v") ?? "none"); siq.setVar("seen", "yes"); }' },
    ]);
    vars.v = 'V';
    const m = msg();
    const t0 = Date.now();
    expect(await engine.run('request', m)).toEqual(['stamp']);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(m.headers).toEqual([['x-v', 'V']]);
    expect(vars.seen).toBe('yes');
    expect(engine.stats.get('busy')!.errors).toBe(1);
    expect(engine.stats.get('busy')!.lastError).toMatch(/timed out/);
    // The host is still usable afterwards.
    const again = msg();
    expect(await engine.run('request', again)).toEqual(['stamp']);
    await engine.load([]);
    expect(engine.active).toBe(false);
  });

  it('reports hook compile errors', async () => {
    await engine.load([{ id: 'bad', name: 'bad', kind: 'hook', code: 'function nothing() {}' }]);
    expect(engine.compileErrors.get('bad')).toMatch(/must define onRequest/);
    await engine.load([]);
  });
});

describe('script trust in a project', () => {
  let dir: string;
  let core: Core;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'siq-trust-'));
    core = await Core.open({ projectDir: join(dir, 'p'), dataDir: join(dir, 'data'), api: false });
  });
  afterAll(async () => {
    await core.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('trusts code saved with the sandbox off on this computer, and asks again for code from elsewhere', async () => {
    const code = "typeof require === 'function'";
    const [saved] = await core.tools.setScripts([{ name: 'mine', kind: 'script', code, sandbox: false }]);
    expect(core.tools.untrustedScripts()).toEqual([]);
    expect((await core.tools.runScript(saved!)).value).toBe('true');

    // Someone else's project: written straight into the database, never saved here.
    core.store.setMeta('scripts', [{ id: 'theirs', name: 'theirs', kind: 'script', code: `${code} // theirs`, sandbox: false }]);
    expect(core.tools.untrustedScripts()).toEqual(['theirs']);
    expect((await core.tools.runScript(core.tools.scriptList()[0]!)).value).toBe('false');
    await core.tools.trustScript('theirs');
    expect(core.tools.untrustedScripts()).toEqual([]);
    expect((await core.tools.runScript(core.tools.scriptList()[0]!)).value).toBe('true');
  });
});

describe('MCP approvals for code', () => {
  it('never grants run_script for 10 minutes', async () => {
    let ran = 0;
    const server = new McpServer(
      [
        { name: 'run_script', description: '', inputSchema: {}, write: true, noGrant: true, run: () => ++ran },
        { name: 'tag', description: '', inputSchema: {}, write: true, run: () => ++ran },
      ],
      () => ({ writeMode: 'ask' }),
    );
    const decideNext = async (d: 'ten-minutes') => {
      for (let i = 0; i < 100 && !server.approvals().length; i++) await new Promise((r) => setTimeout(r, 5));
      const a = server.approvals()[0]!;
      server.decide(a.id, d);
      return a;
    };
    const first = server.call('run_script', {});
    expect((await decideNext('ten-minutes')).allowGrant).toBe(false);
    await first;
    // A second call still waits for approval.
    void server.call('run_script', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(server.approvals()).toHaveLength(1);
    server.decide(server.approvals()[0]!.id, 'deny');

    const tagged = server.call('tag', {});
    expect((await decideNext('ten-minutes')).allowGrant).toBe(true);
    await tagged;
    await server.call('tag', {});
    expect(server.approvals()).toHaveLength(0);
    expect(ran).toBe(3);
  });
});
