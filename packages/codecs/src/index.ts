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
