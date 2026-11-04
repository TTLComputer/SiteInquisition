/**
 * A small JSONPath for finding and bulk-editing values. No Node imports, so the
 * renderer can use it directly.
 *
 *   $.user.name   $['odd key']   $.items[0]   $.items[*].price   $..id
 *   $.items[?(@.qty>1)]   $.items[?(@.sku=='A1')]   $.items[-1]
 */
export type PathSeg = string | number;
export interface Match {
  path: PathSeg[];
  value: unknown;
}

type Step =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'wild' }
  | { kind: 'deep'; key: string | null }
  | { kind: 'filter'; key: string[]; op: string; value: unknown };

export function parsePath(path: string): Step[] {
  const p = path.trim();
  if (!p.startsWith('$')) throw new Error('a JSONPath starts with $');
  const steps: Step[] = [];
  let i = 1;
  const ident = () => {
    const m = /^[A-Za-z_$][\w$-]*|^\*/.exec(p.slice(i));
    if (!m) throw new Error(`expected a name at position ${i} in ${path}`);
    i += m[0].length;
    return m[0];
  };
  while (i < p.length) {
    if (p.startsWith('..', i)) {
      i += 2;
      if (p[i] === '[') {
        steps.push({ kind: 'deep', key: null });
        continue;
      }
      const name = ident();
      steps.push({ kind: 'deep', key: name === '*' ? null : name });
    } else if (p[i] === '.') {
      i++;
      const name = ident();
      steps.push(name === '*' ? { kind: 'wild' } : { kind: 'key', key: name });
    } else if (p[i] === '[') {
      const end = findClose(p, i);
      const inner = p.slice(i + 1, end).trim();
      i = end + 1;
      if (inner === '*') steps.push({ kind: 'wild' });
      else if (/^-?\d+$/.test(inner)) steps.push({ kind: 'index', index: Number(inner) });
      else if (/^(['"]).*\1$/.test(inner)) steps.push({ kind: 'key', key: inner.slice(1, -1) });
      else if (inner.startsWith('?(') && inner.endsWith(')')) steps.push(parseFilter(inner.slice(2, -1)));
      else throw new Error(`cannot read [${inner}] in ${path}`);
    } else throw new Error(`unexpected "${p[i]}" at position ${i} in ${path}`);
  }
  return steps;
}

function findClose(p: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let j = start; j < p.length; j++) {
    const c = p[j]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') {
      depth--;
      if (depth === 0 && c === ']') return j;
    }
  }
  throw new Error('unclosed [ in JSONPath');
}

function parseFilter(expr: string): Step {
  const m = /^@((?:\.[\w$-]+)+)\s*(==|!=|>=|<=|>|<|=~)?\s*(.*)$/.exec(expr.trim());
  if (!m) throw new Error(`cannot read filter ?(${expr})`);
  const key = m[1]!.slice(1).split('.');
  if (!m[2]) return { kind: 'filter', key, op: 'exists', value: null };
  const raw = m[3]!.trim();
  let value: unknown = raw;
  if (/^(['"]).*\1$/.test(raw)) value = raw.slice(1, -1);
  else if (m[2] === '=~') value = raw.replace(/^\/|\/[a-z]*$/g, '');
  else {
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
  }
  return { kind: 'filter', key, op: m[2], value };
}

const children = (v: unknown): Array<[PathSeg, unknown]> =>
  Array.isArray(v) ? v.map((x, i) => [i, x]) : v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>) : [];

function test(item: unknown, s: Extract<Step, { kind: 'filter' }>): boolean {
  let v: unknown = item;
  for (const k of s.key) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  switch (s.op) {
    case 'exists':
      return v !== undefined;
    case '==':
      return v === s.value;
    case '!=':
      return v !== s.value;
    case '>':
      return typeof v === 'number' && v > (s.value as number);
    case '<':
      return typeof v === 'number' && v < (s.value as number);
    case '>=':
      return typeof v === 'number' && v >= (s.value as number);
    case '<=':
      return typeof v === 'number' && v <= (s.value as number);
    case '=~':
      return typeof v === 'string' && new RegExp(String(s.value)).test(v);
    default:
      return false;
  }
}

export function query(root: unknown, path: string): Match[] {
  let current: Match[] = [{ path: [], value: root }];
  for (const step of parsePath(path)) {
    const next: Match[] = [];
    for (const m of current) {
      const v = m.value;
      if (step.kind === 'key') {
        if (v && typeof v === 'object' && !Array.isArray(v) && step.key in (v as object)) next.push({ path: [...m.path, step.key], value: (v as Record<string, unknown>)[step.key] });
      } else if (step.kind === 'index') {
        if (Array.isArray(v)) {
          const i = step.index < 0 ? v.length + step.index : step.index;
          if (i >= 0 && i < v.length) next.push({ path: [...m.path, i], value: v[i] });
        }
      } else if (step.kind === 'wild') {
        for (const [k, c] of children(v)) next.push({ path: [...m.path, k], value: c });
      } else if (step.kind === 'filter') {
        for (const [k, c] of children(v)) if (test(c, step)) next.push({ path: [...m.path, k], value: c });
      } else {
        const walk = (val: unknown, p: PathSeg[]) => {
          for (const [k, c] of children(val)) {
            if (step.key === null || k === step.key) next.push({ path: [...p, k], value: c });
            walk(c, [...p, k]);
          }
        };
        walk(v, m.path);
      }
    }
    current = next;
  }
  return current;
}

export const formatPath = (path: PathSeg[]): string =>
  '$' + path.map((s) => (typeof s === 'number' ? `[${s}]` : /^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `['${s.replace(/'/g, "\\'")}']`)).join('');

/** Return a copy of root with fn applied to every match; also the number changed. */
export function update(root: unknown, path: string, fn: (value: unknown, at: PathSeg[]) => unknown): { value: unknown; count: number } {
  const matches = query(root, path);
  let out = structuredClone(root);
  // Deepest first, so editing a parent never invalidates a child path.
  matches.sort((a, b) => b.path.length - a.path.length);
  for (const m of matches) out = setAt(out, m.path, fn(getAt(out, m.path), m.path));
  return { value: out, count: matches.length };
}

export function getAt(root: unknown, path: PathSeg[]): unknown {
  let v = root;
  for (const s of path) v = v && typeof v === 'object' ? (v as Record<string | number, unknown>)[s] : undefined;
  return v;
}

export function setAt(root: unknown, path: PathSeg[], value: unknown): unknown {
  if (path.length === 0) return value;
  let v = root as Record<string | number, unknown>;
  for (const s of path.slice(0, -1)) v = v[s] as Record<string | number, unknown>;
  v[path[path.length - 1]!] = value;
  return root;
}

export type BulkOp = 'set' | 'increment' | 'swap-type' | 'flip' | 'append' | 'delete';

/** The JSON editor's bulk operations, applied to every value a path matches. */
export function bulk(root: unknown, path: string, op: BulkOp, arg?: unknown): { value: unknown; count: number } {
  if (op === 'delete') {
    const matches = query(root, path).sort((a, b) => b.path.length - a.path.length || Number(b.path.at(-1)) - Number(a.path.at(-1)));
    const out = structuredClone(root);
    for (const m of matches) {
      const parent = getAt(out, m.path.slice(0, -1));
      const k = m.path.at(-1)!;
      if (Array.isArray(parent)) parent.splice(Number(k), 1);
      else if (parent && typeof parent === 'object') delete (parent as Record<string, unknown>)[k];
    }
    return { value: out, count: matches.length };
  }
  return update(root, path, (v) => {
    switch (op) {
      case 'set':
        return structuredClone(arg);
      case 'increment':
        return typeof v === 'number' ? v + (Number(arg) || 1) : typeof v === 'string' && /^-?\d+$/.test(v) ? String(Number(v) + (Number(arg) || 1)) : v;
      case 'swap-type':
        // The classic type-confusion probe: numbers become strings and back, booleans become "true"/"false".
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (typeof v === 'string') {
          if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
          if (v === 'true' || v === 'false') return v === 'true';
        }
        return v;
      case 'flip':
        return typeof v === 'boolean' ? !v : v;
      case 'append':
        return Array.isArray(v) ? [...v, structuredClone(arg)] : typeof v === 'string' ? v + String(arg ?? '') : v;
      default:
        return v;
    }
  });
}
