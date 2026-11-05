import { describe, expect, it } from '@siteinquisition/devkit/test';
import { Evergreen, parseJwt, renderEvergreen, resolveTokens, signableKind, signFlaskCookie, signJwt, SessionKeyStore, verifyFlaskCookie, verifyJwt, type CaptureStore, type EvergreenEntry } from '@siteinquisition/core';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (header: object, payload: object) => signJwt(header, payload, { kind: 'hmac', secret: 'topsecret' }, (header as { alg?: string }).alg ?? 'HS256');

/** A tiny store that only remembers meta, which is all Evergreen touches. */
function metaStore(): CaptureStore {
  const meta = new Map<string, unknown>();
  return {
    getMeta: <T>(k: string) => meta.get(k) as T | undefined,
    setMeta: (k: string, v: unknown) => meta.set(k, v),
  } as unknown as CaptureStore;
}

describe('signableKind', () => {
  it('recognizes a JWT and a Flask session cookie, and nothing else', () => {
    expect(signableKind(jwt({ alg: 'HS256' }, { sub: 'u1', exp: 1 }))).toBe('jwt');
    expect(signableKind(signFlaskCookie({ user_id: 7 }, 'topsecret'))).toBe('flask');
    expect(signableKind('not-a-token')).toBe(null);
    expect(signableKind('s:opaque-sid.sig')).toBe(null); // express sid store: no readable payload
  });
});

describe('renderEvergreen', () => {
  const now = 1_762_000_000_000;
  const sec = Math.floor(now / 1000);

  it('pushes exp forward and refreshes iat on a JWT, and re-signs so it verifies', () => {
    const token = renderEvergreen({ kind: 'jwt', alg: 'HS256', header: { alg: 'HS256', typ: 'JWT' }, payload: { sub: 'admin', exp: 1, iat: 1 }, ttlSeconds: 3600 }, { kind: 'hmac', secret: 'topsecret' }, now);
    const p = parseJwt(token, now);
    expect(p.expiresAt).toBe((sec + 3600) * 1000);
    expect(p.issuedAt).toBe(sec * 1000);
    expect(p.expired).toBe(false);
    expect(verifyJwt(token, { kind: 'hmac', secret: 'topsecret' })).toBe(true);
  });

  it('defaults to a one-hour window and can set nbf', () => {
    const token = renderEvergreen({ kind: 'jwt', payload: { sub: 'x', nbf: 1 }, bumpNbf: true }, { kind: 'hmac', secret: 'topsecret' }, now);
    const p = parseJwt(token, now);
    expect(p.expiresAt).toBe((sec + 3600) * 1000);
    expect(p.notBefore).toBe(sec * 1000);
  });

  it('re-signs a Flask cookie with a fresh timestamp', () => {
    const token = renderEvergreen({ kind: 'flask', payload: { user_id: 7, admin: true } }, { kind: 'hmac', secret: 'topsecret' }, now);
    expect(verifyFlaskCookie(token, 'topsecret')).toBe(true);
  });

  it('refuses to sign a Flask cookie with a PEM key', () => {
    expect(() => renderEvergreen({ kind: 'flask', payload: {} }, { kind: 'pem', pem: '-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----' })).toThrow(/HMAC secret/);
  });
});

describe('Evergreen registry', () => {
  const entry = (over: Partial<EvergreenEntry> = {}): EvergreenEntry => ({ name: 'admin', kind: 'jwt', keyName: 'app', payload: { sub: 'admin', exp: 1 }, ttlSeconds: 600, updatedAt: 0, ...over });

  it('saves, lists with key status, resolves fresh, and deletes', () => {
    const keys = new SessionKeyStore();
    const eg = new Evergreen(metaStore(), keys);
    eg.save(entry());
    expect(eg.list()).toHaveLength(1);
    expect(eg.list()[0]!.canSign).toBe(false); // key not loaded yet

    keys.setSecret('app', 'topsecret');
    expect(eg.list()[0]!.canSign).toBe(true);
    const token = eg.resolve('admin');
    expect(parseJwt(token).expired).toBe(false);
    expect(verifyJwt(token, { kind: 'hmac', secret: 'topsecret' })).toBe(true);

    eg.delete('admin');
    expect(eg.list()).toHaveLength(0);
  });

  it('throws a clear error when the token or its key is missing', () => {
    const keys = new SessionKeyStore();
    const eg = new Evergreen(metaStore(), keys);
    expect(() => eg.resolve('nope')).toThrow(/no signed token/);
    eg.save(entry());
    expect(() => eg.resolve('admin')).toThrow(/not loaded/);
  });

  it('re-mints a cookie bound to a host, matching subdomains', () => {
    const keys = new SessionKeyStore();
    keys.setSecret('app', 'topsecret');
    const eg = new Evergreen(metaStore(), keys);
    eg.save(entry({ name: 'sess', kind: 'flask', payload: { admin: true }, cookie: { domain: 'example.com', name: 'session' } }));
    const fresh = eg.resignCookie('app.example.com', 'session');
    expect(fresh?.token).toBe('sess');
    expect(verifyFlaskCookie(fresh!.value, 'topsecret')).toBe(true);
    expect(eg.resignCookie('other.test', 'session')).toBe(null);
    expect(eg.resignCookie('example.com', 'different')).toBe(null);
  });

  it('rejects an invalid token name', () => {
    const eg = new Evergreen(metaStore(), new SessionKeyStore());
    expect(() => eg.save(entry({ name: 'bad name' }))).toThrow(/invalid token name/);
  });
});

describe('{{sign:name}} token', () => {
  it('resolves through the token engine and errors without a resolver', () => {
    const keys = new SessionKeyStore();
    keys.setSecret('app', 'topsecret');
    const eg = new Evergreen(metaStore(), keys);
    eg.save({ name: 'admin', kind: 'jwt', keyName: 'app', payload: { sub: 'admin', exp: 1 }, ttlSeconds: 600, updatedAt: 0 });

    const out = resolveTokens('Authorization: Bearer {{sign:admin}}', { url: 'https://example.com/', cookies: () => [], vars: () => ({}), sign: (n) => eg.resolve(n) });
    const token = out.replace('Authorization: Bearer ', '');
    expect(verifyJwt(token, { kind: 'hmac', secret: 'topsecret' })).toBe(true);
    expect(parseJwt(token).expired).toBe(false);

    expect(() => resolveTokens('{{sign:admin}}', { url: 'https://example.com/', cookies: () => [], vars: () => ({}) })).toThrow(/needs a saved signed token/);
  });
});
