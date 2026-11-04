import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaptureStore } from '../src/store.js';
import { H3Server, type H3ServerRequest } from '../src/quic/index.js';
import { h3Tickets, runH3Plan, type H3PlanRequest } from '../src/quic/plan.js';
import { runRace } from '../src/race.js';
import { sendReplay } from '../src/replay.js';
import { generateCA, LeafIssuer } from '../src/x509.js';

const ca = generateCA({ commonName: 'plan CA' });
const issuer = new LeafIssuer(ca);

interface Seen {
  path: string;
  at: number;
  early: boolean;
  priority?: string;
  conn: number;
}

describe('HTTP/3 stream plans', () => {
  const dir = mkdtempSync(join(tmpdir(), 'siq-plan-'));
  const store = CaptureStore.openProject(dir);
  const seen: Seen[] = [];
  const resets: number[] = [];
  const priorityUpdates: Array<[number, string]> = [];
  const conns = new Map<object, number>();
  let server: H3Server;
  let base = '';

  beforeAll(async () => {
    const leaf = issuer.issue('localhost');
    server = new H3Server({ cert: leaf.cert + ca.cert, key: leaf.key, acceptEarlyData: true }, async (req: H3ServerRequest) => {
      if (!conns.has(req.connection)) conns.set(req.connection, conns.size);
      req.stream.on('reset', (code: number) => resets.push(code));
      const body = await req.body();
      const path = req.path;
      seen.push({ path, at: performance.now(), early: !req.connection.handshakeConfirmed || req.connection.log.some((e) => e.dir === 'in' && e.type === '0rtt' && e.frames.some((f) => f.includes(`id=${req.stream.id} `))), priority: req.headers.find(([k]) => k === 'priority')?.[1], conn: conns.get(req.connection)! });
      const m = /^\/delay\/(\d+)/.exec(path);
      if (m) await new Promise((r) => setTimeout(r, Number(m[1])));
      const size = /^\/size\/(\d+)/.exec(path);
      if (req.stream.resetCode !== null) return;
      req.respond(200, [['x-body', String(body.length)]], size ? Buffer.alloc(Number(size[1]), 0x61) : `ok ${path}`);
    });
    server.on('session', (s) => s.on('priority', (id: number, v: string) => priorityUpdates.push([id, v])));
    if (process.env.DBG) server.quic.on('connection', (c) => { c.ev.packet = (e: { dir: string; type: string; frames: string[] }) => console.log('S', e.dir, e.type, e.frames.join(' | ')); });
    const { port } = await server.listen(0);
    base = `https://localhost:${port}`;
  });
  afterAll(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const row = (path: string, o: Partial<H3PlanRequest> = {}): H3PlanRequest => ({ method: 'GET', url: base + path, headers: [], ...o });
  const plan = (rows: H3PlanRequest[], o = {}) => runH3Plan(store, rows, { ca: [ca.cert], ...o });

  it('sends concurrent streams and reports the order responses came back in', async () => {
    const r = await plan([row('/delay/150'), row('/delay/0'), row('/delay/60')]);
    const run = r.runs[0]!;
    expect(run.rows.map((x) => x.status)).toEqual([200, 200, 200]);
    expect(run.rows.map((x) => x.completedOrder)).toEqual([2, 0, 1]);
    expect(run.reordered).toBe(true);
    expect(run.connections[0]!.alpn).toBe('h3');
    const ex = store.getExchange(run.rows[0]!.exchangeId)!;
    expect(ex.httpVersion).toBe('3');
    expect(ex.status).toBe(200);
  });

  it('holds the last byte of every row and releases them in one datagram', async () => {
    seen.length = 0;
    const rows = Array.from({ length: 12 }, (_, i) => row(`/gate/${i}`, { method: 'POST', body: Buffer.from(`coupon=SAVE10&n=${i}`), hold: 'last-byte' as const, openAtMs: i * 15 }));
    const r = await plan(rows, { gate: 'single-datagram' });
    const run = r.runs[0]!;
    expect(run.rows.every((x) => x.status === 200)).toBe(true);
    expect(run.connections[0]!.gateDatagrams).toBe(1);
    expect(run.spreadMs).toBeLessThan(5);
    const gate = seen.filter((s) => s.path.startsWith('/gate/'));
    expect(gate).toHaveLength(12);
    // All twelve arrived together even though they were opened 165 ms apart.
    expect(Math.max(...gate.map((s) => s.at)) - Math.min(...gate.map((s) => s.at))).toBeLessThan(30);
  });

  it('limits concurrency and honours row dependencies', async () => {
    const r = await plan([row('/delay/40'), row('/delay/0', { after: { row: 0, event: 'end' } }), row('/delay/0')], { concurrency: 1 });
    const rows = r.runs[0]!.rows;
    expect(rows[1]!.timings.opened!).toBeGreaterThanOrEqual(rows[0]!.timings.complete!);
    expect(rows[2]!.timings.opened!).toBeGreaterThanOrEqual(rows[0]!.timings.complete!);
  });

  it('resets a stream partway through its body', async () => {
    resets.length = 0;
    const r = await plan([row('/upload', { method: 'POST', body: Buffer.alloc(5000, 1), resetAfterBytes: 1000, resetCode: 0x10c })]);
    expect(r.runs[0]!.rows[0]!.status).toBeNull();
    expect(r.runs[0]!.rows[0]!.timings.resetSent).toBeDefined();
    await new Promise((x) => setTimeout(x, 30));
    expect(resets).toContain(0x10c);
  });

  it('stops the response after some bytes', async () => {
    const r = await plan([row('/size/400000', { stopSendingAfterBytes: 10_000 })]);
    const x = r.runs[0]!.rows[0]!;
    expect(x.error).toMatch(/reset/);
    expect(x.bodyBytes).toBeLessThan(400_000);
  });

  it('sends priority headers and PRIORITY_UPDATE frames', async () => {
    priorityUpdates.length = 0;
    seen.length = 0;
    const r = await plan([row('/delay/80', { priority: 'u=5', priorityUpdates: [{ atMs: 20, value: 'u=0, i' }] })]);
    expect(r.runs[0]!.rows[0]!.status).toBe(200);
    expect(seen.find((s) => s.path === '/delay/80')?.priority).toBe('u=5');
    expect(priorityUpdates).toContainEqual([r.runs[0]!.rows[0]!.streamId, 'u=0, i']);
  });

  it('replays a request in 0-RTT on two connections', async () => {
    h3Tickets.clear();
    seen.length = 0;
    const r = await plan([row('/early', { method: 'POST', body: Buffer.from('transfer=100'), earlyData: true })], { zeroRttConnections: 2 });
    const run = r.runs[0]!;
    expect(run.connections).toHaveLength(2);
    expect(run.connections.every((c) => c.resumed && c.earlyDataAccepted)).toBe(true);
    expect(run.rows.filter((x) => x.early && x.status === 200)).toHaveLength(2);
    expect(seen.filter((s) => s.path === '/early')).toHaveLength(2);
  });

  it('migrates to a new port mid-plan and keeps going', async () => {
    const r = await plan([row('/delay/0'), row('/delay/0', { openAtMs: 120 })], { migrateAtMs: 40 });
    const run = r.runs[0]!;
    expect(run.rows.map((x) => x.status)).toEqual([200, 200]);
    expect(run.connections[0]!.localPorts).toHaveLength(2);
  });

  it('starves the server with tiny flow control windows', async () => {
    const r = await plan([row('/size/200000')], { transport: { initialMaxStreamDataBidiLocal: 4096, initialMaxData: 8192 }, autoCredit: false, timeoutMs: 400 });
    const x = r.runs[0]!.rows[0]!;
    expect(x.status).toBeNull();
    expect(x.bodyBytes).toBeLessThanOrEqual(8192);
    expect(r.runs[0]!.connections[0]!.packets.some((p) => p.dir === 'in' && p.frames.some((f) => f.includes('BLOCKED')))).toBe(true);
  });

  it('races over HTTP/3 with the single-datagram gate', async () => {
    seen.length = 0;
    const reqs = Array.from({ length: 8 }, (_, i) => ({ method: 'POST', url: `${base}/race/${i}`, headers: [] as Array<[string, string]>, body: Buffer.from('redeem=1'), offsetMs: 0 }));
    // The race uses the system CA store, so trust the test CA through the plan's default.
    const r = await runRace(store, reqs, { sync: 'h3-single-datagram', ignoreTlsErrors: true });
    expect(r.runs[0]!.sends.every((x) => x.status === 200)).toBe(true);
    expect(r.runs[0]!.spreadMs).toBeLessThan(5);
    const ex = store.getExchange(r.runs[0]!.sends[0]!.exchangeId)!;
    expect(ex.tags).toContain(`race:${r.id}`);

    const timed = await runRace(store, reqs.slice(0, 2).map((x, i) => ({ ...x, offsetMs: i * 40 })), { sync: 'h3-single-datagram', ignoreTlsErrors: true });
    const s2 = timed.runs[0]!.sends;
    expect(s2[1]!.actualMs - s2[0]!.actualMs).toBeGreaterThan(30);
  });

  it('replays one request over HTTP/3', async () => {
    const res = await sendReplay(store, { method: 'GET', url: `${base}/replay`, headers: [['accept', '*/*']], protocol: 'h3', ignoreTlsErrors: true });
    expect(res.status).toBe(200);
    expect(store.getExchange(res.id)!.httpVersion).toBe('3');
  });
});
