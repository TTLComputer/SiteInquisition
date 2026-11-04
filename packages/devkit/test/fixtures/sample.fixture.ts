import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@siteinquisition/devkit/test';

// Run by runner.test.ts through the CLI; the results are checked there.
const log: string[] = [];
beforeAll(() => void log.push('beforeAll'));
afterAll(() => {
  console.log(`ORDER ${log.join(',')}`);
});

describe('outer', () => {
  beforeEach(() => void log.push('be-outer'));
  afterEach(() => void log.push('ae-outer'));
  it('passes', () => {
    log.push('t1');
    expect({ a: 1, b: undefined }).toEqual({ a: 1 });
  });
  describe('inner', () => {
    beforeEach(() => void log.push('be-inner'));
    it('fails with a diff', () => {
      log.push('t2');
      expect({ a: [1, 2], b: 'x' }).toEqual({ a: [1, 3], b: 'x' });
    });
  });
  it.skip('is skipped', () => undefined);
  it.skipIf(true)('is skipped by condition', () => undefined);
  it.each([
    [1, 2],
    [2, 4],
  ])('doubles %s to %s', (a, b) => expect(a * 2).toBe(b));
  it('times out', () => new Promise(() => undefined), 50);
  it('polls', async () => {
    let n = 0;
    await expect.poll(() => ++n, { interval: 1 }).toBeGreaterThan(3);
  });
});

describe.skipIf(true)('skipped suite', () => {
  it('never runs', () => {
    throw new Error('ran');
  });
});

describe('a failing beforeAll', () => {
  beforeAll(() => {
    throw new Error('setup broke');
  });
  it('is reported as failed', () => undefined);
});
