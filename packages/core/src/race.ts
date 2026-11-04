import * as http from 'node:http';
import * as http2 from 'node:http2';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { newId } from './ids.js';
import { runH3Plan } from './quic/plan.js';
import type { CaptureStore, ExchangeSummary, HeaderList } from './store.js';

/**
 * Race-timed replay: send several requests so they reach the server as close
 * together as possible, or at chosen offsets, to shake out race conditions
 * (double spends, coupon reuse, TOCTOU checks).
 *
 *  - last-byte:     HTTP/1.1. Every connection (and TLS handshake) is opened
 *                   first and each request is written except its final byte;
 *                   at the gate the last bytes go out at their offsets.
 *  - single-packet: HTTP/2. All streams open on one connection with their
 *                   bodies held back; at the gate every stream ends in the
 *                   same tick, so the final frames share one TCP write.
 *  - h3-single-datagram: HTTP/3. Every stream is written except its last
 *                   byte; at the gate the last bytes of all streams go out in
 *                   one UDP datagram (as few as possible when they do not fit).
 *  - none:          plain sends at the offsets, for comparison.
 */
export interface RaceRequest {
  method: string;
  url: string;
  headers: HeaderList;
  body?: Uint8Array;
  /** Milliseconds after the gate opens. */
  offsetMs: number;
  replayOf?: string | null;
}

export interface RaceOptions {
  sync: 'last-byte' | 'single-packet' | 'h3-single-datagram' | 'none';
  repeat?: number;
  /** Random extra delay, 0 to jitterMs, added to each offset. */
  jitterMs?: number;
  ignoreTlsErrors?: boolean;
  timeoutMs?: number;
}

export interface RaceSendResult {
  index: number;
  exchangeId: string;
  plannedMs: number;
  /** When the final byte was handed to the socket, relative to the gate. */
  actualMs: number;
  status: number | null;
  durationMs: number | null;
  error?: string;
}

export interface RaceRun {
  run: number;
  flowId: string;
  sends: RaceSendResult[];
  /** Spread between the first and last actual send. */
  spreadMs: number;
  /** Distinct status codes in this run, a quick hint that something raced. */
  statuses: Array<number | null>;
}

export interface RaceResult {
  id: string;
  sync: RaceOptions['sync'];
  runs: RaceRun[];
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length']);

function cleanHeaders(req: RaceRequest, url: URL, h2: boolean): HeaderList {
  const out: HeaderList = [];
  let hasHost = false;
  for (const [k, v] of req.headers) {
    const l = k.toLowerCase();
    if (HOP.has(l) || k.startsWith(':')) continue;
    if (l === 'host') {
      hasHost = true;
      if (h2) continue;
    }
    out.push([h2 ? l : k, v]);
  }
  if (!hasHost && !h2) out.unshift(['Host', url.host]);
  const body = req.body ?? new Uint8Array();
  if (body.length || !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method.toUpperCase())) out.push([h2 ? 'content-length' : 'Content-Length', String(body.length)]);
  return out;
}

const now = () => performance.now();
const round = (n: number) => Math.round(n * 1000) / 1000;
const sleepUntil = (t: number) =>
  new Promise<void>((r) => {
    const wait = t - now();
    if (wait <= 1) return r();
    setTimeout(r, wait - 1);
  }).then(() => {
    while (now() < t) {
      // spin for the last millisecond: timers are too coarse for race windows
    }
  });

interface Prepared {
  index: number;
  plannedMs: number;
  exchangeId: string;
  fire(): void;
  done: Promise<{ status: number; message: string; headers: HeaderList; body: Buffer }>;
  firedAt?: number;
}

function connect(url: URL, ignoreTls: boolean, alpn?: string[]): Promise<net.Socket> {
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const s =
      url.protocol === 'https:'
        ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !ignoreTls, ALPNProtocols: alpn }, () => resolve(s))
        : net.connect({ host, port }, () => resolve(s));
    s.setNoDelay(true);
    s.once('error', reject);
  });
}

async function prepareHttp1(store: CaptureStore, r: RaceRequest, index: number, planned: number, flowId: string, tag: string, opts: RaceOptions): Promise<Prepared> {
  const url = new URL(r.url);
  const headers = cleanHeaders(r, url, false);
  const body = r.body ?? new Uint8Array();
  const socket = await connect(url, !!opts.ignoreTlsErrors);
  const ex = store.addRequest({ source: 'replay', startedAt: Date.now(), method: r.method.toUpperCase(), url: url.href, httpVersion: '1.1', headers, body, replayOf: r.replayOf ?? null, flowId, tags: [tag] });
  let fire!: () => void;
  const done = new Promise<{ status: number; message: string; headers: HeaderList; body: Buffer }>((resolve, reject) => {
    const req = http.request({
      method: r.method.toUpperCase(),
      path: url.pathname + url.search,
      headers: headers.flat(),
      createConnection: () => socket,
      timeout: opts.timeoutMs ?? 30_000,
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const list: HeaderList = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) list.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
        resolve({ status: res.statusCode ?? 0, message: res.statusMessage ?? '', headers: list, body: Buffer.concat(chunks) });
        socket.destroy();
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('no response before the timeout')));
    req.on('error', reject);
    if (body.length) {
      // Everything but the last byte now; the last byte opens the gate.
      req.flushHeaders();
      if (body.length > 1) req.write(body.subarray(0, body.length - 1));
      fire = () => req.end(body.subarray(body.length - 1));
    } else {
      // No body to hold back: the connection is warm and the whole head goes out at the gate.
      fire = () => req.end();
    }
  });
  done.catch(() => undefined);
  return { index, plannedMs: planned, exchangeId: ex.id, fire: () => fire(), done };
}

async function prepareHttp2(
  store: CaptureStore,
  session: http2.ClientHttp2Session,
  r: RaceRequest,
  index: number,
  planned: number,
  flowId: string,
  tag: string,
  opts: RaceOptions,
): Promise<Prepared> {
  const url = new URL(r.url);
  const headers = cleanHeaders(r, url, true);
  const body = r.body ?? new Uint8Array();
  const ex = store.addRequest({ source: 'replay', startedAt: Date.now(), method: r.method.toUpperCase(), url: url.href, httpVersion: '2', headers, body, replayOf: r.replayOf ?? null, flowId, tags: [tag] });
  const stream = session.request({ ':method': r.method.toUpperCase(), ':path': url.pathname + url.search, ':authority': url.host, ...Object.fromEntries(headers) }, { endStream: false });
  stream.setTimeout(opts.timeoutMs ?? 30_000, () => stream.close(http2.constants.NGHTTP2_CANCEL));
  if (body.length > 1) stream.write(body.subarray(0, body.length - 1));
  const done = new Promise<{ status: number; message: string; headers: HeaderList; body: Buffer }>((resolve, reject) => {
    let status = 0;
    const list: HeaderList = [];
    stream.on('response', (h) => {
      status = Number(h[':status']);
      for (const [k, v] of Object.entries(h)) if (!k.startsWith(':')) for (const x of Array.isArray(v) ? v : [v]) list.push([k, String(x)]);
    });
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve({ status, message: '', headers: list, body: Buffer.concat(chunks) }));
    stream.on('error', reject);
    stream.on('close', () => {
      if (!status) reject(new Error('stream closed without a response'));
    });
  });
  done.catch(() => undefined);
  return { index, plannedMs: planned, exchangeId: ex.id, fire: () => stream.end(body.length ? body.subarray(body.length - 1) : undefined), done };
}

async function prepareNone(store: CaptureStore, r: RaceRequest, index: number, planned: number, flowId: string, tag: string, opts: RaceOptions): Promise<Prepared> {
  // Same as last-byte but nothing is held back and connections open at fire time.
  const url = new URL(r.url);
  const headers = cleanHeaders(r, url, false);
  const body = r.body ?? new Uint8Array();
  const ex = store.addRequest({ source: 'replay', startedAt: Date.now(), method: r.method.toUpperCase(), url: url.href, httpVersion: '1.1', headers, body, replayOf: r.replayOf ?? null, flowId, tags: [tag] });
  let resolveDone!: (v: { status: number; message: string; headers: HeaderList; body: Buffer }) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<{ status: number; message: string; headers: HeaderList; body: Buffer }>((res, rej) => ((resolveDone = res), (rejectDone = rej)));
  done.catch(() => undefined);
  const fire = () => {
    connect(url, !!opts.ignoreTlsErrors).then((socket) => {
      const req = http.request({ method: r.method.toUpperCase(), path: url.pathname + url.search, headers: headers.flat(), createConnection: () => socket, timeout: opts.timeoutMs ?? 30_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const list: HeaderList = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) list.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
          resolveDone({ status: res.statusCode ?? 0, message: res.statusMessage ?? '', headers: list, body: Buffer.concat(chunks) });
          socket.destroy();
        });
      });
      req.on('error', rejectDone);
      req.end(body.length ? body : undefined);
    }, rejectDone);
  };
  return { index, plannedMs: planned, exchangeId: ex.id, fire, done };
}

export async function runRace(store: CaptureStore, requests: RaceRequest[], opts: RaceOptions): Promise<RaceResult> {
  if (!requests.length) throw new Error('a race needs at least one request');
  if (opts.sync === 'h3-single-datagram') return raceH3(store, requests, opts);
  if (requests.length > 100) throw new Error('a race can have at most 100 requests');
  for (const r of requests) {
    const u = new URL(r.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`cannot race ${u.protocol} URLs`);
  }
  const repeat = Math.max(1, Math.min(opts.repeat ?? 1, 50));
  const id = newId();
  const runs: RaceRun[] = [];
  for (let run = 0; run < repeat; run++) {
    const flowId = store.createFlow('race');
    const tag = `race:${id}`;
    const planned = requests.map((r) => Math.max(0, r.offsetMs) + (opts.jitterMs ? Math.random() * opts.jitterMs : 0));
    let session: http2.ClientHttp2Session | undefined;
    const prepared: Prepared[] = [];
    const failed: RaceSendResult[] = [];
    try {
      if (opts.sync === 'single-packet') {
        const origins = new Set(requests.map((r) => new URL(r.url).origin));
        if (origins.size > 1) throw new Error('single-packet sync needs every request on the same origin (one HTTP/2 connection)');
        const url = new URL(requests[0]!.url);
        session = await new Promise<http2.ClientHttp2Session>((resolve, reject) => {
          const s = http2.connect(url.origin, { rejectUnauthorized: !opts.ignoreTlsErrors, ...(url.protocol === 'https:' ? { ALPNProtocols: ['h2'] } : {}) });
          s.once('connect', () => resolve(s));
          s.once('error', (e) => reject(new Error(`HTTP/2 connection failed (the server may not support HTTP/2): ${e.message}`)));
        });
      }
      for (let i = 0; i < requests.length; i++) {
        try {
          const r = requests[i]!;
          prepared.push(
            opts.sync === 'single-packet'
              ? await prepareHttp2(store, session!, r, i, planned[i]!, flowId, tag, opts)
              : opts.sync === 'last-byte'
                ? await prepareHttp1(store, r, i, planned[i]!, flowId, tag, opts)
                : await prepareNone(store, r, i, planned[i]!, flowId, tag, opts),
          );
        } catch (e) {
          const ex = store.addRequest({ source: 'replay', startedAt: Date.now(), method: requests[i]!.method, url: requests[i]!.url, httpVersion: '1.1', headers: requests[i]!.headers, flowId, tags: [tag] });
          store.failExchange(ex.id, 'error', (e as Error).message);
          failed.push({ index: i, exchangeId: ex.id, plannedMs: round(planned[i]!), actualMs: NaN, status: null, durationMs: null, error: (e as Error).message });
        }
      }
      // The gate: fire in planned order, same-offset sends in one synchronous pass.
      const gate = now();
      const order = [...prepared].sort((a, b) => a.plannedMs - b.plannedMs);
      let k = 0;
      while (k < order.length) {
        const at = order[k]!.plannedMs;
        if (at > 0) await sleepUntil(gate + at);
        while (k < order.length && order[k]!.plannedMs <= at + 0.05) {
          const p = order[k++]!;
          p.firedAt = now() - gate;
          p.fire();
        }
      }
      const sends: RaceSendResult[] = [...failed];
      await Promise.all(
        prepared.map(async (p) => {
          const firedAbs = gate + (p.firedAt ?? 0);
          try {
            const res = await p.done;
            const total = now() - firedAbs;
            store.completeResponse(p.exchangeId, { status: res.status, statusMessage: res.message, headers: res.headers, body: res.body, timings: { total: round(total) } });
            sends.push({ index: p.index, exchangeId: p.exchangeId, plannedMs: round(p.plannedMs), actualMs: round(p.firedAt ?? 0), status: res.status, durationMs: round(total) });
          } catch (e) {
            store.failExchange(p.exchangeId, 'error', (e as Error).message, { total: round(now() - firedAbs) });
            sends.push({ index: p.index, exchangeId: p.exchangeId, plannedMs: round(p.plannedMs), actualMs: round(p.firedAt ?? 0), status: null, durationMs: null, error: (e as Error).message });
          }
        }),
      );
      sends.sort((a, b) => a.index - b.index);
      const fired = sends.filter((s) => Number.isFinite(s.actualMs)).map((s) => s.actualMs);
      runs.push({ run, flowId, sends, spreadMs: fired.length ? round(Math.max(...fired) - Math.min(...fired)) : 0, statuses: [...new Set(sends.map((s) => s.status))] });
    } finally {
      session?.close();
    }
  }
  return { id, sync: opts.sync, runs };
}

export type { ExchangeSummary };

/** HTTP/3 race: a stream plan where every row holds its last byte and the gate releases them together. */
async function raceH3(store: CaptureStore, requests: RaceRequest[], opts: RaceOptions): Promise<RaceResult> {
  if (requests.length > 100) throw new Error('a race can have at most 100 requests');
  const repeat = Math.max(1, Math.min(opts.repeat ?? 1, 50));
  const id = newId();
  const runs: RaceRun[] = [];
  for (let run = 0; run < repeat; run++) {
    const offsets = requests.map((r) => Math.max(0, r.offsetMs) + (opts.jitterMs ? Math.random() * opts.jitterMs : 0));
    const base = Math.min(...offsets);
    const plan = await runH3Plan(
      store,
      requests.map((r, i) => ({
        method: r.method,
        url: r.url,
        headers: r.headers,
        body: r.body,
        replayOf: r.replayOf,
        hold: 'last-byte' as const,
        // Equal offsets release together through the gate. With offsets, every
        // row is held first and released 50 ms in, plus its offset.
        releaseAtMs: offsets.some((o) => o - base > 0.05) ? 50 + Math.round((offsets[i]! - base) * 1000) / 1000 : undefined,
      })),
      { gate: 'single-datagram', ignoreTlsErrors: opts.ignoreTlsErrors, timeoutMs: opts.timeoutMs },
    );
    const p = plan.runs[0]!;
    for (const r of p.rows) store.tagExchange(r.exchangeId, [...(store.getSummary(r.exchangeId)?.tags ?? []), `race:${id}`]);
    const fired = p.rows.map((r) => r.timings.released ?? r.timings.finSent ?? NaN);
    const gate = Math.min(...fired.filter(Number.isFinite));
    const sends: RaceSendResult[] = p.rows.map((r, i) => ({
      index: r.index,
      exchangeId: r.exchangeId,
      plannedMs: round(offsets[i]! - base),
      actualMs: Number.isFinite(fired[i]!) ? round(fired[i]! - gate) : NaN,
      status: r.status,
      durationMs: r.timings.complete !== undefined && Number.isFinite(fired[i]!) ? round(r.timings.complete - fired[i]!) : null,
      error: r.error,
    }));
    runs.push({ run, flowId: p.flowId, sends, spreadMs: p.spreadMs, statuses: [...new Set(sends.map((s) => s.status))] });
  }
  return { id, sync: opts.sync, runs };
}
