/**
 * Search language for captured traffic. Filters are `key:value` pairs, and
 * everything else is text search over the URL, headers and decoded bodies.
 * Text matches any part of a word, ignoring case: `PO-77` finds `PO-7781`.
 *
 *   csrf_tok "Bearer eyJ"                         (anywhere: URL, headers, bodies)
 *   req:apikey res:"stack trace"                  (one side: its headers and body)
 *   reqbody:password resbody:"\"admin\":true"     (just a body)
 *   reqheader:"x-api-key" resheader:"server: nginx" (just headers, as "name: value")
 *   body:token header:x-trace                     (either side)
 *
 *   host:api.example.com method:POST status:>=400 "session expired"
 *   host:*.example.com path:/api/ body:token ws:true -status:304
 *   since:2026-11-04T09:00 until:1762246800000   (ISO time or epoch ms)
 *   tech:django tech:aws                          (hosts running a technology)
 *   error:sql error:high error:any                (server errors recognized in responses)
 *   id:01J...,01J...                              (exact exchanges, comma separated)
 *
 * A leading `-` negates a filter. Quoted text is matched as a phrase.
 */

export interface CompiledQuery {
  where: string[];
  params: unknown[];
  /** The text the query looks for, in order. */
  text: TextTerm[];
}

/** Text columns of exchange_text each text key searches. */
export const TEXT_KEYS: Record<string, TextColumn[]> = {
  text: ['url', 'req_headers', 'req_body', 'res_headers', 'res_body'],
  body: ['req_body', 'res_body'],
  header: ['req_headers', 'res_headers'],
  req: ['req_headers', 'req_body'],
  res: ['res_headers', 'res_body'],
  reqbody: ['req_body'],
  resbody: ['res_body'],
  reqheader: ['req_headers'],
  resheader: ['res_headers'],
};
export type TextColumn = 'url' | 'req_headers' | 'req_body' | 'res_headers' | 'res_body';
const TEXT_ALIASES: Record<string, string> = { request: 'req', response: 'res', reqheaders: 'reqheader', resheaders: 'resheader', headers: 'header' };

const FILTER_KEYS = new Set([
  ...['host', 'method', 'status', 'path', 'url', 'source', 'ws', 'tag', 'state', 'flow', 'scheme', 'replayof', 'since', 'until', 'tech', 'error', 'id'],
  ...Object.keys(TEXT_KEYS).filter((k) => k !== 'text'),
  ...Object.keys(TEXT_ALIASES),
]);

/** A piece of text a query looks for, and where; the Inspector highlights these. */
export interface TextTerm {
  value: string;
  in: TextColumn[];
  negate: boolean;
}

interface Token {
  key?: string;
  value: string;
  negate: boolean;
  quoted: boolean;
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const re = /(-)?(?:([a-z]+):)?(?:"((?:[^"\\]|\\.)*)"|(\S+))/gi;
  for (const m of input.matchAll(re)) {
    const [, neg, rawKey, quoted, bare] = m;
    const lower = rawKey?.toLowerCase();
    const key = lower ? (TEXT_ALIASES[lower] ?? lower) : undefined;
    if (key && !FILTER_KEYS.has(key)) {
      // Not a filter we know, so treat the whole thing as free text.
      tokens.push({ value: m[0].replace(/^-/, ''), negate: !!neg, quoted: false });
      continue;
    }
    const value = quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : (bare ?? '');
    if (!value) continue;
    tokens.push({ key, value, negate: !!neg, quoted: quoted !== undefined });
  }
  return tokens;
}

const globLike = (v: string) => v.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '%');
const ftsPhrase = (v: string) => `"${v.replace(/"/g, '""')}"`;

function statusClause(value: string): { sql: string; params: unknown[] } {
  const cls = /^([1-5])xx$/i.exec(value);
  if (cls) {
    const base = Number(cls[1]) * 100;
    return { sql: 'e.status BETWEEN ? AND ?', params: [base, base + 99] };
  }
  const range = /^(\d{3})-(\d{3})$/.exec(value);
  if (range) return { sql: 'e.status BETWEEN ? AND ?', params: [Number(range[1]), Number(range[2])] };
  const cmp = /^(>=|<=|>|<|=)?(\d{3})$/.exec(value);
  if (!cmp) throw new Error(`invalid status filter "${value}"`);
  return { sql: `e.status ${cmp[1] ?? '='} ?`, params: [Number(cmp[2])] };
}

/** Epoch ms or an ISO date/time; a time without a zone is local time, as typed. */
function timeValue(value: string): number {
  if (/^\d{10,}$/.test(value)) return Number(value);
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`invalid time "${value}": use epoch ms or an ISO time like 2026-11-04T09:30`);
  return t;
}

export interface CompileContext {
  /** Hosts running a technology; without it `tech:` matches nothing. */
  techHosts?: (tech: string) => string[];
}

export function compileQuery(input: string, ctx: CompileContext = {}): CompiledQuery {
  const where: string[] = [];
  const params: unknown[] = [];
  const text: TextTerm[] = [];

  const add = (t: Token, sql: string, p: unknown[]) => {
    where.push(t.negate ? `NOT (${sql})` : sql);
    params.push(...p);
  };

  for (const t of tokenize(input)) {
    switch (t.key) {
      case undefined:
      case 'body':
      case 'header':
      case 'req':
      case 'res':
      case 'reqbody':
      case 'resbody':
      case 'reqheader':
      case 'resheader': {
        const cols = TEXT_KEYS[t.key ?? 'text']!;
        text.push({ value: t.value, in: cols, negate: t.negate });
        // Trigrams need three characters; shorter text is a plain substring scan.
        if ([...t.value].length >= 3) add(t, 'e.id IN (SELECT exchange_id FROM exchange_text WHERE exchange_text MATCH ?)', [`{${cols.join(' ')}} : ${ftsPhrase(t.value)}`]);
        else add(t, `e.id IN (SELECT exchange_id FROM exchange_text WHERE ${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`, cols.map(() => `%${globLike(t.value)}%`));
        break;
      }
      case 'host':
        add(t, "e.host LIKE ? ESCAPE '\\'", [globLike(t.value.toLowerCase())]);
        break;
      case 'method':
        add(t, 'e.method = ?', [t.value.toUpperCase()]);
        break;
      case 'status': {
        const c = statusClause(t.value);
        add(t, c.sql, c.params);
        break;
      }
      case 'path':
        add(t, "e.path LIKE ? ESCAPE '\\'", [t.value.includes('*') ? globLike(t.value) : `${globLike(t.value)}%`]);
        break;
      case 'url':
        add(t, "e.url LIKE ? ESCAPE '\\'", [`%${globLike(t.value)}%`]);
        break;
      case 'source':
      case 'state':
      case 'scheme':
        add(t, `e.${t.key} = ?`, [t.value.toLowerCase()]);
        break;
      case 'flow':
        add(t, 'e.flow_id = ?', [t.value]);
        break;
      case 'replayof':
        add(t, 'e.replay_of = ?', [t.value]);
        break;
      case 'ws':
        add(t, 'e.is_websocket = ?', [/^(1|true|yes)$/i.test(t.value) ? 1 : 0]);
        break;
      case 'since':
        add(t, 'e.started_at >= ?', [timeValue(t.value)]);
        break;
      case 'until':
        add(t, 'e.started_at < ?', [timeValue(t.value)]);
        break;
      case 'tech': {
        const hosts = ctx.techHosts?.(t.value.toLowerCase()) ?? [];
        add(t, hosts.length ? `e.host IN (${hosts.map(() => '?').join(', ')})` : '0', hosts);
        break;
      }
      case 'error': {
        const v = t.value.toLowerCase();
        if (v === 'any' || v === 'true' || v === 'yes') add(t, 'EXISTS (SELECT 1 FROM exchange_error x WHERE x.exchange_id = e.id)', []);
        else add(t, 'EXISTS (SELECT 1 FROM exchange_error x WHERE x.exchange_id = e.id AND (x.kind = ? OR x.sig = ? OR x.severity = ?))', [v, v, v]);
        break;
      }
      case 'id': {
        const ids = t.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 500);
        add(t, ids.length ? `e.id IN (${ids.map(() => '?').join(', ')})` : '0', ids);
        break;
      }
      case 'tag':
        add(t, 'EXISTS (SELECT 1 FROM json_each(e.tags) WHERE json_each.value = ?)', [t.value]);
        break;
    }
  }

  return { where, params, text };
}
