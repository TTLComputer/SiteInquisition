/**
 * Field codecs: a codec chain for one field inside a JSON document, such as
 * `$.payload` holding base64 of more JSON. Decoding swaps each field for its
 * decoded value so it reads (and edits) as part of the document; encoding
 * puts every field back the way the server expects it.
 *
 * Specs apply in order when decoding, so a later spec can reach into a field
 * an earlier one decoded (`$.payload` then `$.payload.token`). Encoding runs
 * them in reverse.
 */
import { bytesToString, decodeChain, detectChain, encodeChain, parseChain } from './index.js';
import { formatPath, getAt, query, setAt, update, type PathSeg } from './jsonpath.js';

export interface FieldCodec {
  /** JSONPath of the field, e.g. $.payload or $.items[*].blob. */
  path: string;
  /** Codec ids, outermost first, e.g. ["base64", "json"]. */
  chain: string[];
}

export interface FieldResult {
  value: unknown;
  /** How many values each spec changed, in spec order. */
  counts: number[];
  /** Specs that failed on a value, with why. The value is left as it was. */
  errors: string[];
}

const asJsonValue = (v: unknown): unknown => (v instanceof Uint8Array ? bytesToString(v) : v);

/** Decode every field a spec names. Only string values are decoded; anything else is left alone. */
export function decodeFields(root: unknown, specs: FieldCodec[]): FieldResult {
  let value = root;
  const counts: number[] = [];
  const errors: string[] = [];
  for (const s of specs) {
    parseChain(s.chain);
    let n = 0;
    value = update(value, s.path, (v) => {
      if (typeof v !== 'string') return v;
      try {
        const out = asJsonValue(decodeChain(s.chain, v));
        n++;
        return out;
      } catch (e) {
        errors.push(`${s.path} (${s.chain.join(' > ')}): ${(e as Error).message}`);
        return v;
      }
    }).value;
    counts.push(n);
  }
  return { value, counts, errors };
}

/**
 * Encode every field back, innermost spec first. A field still holding a
 * string that does not decode with its chain is taken as already encoded
 * (it was never decoded, or the user pasted the encoded form) and left alone.
 */
export function encodeFields(root: unknown, specs: FieldCodec[]): FieldResult {
  let value = root;
  const counts: number[] = [];
  const errors: string[] = [];
  for (const s of [...specs].reverse()) {
    const chain = parseChain(s.chain);
    const terminal = chain[chain.length - 1]?.terminal === true;
    let n = 0;
    value = update(value, s.path, (v) => {
      // A JSON-ending chain decodes to an object, array, number...; a string there is still the encoded form.
      if (terminal && typeof v === 'string' && decodesWith(s.chain, v)) return v;
      try {
        const out = bytesToString(encodeChain(s.chain, v));
        n++;
        return out;
      } catch (e) {
        errors.push(`${s.path} (${s.chain.join(' > ')}): ${(e as Error).message}`);
        return v;
      }
    }).value;
    counts.unshift(n);
  }
  return { value, counts, errors };
}

function decodesWith(chain: string[], v: string): boolean {
  try {
    decodeChain(chain, v);
    return true;
  } catch {
    return false;
  }
}

/** Decode the fields of JSON text, pretty printed. Returns null when the text is not JSON or no spec matched. */
export function decodeFieldsText(text: string, specs: FieldCodec[]): { text: string; counts: number[]; errors: string[] } | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!specs.some((s) => query(json, s.path).length)) return null;
  const r = decodeFields(json, specs);
  if (!r.counts.some(Boolean)) return null;
  return { text: JSON.stringify(r.value, null, 2), counts: r.counts, errors: r.errors };
}

/** Encode the fields of JSON text back. Keeps the text's layout when nothing changed; throws when it is not JSON. */
export function encodeFieldsText(text: string, specs: FieldCodec[]): { text: string; counts: number[]; errors: string[] } {
  const json = JSON.parse(text) as unknown;
  const r = encodeFields(json, specs);
  return { text: r.counts.some(Boolean) ? JSON.stringify(r.value) : text, counts: r.counts, errors: r.errors };
}

/**
 * Parse "$.payload = base64>json; $.meta.sig = hex" (also one per line).
 * The chain is the part after the last "=" that looks like codec ids.
 */
export function parseFieldSpecs(spec: string): FieldCodec[] {
  const out: FieldCodec[] = [];
  for (const part of spec.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.*\S)\s*=\s*([\w-]+(?:\s*(?:>|,|→)\s*[\w-]+)*)$/.exec(part);
    if (!m) throw new Error(`"${part}": write it as $.field = codec>codec`);
    const path = m[1]!.startsWith('$') ? m[1]! : `$.${m[1]}`;
    const chain = m[2]!.split(/\s*(?:>|,|→)\s*/).filter(Boolean);
    parseChain(chain);
    out.push({ path, chain });
  }
  return out;
}

export const formatFieldSpecs = (specs: FieldCodec[]): string => specs.map((s) => `${s.path} = ${s.chain.join('>')}`).join('; ');

/**
 * A field found inside a JSON value that holds more encoded JSON, such as
 * `"inner_data": "{\"meat\": \"turkey\"}"` or a url-encoded base64 blob.
 */
export interface NestedField {
  /** Where it sits in the expanded value. Parents come before their children. */
  at: PathSeg[];
  path: string;
  /** How it was encoded, outermost first; always ends in json. */
  chain: string[];
  /** The string as it was, so an untouched field goes back byte for byte. */
  original: string;
  /** What it decoded to, before any field inside it was expanded. */
  decoded: unknown;
}

export interface Expanded {
  value: unknown;
  fields: NestedField[];
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Expand every string inside a JSON value that is itself encoded JSON
 * (directly, or through url, base64, hex, gzip...), as deep as it goes.
 * Only layers that end in a JSON object or array count, so ordinary text
 * and ids that happen to look like base64 stay as they are.
 */
export function expandNested(root: unknown, opts: { maxDepth?: number; maxFields?: number } = {}): Expanded {
  const maxDepth = opts.maxDepth ?? 8;
  const maxFields = opts.maxFields ?? 200;
  const fields: NestedField[] = [];
  const walk = (v: unknown, at: PathSeg[], depth: number): unknown => {
    if (fields.length >= maxFields) return v;
    if (typeof v === 'string') {
      if (depth >= maxDepth || v.length < 2) return v;
      const chain = detectChain(v);
      if (chain[chain.length - 1] !== 'json') return v;
      let decoded: unknown;
      try {
        decoded = decodeChain(chain, v);
      } catch {
        return v;
      }
      if (decoded === null || typeof decoded !== 'object') return v;
      fields.push({ at, path: formatPath(at), chain, original: v, decoded: structuredClone(decoded) });
      return walk(decoded, at, depth + 1);
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...at, i], depth));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, [...at, k], depth)]));
    return v;
  };
  return { value: walk(structuredClone(root), [], 0), fields };
}

/**
 * Put every expanded field back the way it was encoded, innermost first.
 * A field that was not changed goes back as its original string, so the
 * result matches the input exactly until something is edited. A field the
 * user turned back into a string (or deleted) is left as they made it.
 */
export function collapseNested(value: unknown, fields: NestedField[]): { value: unknown; changed: string[]; errors: string[] } {
  let out = structuredClone(value);
  const changed: string[] = [];
  const errors: string[] = [];
  for (const f of [...fields].reverse()) {
    const cur = getAt(out, f.at);
    if (cur === undefined || typeof cur === 'string') continue;
    if (sameJson(cur, f.decoded)) {
      out = setAt(out, f.at, f.original);
      continue;
    }
    try {
      out = setAt(out, f.at, bytesToString(encodeChain(f.chain, cur)));
      changed.push(f.path);
    } catch (e) {
      errors.push(`${f.path} (${f.chain.join(' > ')}): ${(e as Error).message}`);
    }
  }
  return { value: out, changed, errors };
}

export interface DeepDecoded extends Expanded {
  /** The outer chain, e.g. url > base64 > json. Empty when the input is not encoded JSON. */
  chain: string[];
  /** The outer value straight from the chain, before nested fields were expanded. */
  outer: unknown;
  input: string;
}

/** Decode a value all the way down: its own layers, then every nested JSON field inside. Null when it is not JSON at the bottom. */
export function deepDecode(input: string): DeepDecoded | null {
  const chain = detectChain(input);
  if (chain[chain.length - 1] !== 'json') return null;
  const outer = decodeChain(chain, input);
  if (outer === null || typeof outer !== 'object') return null;
  return { ...expandNested(outer), chain, outer, input };
}

/** Encode an edited deep value back through every layer, as text (deepDecode only takes text, so a binary outer layer such as gzip sits under base64 or hex). Unchanged input comes back exactly as it went in. */
export function deepEncode(d: DeepDecoded, value: unknown): { text: string; changed: string[]; errors: string[] } {
  const r = collapseNested(value, d.fields);
  if (sameJson(r.value, d.outer)) return { text: d.input, changed: r.changed, errors: r.errors };
  return { text: bytesToString(encodeChain(d.chain, r.value)), changed: r.changed, errors: r.errors };
}
