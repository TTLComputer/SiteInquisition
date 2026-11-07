import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { Core, makePkce } from '@siteinquisition/core';

let tmp: string;
let core: Core;
let server: Server;
let base: string;
/** What the fake server saw last, per path. */
const seen = new Map<string, { headers: Record<string, string | string[] | undefined>; body: Buffer }>();
let issued = 0;
const codes = new Map<string, { challenge: string; method: string; redirect: string }>();

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-reqbuild-'));
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd'), api: false, keyring: null });
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url!, 'http://x');
      seen.set(url.pathname, { headers: req.headers, body });
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (url.pathname === '/.well-known/openid-configuration') return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, code_challenge_methods_supported: ['S256'] });
      if (url.pathname === '/authorize') {
        const code = `code-${++issued}`;
        codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', method: url.searchParams.get('code_challenge_method') ?? '', redirect: url.searchParams.get('redirect_uri') ?? '' });
        res.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}` });
        return res.end();
      }
      if (url.pathname === '/token') {
        const f = new URLSearchParams(body.toString());
        const auth = req.headers.authorization ?? '';
        const client = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : `${f.get('client_id')}:${f.get('client_secret') ?? ''}`;
        if (client !== 'cli:s3cret') return json(401, { error: 'invalid_client' });
        const g = f.get('grant_type');
        if (g === 'client_credentials') return json(200, { access_token: `cc-${++issued}`, token_type: 'Bearer', expires_in: 3600, scope: f.get('scope') });
        if (g === 'password') return f.get('password') === 'pw' ? json(200, { access_token: `pw-${++issued}`, token_type: 'Bearer', expires_in: 1, refresh_token: 'rt-1' }) : json(400, { error: 'invalid_grant', error_description: 'bad password' });
        if (g === 'refresh_token') return f.get('refresh_token') === 'rt-1' ? json(200, { access_token: `refreshed-${++issued}`, token_type: 'Bearer', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
        if (g === 'authorization_code') {
          const c = codes.get(f.get('code') ?? '');
          if (!c) return json(400, { error: 'invalid_grant' });
          const verifier = f.get('code_verifier') ?? '';
          const ok = c.method === 'S256' ? createHash('sha256').update(verifier).digest('base64url') === c.challenge : verifier === c.challenge;
          if (!ok || f.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant', error_description: 'PKCE check failed' });
          return json(200, { access_token: `ac-${++issued}`, token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-1', id_token: 'id.tok.en' });
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      json(200, { path: url.pathname, auth: req.headers.authorization ?? null, type: req.headers['content-type'] ?? null, size: body.length });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await core.close();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});

describe('file bodies', () => {
  it('splices attached files into a multipart body as bytes, with tokens around them filled in', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff]);
    await core.tools.vars.set('who', 'nick');
    const body = '--B\r\nContent-Disposition: form-data; name="user"\r\n\r\n{{var:who}}\r\n--B\r\nContent-Disposition: form-data; name="pic"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n{{file:p.png}}\r\n--B--\r\n';
    const res = await core.tools.sender.send({ method: 'POST', url: `${base}/upload`, headers: [['Content-Type', 'multipart/form-data; boundary=B']], body: new TextEncoder().encode(body), attachments: { 'p.png': png } }, { tokens: true });
    expect(res.status).toBe(200);
    const got = seen.get('/upload')!.body;
    const expected = Buffer.concat([Buffer.from(body.slice(0, body.indexOf('{{var:who}}'))), Buffer.from('nick'), Buffer.from(body.slice(body.indexOf('{{var:who}}') + 11, body.indexOf('{{file:p.png}}'))), Buffer.from(png), Buffer.from('\r\n--B--\r\n')]);
    expect(got.equals(expected)).toBe(true);
    expect(seen.get('/upload')!.headers['content-length']).toBe(String(expected.length));
  });

  it('reads {{file:...}} from the project folder, and refuses paths outside it', async () => {
    writeFileSync(join(core.projectDir, 'blob.bin'), Buffer.from([1, 2, 3, 0, 250]));
    await core.tools.sender.send({ method: 'PUT', url: `${base}/blob`, headers: [], body: new TextEncoder().encode('{{file:blob.bin}}') }, { tokens: true });
    expect([...seen.get('/blob')!.body]).toEqual([1, 2, 3, 0, 250]);
    await expect(core.tools.sender.send({ method: 'PUT', url: `${base}/blob`, headers: [], body: new TextEncoder().encode('{{file:/etc/hostname}}') }, { tokens: true })).rejects.toThrow(/not attached/);
    await expect(core.tools.sender.send({ method: 'PUT', url: `${base}/blob`, headers: [], body: new TextEncoder().encode('{{file:../escape.txt}}') }, { tokens: true })).rejects.toThrow(/not attached/);
  });
});

describe('OAuth profiles', () => {
  it('makes PKCE pairs', () => {
    const p = makePkce('S256', 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    // The example from RFC 7636 appendix B.
    expect(p.challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(makePkce('plain').challenge.length).toBeGreaterThanOrEqual(43);
  });

  it('client credentials: fetched on first use by {{oauth:name}}, and recorded', async () => {
    core.tools.oauth.save({ name: 'svc', grant: 'client_credentials', tokenUrl: `${base}/token`, clientId: 'cli', clientSecret: 's3cret', scope: 'read write' });
    const res = await core.tools.sender.send({ method: 'GET', url: `${base}/api/me`, headers: [['Authorization', 'Bearer {{oauth:svc}}']] }, { tokens: true });
    const out = JSON.parse(new TextDecoder().decode(core.store.getBody(res.id, 'response', true)!)) as { auth: string };
    expect(out.auth).toMatch(/^Bearer cc-\d+$/);
    expect(core.tools.oauth.views()[0]!.token).toMatchObject({ scope: 'read write', expired: false });
    expect(core.store.search('tag:oauth:svc').length).toBe(1);
    expect(core.tools.oauth.value('svc.header')).toMatch(/^Bearer cc-/);
    // Secret sent as HTTP Basic by default.
    expect(String(seen.get('/token')!.headers.authorization)).toMatch(/^Basic /);
  });

  it('password grant: refreshes an expired token before the send', async () => {
    core.tools.oauth.save({ name: 'pw', grant: 'password', tokenUrl: `${base}/token`, clientId: 'cli', clientSecret: 's3cret', clientAuth: 'body', username: 'nick', password: 'pw' });
    await core.tools.oauth.fetch('pw');
    expect(core.tools.oauth.value('pw')).toMatch(/^pw-/);
    // expires_in was 1 second: it is already inside the refresh window.
    const res = await core.tools.sender.send({ method: 'GET', url: `${base}/api/me`, headers: [['Authorization', 'Bearer {{oauth:pw}}']] }, { tokens: true });
    const out = JSON.parse(new TextDecoder().decode(core.store.getBody(res.id, 'response', true)!)) as { auth: string };
    expect(out.auth).toMatch(/^Bearer refreshed-/);
    expect(core.tools.oauth.value('pw.refresh_token')).toBe('rt-1');
    core.tools.oauth.save({ name: 'pw', grant: 'password', tokenUrl: `${base}/token`, clientId: 'cli', clientSecret: 's3cret', clientAuth: 'body', username: 'nick', password: 'wrong' });
    core.tools.oauth.clearTokens('pw');
    await expect(core.tools.oauth.fetch('pw')).rejects.toThrow(/invalid_grant: bad password/);
  });

  it('authorization code with PKCE: the proxy answers the redirect and gets the token', async () => {
    const d = await core.tools.oauth.discover(base);
    expect(d).toMatchObject({ authUrl: `${base}/authorize`, tokenUrl: `${base}/token`, pkceMethods: ['S256'] });
    core.tools.oauth.save({ name: 'web', grant: 'authorization_code', authUrl: d.authUrl, tokenUrl: d.tokenUrl!, clientId: 'cli', clientSecret: 's3cret', redirectUri: 'http://localhost:4999/callback', scope: 'openid profile' });
    const begin = core.tools.oauth.begin('web');
    const u = new URL(begin.url);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('nonce')).toBeTruthy();
    expect(core.tools.oauth.views().find((v) => v.name === 'web')!.waiting).toBe(true);
    // What the browser does: load the sign-in page, follow its redirect back.
    const r = await fetch(begin.url, { redirect: 'manual' });
    const back = r.headers.get('location')!;
    // Not the matching state: left alone.
    expect(core.tools.oauth.capture(back.replace(/state=[^&]+/, 'state=other'))).toBe(null);
    const answered = await core.tools.hooks.request!({ method: 'GET', url: back, headers: [], body: new Uint8Array() }, { key: 'k', source: 'browser' });
    expect(answered.respond?.status).toBe(200);
    expect(new TextDecoder().decode(answered.respond!.body)).toContain('Signed in');
    await expect.poll(() => core.tools.oauth.views().find((v) => v.name === 'web')!.token?.hasRefresh ?? false).toBe(true);
    expect(core.tools.oauth.value('web')).toMatch(/^ac-/);
    expect(core.tools.oauth.value('web.id_token')).toBe('id.tok.en');
    // Once done, the redirect URI is not answered any more.
    expect(core.tools.oauth.capture(back)).toBe(null);
  });

  it('authorization code: a pasted redirect URL works too, and a wrong one says why', async () => {
    const begin = core.tools.oauth.begin('web');
    const back = (await fetch(begin.url, { redirect: 'manual' })).headers.get('location')!;
    await expect(core.tools.oauth.complete('web', 'http://localhost:4999/callback?error=access_denied&error_description=nope')).rejects.toThrow(/access_denied: nope/);
    await core.tools.oauth.complete('web', back);
    expect(core.tools.oauth.value('web')).toMatch(/^ac-/);
    await expect(core.tools.oauth.complete('web', back)).rejects.toThrow(/no sign-in is waiting/);
  });

  it('removes profiles, and names must suit tokens', () => {
    expect(() => core.tools.oauth.save({ name: 'has space', tokenUrl: 'x', clientId: 'y' })).toThrow(/letters/);
    expect(core.tools.oauth.remove('pw')).toBe(true);
    expect(core.tools.oauth.views().map((v) => v.name)).toEqual(['svc', 'web']);
  });
});
