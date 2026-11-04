import { describe, expect, it } from '@siteinquisition/devkit/test';
import { decodeSessionCookie, signFlaskCookie, tryFlaskSecrets, verifyFlaskCookie } from '@siteinquisition/core';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('Session cookie decoding', () => {
  it('reads a Flask session payload without the key, and shows its timestamp', () => {
    const t = signFlaskCookie({ user_id: 7, admin: false }, 'topsecret', { at: 1_762_000_000_000 });
    const c = decodeSessionCookie('session', t);
    expect(c.framework).toBe('flask');
    expect(c.structure).toBe('signed');
    expect(c.payload).toEqual({ user_id: 7, admin: false });
    expect(c.flags).toContain('payload-readable-without-key');
    expect(c.parts.find((p) => p.label === 'timestamp')?.value).toBe('2025-11-01T12:26:40.000Z');
  });

  it('decodes a compressed Flask payload', () => {
    const big = { roles: Array.from({ length: 40 }, (_, i) => `role-${i}`) };
    const t = signFlaskCookie(big, 's3cr3t', { compress: true });
    expect(t.startsWith('.')).toBe(true); // itsdangerous compression marker
    const c = decodeSessionCookie('session', t);
    expect(c.compressed).toBe(true);
    expect(c.payload).toEqual(big);
  });

  it('identifies a Laravel encrypted envelope and flags that it needs the key', () => {
    const cookie = Buffer.from(JSON.stringify({ iv: 'aXY=', value: 'Y2lwaGVy', mac: 'abcd', tag: '' })).toString('base64');
    const c = decodeSessionCookie('laravel_session', cookie);
    expect(c.framework).toBe('laravel');
    expect(c.structure).toBe('encrypted');
    expect(c.flags).toContain('needs-app-key-to-decrypt');
    expect(c.parts.map((p) => p.label)).toContain('iv');
  });

  it('splits a Django signed_cookies session and reads the JSON data', () => {
    const data = b64url({ _auth_user_id: '1' });
    const c = decodeSessionCookie('sessionid', `${data}:1abc:deadbeef`);
    expect(c.framework).toBe('django');
    expect(c.payload).toEqual({ _auth_user_id: '1' });
  });

  it('recognizes an Express express-session signed id and a Rails encrypted triple', () => {
    const exp = decodeSessionCookie('connect.sid', 's%3AabcDEF123.sIgNaTuRe');
    expect(exp.framework).toBe('express');
    expect(exp.parts[0]).toEqual({ label: 'session id', value: 'abcDEF123' });

    const rails = decodeSessionCookie('_myapp_session', encodeURIComponent('Y2lwaGVy--aXZpdg==--dGFndGFn'));
    expect(rails.framework).toBe('rails');
    expect(rails.structure).toBe('encrypted');
    expect(rails.parts.map((p) => p.label)).toEqual(['ciphertext', 'iv', 'auth tag']);
  });
});

describe('Flask cookie signing', () => {
  it('verifies the right secret and rejects a wrong one or a tampered payload', () => {
    const t = signFlaskCookie({ admin: false }, 'changeme');
    expect(verifyFlaskCookie(t, 'changeme')).toBe(true);
    expect(verifyFlaskCookie(t, 'nope')).toBe(false);
    // Flip the payload to admin:true but keep the signature.
    const parts = t.split('.');
    const forged = `${Buffer.from(JSON.stringify({ admin: true })).toString('base64url')}.${parts[1]}.${parts[2]}`;
    expect(verifyFlaskCookie(forged, 'changeme')).toBe(false);
  });

  it('confirms which candidate secret signed a cookie', () => {
    const t = signFlaskCookie({ sub: 'u1' }, 'the-real-key');
    expect(tryFlaskSecrets(t, ['a', 'b', 'the-real-key', 'c'])).toBe('the-real-key');
    expect(tryFlaskSecrets(t, ['a', 'b'])).toBeNull();
  });

  it('round-trips: re-signing a forged payload with the known key verifies', () => {
    const forged = signFlaskCookie({ user_id: 1, admin: true }, 'leaked-secret');
    expect(verifyFlaskCookie(forged, 'leaked-secret')).toBe(true);
    expect(decodeSessionCookie('session', forged).payload).toEqual({ user_id: 1, admin: true });
  });
});
