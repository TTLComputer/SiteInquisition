/**
 * Decode a region of text in place, and encode regions back. The renderer
 * keeps where regions are (regionedit.ts); this does the codec work, which
 * needs the zlib-backed codecs.
 */
import { bytesToString, decodeChain, detectChain, encodeChain, getCodec, looksLikeText, parseChain, toBytes } from './index.js';
import type { FieldCodec } from './fields.js';
import { formatPath, update, type PathSeg } from './jsonpath.js';
import { adjustForEdit, regionId, regionLabel, sortRegions, type RegionWrap, type TextRegion } from './regionedit.js';

export * from './regionedit.js';

export interface RegionPlan {
  /** The span that was decoded; it can differ from the selection (trimmed, or widened to a whole JSON string). */
  start: number;
  end: number;
  /** The decoded value as it reads in place. */
  display: string;
  region: Omit<TextRegion, 'start' | 'end' | 'id'>;
}

const LIT_RE = /"(?:[^"\\\n]|\\.)*"/g;

/** JSON string literals on the line around an offset. */
function literalsOnLine(text: string, at: number): Array<[number, number]> {
  const ls = text.lastIndexOf('\n', at - 1) + 1;
  let le = text.indexOf('\n', at);
  if (le === -1) le = text.length;
  const line = text.slice(ls, le);
  const out: Array<[number, number]> = [];
  LIT_RE.lastIndex = 0;
  for (let m = LIT_RE.exec(line); m; m = LIT_RE.exec(line)) out.push([ls + m.index, ls + m.index + m[0].length]);
  return out;
}

const isLiteral = (s: string) => {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return false;
  try {
    return typeof JSON.parse(s) === 'string';
  } catch {
    return false;
  }
};

const VALUE_CHARS = /[A-Za-z0-9+/=_\-.%~]/;

/** With nothing selected: the value under the caret (a JSON string's content, or a run like a cookie value or a token). */
function expandCaret(text: string, at: number): [number, number] | null {
  for (const [s, e] of literalsOnLine(text, at)) if (at > s && at < e) return [s + 1, e - 1];
  let s = at;
  let e = at;
  while (s > 0 && VALUE_CHARS.test(text[s - 1]!)) s--;
  while (e < text.length && VALUE_CHARS.test(text[e]!)) e++;
  if (e <= s) return null;
  // name=value: take the value (keeping base64 padding).
  const m = /^(.*?=)?([^=]+=*)$/.exec(text.slice(s, e));
  if (m?.[1]) s += m[1].length;
  return e > s ? [s, e] : null;
}

/** Leading spaces of the line an offset sits on, so a multi-line value lines up under it. */
const lineIndent = (text: string, at: number) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', at - 1) + 1))![0];

const indentLines = (s: string, indent: string) => (indent ? s.replace(/\n/g, `\n${indent}`) : s);

const jsonEscape = (s: string) => JSON.stringify(s).slice(1, -1);
const jsonUnescape = (s: string) => JSON.parse(`"${s}"`) as string;

/**
 * Work out what to decode for a selection, and decode it. Smart about where
 * the value sits: surrounding spaces and a trailing comma are dropped, a
 * selection of a JSON string's content (or the string with its quotes)
 * decodes the string's value and replaces the whole string, and an empty
 * selection takes the value under the caret. Throws with a message for the
 * user when nothing decodes.
 */
export function planRegion(text: string, start: number, end: number, opts: { chain?: string[] } = {}): RegionPlan {
  if (start > end) [start, end] = [end, start];
  if (start === end) {
    const r = expandCaret(text, start);
    if (!r) throw new Error('Select the value to decode.');
    [start, end] = r;
  }
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /[\s,;]/.test(text[end - 1]!)) end--;
  if (start === end) throw new Error('Select the value to decode.');

  let wrap: RegionWrap = 'none';
  let inner = text.slice(start, end);
  const lit = isLiteral(inner) ? ([start, end] as [number, number]) : literalsOnLine(text, start).find(([s, e]) => s + 1 === start && e - 1 === end);
  if (lit) {
    [start, end] = lit;
    wrap = 'jsonstr';
    inner = JSON.parse(text.slice(start, end)) as string;
  } else if (inner.includes('\\') && literalsOnLine(text, start).some(([s, e]) => start > s && end < e)) {
    try {
      inner = jsonUnescape(inner);
      wrap = 'jsonesc';
    } catch {
      // not a valid escaped piece; decode it as written
    }
  }

  const chain = opts.chain?.length ? opts.chain : detectChain(inner);
  if (!chain.length) throw new Error('Nothing here looks encoded. Try Decode as, or open it in Codecs.');
  parseChain(chain);
  if (wrap === 'none' && chain.length === 1 && chain[0] === 'json') throw new Error('This is already plain JSON.');
  let value: unknown;
  try {
    value = decodeChain(chain, inner);
  } catch (e) {
    throw new Error(`It does not decode as ${chain.join(' › ')}: ${(e as Error).message}`);
  }
  const original = text.slice(start, end);
  const indent = lineIndent(text, start);
  if (value instanceof Uint8Array || typeof value === 'string') {
    const bytes = typeof value === 'string' ? toBytes(value) : value;
    const s = bytesToString(bytes);
    if (!looksLikeText(bytes) || s.includes('�')) throw new Error(`It decodes (${chain.join(' › ')}) to ${bytes.length} bytes of binary data. Open it in Codecs to see them as hex.`);
    const display = wrap === 'jsonstr' ? JSON.stringify(s) : wrap === 'jsonesc' ? jsonEscape(s) : s;
    return { start, end, display, region: { chain, wrap, kind: 'text', original, decoded: s } };
  }
  const compact = JSON.stringify(value) ?? 'null';
  const display = wrap === 'jsonesc' ? jsonEscape(compact) : indentLines(JSON.stringify(value, null, 2) ?? 'null', indent);
  return { start, end, display, region: { chain, wrap, kind: 'json', original, decoded: compact } };
}

/** One region's text back to its encoded form. Untouched regions give back exactly what they replaced. */
export function encodeRegion(r: Pick<TextRegion, 'chain' | 'wrap' | 'kind' | 'original' | 'decoded'>, shown: string): string {
  const label = regionLabel(r);
  let value: unknown;
  try {
    const raw = r.wrap === 'jsonesc' ? jsonUnescape(shown) : shown;
    if (r.kind === 'json') value = JSON.parse(raw);
    else if (r.wrap === 'jsonstr') {
      value = JSON.parse(raw);
      if (typeof value !== 'string') throw new Error('it must stay a "quoted string"');
    } else value = raw;
  } catch (e) {
    throw new Error(`The decoded ${label} value is not valid ${r.kind === 'json' ? 'JSON' : 'text'}: ${(e as Error).message}`);
  }
  const same = r.kind === 'json' ? JSON.stringify(value) === r.decoded : value === r.decoded;
  if (same) return r.original;
  const chain = parseChain(r.chain);
  const last = chain[chain.length - 1]!;
  let s: string;
  try {
    s = bytesToString(encodeChain(r.chain, r.kind === 'json' || last.terminal ? value : toBytes(value as string)));
  } catch (e) {
    throw new Error(`Could not encode the decoded ${label} value: ${(e as Error).message}`);
  }
  return r.wrap === 'jsonstr' ? JSON.stringify(s) : r.wrap === 'jsonesc' ? jsonEscape(s) : s;
}

const TOKENISH = /(?<!\\)\{\{/;
const BLOCK_RE = /\{\{encode:(none|jsonstr|jsonesc):(json|text):([\w>-]+)\}\}((?:(?!\{\{encode:)[\s\S])*?)\{\{\/encode\}\}/;

/**
 * Encode every region back, innermost first, so a region inside a decoded
 * value is encoded before the value around it. With `blocks`, a region that
 * holds {{tokens}} is written as an encode block instead, for the sender to
 * encode once the tokens are filled in (see applyEncodeBlocks).
 */
export function encodeRegions(text: string, regions: TextRegion[], opts: { blocks?: boolean } = {}): { text: string; blocks: number } {
  let out = text;
  let left = sortRegions(regions);
  let blocks = 0;
  while (left.length) {
    // A region with nothing left inside it.
    const r = left.find((x) => !left.some((y) => y !== x && y.start >= x.start && y.end <= x.end && y.end - y.start < x.end - x.start))!;
    const shown = out.slice(r.start, r.end);
    let rep: string;
    if (opts.blocks && TOKENISH.test(shown)) {
      rep = `{{encode:${r.wrap}:${r.kind}:${r.chain.join('>')}}}${shown}{{/encode}}`;
      blocks++;
    } else rep = encodeRegion(r, shown);
    out = out.slice(0, r.start) + rep + out.slice(r.end);
    left = adjustForEdit(
      left.filter((x) => x !== r),
      r.start,
      r.end,
      rep.length,
    );
  }
  return { text: out, blocks };
}

/** Encode the {{encode:...}}...{{/encode}} blocks encodeRegions wrote, innermost first, after tokens are filled in. */
export function applyEncodeBlocks(text: string): string {
  let out = text;
  for (let m = BLOCK_RE.exec(out); m; m = BLOCK_RE.exec(out)) {
    const [whole, wrap, kind, chain, inner] = m;
    const rep = encodeRegion({ wrap: wrap as RegionWrap, kind: kind as 'json' | 'text', chain: chain!.split('>'), original: '', decoded: '\u0000' }, inner!);
    out = out.slice(0, m.index) + rep + out.slice(m.index + whole.length);
  }
  return out;
}

export const hasEncodeBlocks = (text: string): boolean => text.includes('{{encode:');

/** Pretty JSON exactly as JSON.stringify(v, null, 2) writes it, with where each tracked path's value landed. */
function printTracked(root: unknown, tracked: Set<string>): { text: string; spans: Map<string, [number, number]> } {
  let out = '';
  const spans = new Map<string, [number, number]>();
  const walk = (v: unknown, at: PathSeg[], indent: string) => {
    const key = JSON.stringify(at);
    const start = out.length;
    const inner = `${indent}  `;
    if (Array.isArray(v)) {
      if (!v.length) out += '[]';
      else {
        out += '[\n';
        v.forEach((x, i) => {
          out += inner;
          walk(x === undefined ? null : x, [...at, i], inner);
          out += i < v.length - 1 ? ',\n' : '\n';
        });
        out += `${indent}]`;
      }
    } else if (v && typeof v === 'object') {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      if (!entries.length) out += '{}';
      else {
        out += '{\n';
        entries.forEach(([k, x], i) => {
          out += `${inner}${JSON.stringify(k)}: `;
          walk(x, [...at, k], inner);
          out += i < entries.length - 1 ? ',\n' : '\n';
        });
        out += `${indent}}`;
      }
    } else out += JSON.stringify(v) ?? 'null';
    if (tracked.has(key)) spans.set(key, [start, out.length]);
  };
  walk(root, [], '');
  return { text: out, spans };
}

/**
 * Saved field codecs as decoded regions: the JSON text pretty printed with
 * each field decoded in place and marked as a region, nested fields
 * included. Null when the text is not JSON or no field decoded.
 */
export function fieldRegions(text: string, specs: Array<FieldCodec & { id?: string }>): { text: string; regions: TextRegion[]; errors: string[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const found: Array<{ at: PathSeg[]; spec: FieldCodec & { id?: string }; original: string; decoded: unknown }> = [];
  const errors: string[] = [];
  for (const spec of specs) {
    try {
      parseChain(spec.chain);
    } catch (e) {
      errors.push(`${spec.path}: ${(e as Error).message}`);
      continue;
    }
    value = update(value, spec.path, (v, at) => {
      if (typeof v !== 'string') return v;
      try {
        let d = decodeChain(spec.chain, v);
        if (d instanceof Uint8Array) {
          if (!looksLikeText(d)) throw new Error('decodes to binary data');
          d = bytesToString(d);
        }
        found.push({ at, spec, original: v, decoded: structuredClone(d) });
        return d;
      } catch (e) {
        errors.push(`${spec.path} (${spec.chain.join(' > ')}): ${(e as Error).message}`);
        return v;
      }
    }).value;
  }
  if (!found.length) return null;
  const printed = printTracked(value, new Set(found.map((f) => JSON.stringify(f.at))));
  const regions: TextRegion[] = [];
  for (const f of found) {
    const span = printed.spans.get(JSON.stringify(f.at));
    if (!span) continue;
    const kind = typeof f.decoded === 'string' ? 'text' : 'json';
    regions.push({
      id: regionId(),
      start: span[0],
      end: span[1],
      chain: f.spec.chain,
      wrap: 'jsonstr',
      kind,
      original: JSON.stringify(f.original),
      decoded: kind === 'text' ? (f.decoded as string) : JSON.stringify(f.decoded),
      ...(f.spec.id ? { rule: f.spec.id } : {}),
    });
  }
  return { text: printed.text, regions: sortRegions(regions), errors };
}

const MARK = '__siq_region_mark__';

/**
 * The JSONPath of the field a region took the place of, in a JSON text that
 * may have other regions decoded in it ($.payload.token when the region is
 * inside a decoded $.payload). Null when the text is not JSON around it.
 */
export function regionPath(text: string, start: number, end: number): string | null {
  let root: unknown;
  try {
    root = JSON.parse(`${text.slice(0, start)}"${MARK}"${text.slice(end)}`);
  } catch {
    return null;
  }
  let hit: PathSeg[] | null = null;
  const walk = (v: unknown, at: PathSeg[]) => {
    if (hit) return;
    if (v === MARK) hit = at;
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...at, i]));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...at, k]);
  };
  walk(root, []);
  return hit ? formatPath(hit) : null;
}

/** For the codec list in "Decode as": ids that make sense to start a region with. */
export const regionCodecIds = (): string[] => ['url', 'base64', 'base64url', 'hex', 'gzip', 'deflate', 'json', 'jwt', 'form'].filter((id) => {
  try {
    getCodec(id);
    return true;
  } catch {
    return false;
  }
});
