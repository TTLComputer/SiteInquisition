import { format, inspect } from 'node:util';

/**
 * The test API, spelled like vitest so test files only change their import
 * line: describe, it/test (with .each, .skip, .skipIf, .only, .todo),
 * beforeAll, afterAll, beforeEach, afterEach and expect.
 *
 * A test file registers its suites when it is imported; the worker then
 * calls run() and reports each result.
 */
export { expect, AssertionError, type Assertion, type ExpectStatic } from './expect.js';

type Fn = () => unknown | Promise<unknown>;
type Mode = 'run' | 'skip' | 'only' | 'todo';

export interface TestNode {
  kind: 'test';
  name: string;
  fn?: Fn;
  mode: Mode;
  timeout?: number;
  parent: SuiteNode;
}
export interface SuiteNode {
  kind: 'suite';
  name: string;
  mode: Mode;
  parent?: SuiteNode;
  children: Array<SuiteNode | TestNode>;
  beforeAll: Array<{ fn: Fn; timeout?: number }>;
  afterAll: Array<{ fn: Fn; timeout?: number }>;
  beforeEach: Array<{ fn: Fn; timeout?: number }>;
  afterEach: Array<{ fn: Fn; timeout?: number }>;
}

const newSuite = (name: string, mode: Mode, parent?: SuiteNode): SuiteNode => ({ kind: 'suite', name, mode, parent, children: [], beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] });

export const root: SuiteNode = newSuite('', 'run');
let current = root;
let collecting = true;

function addSuite(name: string, fn: Fn | undefined, mode: Mode): void {
  const s = newSuite(name, mode, current);
  current.children.push(s);
  if (!fn) return;
  const prev = current;
  current = s;
  try {
    const r = fn();
    if (r && typeof (r as Promise<unknown>).then === 'function') throw new Error(`describe("${name}") must not be async`);
  } finally {
    current = prev;
  }
}

function addTest(name: string, fn: Fn | undefined, mode: Mode, timeout?: number): void {
  if (!collecting) throw new Error(`it("${name}") was called while tests were running; declare tests at the top level or inside describe()`);
  current.children.push({ kind: 'test', name, fn, mode, timeout, parent: current });
}

/** `%s`, `%d`, `%j`, `%o` and `$key` placeholders, as in vitest's .each. */
function title(template: string, args: unknown[], index: number): string {
  let t = template.replace(/%#/g, String(index));
  const row = args[0];
  if (args.length === 1 && row && typeof row === 'object' && !Array.isArray(row)) {
    t = t.replace(/\$([A-Za-z_][\w.]*)/g, (m, key: string) => {
      const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], row);
      return v === undefined ? m : typeof v === 'string' ? v : format('%o', v);
    });
  }
  const count = (t.match(/%[sdifjo]/g) ?? []).length;
  return count ? format(t, ...args.slice(0, count)) : t;
}

type TestFn<A extends unknown[] = []> = (name: string, fn?: (...a: A) => unknown, timeout?: number) => void;
interface TestApi extends TestFn {
  skip: TestFn;
  only: TestFn;
  todo: (name: string) => void;
  skipIf: (cond: unknown) => TestFn;
  runIf: (cond: unknown) => TestFn;
  each: <T>(rows: readonly T[]) => (name: string, fn: (...a: T extends readonly unknown[] ? T : [T]) => unknown, timeout?: number) => void;
}
interface SuiteApi {
  (name: string, fn?: () => void): void;
  skip: (name: string, fn?: () => void) => void;
  only: (name: string, fn?: () => void) => void;
  todo: (name: string) => void;
  skipIf: (cond: unknown) => (name: string, fn?: () => void) => void;
  runIf: (cond: unknown) => (name: string, fn?: () => void) => void;
  each: <T>(rows: readonly T[]) => (name: string, fn: (...a: T extends readonly unknown[] ? T : [T]) => void) => void;
}

const spread = (row: unknown) => (Array.isArray(row) ? row : [row]);

function makeTest(): TestApi {
  const t = ((name, fn, timeout) => addTest(name, fn as Fn, fn ? 'run' : 'todo', timeout)) as TestApi;
  t.skip = (name, fn, timeout) => addTest(name, fn as Fn, 'skip', timeout);
  t.only = (name, fn, timeout) => addTest(name, fn as Fn, 'only', timeout);
  t.todo = (name) => addTest(name, undefined, 'todo');
  t.skipIf = (cond) => (cond ? t.skip : t);
  t.runIf = (cond) => (cond ? t : t.skip);
  t.each = (rows) => (name, fn, timeout) =>
    rows.forEach((row, i) => {
      const args = spread(row);
      addTest(title(name, args, i), () => (fn as (...a: unknown[]) => unknown)(...args), 'run', timeout);
    });
  return t;
}

function makeSuite(): SuiteApi {
  const d = ((name: string, fn?: () => void) => addSuite(name, fn, 'run')) as SuiteApi;
  d.skip = (name, fn) => addSuite(name, fn, 'skip');
  d.only = (name, fn) => addSuite(name, fn, 'only');
  d.todo = (name) => addSuite(name, undefined, 'todo');
  d.skipIf = (cond) => (cond ? d.skip : d);
  d.runIf = (cond) => (cond ? d : d.skip);
  d.each = (rows) => (name, fn) =>
    rows.forEach((row, i) => {
      const args = spread(row);
      addSuite(title(name, args, i), () => (fn as (...a: unknown[]) => void)(...args), 'run');
    });
  return d;
}

export const it = makeTest();
export const test = it;
export const describe = makeSuite();
export const suite = describe;

export const beforeAll = (fn: Fn, timeout?: number): void => void current.beforeAll.push({ fn, timeout });
export const afterAll = (fn: Fn, timeout?: number): void => void current.afterAll.push({ fn, timeout });
export const beforeEach = (fn: Fn, timeout?: number): void => void current.beforeEach.push({ fn, timeout });
export const afterEach = (fn: Fn, timeout?: number): void => void current.afterEach.push({ fn, timeout });

export interface TestResult {
  /** Suite names and the test name, outermost first. */
  path: string[];
  state: 'pass' | 'fail' | 'skip' | 'todo';
  durationMs: number;
  error?: SerializedError;
}
export interface SerializedError {
  message: string;
  stack?: string;
  expected?: string;
  actual?: string;
  diff?: boolean;
  cause?: SerializedError;
}

export interface RunOptions {
  /** Only run tests whose full name matches. */
  filter?: RegExp;
  timeout: number;
  hookTimeout: number;
  onResult: (r: TestResult) => void;
}

function withTimeout(fn: Fn, ms: number, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out in ${ms}ms.`)), ms);
    Promise.resolve()
      .then(fn)
      .then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
  });
}

const pathOf = (n: TestNode | SuiteNode): string[] => {
  const out: string[] = [];
  for (let c: SuiteNode | TestNode | undefined = n; c && c !== root; c = c.parent) out.unshift(c.name);
  return out;
};

function hasOnly(s: SuiteNode): boolean {
  return s.children.some((c) => c.mode === 'only' || (c.kind === 'suite' && hasOnly(c)));
}

export function serializeError(e: unknown, depth = 0): SerializedError {
  if (!(e instanceof Error)) return { message: `thrown: ${inspect(e)}` };
  const x = e as Error & { expected?: unknown; actual?: unknown; showDiff?: boolean; cause?: unknown };
  const out: SerializedError = { message: x.message, stack: x.stack };
  if (x.showDiff) {
    out.diff = true;
    const opts = { depth: 8, compact: false, sorted: false, maxArrayLength: 200, maxStringLength: 4000 };
    out.expected = inspect(x.expected, opts);
    out.actual = inspect(x.actual, opts);
  }
  if (x.cause !== undefined && depth < 3) out.cause = serializeError(x.cause, depth + 1);
  return out;
}

/** Run every collected test in order, reporting each result. */
export async function run(opts: RunOptions): Promise<void> {
  collecting = false;
  const only = hasOnly(root);

  const selected = (t: TestNode, inOnly: boolean): boolean => (!only || inOnly || t.mode === 'only') && (!opts.filter || opts.filter.test(pathOf(t).join(' ')));
  const countRunnable = (s: SuiteNode, skipped: boolean, inOnly: boolean): number =>
    s.children.reduce((n, c) => {
      const sk = skipped || c.mode === 'skip' || c.mode === 'todo';
      const io = inOnly || c.mode === 'only';
      return n + (c.kind === 'suite' ? countRunnable(c, sk, io) : !sk && c.fn && selected(c, io) ? 1 : 0);
    }, 0);

  const report = (t: TestNode, state: TestResult['state'], durationMs = 0, error?: unknown) =>
    opts.onResult({ path: pathOf(t), state, durationMs, ...(error !== undefined ? { error: serializeError(error) } : {}) });

  const skipAll = (s: SuiteNode, state: 'skip' | 'todo') => {
    for (const c of s.children) {
      if (c.kind === 'suite') skipAll(c, c.mode === 'todo' ? 'todo' : state);
      else report(c, c.mode === 'todo' ? 'todo' : state);
    }
  };
  const failAll = (s: SuiteNode, error: unknown) => {
    for (const c of s.children) {
      if (c.kind === 'suite') failAll(c, error);
      else report(c, 'fail', 0, error);
    }
  };

  const eachHooks = (s: SuiteNode, kind: 'beforeEach' | 'afterEach') => {
    const chain: SuiteNode[] = [];
    for (let c: SuiteNode | undefined = s; c; c = c.parent) chain.unshift(c);
    const hooks = chain.flatMap((c) => c[kind]);
    return kind === 'afterEach' ? hooks.reverse() : hooks;
  };

  async function runSuite(s: SuiteNode, skipped: boolean, inOnly: boolean): Promise<void> {
    if (skipped || countRunnable(s, false, inOnly) === 0) {
      skipAll(s, s.mode === 'todo' ? 'todo' : 'skip');
      return;
    }
    try {
      for (const h of s.beforeAll) await withTimeout(h.fn, h.timeout ?? opts.hookTimeout, 'Hook');
    } catch (e) {
      failAll(s, e);
      await runAfterAll(s);
      return;
    }
    for (const c of s.children) {
      const sk = c.mode === 'skip' || c.mode === 'todo';
      const io = inOnly || c.mode === 'only';
      if (c.kind === 'suite') {
        await runSuite(c, sk, io);
        continue;
      }
      if (c.mode === 'todo' || !c.fn) {
        report(c, 'todo');
        continue;
      }
      if (sk || !selected(c, io)) {
        report(c, 'skip');
        continue;
      }
      const start = performance.now();
      let error: unknown;
      try {
        for (const h of eachHooks(s, 'beforeEach')) await withTimeout(h.fn, h.timeout ?? opts.hookTimeout, 'Hook');
        await withTimeout(c.fn, c.timeout ?? opts.timeout, 'Test');
      } catch (e) {
        error = e;
      }
      for (const h of eachHooks(s, 'afterEach')) {
        try {
          await withTimeout(h.fn, h.timeout ?? opts.hookTimeout, 'Hook');
        } catch (e) {
          error ??= e;
        }
      }
      report(c, error === undefined ? 'pass' : 'fail', performance.now() - start, error);
    }
    await runAfterAll(s);
  }

  async function runAfterAll(s: SuiteNode): Promise<void> {
    for (const h of s.afterAll) {
      try {
        await withTimeout(h.fn, h.timeout ?? opts.hookTimeout, 'Hook');
      } catch (e) {
        opts.onResult({ path: [...pathOf(s), 'afterAll'], state: 'fail', durationMs: 0, error: serializeError(e) });
      }
    }
  }

  await runSuite(root, false, false);
}
