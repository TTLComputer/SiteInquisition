import { createHmac, timingSafeEqual } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Reading framework session cookies. Most are not opaque: a signed cookie
 * (Flask, Django's signed_cookies, Express cookie-session) carries its payload
 * in the clear and only the signature needs the secret, so the contents can be
 * shown without any key. An encrypted cookie (Laravel, Rails 5.2+) only yields
 * its envelope (iv, ciphertext, tag) without the key. This names the framework,
 * splits the parts, and decodes the payload when it is plaintext.
 *
 * For Flask specifically, which is the usual target for "sign your own session"
 * testing, we also verify and re-sign with a candidate secret, following the
 * itsdangerous URLSafeTimedSerializer defaults (HMAC-SHA1, salt 'cookie-session').
 */

export type SessionFramework = 'flask' | 'django' | 'rails' | 'laravel' | 'express' | 'unknown';
export type SessionStructure = 'signed' | 'encrypted' | 'opaque';

export interface SessionPart {
  label: string;
  value: string;
}

export interface SessionCookie {
  framework: SessionFramework;
  structure: SessionStructure;
  parts: SessionPart[];
  /** The decoded payload, when it is readable without a key. */
  payload?: unknown;
  /** True when the payload was zlib-compressed. */
  compressed?: boolean;
  flags: string[];
}

const b64urlDecode = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64urlEncode = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Decode a base64 (url or standard) blob, optionally zlib-wrapped with a leading '.' as itsdangerous marks it. */
function decodePayload(b64: string): { value: unknown; compressed: boolean } | null {
  let compressed = false;
  let s = b64;
  if (s.startsWith('.')) {
    compressed = true;
    s = s.slice(1);
  }
  let raw: Buffer;
  try {
    raw = b64urlDecode(s);
  } catch {
    return null;
  }
  if (compressed) {
    try {
      raw = inflateSync(raw);
    } catch {
      return null;
    }
  }
  try {
    return { value: JSON.parse(raw.toString('utf8')), compressed };
  } catch {
    return null;
  }
}

function tryBase64Json(value: string): unknown | null {
  try {
    const raw = Buffer.from(value, 'base64').toString('utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Decode a session cookie's structure and any plaintext payload. Never needs a key. */
export function decodeSessionCookie(name: string, rawValue: string): SessionCookie {
  const value = (() => {
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  })();
  const lname = name.toLowerCase();

  // Laravel: base64 of a JSON envelope { iv, value, mac, tag? }.
  const envelope = tryBase64Json(value) as { iv?: unknown; value?: unknown; mac?: unknown } | null;
  if (envelope && typeof envelope.iv === 'string' && typeof envelope.value === 'string' && typeof envelope.mac === 'string') {
    return {
      framework: 'laravel',
      structure: 'encrypted',
      parts: Object.entries(envelope).map(([k, v]) => ({ label: k, value: String(v) })),
      flags: ['encrypted', 'needs-app-key-to-decrypt'],
    };
  }

  // Flask / itsdangerous: payload.timestamp.signature. The payload carries no
  // '.' of its own (base64url), but a compressed one is marked with a leading
  // '.', so the two separators are the rightmost dots.
  const lastDot = value.lastIndexOf('.');
  const sepDot = lastDot > 0 ? value.lastIndexOf('.', lastDot - 1) : -1;
  if (sepDot > 0) {
    const payloadB64 = value.slice(0, sepDot);
    const ts = value.slice(sepDot + 1, lastDot);
    const sig = value.slice(lastDot + 1);
    const decoded = payloadB64 && ts && sig ? decodePayload(payloadB64) : null;
    if (decoded) {
      const when = (() => {
        try {
          return Number(BigInt('0x' + b64urlDecode(ts).toString('hex') || '0')) * 1000 || null;
        } catch {
          return null;
        }
      })();
      return {
        framework: 'flask',
        structure: 'signed',
        parts: [
          { label: 'payload', value: payloadB64 },
          { label: 'timestamp', value: when ? new Date(when).toISOString() : ts },
          { label: 'signature', value: sig },
        ],
        payload: decoded.value,
        ...(decoded.compressed ? { compressed: true } : {}),
        flags: ['signed', 'payload-readable-without-key'],
      };
    }
  }

  // Django signed_cookies: data:timestamp:signature (colon separated).
  const colons = value.split(':');
  if (colons.length === 3 && colons.every(Boolean)) {
    const [dataB64, ts, sig] = colons as [string, string, string];
    const decoded = decodePayload(dataB64);
    return {
      framework: 'django',
      structure: 'signed',
      parts: [
        { label: 'data', value: dataB64 },
        { label: 'timestamp', value: ts },
        { label: 'signature', value: sig },
      ],
      ...(decoded ? { payload: decoded.value, ...(decoded.compressed ? { compressed: true } : {}) } : {}),
      flags: decoded ? ['signed', 'payload-readable-without-key'] : ['signed', 'opaque-or-pickled-payload'],
    };
  }

  // Express express-session: "s:<sid>.<signature>".
  if (value.startsWith('s:') && value.lastIndexOf('.') > 2) {
    const dot = value.lastIndexOf('.');
    return {
      framework: 'express',
      structure: 'signed',
      parts: [
        { label: 'session id', value: value.slice(2, dot) },
        { label: 'signature', value: value.slice(dot + 1) },
      ],
      flags: ['signed', 'session-id-opaque-server-side-store'],
    };
  }

  // Express cookie-session: base64url JSON, signature in a separate ".sig" cookie.
  const cj = tryBase64Json(value) ?? decodePayload(value)?.value;
  if (cj && typeof cj === 'object') {
    return {
      framework: lname.includes('session') ? 'express' : 'unknown',
      structure: 'signed',
      parts: [{ label: 'payload', value }],
      payload: cj,
      flags: ['payload-readable-without-key', 'signature-in-separate-cookie'],
    };
  }

  // Rails: url-decoded value split on "--" (signed: payload--sig; encrypted: data--iv--tag).
  if (value.includes('--')) {
    const segs = value.split('--');
    if (segs.length === 2) {
      const decoded = decodePayload(segs[0]!);
      return {
        framework: 'rails',
        structure: 'signed',
        parts: [
          { label: 'payload', value: segs[0]! },
          { label: 'signature', value: segs[1]! },
        ],
        ...(decoded ? { payload: decoded.value } : {}),
        flags: decoded ? ['signed', 'payload-readable-without-key'] : ['signed', 'marshalled-payload'],
      };
    }
    if (segs.length === 3) {
      return {
        framework: 'rails',
        structure: 'encrypted',
        parts: [
          { label: 'ciphertext', value: segs[0]! },
          { label: 'iv', value: segs[1]! },
          { label: 'auth tag', value: segs[2]! },
        ],
        flags: ['encrypted', 'needs-secret-key-base-to-decrypt'],
      };
    }
  }

  return { framework: 'unknown', structure: 'opaque', parts: [{ label: 'value', value }], flags: [] };
}

// ---------- Flask (itsdangerous) signing ----------

/** The itsdangerous 'hmac' key derivation: HMAC(secret, salt). */
const deriveKey = (secret: string, salt: string): Buffer => createHmac('sha1', secret).update(salt).digest();

const flaskSignature = (signedPart: string, secret: string, salt: string): string => b64urlEncode(createHmac('sha1', deriveKey(secret, salt)).update(signedPart).digest());

/**
 * Verify a Flask session cookie's signature with a candidate secret, following
 * itsdangerous URLSafeTimedSerializer defaults (HMAC-SHA1, salt 'cookie-session').
 */
export function verifyFlaskCookie(value: string, secret: string, salt = 'cookie-session'): boolean {
  const lastDot = value.lastIndexOf('.');
  const sepDot = lastDot > 0 ? value.lastIndexOf('.', lastDot - 1) : -1;
  if (sepDot <= 0) return false;
  const signedPart = value.slice(0, lastDot);
  const sig = value.slice(lastDot + 1);
  const expected = flaskSignature(signedPart, secret, salt);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Return the first candidate secret the Flask cookie is signed with, or null. */
export function tryFlaskSecrets(value: string, candidates: string[], salt = 'cookie-session'): string | null {
  for (const s of candidates) if (verifyFlaskCookie(value, s, salt)) return s;
  return null;
}

/** Re-sign a payload as a Flask session cookie with a known secret. */
export function signFlaskCookie(payload: unknown, secret: string, opts: { salt?: string; at?: number; compress?: boolean } = {}): string {
  const salt = opts.salt ?? 'cookie-session';
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  let payloadB64: string;
  if (opts.compress) {
    // Matches itsdangerous: a leading '.' marks a zlib-compressed payload.
    payloadB64 = '.' + b64urlEncode(deflateSync(json));
  } else {
    payloadB64 = b64urlEncode(json);
  }
  const seconds = Math.floor((opts.at ?? Date.now()) / 1000);
  let hex = seconds.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const tsB64 = b64urlEncode(Buffer.from(hex, 'hex'));
  const signedPart = `${payloadB64}.${tsB64}`;
  return `${signedPart}.${flaskSignature(signedPart, secret, salt)}`;
}
