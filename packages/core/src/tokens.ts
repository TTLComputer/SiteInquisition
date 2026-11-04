import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { JarCookie } from './cookies.js';

/**
 * Tokens are placeholders resolved when a request is sent:
 *
 *   {{cookie:session}}                 cookie from the jar for the request's host and path
 *   {{cookie:session@shop.example.com}} cookie from a named domain
 *   {{var:csrf}}                       a variable (set by hand, by an extraction rule or a script)
 *   {{uuid}} {{now}} {{now:ms}} {{now:unix}} {{random:16}}   generators
 *   {{counter:1..100}} {{counter:0..1000:10}}  batch: one send per value
 *   {{list:a,b,c}} {{list:ids.txt}}    batch: one send per item (a file in the project folder)
 *
 * Write `\{{` to send a literal `{{`.
 */
export const TOKEN_RE = /(?<!\\)\{\{\s*([a-z]+)(?::([^}]*))?\s*\}\}/gi;

export interface TokenContext {
  /** Request URL, used to pick cookies by host and path. */
  url: string;
  cookies: () => JarCookie[];
  vars: () => Record<string, string>;
  /** Folder that `{{list:file}}` paths are relative to. */
  projectDir?: string;
  /** Values for batch tokens in this send, by token text. */
  batch?: Map<string, string>;
  now?: () => number;
}

export class TokenError extends Error {}

function cookieFor(ctx: TokenContext, arg: string): string {
  const at = arg.lastIndexOf('@');
  const name = at === -1 ? arg : arg.slice(0, at);
  const domain = at === -1 ? undefined : arg.slice(at + 1).toLowerCase().replace(/^\./, '');
  let host = '';
  let path = '/';
  try {
    const u = new URL(ctx.url);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    // fall back to any domain
  }
  const now = ctx.now?.() ?? Date.now();
  const matches = ctx.cookies().filter((c) => {
    if (c.name !== name || (c.expires !== null && c.expires <= now)) return false;
    if (domain) return c.domain === domain;
    if (!host) return true;
    const domainOk = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`);
    return domainOk && path.startsWith(c.path);
  });
  // Most specific path first, then the most recently set.
  matches.sort((a, b) => b.path.length - a.path.length || b.setAt - a.setAt);
  const hit = matches[0];
  if (!hit) throw new TokenError(`no cookie "${name}"${domain ? ` for ${domain}` : host ? ` for ${host}` : ''} in the jar`);
  return hit.value;
}

function listValues(arg: string, projectDir?: string): string[] {
  if (/\.(txt|csv|lst)$/i.test(arg) && !arg.includes(',')) {
    const base = resolve(projectDir ?? '.');
    const file = isAbsolute(arg) ? arg : join(base, arg);
    if (relative(base, file).startsWith('..')) throw new TokenError(`list file must be inside the project folder: ${arg}`);
    try {
      return readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      throw new TokenError(`cannot read list file ${arg}`);
    }
  }
  return arg.split(',').map((s) => s.trim());
}

function counterValues(arg: string): string[] {
  const m = /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*(?::\s*(\d+))?\s*$/.exec(arg);
  if (!m) throw new TokenError(`counter needs a range like 1..100 or 0..1000:10, got "${arg}"`);
  const [from, to, step] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)];
  if (step <= 0) throw new TokenError('counter step must be positive');
  const width = m[1]!.startsWith('0') && m[1]!.length > 1 ? m[1]!.length : 0;
  const out: string[] = [];
  const dir = to >= from ? 1 : -1;
  for (let v = from; dir > 0 ? v <= to : v >= to; v += step * dir) {
    out.push(width ? String(v).padStart(width, '0') : String(v));
    if (out.length > 100_000) throw new TokenError('counter has more than 100000 values');
  }
  return out;
}

/** The batch tokens in some texts, with all their values; an empty array means a single send. */
export function batchTokens(texts: string[], projectDir?: string): Array<{ token: string; values: string[] }> {
  const seen = new Map<string, string[]>();
  for (const t of texts) {
    for (const m of t.matchAll(TOKEN_RE)) {
      const kind = m[1]!.toLowerCase();
      if (kind !== 'counter' && kind !== 'list') continue;
      if (seen.has(m[0])) continue;
      seen.set(m[0], kind === 'counter' ? counterValues(m[2] ?? '') : listValues(m[2] ?? '', projectDir));
    }
  }
  return [...seen.entries()].map(([token, values]) => ({ token, values }));
}

/**
 * The value sets for a batch: tokens advance together (zip), so
 * `/users/{{counter:1..3}}?n={{list:a,b,c}}` sends 1/a, 2/b, 3/c. The batch
 * is as long as the shortest token.
 */
export function batchPlan(texts: string[], projectDir?: string, max = 10_000): Array<Map<string, string>> {
  const tokens = batchTokens(texts, projectDir);
  if (!tokens.length) return [new Map()];
  const n = Math.min(...tokens.map((t) => t.values.length));
  if (n > max) throw new TokenError(`batch of ${n} sends is over the limit of ${max}`);
  return Array.from({ length: n }, (_, i) => new Map(tokens.map((t) => [t.token, t.values[i]!])));
}

export function hasTokens(text: string): boolean {
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(text);
}

export function resolveTokens(text: string, ctx: TokenContext): string {
  const out = text.replace(TOKEN_RE, (whole, rawKind: string, rawArg: string | undefined) => {
    const kind = rawKind.toLowerCase();
    const arg = (rawArg ?? '').trim();
    switch (kind) {
      case 'cookie':
        return cookieFor(ctx, arg);
      case 'var': {
        const v = ctx.vars()[arg];
        if (v === undefined) throw new TokenError(`variable "${arg}" is not set`);
        return v;
      }
      case 'uuid':
        return randomUUID();
      case 'now': {
        const t = ctx.now?.() ?? Date.now();
        return arg === 'ms' ? String(t) : arg === 'unix' ? String(Math.floor(t / 1000)) : new Date(t).toISOString();
      }
      case 'random':
        return randomBytes(Math.max(1, Math.min(256, Number(arg) || 8))).toString('hex').slice(0, Number(arg) || 16);
      case 'counter':
      case 'list': {
        const v = ctx.batch?.get(whole);
        if (v === undefined) return (kind === 'counter' ? counterValues(arg) : listValues(arg, ctx.projectDir))[0] ?? '';
        return v;
      }
      default:
        throw new TokenError(`unknown token {{${rawKind}}}`);
    }
  });
  return out.replace(/\\\{\{/g, '{{');
}
