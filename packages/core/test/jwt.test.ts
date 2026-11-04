import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from '@siteinquisition/devkit/test';
import { awsLabel, awsRequestInfo, parseAmzTarget, parsePresignedUrl, parseS3Url, parseJwt, signJwt, tryHmacSecrets, verifyJwt, type SigningKey } from '@siteinquisition/core';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const make = (header: object, payload: object, sig = 'x') => `${b64url(header)}.${b64url(payload)}.${sig}`;

describe('JWT parsing and flags', () => {
  it('reads claims and expiry', () => {
    const now = 1_762_000_000_000;
    const t = make({ alg: 'HS256', typ: 'JWT' }, { sub: 'u1', iss: 'acme', exp: now / 1000 + 3600, iat: now / 1000 });
    const p = parseJwt(t, now);
    expect(p.subject).toBe('u1');
    expect(p.issuer).toBe('acme');
    expect(p.expired).toBe(false);
    expect(p.expiresAt).toBe(now + 3_600_000);
  });

  it('flags the dangerous shapes', () => {
    const ids = (h: object, pl: object = {}) => parseJwt(make(h, pl)).flags.map((f) => f.id);
    expect(ids({ alg: 'none' })).toContain('alg-none');
    expect(ids({ alg: 'HS256' })).toContain('symmetric');
    expect(ids({ alg: 'RS256', jku: 'https://evil.test/keys' })).toContain('key-url');
    expect(ids({ alg: 'RS256', jwk: { kty: 'RSA' } })).toContain('embedded-key');
    expect(ids({ alg: 'HS256', kid: '../../key' })).toContain('kid');
    expect(ids({ alg: 'RS256' }, {})).toContain('no-expiry');
    expect(parseJwt(make({ alg: 'HS256' }, { exp: 1 }), 1_000_000).flags.map((f) => f.id)).toContain('expired');
  });

  it('rejects malformed tokens', () => {
    expect(() => parseJwt('not.a.jwt')).toThrow(/not valid base64url JSON/);
    expect(() => parseJwt('onlyonepart')).toThrow(/three/);
  });
});

describe('JWT signing round-trips', () => {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: 'admin', role: 'root' };

  it('signs and verifies HS256, and detects a wrong secret', () => {
    const t = signJwt(header, payload, { kind: 'hmac', secret: 'topsecret' });
    expect(verifyJwt(t, { kind: 'hmac', secret: 'topsecret' })).toBe(true);
    expect(verifyJwt(t, { kind: 'hmac', secret: 'nope' })).toBe(false);
    expect(parseJwt(t).payload.role).toBe('root');
  });

  it('confirms a token is signed with a candidate secret', () => {
    const t = signJwt(header, payload, { kind: 'hmac', secret: 'changeme' });
    expect(tryHmacSecrets(t, ['a', 'b', 'changeme', 'c'])).toBe('changeme');
    expect(tryHmacSecrets(t, ['a', 'b'])).toBeNull();
  });

  for (const [name, opts] of [
    ['RS256', { type: 'rsa', modulusLength: 2048 }],
    ['PS256', { type: 'rsa', modulusLength: 2048 }],
    ['ES256', { type: 'ec', namedCurve: 'P-256' }],
    ['ES384', { type: 'ec', namedCurve: 'P-384' }],
    ['EdDSA', { type: 'ed25519' }],
  ] as const) {
    it(`signs and verifies ${name}`, () => {
      const { privateKey, publicKey } = generateKeyPairSync(opts.type as 'rsa', opts as never);
      const key: SigningKey = { kind: 'keyObject', key: privateKey };
      const t = signJwt({ alg: name, typ: 'JWT' }, payload, key, name);
      expect(verifyJwt(t, { kind: 'keyObject', key: publicKey })).toBe(true);
      // A tampered payload fails.
      const [h, , s] = t.split('.');
      expect(verifyJwt(`${h}.${b64url({ sub: 'attacker' })}.${s}`, { kind: 'keyObject', key: publicKey })).toBe(false);
    });
  }

  it('can forge alg:none', () => {
    const t = signJwt({ alg: 'none' }, payload, { kind: 'hmac', secret: '' }, 'none');
    expect(t.endsWith('.')).toBe(true);
    expect(verifyJwt(t, { kind: 'hmac', secret: '' })).toBe(true);
  });
});

describe('AWS request shapes', () => {
  it('parses a presigned URL and its expiry', () => {
    const url = 'https://my-bucket.s3.us-east-1.amazonaws.com/path/file.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261104%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261104T120000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=abcd';
    const p = parsePresignedUrl(url)!;
    expect(p).toMatchObject({ accessKeyId: 'AKIAEXAMPLE', region: 'us-east-1', service: 's3', expiresInSeconds: 900 });
    expect(p.expiresAt - p.signedAt).toBe(900_000);
    expect(new Date(p.signedAt).toISOString()).toBe('2026-11-04T12:00:00.000Z');
    expect(parsePresignedUrl('https://x.test/plain')).toBeNull();
  });

  it('names the operation of an X-Amz-Target call', () => {
    const t = parseAmzTarget([['X-Amz-Target', 'DynamoDB_20120810.GetItem']])!;
    expect(t).toEqual({ target: 'DynamoDB_20120810.GetItem', service: 'DynamoDB_20120810', operation: 'GetItem' });
    expect(awsLabel({ amzTarget: t })).toBe('GetItem');
  });

  it('reads S3 bucket and key, virtual-host and path style', () => {
    expect(parseS3Url('https://assets.s3.amazonaws.com/img/logo.png')).toEqual({ bucket: 'assets', key: 'img/logo.png', style: 'virtual-host' });
    expect(parseS3Url('https://s3.eu-west-1.amazonaws.com/assets/img/logo.png')).toEqual({ bucket: 'assets', key: 'img/logo.png', style: 'path' });
  });

  it('pulls everything together, including API Gateway', () => {
    const info = awsRequestInfo({ url: 'https://abc123.execute-api.eu-west-1.amazonaws.com/prod/orders', headers: [['X-Amz-Target', 'AWSCognitoIdentityProviderService.InitiateAuth']] });
    expect(info.apiGateway).toEqual({ apiId: 'abc123', stage: 'prod' });
    expect(info.amzTarget?.operation).toBe('InitiateAuth');
  });
});
