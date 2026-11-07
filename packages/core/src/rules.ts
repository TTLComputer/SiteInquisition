import { bytesToString, decodeChain, detectChain, encodeChain, looksLikeText, replaceThroughChain } from '@siteinquisition/codecs';
import { update } from '@siteinquisition/codecs/jsonpath';
import { newId } from './ids.js';
import { conditionHolds, normalizeMatchConditions, pathMatches, toRegExp, type MatchCondition, type PathMatch, type MatchOptions, type MatchSubject } from './match.js';
import { globToRegExp } from './scope.js';
import type { HeaderList } from './store.js';

/** A request or response as hooks see it: headers in order, body with Content-Encoding undone. */
export interface HookMessage {
  method: string;
  url: string;
  headers: HeaderList;
  body: Uint8Array;
  /** Responses only. */
  status?: number;
  statusMessage?: string;
}

export interface RuleConditions {
  /** Host glob; empty matches every host. */
  host?: string;
  /** One method, or several separated by commas ("GET,HEAD"). */
  method?: string;
  /** Matches the start of the path and query string. */
  pathPrefix?: string;
  /** The path without its query string, compared as `pathMatch` says. */
  path?: string;
  /**
   * How `path` compares. "exact" (default), "glob" (`*` is one segment,
   * `**` any number), "regex", or "template" (`/users/{id}` with each
   * `{name}` one segment).
   */
  pathMatch?: PathMatch;
  /** Responses only: status code, class ("4xx") or comparison (">=400"). */
  status?: string;
  /** Precise conditions on query parameters, headers, cookies, JSON values, GraphQL operations and bodies. All must hold. */
  where?: MatchCondition[];
}

export interface ReplaceRule extends RuleConditions {
  id: string;
  name: string;
  enabled?: boolean;
  phase: 'request' | 'response';
  /** What to change. */
  target: 'url' | 'header' | 'body' | 'status';
  /** Header rules: the header to change. With action "set" or "remove" no find is needed. */
  header?: string;
  action?: 'replace' | 'set' | 'remove';
  /** Body rules: a codec chain to work inside ("base64>json"), or "auto" to detect it. */
  chain?: string;
  /** Body rules on a JSON layer: set this JSONPath to `replace` instead of text matching. */
  jsonPath?: string;
  find?: string;
  replace?: string;
  regex?: boolean;
  matchCase?: boolean;
  /** Also rename JSON keys. */
  keys?: boolean;
}

export interface MockRule extends Omit<RuleConditions, 'status'> {
  id: string;
  name: string;
  enabled?: boolean;
  status: number;
  headers: HeaderList;
  body: string;
  delayMs?: number;
}

export type RuleInput<T> = Omit<T, 'id'> & { id?: string };

export function statusMatches(spec: string | undefined, status: number | undefined): boolean {
  if (!spec) return true;
  if (status === undefined) return false;
  const s = spec.trim();
  const cls = /^([1-5])xx$/i.exec(s);
  if (cls) return Math.floor(status / 100) === Number(cls[1]);
  const cmp = /^(>=|<=|>|<|=)?\s*(\d{3})$/.exec(s);
  if (!cmp) return false;
  const n = Number(cmp[2]);
  switch (cmp[1]) {
    case '>=':
      return status >= n;
    case '<=':
      return status <= n;
    case '>':
      return status > n;
    case '<':
      return status < n;
    default:
      return status === n;
  }
}

/** A HookMessage as the request side of a match. */
export const requestSubject = (msg: { method: string; url: string; headers?: HeaderList; body?: Uint8Array }): MatchSubject => ({
  method: msg.method,
  url: msg.url,
  phase: 'request',
  request: { headers: msg.headers, body: msg.body },
});

/** A response and the request it answers. */
export const responseSubject = (req: { method: string; url: string; headers?: HeaderList; body?: Uint8Array } | undefined, res: HookMessage): MatchSubject => ({
  method: req?.method ?? res.method,
  url: req?.url ?? res.url,
  status: res.status,
  phase: 'response',
  request: req ? { headers: req.headers, body: req.body } : undefined,
  response: { headers: res.headers, body: res.body },
});

/**
 * Whether a rule's conditions hold. A plain `{ method, url, status }` is
 * accepted too; it knows no headers or bodies, so conditions on them then
 * fail (or pass with `lenient`).
 */
export function conditionsMatch(c: RuleConditions, msg: MatchSubject | { method: string; url: string; status?: number; headers?: HeaderList; body?: Uint8Array }, opts: MatchOptions = {}): boolean {
  let u: URL;
  try {
    u = new URL(msg.url);
  } catch {
    return false;
  }
  if (c.host && !globToRegExp(c.host).test(u.hostname.toLowerCase())) return false;
  if (c.method) {
    const methods = c.method.toUpperCase().split(/[\s,|]+/).filter(Boolean);
    if (methods.length && !methods.includes(msg.method.toUpperCase())) return false;
  }
  if (c.pathPrefix && !(u.pathname + u.search).startsWith(c.pathPrefix)) return false;
  if (c.path && !pathMatches(c.path, c.pathMatch, u.pathname)) return false;
  if (c.status && !statusMatches(c.status, msg.status)) return false;
  if (c.where?.length) {
    const subject: MatchSubject = 'phase' in msg || 'request' in msg || 'response' in msg ? (msg as MatchSubject) : requestSubject(msg as HookMessage);
    for (const w of c.where) if (!conditionHolds(w, subject, u, opts)) return false;
  }
  return true;
}

/** Validate and tidy the shared conditions of a rule, mock or breakpoint. */
export function normalizeConditions<T extends Omit<RuleConditions, 'status'>>(c: T): T {
  const out = { ...c };
  if (out.pathMatch !== undefined && !['exact', 'glob', 'regex', 'template'].includes(out.pathMatch)) throw new Error('pathMatch must be exact, glob, regex or template');
  if (out.path !== undefined && out.path !== '') {
    if (out.pathMatch === 'regex') toRegExp(out.path);
    else if (!out.path.startsWith('/')) throw new Error('path must start with "/"');
  } else {
    delete out.path;
    delete out.pathMatch;
  }
  if (!out.pathPrefix) delete out.pathPrefix;
  const where = normalizeMatchConditions(out.where);
  if (where) out.where = where;
  else delete out.where;
  return out;
}

const matcher = (r: { find?: string; regex?: boolean; matchCase?: boolean }) =>
  new RegExp(r.regex ? (r.find ?? '') : (r.find ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), r.matchCase ? 'g' : 'gi');

function replaceText(text: string, r: ReplaceRule, replacement: string): { text: string; count: number } {
  if (!r.find) return { text, count: 0 };
  let count = 0;
  const out = text.replace(matcher(r), (...m) => {
    count++;
    return replacement.replace(/\$(\d)/g, (_x, d: string) => String(m[Number(d)] ?? ''));
  });
  return { text: out, count };
}

/**
 * Apply one rule to a message. `resolve` turns tokens in the replacement into
 * values. Returns the number of changes it made (0 when it did not apply).
 */
export function applyRule(r: ReplaceRule, msg: HookMessage, resolve: (s: string) => string = (s) => s): number {
  const replacement = resolve(r.replace ?? '');
  switch (r.target) {
    case 'url': {
      const res = replaceText(msg.url, r, replacement);
      if (res.count) msg.url = res.text;
      return res.count;
    }
    case 'status': {
      if (msg.status === undefined) return 0;
      const res = r.find ? replaceText(String(msg.status), r, replacement) : { text: replacement, count: 1 };
      const n = Number(res.text);
      if (!res.count || !Number.isInteger(n) || n < 100 || n > 999) return 0;
      msg.status = n;
      return 1;
    }
    case 'header': {
      const name = (r.header ?? '').toLowerCase();
      const action = r.action ?? 'replace';
      if (action === 'remove') {
        const before = msg.headers.length;
        msg.headers = msg.headers.filter(([k]) => k.toLowerCase() !== name);
        return before - msg.headers.length;
      }
      if (action === 'set') {
        // Replace every copy with one header at the first copy's position (or at the end).
        const i = msg.headers.findIndex(([k]) => k.toLowerCase() === name);
        const kept = msg.headers.filter(([k]) => k.toLowerCase() !== name);
        kept.splice(i === -1 ? kept.length : i, 0, [i === -1 ? r.header! : msg.headers[i]![0], replacement]);
        msg.headers = kept;
        return 1;
      }
      let count = 0;
      msg.headers = msg.headers.map(([k, v]) => {
        if (name && k.toLowerCase() !== name) return [k, v];
        const res = replaceText(v, r, replacement);
        count += res.count;
        return [k, res.text];
      });
      return count;
    }
    case 'body': {
      if (!msg.body.length) return 0;
      const chain = r.chain === 'auto' ? detectChain(msg.body) : r.chain ? r.chain.split(/\s*>\s*/).filter(Boolean) : [];
      if (r.jsonPath) {
        const spec = chain.length && chain[chain.length - 1] === 'json' ? chain : [...chain, 'json'];
        let value: unknown;
        try {
          value = decodeChain(spec, msg.body);
        } catch {
          return 0;
        }
        let parsed: unknown = replacement;
        try {
          parsed = JSON.parse(replacement);
        } catch {
          // a plain string value
        }
        const res = update(value, r.jsonPath, () => parsed);
        if (!res.count) return 0;
        msg.body = encodeChain(spec, res.value);
        return res.count;
      }
      if (!r.find) return 0;
      if (!chain.length) {
        if (!looksLikeText(msg.body)) return 0;
        const res = replaceText(bytesToString(msg.body), r, replacement);
        if (res.count) msg.body = new TextEncoder().encode(res.text);
        return res.count;
      }
      try {
        const res = replaceThroughChain(chain, msg.body, { find: r.find, replace: replacement, regex: r.regex, matchCase: r.matchCase, keys: r.keys });
        const total = res.counts.reduce((a, b) => a + b, 0);
        if (total) msg.body = res.output;
        return total;
      } catch {
        return 0;
      }
    }
  }
}

export function normalizeReplaceRule(r: RuleInput<ReplaceRule>): ReplaceRule {
  if (!r.name?.trim()) throw new Error('a rule needs a name');
  if (r.phase !== 'request' && r.phase !== 'response') throw new Error('phase must be "request" or "response"');
  if (!['url', 'header', 'body', 'status'].includes(r.target)) throw new Error(`invalid target "${r.target}"`);
  if (r.target === 'header' && !r.header && (r.action === 'set' || r.action === 'remove')) throw new Error('header rules that set or remove need a header name');
  if (r.regex && r.find) new RegExp(r.find);
  if (r.chain && r.chain !== 'auto') r.chain.split(/\s*>\s*/).filter(Boolean).forEach((id) => decodeChainCheck(id));
  return { ...normalizeConditions(r), id: r.id ?? newId() };
}

const decodeChainCheck = (id: string) => {
  try {
    decodeChain([id], new Uint8Array());
  } catch (e) {
    if ((e as Error).message.startsWith('unknown codec')) throw e;
  }
};

export function normalizeMock(m: RuleInput<MockRule>): MockRule {
  if (!m.name?.trim()) throw new Error('a mock needs a name');
  if (!Number.isInteger(m.status) || m.status < 100 || m.status > 999) throw new Error('mock status must be 100 to 999');
  return { ...normalizeConditions(m), headers: m.headers ?? [], body: m.body ?? '', id: m.id ?? newId() };
}
