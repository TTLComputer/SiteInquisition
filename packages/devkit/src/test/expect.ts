import { inspect, isDeepStrictEqual } from 'node:util';

/**
 * Assertions with the vitest/Jest spelling, covering the matchers this repo
 * uses. Equality follows vitest: `toEqual` ignores properties that are
 * undefined, `toMatchObject` checks a subset, and asymmetric matchers
 * (`expect.any`, `expect.objectContaining`, ...) work anywhere in a value.
 */

export class AssertionError extends Error {
  override name = 'AssertionError';
  constructor(
    message: string,
    readonly expected?: unknown,
    readonly actual?: unknown,
    readonly showDiff = false,
  ) {
    super(message);
  }
}

const ASYM = Symbol.for('siq.asymmetric');

abstract class Asymmetric {
  readonly [ASYM] = true;
  abstract matches(v: unknown): boolean;
  abstract describe(): string;
  [inspect.custom](): string {
    return this.describe();
  }
}
const isAsym = (v: unknown): v is Asymmetric => typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[ASYM] === true;

class AnyOf extends Asymmetric {
  constructor(private readonly ctor: unknown) {
    super();
  }
  matches(v: unknown): boolean {
    const c = this.ctor;
    if (c === String) return typeof v === 'string' || v instanceof String;
    if (c === Number) return typeof v === 'number' || v instanceof Number;
    if (c === Boolean) return typeof v === 'boolean' || v instanceof Boolean;
    if (c === BigInt) return typeof v === 'bigint';
    if (c === Symbol) return typeof v === 'symbol';
    if (c === Function) return typeof v === 'function';
    if (c === Object) return typeof v === 'object' && v !== null;
    return typeof c === 'function' && v instanceof (c as new (...a: never[]) => unknown);
  }
  describe(): string {
    return `Any<${(this.ctor as { name?: string }).name ?? '?'}>`;
  }
}
class Anything extends Asymmetric {
  matches(v: unknown): boolean {
    return v !== null && v !== undefined;
  }
  describe(): string {
    return 'Anything';
  }
}
class ObjectContaining extends Asymmetric {
  constructor(private readonly sub: Record<string, unknown>) {
    super();
  }
  matches(v: unknown): boolean {
    if (typeof v !== 'object' || v === null) return false;
    return Object.keys(this.sub).every((k) => k in (v as object) && equals((v as Record<string, unknown>)[k], this.sub[k]));
  }
  describe(): string {
    return `ObjectContaining ${inspect(this.sub, { depth: 4 })}`;
  }
}
class ArrayContaining extends Asymmetric {
  constructor(private readonly items: unknown[]) {
    super();
  }
  matches(v: unknown): boolean {
    return Array.isArray(v) && this.items.every((i) => v.some((x) => equals(x, i)));
  }
  describe(): string {
    return `ArrayContaining ${inspect(this.items, { depth: 4 })}`;
  }
}
class StringMatching extends Asymmetric {
  constructor(private readonly re: RegExp | string) {
    super();
  }
  matches(v: unknown): boolean {
    return typeof v === 'string' && (typeof this.re === 'string' ? v.includes(this.re) : this.re.test(v));
  }
  describe(): string {
    return `StringMatching ${String(this.re)}`;
  }
}
class StringContaining extends Asymmetric {
  constructor(private readonly s: string) {
    super();
  }
  matches(v: unknown): boolean {
    return typeof v === 'string' && v.includes(this.s);
  }
  describe(): string {
    return `StringContaining ${JSON.stringify(this.s)}`;
  }
}

/**
 * Deep equality. `strictUndefined` false is `toEqual`: a property set to
 * undefined counts as missing. `subset` true is `toMatchObject`: the actual
 * object may have more properties than the expected one.
 */
export function equals(a: unknown, b: unknown, opts: { subset?: boolean } = {}, seen = new Map<object, object>()): boolean {
  if (isAsym(b)) return b.matches(a);
  if (isAsym(a)) return a.matches(b);
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (Array.isArray(a) || Array.isArray(b)) return false;
    return isDeepStrictEqual(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength));
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => equals(x, b[i], opts, seen));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of b) if (!a.has(k) || !equals(a.get(k), v, opts, seen)) return false;
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of b) if (![...a].some((x) => equals(x, v, opts, seen))) return false;
    return true;
  }
  if (a instanceof Error && b instanceof Error && (a.message !== b.message || a.name !== b.name)) return false;
  if (!opts.subset && Object.prototype.toString.call(a) !== Object.prototype.toString.call(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (!opts.subset && ka.length !== kb.length) return false;
  return kb.every((k) => Object.prototype.hasOwnProperty.call(a, k) && equals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], opts, seen));
}

const show = (v: unknown) => inspect(v, { depth: 6, colors: false, breakLength: 100, maxArrayLength: 50, maxStringLength: 2000 });

type MatcherResult = { pass: boolean; message: () => string; expected?: unknown; actual?: unknown; diff?: boolean };

function matchers(actual: unknown): Record<string, (...args: never[]) => MatcherResult> {
  const len = (v: unknown) => (v as { length?: unknown } | null)?.length;
  return {
    toBe: (exp: unknown) => ({ pass: Object.is(actual, exp), message: () => `expected ${show(actual)} to be ${show(exp)}`, expected: exp, actual, diff: true }),
    toEqual: (exp: unknown) => ({ pass: equals(actual, exp), message: () => `expected ${show(actual)} to deeply equal ${show(exp)}`, expected: exp, actual, diff: true }),
    toStrictEqual: (exp: unknown) => ({ pass: isDeepStrictEqual(actual, exp), message: () => `expected ${show(actual)} to strictly equal ${show(exp)}`, expected: exp, actual, diff: true }),
    toMatchObject: (exp: unknown) => ({ pass: equals(actual, exp, { subset: true }), message: () => `expected ${show(actual)} to match object ${show(exp)}`, expected: exp, actual, diff: true }),
    toContain: (item: unknown) => ({
      pass: typeof actual === 'string' ? actual.includes(String(item)) : actual != null && typeof (actual as Iterable<unknown>)[Symbol.iterator] === 'function' ? [...(actual as Iterable<unknown>)].includes(item) : false,
      message: () => `expected ${show(actual)} to contain ${show(item)}`,
    }),
    toContainEqual: (item: unknown) => ({ pass: Array.isArray(actual) && actual.some((x) => equals(x, item)), message: () => `expected ${show(actual)} to contain an item equal to ${show(item)}` }),
    toHaveLength: (n: number) => ({ pass: len(actual) === n, message: () => `expected ${show(actual)} to have length ${n}, but it has ${String(len(actual))}` }),
    toHaveProperty: (path: string | string[], ...val: unknown[]) => {
      const parts = Array.isArray(path) ? path : path.split('.');
      let cur: unknown = actual;
      let has = true;
      for (const p of parts) {
        if (cur == null || !(p in Object(cur))) {
          has = false;
          break;
        }
        cur = (cur as Record<string, unknown>)[p];
      }
      const pass = has && (val.length === 0 || equals(cur, val[0]));
      return { pass, message: () => `expected ${show(actual)} to have property ${parts.join('.')}${val.length ? ` equal to ${show(val[0])}` : ''}` };
    },
    toMatch: (re: RegExp | string) => ({
      pass: typeof actual === 'string' && (typeof re === 'string' ? actual.includes(re) : re.test(actual)),
      message: () => `expected ${show(actual)} to match ${String(re)}`,
    }),
    toBeTruthy: () => ({ pass: !!actual, message: () => `expected ${show(actual)} to be truthy` }),
    toBeFalsy: () => ({ pass: !actual, message: () => `expected ${show(actual)} to be falsy` }),
    toBeNull: () => ({ pass: actual === null, message: () => `expected ${show(actual)} to be null` }),
    toBeUndefined: () => ({ pass: actual === undefined, message: () => `expected ${show(actual)} to be undefined` }),
    toBeDefined: () => ({ pass: actual !== undefined, message: () => `expected ${show(actual)} to be defined` }),
    toBeNaN: () => ({ pass: Number.isNaN(actual), message: () => `expected ${show(actual)} to be NaN` }),
    toBeInstanceOf: (c: new (...a: never[]) => unknown) => ({ pass: actual instanceof c, message: () => `expected ${show(actual)} to be an instance of ${c.name}` }),
    toBeGreaterThan: (n: number | bigint) => ({ pass: (actual as number) > n, message: () => `expected ${show(actual)} to be greater than ${n}` }),
    toBeGreaterThanOrEqual: (n: number | bigint) => ({ pass: (actual as number) >= n, message: () => `expected ${show(actual)} to be greater than or equal to ${n}` }),
    toBeLessThan: (n: number | bigint) => ({ pass: (actual as number) < n, message: () => `expected ${show(actual)} to be less than ${n}` }),
    toBeLessThanOrEqual: (n: number | bigint) => ({ pass: (actual as number) <= n, message: () => `expected ${show(actual)} to be less than or equal to ${n}` }),
    toBeCloseTo: (n: number, digits = 2) => ({ pass: Math.abs((actual as number) - n) < 10 ** -digits / 2, message: () => `expected ${show(actual)} to be close to ${n}` }),
    toThrow: (exp?: string | RegExp | (new (...a: never[]) => unknown) | Error) => {
      let thrown: unknown;
      let didThrow = false;
      if (actual instanceof ThrownMarker) {
        didThrow = true;
        thrown = actual.error;
      } else if (typeof actual === 'function') {
        try {
          (actual as () => unknown)();
        } catch (e) {
          didThrow = true;
          thrown = e;
        }
      } else {
        return { pass: false, message: () => `expected a function, got ${show(actual)}` };
      }
      const msg = (thrown as Error | undefined)?.message ?? String(thrown);
      let pass = didThrow;
      if (didThrow && exp !== undefined) {
        if (typeof exp === 'string') pass = msg.includes(exp);
        else if (exp instanceof RegExp) pass = exp.test(msg);
        else if (exp instanceof Error) pass = msg === exp.message;
        else if (typeof exp === 'function') pass = thrown instanceof exp;
      }
      return {
        pass,
        message: () => (didThrow ? `expected the thrown error ${show(msg)} to match ${show(exp)}` : `expected the function to throw${exp !== undefined ? ` ${show(exp)}` : ''}`),
      };
    },
  };
}
class ThrownMarker {
  constructor(readonly error: unknown) {}
}

type Matchers<R> = {
  toBe(v: unknown): R;
  toEqual(v: unknown): R;
  toStrictEqual(v: unknown): R;
  toMatchObject(v: unknown): R;
  toContain(v: unknown): R;
  toContainEqual(v: unknown): R;
  toHaveLength(n: number): R;
  toHaveProperty(path: string | string[], value?: unknown): R;
  toMatch(re: RegExp | string): R;
  toBeTruthy(): R;
  toBeFalsy(): R;
  toBeNull(): R;
  toBeUndefined(): R;
  toBeDefined(): R;
  toBeNaN(): R;
  toBeInstanceOf(c: abstract new (...a: never[]) => unknown): R;
  toBeGreaterThan(n: number | bigint): R;
  toBeGreaterThanOrEqual(n: number | bigint): R;
  toBeLessThan(n: number | bigint): R;
  toBeLessThanOrEqual(n: number | bigint): R;
  toBeCloseTo(n: number, digits?: number): R;
  toThrow(exp?: string | RegExp | (abstract new (...a: never[]) => unknown) | Error): R;
};
export type Assertion = Matchers<void> & { not: Matchers<void>; resolves: Matchers<Promise<void>> & { not: Matchers<Promise<void>> }; rejects: Matchers<Promise<void>> & { not: Matchers<Promise<void>> } };
export type PollAssertion = Matchers<Promise<void>> & { not: Matchers<Promise<void>> };

function check(name: string, actual: unknown, args: unknown[], negate: boolean, label: string | undefined, stackFrom: Function): void {
  const m = matchers(actual)[name];
  if (!m) throw new TypeError(`unknown matcher ${name}`);
  const r = (m as (...a: unknown[]) => MatcherResult)(...args);
  if (r.pass === negate) {
    const base = r.message();
    const msg = negate ? base.replace(/^expected (.*?) to /s, 'expected $1 not to ') : base;
    const err = new AssertionError(label ? `${label}: ${msg}` : msg, r.expected, r.actual, !negate && !!r.diff);
    Error.captureStackTrace(err, stackFrom);
    throw err;
  }
}

const MATCHER_NAMES = Object.keys(matchers(undefined));

function build<R>(run: (name: string, args: unknown[], negate: boolean, from: Function) => R): Matchers<R> & { not: Matchers<R> } {
  const make = (negate: boolean) => {
    const o: Record<string, unknown> = {};
    for (const n of MATCHER_NAMES) {
      const f = (...args: unknown[]) => run(n, args, negate, f);
      o[n] = f;
    }
    return o as Matchers<R>;
  };
  return Object.assign(make(false), { not: make(true) });
}

export interface ExpectStatic {
  (actual: unknown, message?: string): Assertion;
  poll(fn: () => unknown, opts?: { timeout?: number; interval?: number }): PollAssertion;
  any(c: unknown): unknown;
  anything(): unknown;
  objectContaining(o: Record<string, unknown>): unknown;
  arrayContaining(a: unknown[]): unknown;
  stringMatching(r: RegExp | string): unknown;
  stringContaining(s: string): unknown;
  assertions(n: number): void;
}

export const expect: ExpectStatic = Object.assign(
  (actual: unknown, label?: string): Assertion => {
    const sync = build((n, args, neg, from) => check(n, actual, args, neg, label, from));
    const promised = (mode: 'resolves' | 'rejects') =>
      build(async (n, args, neg, from) => {
        let value: unknown;
        try {
          const v = await (typeof actual === 'function' ? (actual as () => unknown)() : actual);
          if (mode === 'rejects') throw new AssertionError(`expected the promise to reject, but it resolved with ${show(v)}`);
          value = v;
        } catch (e) {
          if (e instanceof AssertionError) throw e;
          if (mode === 'resolves') throw new AssertionError(`expected the promise to resolve, but it rejected with ${show(e)}`);
          value = n === 'toThrow' ? new ThrownMarker(e) : e;
        }
        check(n, value, args, neg, label, from);
      });
    return Object.assign(sync, { resolves: promised('resolves'), rejects: promised('rejects') });
  },
  {
    poll(fn: () => unknown, opts: { timeout?: number; interval?: number } = {}): PollAssertion {
      const timeout = opts.timeout ?? 1000;
      const interval = opts.interval ?? 50;
      return build(async (n, args, neg, from) => {
        const start = Date.now();
        let last: unknown;
        for (;;) {
          try {
            check(n, await fn(), args, neg, undefined, from);
            return;
          } catch (e) {
            last = e;
          }
          if (Date.now() - start >= timeout) break;
          await new Promise((r) => setTimeout(r, interval));
        }
        const err = new AssertionError('Matcher did not succeed in time.');
        (err as Error & { cause?: unknown }).cause = last;
        throw err;
      });
    },
    any: (c: unknown) => new AnyOf(c),
    anything: () => new Anything(),
    objectContaining: (o: Record<string, unknown>) => new ObjectContaining(o),
    arrayContaining: (a: unknown[]) => new ArrayContaining(a),
    stringMatching: (r: RegExp | string) => new StringMatching(r),
    stringContaining: (s: string) => new StringContaining(s),
    assertions: () => undefined,
  },
);

export { show };
