import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serveWebSockets } from '@siteinquisition/core';
import { Core, type Keyring } from '@siteinquisition/core';

export const DIST = join(import.meta.dirname, '..', 'dist');

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' };

const listen = (server: Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));

/** A small upstream app: JSON, HTML, a redirect, an error, and a WebSocket echo. */
async function startUpstream() {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/old') {
        res.writeHead(302, { location: '/api/cart' });
        res.end();
      } else if (req.url === '/api/blob' || req.url === '/api/blob-echo') {
        // A JSON field that is base64 of more JSON, for field codecs.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.method === 'POST' ? body : JSON.stringify({ id: 7, blob: Buffer.from(JSON.stringify({ secret: 'inner-value', level: 3 })).toString('base64') }));
      } else if (req.url === '/api/jwt-cookie') {
        // Sets an (expired) HS256 JWT cookie signed with "secret", for the Cookies-tab re-sign flow.
        const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJ1c2VyIiwiZXhwIjoxMDAwMDAwMDAwfQ.aEY4GxRUw9ooq-gjjPRkfKJo7s6Jgm0-_MlUIFWq2B8';
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `auth=${jwt}; Path=/` });
        res.end('{"ok":true}');
      } else if (req.url === '/app') {
        // A page with no framework markers that hands out its CSRF token in a meta tag.
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><head><meta name="csrf-token" content="meta-token-1234567890"/></head><body>app</body>');
      } else if (req.url?.startsWith('/api/')) {
        const cookies = req.url === '/api/cart' ? { 'set-cookie': ['session=eyJ1c2VyIjoibmljayJ9; Path=/; HttpOnly', 'cart=42; Max-Age=600'] } : {};
        res.writeHead(200, { 'content-type': 'application/json', ...cookies });
        res.end(JSON.stringify({ path: req.url, method: req.method, hits, echo: body || null }));
      } else if (req.url === '/api/me') {
        // Reads a bearer JWT (HS256, secret "secret"); shown in the JWT panel.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } else if (req.url?.startsWith('/search')) {
        // Pastes the query into SQL and leaks the error, for the error banner.
        const q = new URL(req.url, 'http://x').searchParams.get('q') ?? '';
        if (q.includes("'")) {
          res.writeHead(500, { 'content-type': 'text/html' });
          res.end(`You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near '${q.slice(q.indexOf("'") + 1)}' LIMIT 20' at line 1`);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[]');
        }
      } else if (req.url === '/account') {
        // A Django-style page behind an AWS load balancer, for the Tech tab.
        res.writeHead(200, { 'content-type': 'text/html', server: 'WSGIServer/0.2 CPython/3.12.1', 'set-cookie': ['csrftoken=tok-abcdef123456; Path=/', 'AWSALB=lb-sticky-1; Path=/'] });
        res.end('<!doctype html><form method="post"><input type="hidden" name="csrfmiddlewaretoken" value="tok-abcdef123456"></form>');
      } else if (req.url === '/broken') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('boom');
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>shop</title><h1>Shop</h1>');
      }
    });
  });
  const wss = serveWebSockets(server, (ws) => ws.on('message', (m) => ws.send(`echo ${String(m)}`)));
  const port = await listen(server);
  return { port, close: () => new Promise<void>((r) => (wss.clients.forEach((c) => c.terminate()), server.close(() => r()))) };
}

function viaProxy(proxyPort: number, url: string, method = 'GET', body?: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, method, path: url, headers: { host: new URL(url).host, ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Serve the built renderer the way a browser would load it. */
async function startStatic() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^([/\\])+/, '');
    const file = join(DIST, path || 'index.html');
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  const port = await listen(server);
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export interface Harness {
  core: Core;
  upstreamPort: number;
  proxyPort: number;
  pageUrl: string;
  send(path: string, method?: string, body?: string, headers?: Record<string, string>): Promise<number>;
  close(): Promise<void>;
}

export async function startHarness(opts: { traffic?: boolean; keyring?: Keyring | null } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'siq-ui-'));
  const upstream = await startUpstream();
  const core = await Core.open({ projectDir: join(dir, 'project'), dataDir: join(dir, 'data'), api: { token: 'ui-test-token' }, ...(opts.keyring !== undefined ? { keyring: opts.keyring } : {}) });
  await core.setScope({ defaultAction: 'ignore', rules: [{ id: 'r1', action: 'include', host: '127.0.0.1', port: upstream.port }] });
  const { proxyPort, apiPort } = await core.start();
  const base = `http://127.0.0.1:${upstream.port}`;
  const send = (path: string, method = 'GET', body?: string, headers?: Record<string, string>) => viaProxy(proxyPort, `${base}${path}`, method, body, headers);
  if (opts.traffic !== false) {
    await send('/');
    await send('/api/cart');
    await send('/api/apply-coupon', 'POST', JSON.stringify({ code: 'SAVE10', cart: 42 }));
    await send('/old');
    await send('/broken');
    // Out of scope: shows up under "seen but not in scope".
    await viaProxy(proxyPort, 'http://localhost.test.invalid:9/').catch(() => 0);
  }
  const web = await startStatic();
  const token = 'ui-test-token';
  const pageUrl = `http://127.0.0.1:${web.port}/index.html?api=${encodeURIComponent(`ws://127.0.0.1:${apiPort}`)}&token=${encodeURIComponent(token)}`;
  return {
    core,
    upstreamPort: upstream.port,
    proxyPort,
    pageUrl,
    send,
    close: async () => {
      await web.close();
      await core.close();
      await upstream.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
