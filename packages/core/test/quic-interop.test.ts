/**
 * Interop with aioquic, a separate QUIC and HTTP/3 implementation. Runs when
 * a Python with aioquic is available (SIQ_AIOQUIC_PYTHON, or python3) and
 * skips otherwise. aioquic is a developer tool here, never a dependency.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { H3Server, h3Connect, requestFields } from '../src/quic/index.js';
import { generateCA, LeafIssuer } from '../src/x509.js';

const python = process.env.SIQ_AIOQUIC_PYTHON ?? 'python3';
const hasAioquic = spawnSync(python, ['-c', 'import aioquic'], { stdio: 'ignore' }).status === 0;
const peer = fileURLToPath(new URL('./fixtures/aioquic_peer.py', import.meta.url));

const ca = generateCA({ commonName: 'interop CA' });
const issuer = new LeafIssuer(ca);

describe.skipIf(!hasAioquic)('HTTP/3 interop with aioquic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'siq-h3-'));
  let proc: ChildProcess;
  let port = 0;

  beforeAll(async () => {
    const leaf = issuer.issue('localhost');
    writeFileSync(join(dir, 'cert.pem'), leaf.cert + ca.cert);
    writeFileSync(join(dir, 'key.pem'), leaf.key);
    writeFileSync(join(dir, 'ca.pem'), ca.cert);
    proc = spawn(python, [peer, 'server', join(dir, 'cert.pem'), join(dir, 'key.pem'), join(dir, 'port')], { stdio: ['ignore', 'inherit', 'inherit'] });
    for (let i = 0; i < 100 && !existsSync(join(dir, 'port')); i++) await new Promise((r) => setTimeout(r, 50));
    port = Number(readFileSync(join(dir, 'port'), 'utf8'));
  });
  afterAll(() => proc?.kill());

  const connect = (o = {}) => h3Connect({ host: '127.0.0.1', port, serverName: 'localhost', ca: [ca.cert], ...o });

  it('fetches from an aioquic server', async () => {
    const c = await connect();
    const s = c.session.request(requestFields('POST', new URL(`https://localhost:${port}/hello?x=1`), [['x-test', 'one'], ['content-type', 'text/plain']]), Buffer.from('ping'))!;
    const res = await s.response();
    expect(res.status).toBe(200);
    expect(res.headers).toContainEqual(['x-served-by', 'aioquic']);
    const echo = JSON.parse(res.body.toString());
    expect(echo.headers).toContainEqual([':path', '/hello?x=1']);
    expect(echo.headers).toContainEqual(['x-test', 'one']);
    expect(echo.body).toBe(4);
    c.close();
  });

  it('runs many concurrent streams and sees responses in server order', async () => {
    const c = await connect();
    const delays = [300, 50, 200, 0, 100];
    const done: number[] = [];
    await Promise.all(
      delays.map(async (d, i) => {
        const s = c.session.request(requestFields('GET', new URL(`https://localhost:${port}/delay/${d}`), []))!;
        const res = await s.response();
        expect(res.status).toBe(200);
        done.push(i);
      }),
    );
    expect(done).toEqual([3, 1, 4, 2, 0]);
    c.close();
  });

  it('downloads a large body', async () => {
    const c = await connect();
    const res = await c.session.request(requestFields('GET', new URL(`https://localhost:${port}/size/2000000`), []))!.response();
    expect(res.body.length).toBe(2_000_000);
    c.close();
  });

  it('uses the dynamic QPACK table both ways', async () => {
    const c = await connect();
    const big: Array<[string, string]> = Array.from({ length: 10 }, (_, i) => [`x-h${i}`, `value-${i}-${'v'.repeat(40)}`]);
    for (let i = 0; i < 3; i++) {
      const res = await c.session.request(requestFields('GET', new URL(`https://localhost:${port}/q`), big))!.response();
      expect(JSON.parse(res.body.toString()).headers).toContainEqual(['x-h9', big[9]![1]]);
    }
    expect(c.session.encoder.stats.inserted).toBeGreaterThan(0);
    c.close();
  });

  it('serves an aioquic client', async () => {
    const leaf = issuer.issue('localhost');
    const server = new H3Server({ cert: leaf.cert + ca.cert, key: leaf.key }, async (req) => {
      const body = await req.body();
      req.respond(201, [['x-served-by', 'siteinquisition']], JSON.stringify({ path: req.path, body: body.toString(), headers: req.headers }));
    });
    const { port: p } = await server.listen(0);
    try {
      // Not spawnSync: the server runs on this event loop.
      const child = spawn(python, [peer, 'client', `https://localhost:${p}/from-aioquic`, join(dir, 'ca.pem')]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      await new Promise((r) => child.on('exit', r));
      expect(stderr).toBe('');
      const out = JSON.parse(stdout);
      expect(out.status).toBe('201');
      expect(JSON.parse(out.body)).toMatchObject({ path: '/from-aioquic', body: 'hello from aioquic' });
    } finally {
      await server.close();
    }
  });
});
