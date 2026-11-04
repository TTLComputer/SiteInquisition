/**
 * Search language for captured traffic. Filters are `key:value` pairs, and
 * everything else is full-text search over URL, headers and decoded bodies.
 *
 *   host:api.example.com method:POST status:>=400 "session expired"
 *   host:*.example.com path:/api/ body:token ws:true -status:304
 *
 * A leading `-` negates a filter. Quoted text is matched as a phrase.
 */

export interface CompiledQuery {
  where: string[];
  params: unknown[];
  /** FTS5 MATCH expression, or undefined when there is no free text. */
  match?: string;
}

const FILTER_KEYS = new Set(['host', 'method', 'status', 'path', 'url', 'source', 'ws', 'tag', 'body', 'header', 'state', 'flow', 'scheme']);

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
    const key = rawKey?.toLowerCase();
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

export function compileQuery(input: string): CompiledQuery {
  const where: string[] = [];
  const params: unknown[] = [];
  const fts: string[] = [];

  const add = (t: Token, sql: string, p: unknown[]) => {
    where.push(t.negate ? `NOT (${sql})` : sql);
    params.push(...p);
  };

  for (const t of tokenize(input)) {
    switch (t.key) {
      case undefined:
        fts.push(t.negate ? `NOT ${ftsPhrase(t.value)}` : ftsPhrase(t.value));
        break;
      case 'body':
      case 'header': {
        const col = t.key === 'body' ? 'body' : 'headers';
        const expr = `${col}:${ftsPhrase(t.value)}`;
        fts.push(t.negate ? `NOT ${expr}` : expr);
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
      case 'ws':
        add(t, 'e.is_websocket = ?', [/^(1|true|yes)$/i.test(t.value) ? 1 : 0]);
        break;
      case 'tag':
        add(t, 'EXISTS (SELECT 1 FROM json_each(e.tags) WHERE json_each.value = ?)', [t.value]);
        break;
    }
  }

  // FTS5 cannot start an expression with NOT, so anchor pure negations on the url column.
  let match: string | undefined;
  if (fts.length) {
    const positives = fts.filter((f) => !f.startsWith('NOT '));
    const negatives = fts.filter((f) => f.startsWith('NOT '));
    if (positives.length) match = [positives.join(' AND '), ...negatives].join(' ');
    else {
      for (const n of negatives) {
        where.push('e.id NOT IN (SELECT exchange_id FROM exchange_fts WHERE exchange_fts MATCH ?)');
        params.push(n.slice(4));
      }
    }
  }
  return { where, params, match };
}
