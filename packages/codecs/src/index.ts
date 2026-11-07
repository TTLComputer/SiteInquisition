import * as zlib from 'node:zlib';

/**
 * A codec turns a value into a decoded form and back again. Most codecs work on
 * bytes in both directions; terminal codecs such as `json` and `text` decode to a
 * structured value. Codecs are chained (`url>base64>gzip>json`) so a deeply
 * wrapped value can be edited as its innermost form and re-encoded outward.
 */
export interface Codec {
  readonly id: string;
  readonly label: string;
  decode(input: Uint8Array): Uint8Array | unknown;
  encode(value: unknown): Uint8Array;
  /** True when decode returns something other than bytes, so nothing can follow it in a chain. */
  readonly terminal?: boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });

export const toBytes = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return enc.encode(v);
  throw new TypeError(`expected bytes or string, got ${typeof v}`);
};
export const bytesToString = (b: Uint8Array): string => dec.decode(b);

const bytesCodec = (
  id: string,
  label: string,
  decode: (b: Uint8Array) => Uint8Array,
  encode: (b: Uint8Array) => Uint8Array,
): Codec => ({ id, label, decode, encode: (v) => encode(toBytes(v)) });

const buf = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength);
const strip = (s: string) => s.replace(/\s+/g, '');

const hasZstd = typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === 'function';

const registry = new Map<string, Codec>();
export const register = (c: Codec): void => void registry.set(c.id, c);

register(
  bytesCodec(
    'url',
    'URL percent-encoding',
    (b) => enc.encode(decodeURIComponent(bytesToString(b).replace(/\+/g, ' '))),
    (b) => enc.encode(encodeURIComponent(bytesToString(b))),
  ),
);
register(
  bytesCodec(
    'base64',
    'Base64',
    (b) => new Uint8Array(Buffer.from(strip(bytesToString(b)), 'base64')),
    (b) => enc.encode(buf(b).toString('base64')),
  ),
);
register(
  bytesCodec(
    'base64url',
    'Base64url',
    (b) => new Uint8Array(Buffer.from(strip(bytesToString(b)), 'base64url')),
    (b) => enc.encode(buf(b).toString('base64url')),
  ),
);
register(
  bytesCodec(
    'hex',
    'Hex',
    (b) => new Uint8Array(Buffer.from(strip(bytesToString(b)), 'hex')),
    (b) => enc.encode(buf(b).toString('hex')),
  ),
);
register(bytesCodec('gzip', 'gzip', (b) => new Uint8Array(zlib.gunzipSync(b)), (b) => new Uint8Array(zlib.gzipSync(b))));
register(
  bytesCodec('deflate', 'deflate (zlib)', (b) => new Uint8Array(inflateAny(b)), (b) => new Uint8Array(zlib.deflateSync(b))),
);
register(
  bytesCodec('br', 'Brotli', (b) => new Uint8Array(zlib.brotliDecompressSync(b)), (b) => new Uint8Array(zlib.brotliCompressSync(b))),
);
if (hasZstd) {
  const z = zlib as unknown as { zstdDecompressSync(b: Uint8Array): Buffer; zstdCompressSync(b: Uint8Array): Buffer };
  register(bytesCodec('zstd', 'Zstandard', (b) => new Uint8Array(z.zstdDecompressSync(b)), (b) => new Uint8Array(z.zstdCompressSync(b))));
}
register({
  id: 'text',
  label: 'UTF-8 text',
  terminal: true,
  decode: (b) => bytesToString(b),
  encode: (v) => toBytes(String(v)),
});
register({
  id: 'json',
  label: 'JSON',
  terminal: true,
  decode: (b) => JSON.parse(bytesToString(b)) as unknown,
  encode: (v) => enc.encode(JSON.stringify(v)),
});

register({
  id: 'jwt',
  label: 'JWT (header, payload, signature)',
  terminal: true,
  decode: (b) => {
    const parts = bytesToString(b).trim().split('.');
    if (parts.length !== 3) throw new Error('a JWT has three dot-separated parts');
    const part = (p: string) => JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as unknown;
    return { header: part(parts[0]!), payload: part(parts[1]!), signature: parts[2] };
  },
  // Re-encoding keeps the original signature: useful for testing servers that do not verify it.
  encode: (v) => {
    const o = v as { header: unknown; payload: unknown; signature?: string };
    const part = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
    return enc.encode(`${part(o.header)}.${part(o.payload)}.${o.signature ?? ''}`);
  },
});
register({
  id: 'form',
  label: 'Form fields (a=1&b=2)',
  terminal: true,
  decode: (b) => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(bytesToString(b))) {
      const cur = out[k];
      out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
    }
    return out;
  },
  encode: (v) => {
    const p = new URLSearchParams();
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) for (const x of Array.isArray(val) ? val : [val]) p.append(k, String(x));
    return enc.encode(p.toString());
  },
});

/** Servers send "deflate" as either zlib-wrapped or raw deflate; accept both. */
function inflateAny(b: Uint8Array): Buffer {
  try {
    return zlib.inflateSync(b);
  } catch {
    return zlib.inflateRawSync(b);
  }
}

export const getCodec = (id: string): Codec => {
  const c = registry.get(id);
  if (!c) throw new Error(`unknown codec "${id}"`);
  return c;
};
export const listCodecs = (): Codec[] => [...registry.values()];

/** Parse "url>base64>json" (also accepts "," or whitespace-free arrows like "→"). */
export const parseChain = (spec: string | string[]): Codec[] => {
  const ids = Array.isArray(spec) ? spec : spec.split(/\s*(?:>|,|→)\s*/).filter(Boolean);
  const chain = ids.map(getCodec);
  chain.forEach((c, i) => {
    if (c.terminal && i !== chain.length - 1) throw new Error(`codec "${c.id}" must be last in a chain`);
  });
  return chain;
};

/** Run every codec's decode in order. */
export const decodeChain = (spec: string | string[], input: Uint8Array | string): unknown => {
  let v: unknown = toBytes(input);
  for (const c of parseChain(spec)) v = c.decode(v as Uint8Array);
  return v;
};

/** Run every codec's encode in reverse order: the inverse of decodeChain. */
export const encodeChain = (spec: string | string[], value: unknown): Uint8Array => {
  const chain = parseChain(spec);
  let v: unknown = value;
  for (let i = chain.length - 1; i >= 0; i--) v = chain[i]!.encode(v);
  return toBytes(v);
};

/** Decode, let the caller change the innermost value, and re-encode. */
export const transformChain = (
  spec: string | string[],
  input: Uint8Array | string,
  fn: (value: unknown) => unknown,
): Uint8Array => encodeChain(spec, fn(decodeChain(spec, input)));

const CONTENT_ENCODINGS: Record<string, string> = {
  gzip: 'gzip',
  'x-gzip': 'gzip',
  deflate: 'deflate',
  br: 'br',
  zstd: 'zstd',
  identity: '',
};

/**
 * Undo an HTTP Content-Encoding header ("gzip", "br, gzip", ...). Returns
 * undefined when an encoding is unknown or the body is corrupt, so callers can
 * fall back to the raw bytes.
 */
export const decodeContentEncoding = (body: Uint8Array, header: string | undefined): Uint8Array | undefined => {
  if (!header) return body;
  const layers = header
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .reverse();
  let out = body;
  try {
    for (const layer of layers) {
      const id = CONTENT_ENCODINGS[layer];
      if (id === undefined || (id && !registry.has(id))) return undefined;
      if (id) out = getCodec(id).decode(out) as Uint8Array;
    }
    return out;
  } catch {
    return undefined;
  }
};

/** Best guess at whether bytes are human-readable text worth indexing. */
export const looksLikeText = (b: Uint8Array, sample = 4096): boolean => {
  const n = Math.min(b.length, sample);
  if (n === 0) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i]!;
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / n < 0.05;
};

const isPrintable = (b: Uint8Array) => b.length > 0 && looksLikeText(b) && !bytesToString(b).includes('\uFFFD');
const tryJson = (b: Uint8Array) => {
  const t = bytesToString(b).trim();
  if (!(t.startsWith('{') || t.startsWith('[') || t.startsWith('"'))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
};

/**
 * Guess the chain that unwraps a value, e.g. url > base64 > gzip > json. Each
 * step must decode cleanly and make progress; detection stops at the first
 * terminal form or when nothing else applies.
 */
export function detectChain(input: Uint8Array | string, maxSteps = 8): string[] {
  const chain: string[] = [];
  let b = toBytes(input);
  for (let i = 0; i < maxSteps; i++) {
    const step = detectStep(b);
    if (!step) break;
    chain.push(step.id);
    if (step.terminal) break;
    b = step.out!;
  }
  return chain;
}

function detectStep(b: Uint8Array): { id: string; terminal?: boolean; out?: Uint8Array } | null {
  if (b.length === 0) return null;
  if (b[0] === 0x1f && b[1] === 0x8b) return attempt('gzip', b);
  if (b[0] === 0x78 && (b[1] === 0x01 || b[1] === 0x5e || b[1] === 0x9c || b[1] === 0xda)) {
    const r = attempt('deflate', b);
    if (r) return r;
  }
  if (!isPrintable(b)) return null;
  const s = bytesToString(b).trim();
  if (tryJson(b)) return { id: 'json', terminal: true };
  if (/^eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(s)) {
    try {
      getCodec('jwt').decode(b);
      return { id: 'jwt', terminal: true };
    } catch {
      // not a JWT after all
    }
  }
  if (/%[0-9a-f]{2}/i.test(s)) {
    const r = attempt('url', b);
    if (r && bytesToString(r.out!) !== s) return r;
  }
  if (s.length >= 16 && s.length % 2 === 0 && /^[0-9a-f]+$/i.test(s)) {
    const r = attempt('hex', b);
    if (r && (isPrintable(r.out!) || detectStep(r.out!))) return r;
  }
  if (s.length >= 8 && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 !== 1) {
    const r = attempt('base64', b);
    if (r && (isPrintable(r.out!) || detectStep(r.out!))) return r;
  }
  if (s.length >= 8 && /^[A-Za-z0-9_-]+={0,2}$/.test(s) && /[-_]/.test(s)) {
    const r = attempt('base64url', b);
    if (r && (isPrintable(r.out!) || detectStep(r.out!))) return r;
  }
  if (/^[\w.%+-]+=[^&]*(&[\w.%+-]+=[^&]*)+$/.test(s)) return { id: 'form', terminal: true };
  return null;
}

function attempt(id: string, b: Uint8Array): { id: string; out: Uint8Array } | null {
  if (!registry.has(id)) return null;
  try {
    const out = getCodec(id).decode(b) as Uint8Array;
    return out.length ? { id, out } : null;
  } catch {
    return null;
  }
}

/** Every intermediate value of a chain: index 0 is the input, the last is the innermost value. */
export function decodeLayers(spec: string | string[], input: Uint8Array | string): unknown[] {
  const layers: unknown[] = [toBytes(input)];
  for (const c of parseChain(spec)) layers.push(c.decode(layers[layers.length - 1] as Uint8Array));
  return layers;
}

export interface ReplaceOptions {
  find: string;
  replace: string;
  regex?: boolean;
  matchCase?: boolean;
  /** JSON layers: also rename matching keys. Values are always searched. */
  keys?: boolean;
  /** "layer": only the innermost value. "all": every text layer, innermost first, re-encoding outward. */
  scope?: 'layer' | 'all';
}

const makeMatcher = (o: ReplaceOptions): RegExp => {
  const src = o.regex ? o.find : o.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(src, o.matchCase ? 'g' : 'gi');
};

function replaceInText(text: string, re: RegExp, replacement: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(re, (...m) => {
    count++;
    return replacement.replace(/\$(\d)/g, (_x, d: string) => String(m[Number(d)] ?? ''));
  });
  return { text: out, count };
}

/** Replace inside a JSON value: string values (and numbers/booleans when the whole value matches), and keys if asked. */
function replaceInJson(v: unknown, re: RegExp, replacement: string, keys: boolean): { value: unknown; count: number } {
  let count = 0;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') {
      const r = replaceInText(x, re, replacement);
      count += r.count;
      return r.text;
    }
    if (typeof x === 'number' || typeof x === 'boolean') {
      const s = String(x);
      const r = replaceInText(s, re, replacement);
      if (!r.count) return x;
      count += r.count;
      try {
        return JSON.parse(r.text) as unknown;
      } catch {
        return r.text;
      }
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) {
        let key = k;
        if (keys) {
          const r = replaceInText(k, re, replacement);
          count += r.count;
          key = r.text;
        }
        out[key] = walk(val);
      }
      return out;
    }
    return x;
  };
  return { value: walk(v), count };
}

/**
 * Find and replace through a codec chain and re-encode the result. Returns the
 * new outermost bytes and how many matches each layer had (index as in decodeLayers).
 */
export function replaceThroughChain(spec: string | string[], input: Uint8Array | string, o: ReplaceOptions): { output: Uint8Array; counts: number[] } {
  const chain = parseChain(spec);
  const layers = decodeLayers(chain.map((c) => c.id), input);
  const counts = layers.map(() => 0);
  const re = makeMatcher(o);
  const n = layers.length - 1;
  const replaceLayer = (v: unknown, i: number): unknown => {
    re.lastIndex = 0;
    if (v instanceof Uint8Array) {
      if (!looksLikeText(v)) return v;
      const r = replaceInText(bytesToString(v), re, o.replace);
      counts[i] = r.count;
      return r.count ? enc.encode(r.text) : v;
    }
    if (typeof v === 'string') {
      const r = replaceInText(v, re, o.replace);
      counts[i] = r.count;
      return r.text;
    }
    const r = replaceInJson(v, re, o.replace, !!o.keys);
    counts[i] = r.count;
    return r.value;
  };
  let v = replaceLayer(layers[n], n);
  for (let i = n - 1; i >= 0; i--) {
    v = chain[i]!.encode(v);
    if (o.scope === 'all') v = replaceLayer(v, i);
  }
  return { output: toBytes(v), counts };
}

import { PROTOCOL_CODEC_DEFS } from './protocols.js';
for (const c of PROTOCOL_CODEC_DEFS) register(c);
export * from './protocols.js';

import { PROTOBUF_CODEC_DEFS } from './protobuf.js';
for (const c of PROTOBUF_CODEC_DEFS) register(c);
export * from './protobuf.js';

export * from './fields.js';
export * from './regions.js';
export * from './structure.js';
export * from './httpmsg.js';
