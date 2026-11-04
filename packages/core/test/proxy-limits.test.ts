import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { ProxyClient } from './proxy-client.js';
import { Core, type ExchangeSummary } from '@siteinquisition/core';

// Small limits so the test moves a few MB instead of hundreds.
const CAPTURE = 256 * 1024;
const BUFFER = 1024 * 1024;
const BIG = 5 * 1024 * 1024;

let tmp: string;
let core: Core;
let target: Server;
let base: string;
let agent: ProxyClient;
const big = Buffer.alloc(BIG);
for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

async function waitFor(query: string): Promise<ExchangeSummary> {
  for (let i = 0; i < 200; i++) {
    const hit = core.store.search(query).find((e) => e.state !== 'pending');
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no exchange for ${query}`);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-limits-'));
  target = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/download') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        // Several writes, as a real server streams a file.
        for (let off = 0; off < big.length; off += 64 * 1024) res.write(big.subarray(off, off + 64 * 1024));
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${Buffer.concat(chunks).length} ${sha(Buffer.concat(chunks))}`);
    });
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd'), api: false, store: { maxBodyBytes: CAPTURE }, proxy: { maxBufferBytes: BUFFER } });
  await core.setScope({ defaultAction: 'ignore', rules: [{ action: 'include', host: '127.0.0.1' }] });
  const { proxyPort } = await core.start();
  agent = new ProxyClient({ uri: `http://127.0.0.1:${proxyPort}` });
});

afterAll(async () => {
  agent?.close();
  await core?.close();
  target?.closeAllConnections();
  await new Promise((r) => target?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe('large bodies', () => {
  it('streams a download larger than the capture limit and records its start and real size', async () => {
    const res = await agent.fetch(`${base}/download`);
    const got = Buffer.from(await res.arrayBuffer());
    expect(sha(got)).toBe(sha(big));
    const ex = core.store.getExchange((await waitFor('path:/download')).id)!;
    expect(ex.responseBodyTruncated).toBe(true);
    expect(ex.resBodySize).toBe(BIG);
    expect(core.store.getBody(ex.id, 'response', false)!.byteLength).toBe(CAPTURE);
  });

  it('streams a download past hooks when it is larger than the buffer limit', async () => {
    await core.tools.setScripts([{ name: 'stamp', kind: 'hook', code: 'function onResponse(req, res) { res.setHeader("x-hooked", "1"); }' }]);
    try {
      const res = await agent.fetch(`${base}/download`);
      expect(sha(Buffer.from(await res.arrayBuffer()))).toBe(sha(big));
      // Too big to hold for the hook, so it passed through unchanged.
      expect(res.headers.get('x-hooked')).toBeNull();
    } finally {
      await core.tools.setScripts([]);
    }
  });

  it('streams an upload larger than the buffer limit and records its start and declared size', async () => {
    const res = await agent.fetch(`${base}/upload`, { method: 'POST', body: big, headers: { 'content-type': 'application/octet-stream' } });
    expect(await res.text()).toBe(`${BIG} ${sha(big)}`);
    const ex = core.store.getExchange((await waitFor('path:/upload')).id)!;
    expect(ex.requestBodyTruncated).toBe(true);
    expect(ex.reqBodySize).toBe(BIG);
    expect(core.store.getBody(ex.id, 'request', false)!.byteLength).toBe(CAPTURE);
  });

  it('still buffers small bodies whole for hooks', async () => {
    await core.tools.setScripts([{ name: 'stamp', kind: 'hook', code: 'function onResponse(req, res) { res.setHeader("x-hooked", "1"); }' }]);
    try {
      const res = await agent.fetch(`${base}/upload`, { method: 'POST', body: 'small' });
      expect(res.headers.get('x-hooked')).toBe('1');
      expect(await res.text()).toBe(`5 ${sha(Buffer.from('small'))}`);
    } finally {
      await core.tools.setScripts([]);
    }
  });
});
