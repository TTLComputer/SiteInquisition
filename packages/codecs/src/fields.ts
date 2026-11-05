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
import { bytesToString, decodeChain, encodeChain, parseChain } from './index.js';
import { query, update } from './jsonpath.js';

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
