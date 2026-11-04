import { createHmac, createPrivateKey, createPublicKey, createSign, createVerify, timingSafeEqual, sign as rawSign, verify as rawVerify, type KeyObject } from 'node:crypto';

/**
 * JSON Web Tokens: read one, say what is risky about it, and sign an edited
 * copy with a key the user holds. Everything uses node:crypto.
 */

export interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** The signature as received, base64url. */
  signature: string;
  alg: string;
  issuedAt?: number;
  expiresAt?: number;
  notBefore?: number;
  issuer?: string;
  subject?: string;
  audience?: string | string[];
  expired: boolean;
  flags: JwtFlag[];
}

export interface JwtFlag {
  id: 'alg-none' | 'symmetric' | 'weak-secret' | 'kid' | 'key-url' | 'embedded-key' | 'no-expiry' | 'long-lived' | 'expired' | 'not-yet-valid';
  severity: 'high' | 'medium' | 'low' | 'info';
  text: string;
}

export const JWT_RE = /^eyJ[\w-]*\.eyJ[\w-]*\.[\w-]*$/;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');

/**
 * A few placeholder secrets that ship in framework examples and tutorials. A
 * token that verifies under one of these is forgeable by anyone. This is a
 * deliberately tiny starter set; callers pass their own list to check more.
 */
export const EXAMPLE_SECRETS = ['secret', 'your-256-bit-secret', 'changeme', 'jwt_secret', 'supersecret'];

const HMAC_ALG: Record<string, string> = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };
const RSA_PSS_ALG: Record<string, string> = { PS256: 'sha256', PS384: 'sha384', PS512: 'sha512' };
const RSA_ALG: Record<string, string> = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512' };
const EC_ALG: Record<string, string> = { ES256: 'sha256', ES384: 'sha384', ES512: 'sha512' };
const EC_SIZE: Record<string, number> = { ES256: 32, ES384: 48, ES512: 66 };

const asMs = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v * 1000 : undefined);

/** Parse a JWT and note what is risky about it. Does not verify the signature. */
export function parseJwt(token: string, now = Date.now()): ParsedJwt {
  const parts = token.trim().split('.');
  if (parts.length !== 3) throw new Error('a JWT has three dot-separated parts');
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(fromB64url(parts[0]!).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('the JWT header is not valid base64url JSON');
  }
  try {
    payload = JSON.parse(fromB64url(parts[1]!).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('the JWT payload is not valid base64url JSON');
  }
  const alg = String(header.alg ?? 'none');
  const expiresAt = asMs(payload.exp);
  const notBefore = asMs(payload.nbf);
  const issuedAt = asMs(payload.iat);
  const expired = expiresAt !== undefined && expiresAt <= now;

  const flags: JwtFlag[] = [];
  if (/^none$/i.test(alg)) flags.push({ id: 'alg-none', severity: 'high', text: 'alg is "none": if the server accepts it, the signature is not checked at all.' });
  if (alg in HMAC_ALG) flags.push({ id: 'symmetric', severity: 'medium', text: `${alg} is symmetric: whoever knows the signing secret can mint tokens. Try re-signing with a guessed or leaked secret.` });
  if (typeof header.kid === 'string') flags.push({ id: 'kid', severity: 'low', text: `kid "${header.kid}": some servers read the key from a path or query built from kid, which can allow injection or key confusion.` });
  if (typeof header.jku === 'string' || typeof header.x5u === 'string') flags.push({ id: 'key-url', severity: 'high', text: `${header.jku ? 'jku' : 'x5u'} points the server at a URL for the key; if it is not pinned, it may fetch a key you control.` });
  if (header.jwk || header.x5c) flags.push({ id: 'embedded-key', severity: 'high', text: 'the token carries its own key (jwk/x5c); a server that trusts it will accept anything you sign.' });
  if (expiresAt === undefined) flags.push({ id: 'no-expiry', severity: 'medium', text: 'no exp claim: this token may never expire.' });
  else if (issuedAt !== undefined && expiresAt - issuedAt > 7 * 24 * 3600 * 1000) flags.push({ id: 'long-lived', severity: 'low', text: `long-lived: valid for ${Math.round((expiresAt - issuedAt) / 86_400_000)} days.` });
  if (expired) flags.push({ id: 'expired', severity: 'info', text: `expired ${new Date(expiresAt!).toISOString()}.` });
  if (notBefore !== undefined && notBefore > now) flags.push({ id: 'not-yet-valid', severity: 'info', text: `not valid until ${new Date(notBefore).toISOString()}.` });

  return {
    header,
    payload,
    signature: parts[2]!,
    alg,
    ...(issuedAt !== undefined ? { issuedAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(notBefore !== undefined ? { notBefore } : {}),
    ...(typeof payload.iss === 'string' ? { issuer: payload.iss } : {}),
    ...(typeof payload.sub === 'string' ? { subject: payload.sub } : {}),
    ...(typeof payload.aud === 'string' || Array.isArray(payload.aud) ? { audience: payload.aud as string | string[] } : {}),
    expired,
    flags,
  };
}

/** The signing-input bytes (header.payload) for a token. */
const signingInput = (headerB64: string, payloadB64: string) => `${headerB64}.${payloadB64}`;

/** Turn a DER ECDSA signature into the JOSE fixed-width r||s. */
function derToJose(der: Buffer, size: number): Buffer {
  // SEQUENCE { INTEGER r, INTEGER s }
  let o = 2;
  if (der[1]! & 0x80) o = 2 + (der[1]! & 0x7f);
  const readInt = (pos: number): [Buffer, number] => {
    const len = der[pos + 1]!;
    let start = pos + 2;
    let l = len;
    while (l > 1 && der[start] === 0) {
      start++;
      l--;
    }
    return [der.subarray(start, start + l), pos + 2 + len];
  };
  const [r, nextR] = readInt(o);
  const [s] = readInt(nextR);
  const out = Buffer.alloc(size * 2);
  r.copy(out, size - r.length);
  s.copy(out, size * 2 - s.length);
  return out;
}

function joseToDer(jose: Buffer, size: number): Buffer {
  const trim = (b: Buffer) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return v;
  };
  const r = trim(jose.subarray(0, size));
  const s = trim(jose.subarray(size, size * 2));
  const seqLen = 2 + r.length + 2 + s.length;
  return Buffer.concat([Buffer.from([0x30, seqLen, 0x02, r.length]), r, Buffer.from([0x02, s.length]), s]);
}

export type SigningKey =
  | { kind: 'hmac'; secret: string | Buffer }
  | { kind: 'pem'; pem: string; passphrase?: string }
  | { kind: 'keyObject'; key: KeyObject };

function privateKeyOf(key: SigningKey): KeyObject {
  if (key.kind === 'keyObject') return key.key;
  if (key.kind === 'pem') return createPrivateKey({ key: key.pem, ...(key.passphrase ? { passphrase: key.passphrase } : {}) });
  throw new Error('not an asymmetric key');
}

/**
 * Sign a header and payload into a JWT. `alg` comes from the header unless
 * overridden. HMAC algorithms take a secret; RS/PS/ES/EdDSA take a private key.
 */
export function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: SigningKey, alg = String(header.alg ?? 'HS256')): string {
  const h = { ...header, alg };
  const headerB64 = b64url(JSON.stringify(h));
  const payloadB64 = b64url(JSON.stringify(payload));
  const input = signingInput(headerB64, payloadB64);

  let sig: Buffer;
  if (/^none$/i.test(alg)) return `${input}.`;
  else if (alg in HMAC_ALG) {
    if (key.kind !== 'hmac') throw new Error(`${alg} needs a secret, not a key`);
    sig = createHmac(HMAC_ALG[alg]!, key.secret).update(input).digest();
  } else if (alg in RSA_ALG) {
    sig = createSign(RSA_ALG[alg]!).update(input).sign(privateKeyOf(key));
  } else if (alg in RSA_PSS_ALG) {
    sig = createSign(RSA_PSS_ALG[alg]!).update(input).sign({ key: privateKeyOf(key), padding: 6, saltLength: -1 });
  } else if (alg in EC_ALG) {
    const der = createSign(EC_ALG[alg]!).update(input).sign(privateKeyOf(key));
    sig = derToJose(der, EC_SIZE[alg]!);
  } else if (alg === 'EdDSA') {
    sig = rawSign(null, Buffer.from(input), privateKeyOf(key));
  } else throw new Error(`unsupported alg "${alg}"`);
  return `${input}.${b64url(sig)}`;
}

/** Verify a token against a key or secret. Returns true when the signature checks out. */
export function verifyJwt(token: string, key: SigningKey): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const alg = String((JSON.parse(fromB64url(parts[0]!).toString('utf8')) as Record<string, unknown>).alg ?? 'none');
  const input = signingInput(parts[0]!, parts[1]!);
  const sig = fromB64url(parts[2]!);
  try {
    if (/^none$/i.test(alg)) return parts[2] === '';
    if (alg in HMAC_ALG) {
      if (key.kind !== 'hmac') return false;
      const want = createHmac(HMAC_ALG[alg]!, key.secret).update(input).digest();
      return want.length === sig.length && timingSafeEqual(want, sig);
    }
    const pub = key.kind === 'hmac' ? null : key.kind === 'keyObject' ? (key.key.type === 'public' ? key.key : createPublicKey(key.key)) : createPublicKey(key.pem);
    if (!pub) return false;
    if (alg in RSA_ALG) return createVerify(RSA_ALG[alg]!).update(input).verify(pub, sig);
    if (alg in RSA_PSS_ALG) return createVerify(RSA_PSS_ALG[alg]!).update(input).verify({ key: pub, padding: 6, saltLength: -1 }, sig);
    if (alg in EC_ALG) return createVerify(EC_ALG[alg]!).update(input).verify(pub, joseToDer(sig, EC_SIZE[alg]!));
    if (alg === 'EdDSA') return rawVerify(null, Buffer.from(input), pub, sig);
  } catch {
    return false;
  }
  return false;
}

/**
 * Try a list of candidate secrets against an HMAC token (the caller supplies
 * the list). Returns the first that verifies, so a tester can confirm a token
 * is signed with a known-weak or leaked secret. No guessing is done here.
 */
export function tryHmacSecrets(token: string, candidates: Iterable<string>): string | null {
  const alg = String((JSON.parse(fromB64url(token.split('.')[0]!).toString('utf8')) as Record<string, unknown>).alg ?? '');
  if (!(alg in HMAC_ALG)) return null;
  for (const secret of candidates) if (verifyJwt(token, { kind: 'hmac', secret })) return secret;
  return null;
}
