/**
 * Decode one value (a query parameter, a header, a cookie, a form field) as
 * far as it goes, for the structured request editors, and encode an edited
 * version back through the same layers. An untouched value goes back exactly
 * as it came, however oddly it was encoded.
 */
import { bytesToString, decodeChain, detectChain, encodeChain, looksLikeText, toBytes } from './index.js';
import { collapseNested, expandNested, type NestedField } from './fields.js';

export interface DecodedValue {
  /** Layers, outermost first, e.g. url > base64 > json. */
  chain: string[];
  /**
   * json: display is pretty JSON (nested encoded fields expanded too);
   * form: display is a=1&b=2 text, for the rows editor;
   * text: display is the decoded text.
   */
  kind: 'json' | 'form' | 'text';
  display: string;
  /** The value as it was given. */
  original: string;
  /** Nested encoded JSON fields that were expanded inside a json value. */
  fields: NestedField[];
  /** The outer decoded JSON value before nested fields were expanded (json only). */
  outer?: unknown;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Decode a value, or null when nothing about it is encoded. Plain JSON
 * counts (it is shown pretty, with nested encoded fields opened up), so does
 * a value that is form fields after its layers.
 */
export function decodeValue(text: string): DecodedValue | null {
  if (text.length < 2 || /\{\{/.test(text)) return null;
  const chain = detectChain(text);
  if (!chain.length) return null;
  const last = chain[chain.length - 1]!;
  if (last === 'form') {
    const inner = chain.slice(0, -1);
    let display = text;
    if (inner.length) {
      const v = decodeChain(inner, text);
      if (!(v instanceof Uint8Array) || !looksLikeText(v)) return null;
      display = bytesToString(v);
    }
    // A value that is form fields with no layers on top is still worth showing as rows.
    return { chain, kind: 'form', display, original: text, fields: [] };
  }
  let value: unknown;
  try {
    value = decodeChain(chain, text);
  } catch {
    return null;
  }
  if (last === 'json' || last === 'jwt') {
    if (value === null || typeof value !== 'object') return null;
    const ex = expandNested(value);
    return { chain, kind: 'json', display: JSON.stringify(ex.value, null, 2), original: text, fields: ex.fields, outer: value };
  }
  const bytes = value instanceof Uint8Array ? value : typeof value === 'string' ? toBytes(value) : null;
  if (!bytes || !looksLikeText(bytes)) return null;
  const s = bytesToString(bytes);
  if (s.includes('�') || s === text) return null;
  // The decoded text may itself be form fields or JSON after its layers.
  const deeper = decodeValue(s);
  if (deeper && (deeper.kind === 'json' || deeper.kind === 'form')) return { ...deeper, chain: [...chain, ...deeper.chain], original: text, fields: deeper.fields };
  return { chain, kind: 'text', display: s, original: text, fields: [] };
}

/** Encode an edited display back to a value through the decoded layers. */
export function encodeValue(d: DecodedValue, shown: string): string {
  if (shown === d.display) return d.original;
  if (d.kind === 'form') {
    const inner = d.chain.slice(0, -1);
    return inner.length ? bytesToString(encodeChain(inner, shown)) : shown;
  }
  if (d.kind === 'text') return bytesToString(encodeChain(d.chain, shown));
  let edited: unknown;
  try {
    edited = JSON.parse(shown);
  } catch (e) {
    throw new Error(`That is not valid JSON: ${(e as Error).message}`);
  }
  const r = collapseNested(edited, d.fields);
  if (r.errors.length) throw new Error(r.errors[0]);
  if (sameJson(r.value, d.outer)) return d.original;
  return bytesToString(encodeChain(d.chain, r.value));
}
