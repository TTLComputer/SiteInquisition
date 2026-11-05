/**
 * JSONPath filters for search: `resjson:$.order.status=open`,
 * `reqjson:"$.payload['some_value']~abc"`, `json:$.items[*].qty>=2`, or a
 * bare path to say the field is there. Paths are the same JSONPath Replay
 * and the Codecs use. A field holding more encoded JSON (a JSON string,
 * base64 of JSON...) is looked into too, so `$.payload.user` works when
 * payload is base64.
 */
import { expandNested } from '@siteinquisition/codecs';
import { parsePath, query } from '@siteinquisition/codecs/jsonpath';

export type JsonOp = '=' | '!=' | '~' | '!~' | '>' | '>=' | '<' | '<=';

export interface JsonFilter {
  path: string;
  /** No op: the field is present (and not null). */
  op?: JsonOp;
  value?: string;
}

const OPS: JsonOp[] = ['!=', '!~', '>=', '<=', '=', '~', '>', '<'];

/** Split "path op value", finding the operator outside brackets and quotes. */
export function parseJsonFilter(spec: string): JsonFilter {
  const s = spec.trim();
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (depth === 0) {
      const op = OPS.find((o) => s.startsWith(o, i));
      if (op && i > 0) return check({ path: normalize(s.slice(0, i)), op, value: unquote(s.slice(i + op.length).trim()) });
    }
  }
  return check({ path: normalize(s) });
}

const normalize = (p: string) => {
  const t = p.trim();
  return t.startsWith('$') ? t : t.startsWith('[') ? `$${t}` : `$.${t}`;
};
const unquote = (v: string) => (/^(["']).*\1$/s.test(v) && v.length >= 2 ? v.slice(1, -1) : v);

function check(f: JsonFilter): JsonFilter {
  try {
    parsePath(f.path);
  } catch (e) {
    throw new Error(`JSON filter "${f.path}": ${(e as Error).message}`);
  }
  if (f.op && ['>', '>=', '<', '<='].includes(f.op) && !Number.isFinite(Number(f.value))) throw new Error(`JSON filter ${f.path} ${f.op}: compare with a number, not "${f.value}"`);
  return f;
}

/** Does a value from the document satisfy the filter's comparison? */
function compare(v: unknown, f: JsonFilter): boolean {
  if (v === undefined) return false;
  if (!f.op) return v !== null;
  const want = f.value ?? '';
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  switch (f.op) {
    case '=':
    case '!=': {
      const eq = typeof v === 'string' ? v === want : typeof v === 'number' ? want.trim() !== '' && Number(want) === v : text === want;
      return f.op === '=' ? eq : !eq;
    }
    case '~':
    case '!~': {
      const has = text.toLowerCase().includes(want.toLowerCase());
      return f.op === '~' ? has : !has;
    }
    default: {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) return false;
      const w = Number(want);
      return f.op === '>' ? n > w : f.op === '>=' ? n >= w : f.op === '<' ? n < w : n <= w;
    }
  }
}

function test(doc: unknown, f: JsonFilter): boolean {
  try {
    return query(doc, f.path).some((m) => compare(m.value, f));
  } catch {
    return false;
  }
}

/** Whether a body (as text) matches. Not JSON, or the field is missing: no match. */
export function jsonFilterMatches(text: string | null | undefined, f: JsonFilter): boolean {
  if (!text) return false;
  const t = text.trimStart();
  if (t[0] !== '{' && t[0] !== '[') return false;
  let doc: unknown;
  try {
    doc = JSON.parse(t);
  } catch {
    return false;
  }
  if (test(doc, f)) return true;
  // The field may sit inside a value that is itself encoded JSON.
  const x = expandNested(doc, { maxFields: 50 });
  return x.fields.length > 0 && test(x.value, f);
}

/** A bare search word that is a JSONPath, such as $.payload['x'], is a JSON filter. */
export const looksLikeJsonPath = (s: string): boolean => /^\$(\.|\[|$)/.test(s) && s.length > 1;
