import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from '@siteinquisition/devkit/test';

const CLI = join(import.meta.dirname, '..', 'dist', 'test', 'cli.js');

describe('matchers', () => {
  it('compares like vitest', () => {
    expect({ a: 1, b: undefined }).toEqual({ a: 1 });
    expect([1, { x: 2 }]).not.toEqual([1, { x: 3 }]);
    expect(Buffer.from('ab')).toEqual(new Uint8Array([0x61, 0x62]));
    expect(new Map([['k', [1]]])).toEqual(new Map([['k', [1]]]));
    expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } });
    expect([{ a: 1, z: 0 }]).toMatchObject([{ a: 1 }]);
    expect([{ a: 1 }, { a: 2 }]).not.toMatchObject([{ a: 1 }]);
    expect(Object.assign(new Error('boom'), { code: 7 })).toMatchObject({ code: 7 });
    expect({ id: 'x1', n: 5, at: new Date() }).toEqual({ id: expect.stringMatching(/^x/), n: expect.any(Number), at: expect.any(Date) });
    expect([3, 1, 2]).toEqual(expect.arrayContaining([1, 2]));
    expect({ a: 1, b: 2 }).toEqual(expect.objectContaining({ b: 2 }));
    expect('hello world').toEqual(expect.stringContaining('lo w'));
    expect('abc').toContain('b');
    expect(new Set([1, 2])).toContain(2);
    expect([1, 2]).toHaveLength(2);
    expect('abc').toMatch(/b/);
    expect(2).toBeGreaterThan(1);
    expect(2).toBeLessThanOrEqual(2);
    expect(null).toBeNull();
    expect(undefined).toBeUndefined();
    expect(0).not.toBeTruthy();
    expect(new TypeError('x')).toBeInstanceOf(Error);
    expect({ a: { b: 1 } }).toHaveProperty('a.b', 1);
  });

  it('checks thrown errors and promises', async () => {
    expect(() => JSON.parse('{')).toThrow();
    expect(() => {
      throw new TypeError('bad thing');
    }).toThrow(/bad/);
    expect(() => {
      throw new TypeError('bad thing');
    }).toThrow(TypeError);
    expect(() => undefined).not.toThrow();
    await expect(Promise.reject(new Error('nope'))).rejects.toThrow('nope');
    await expect(Promise.reject(Object.assign(new Error('x'), { code: 1 }))).rejects.toMatchObject({ code: 1 });
    await expect(Promise.resolve(5)).resolves.toBe(5);
  });

  it('fails with a readable message', () => {
    let msg = '';
    try {
      expect([1, 2], 'the list').toEqual([1, 3]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe('the list: expected [ 1, 2 ] to deeply equal [ 1, 3 ]');
    expect(() => expect(1).not.toBe(1)).toThrow('expected 1 not to be 1');
  });
});

describe('the runner', () => {
  const runFixture = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, 'sample.fixture.ts', ...args], { cwd: join(import.meta.dirname, 'fixtures'), encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

  it('runs hooks in order, skips, expands each, times out and reports failures', () => {
    const r = runFixture();
    expect(r.status).toBe(1);
    const out = r.stdout;
    expect(out).toContain('ORDER beforeAll,be-outer,t1,ae-outer,be-outer,be-inner,t2,ae-outer');
    expect(out).toContain('✓ outer > passes');
    expect(out).toContain('× outer > inner > fails with a diff');
    expect(out).toContain('✓ outer > doubles 1 to 2');
    expect(out).toContain('✓ outer > doubles 2 to 4');
    expect(out).toContain('↓ outer > is skipped');
    expect(out).toContain('↓ outer > is skipped by condition');
    expect(out).toContain('↓ skipped suite > never runs');
    expect(out).toContain('Test timed out in 50ms.');
    expect(out).toContain('✓ outer > polls');
    expect(out).toContain('× a failing beforeAll > is reported as failed');
    expect(out).toContain('setup broke');
    // The diff marks the changed line only.
    expect(out).toMatch(/- {5}3,?\n\+ {5}2,?\n/);
    expect(out).toContain('Tests  3 failed | 4 passed | 3 skipped (10)');
    expect(out).toMatch(/❯ sample\.fixture\.ts:\d+:\d+|sample\.fixture\.ts:21/);
  });

  it('filters by test name', () => {
    const r = runFixture('-t', 'doubles');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Tests  2 passed | 8 skipped (10)');
  });
});
