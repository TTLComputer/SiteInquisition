/**
 * The HTTP/2 stream plan runner behind the protocol lab: many requests on
 * one HTTP/2 connection with control over when each stream opens, what is
 * held back, what is reset, priorities, flow control, HPACK, SETTINGS,
 * CONTINUATION, raw frames and connection-level events. Rows and results
 * have the same shape as the HTTP/3 plan's, so the lab shows both alike.
 */
import { performance } from 'node:perf_hooks';
import { newId } from '../ids.js';
import type { CaptureStore, HeaderList } from '../store.js';
import type { H3RowResult } from '../quic/plan.js';
import { collectResponse, type CollectedResponse, type Field, type FrameLogEntry, type H2Settings, type H2Stream } from './connection.js';
import { h2Connect, type H2ConnectMethod, type H2Connected } from './connect.js';
import { H2Error, h2ErrorCode, h2ErrorName, settingName, type PriorityInfo } from './frames.js';
import type { HpackPolicy } from './hpack.js';

export interface H2PlanRequest {
  label?: string;
  method: string;
  url: string;
  headers: HeaderList;
  body?: Uint8Array;
  replayOf?: string | null;
  openAtMs?: number;
  after?: { row: number; event: 'headers' | 'end' };
  /** 'last-byte' keeps the final body byte back; 'fin' sends the body but not END_STREAM. */
  hold?: 'last-byte' | 'fin';
  releaseAtMs?: number;
  /** DATA frames of this size, with gaps between them. */
  chunkSize?: number;
  chunkGapMs?: number;
  resetAfterBytes?: number;
  resetAtMs?: number;
  resetCode?: number | string;
  /** Stop granting credit for the response after this many bytes: the server stalls on this stream. */
  stopReadingAfterBytes?: number;
  /** RFC 9218 priority header, such as "u=0, i". */
  priority?: string;
  /** RFC 7540 priority in the HEADERS frame. */
  priorityFrame?: PriorityInfo;
  /** PRIORITY frames while the stream is open. */
  priorityUpdates?: Array<{ atMs: number; priority: PriorityInfo }>;
  /** Trailers after the body (HEADERS with END_STREAM). */
  trailers?: HeaderList;
  /** Split the header block into CONTINUATION frames of this size. */
  continuationSize?: number;
  padding?: number;
  /** Extra frames written right after the headers: type, flags and hex payload; stream 0 when connection is true. */
  rawFrames?: Array<{ type: number; flags?: number; payloadHex: string; connection?: boolean }>;
}

export interface H2AbuseOptions {
  /** Open and reset this many streams at once (CVE-2023-44487 style), at most 1000. */
  rapidReset?: number;
  /** PING frames sent at once, at most 1000. */
  pingFlood?: number;
  /** SETTINGS frames sent at once, at most 1000. */
  settingsFlood?: number;
  /** Empty DATA frames on one open stream, at most 1000. */
  emptyData?: number;
}

export interface H2PlanOptions {
  /** How to get HTTP/2 from the server (default ALPN for https, prior knowledge for http). */
  connect?: H2ConnectMethod;
  alpn?: string[];
  settings?: H2Settings;
  hpack?: HpackPolicy;
  autoCredit?: boolean;
  connectionWindow?: number;
  autoAckSettings?: boolean;
  autoAckPing?: boolean;
  /** Refuse a malformed response (default true). Off shows what the server sent. */
  validate?: boolean;
  concurrency?: number;
  /** single-packet: release held rows' final frames in one TCP write. */
  gate?: 'none' | 'single-packet';
  pingAtMs?: number[];
  goawayAtMs?: number;
  goawayCode?: number | string;
  closeAtMs?: number;
  /** HPACK dynamic table size update at a time (may be over the server's limit on purpose). */
  tableSizeUpdate?: { atMs: number; size: number };
  abuse?: H2AbuseOptions;
  ignoreTlsErrors?: boolean;
  timeoutMs?: number;
  connectTo?: { host: string; port: number };
  ca?: string[];
  repeat?: number;
  resetGraceMs?: number;
}

export interface H2ConnectionReport {
  index: number;
  method: H2ConnectMethod;
  alpn: string | null | undefined;
  serverSettings: Record<string, number>;
  frames: FrameLogEntry[];
  hpack: { encoder: object; decoder: object };
  goaway: { lastStream: number; code: string; debug: string } | null;
  closed: string | null;
  pingRttMs: number[];
  upgradeHead?: string;
  /** Bytes the gate's single write carried. */
  gateBytes?: number;
}

export interface H2PlanRun {
  run: number;
  flowId: string;
  rows: H3RowResult[];
  connections: H2ConnectionReport[];
  spreadMs: number;
  reordered: boolean;
}

export interface H2PlanResult {
  id: string;
  protocol: 'h2';
  runs: H2PlanRun[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const now = () => performance.now();
const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 1000) / 1000);
const cap = (n: number | undefined) => Math.max(0, Math.min(n ?? 0, 1000));

/**
 * Request pseudo-headers and headers for HTTP/2 from a captured or edited
 * header list. Pseudo-headers in the list (":authority: other.test") are
 * sent exactly as given, in their order, in place of the ones the URL
 * implies, so a test can send a mismatched :authority, an odd :path, or leave
 * one out. Only when the list has none are they built from the method and URL.
 */
export function h2RequestFields(method: string, url: URL, headers: HeaderList, scheme = url.protocol.replace(':', '')): Field[] {
  const drop = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'http2-settings']);
  const given = headers.filter(([k]) => k.startsWith(':')).map(([k, v]): Field => [k.toLowerCase(), v]);
  const host = headers.find(([k]) => k.toLowerCase() === 'host')?.[1] ?? url.host;
  const out: Field[] = given.length ? given : [[':method', method.toUpperCase()], [':scheme', scheme], [':authority', host], [':path', url.pathname + url.search]];
  for (const [k, v] of headers) {
    const l = k.toLowerCase();
    if (drop.has(l) || l.startsWith(':')) continue;
    if (l === 'te' && v.trim().toLowerCase() !== 'trailers') continue;
    out.push([l, v]);
  }
  return out;
}

export async function runH2Plan(store: CaptureStore, rows: H2PlanRequest[], opts: H2PlanOptions = {}): Promise<H2PlanResult> {
  if (!rows.length) throw new Error('a plan needs at least one request');
  if (rows.length > 200) throw new Error('a plan can have at most 200 requests');
  const urls = rows.map((r) => new URL(r.url));
  for (const u of urls) {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`HTTP/2 needs http or https URLs (${u.href})`);
    if (u.origin !== urls[0]!.origin) throw new Error('every request in a plan must go to the same origin (one HTTP/2 connection)');
  }
  rows.forEach((r, i) => {
    if (r.after && (r.after.row < 0 || r.after.row >= rows.length || r.after.row === i)) throw new Error(`row ${i + 1} waits for a row that does not exist`);
  });
  const id = newId();
  const runs: H2PlanRun[] = [];
  const repeat = Math.max(1, Math.min(opts.repeat ?? 1, 20));
  for (let run = 0; run < repeat; run++) runs.push(await runOnce(store, rows, opts, id, run));
  return { id, protocol: 'h2', runs };
}

async function runOnce(store: CaptureStore, rows: H2PlanRequest[], opts: H2PlanOptions, planId: string, run: number): Promise<H2PlanRun> {
  const url0 = new URL(rows[0]!.url);
  const flowId = store.createFlow('h2-plan');
  const tag = `lab:${planId}`;
  const timeout = opts.timeoutMs ?? 30_000;
  const method = opts.connect ?? (url0.protocol === 'https:' ? 'alpn' : 'prior-knowledge');
  const first = rows[0]!;
  const t0 = now();
  const rel = (t: number | undefined) => (t === undefined ? undefined : round(t - t0));
  const results: H3RowResult[] = [];
  let completed = 0;

  // In upgrade mode the first row is the HTTP/1.1 request that carries the offer.
  const upgradeEx =
    method === 'upgrade'
      ? store.addRequest({ source: 'replay', startedAt: Date.now(), method: first.method.toUpperCase(), url: url0.href, httpVersion: '1.1', headers: first.headers, body: first.body ?? new Uint8Array(), replayOf: first.replayOf ?? null, flowId, tags: [tag, 'h2c-upgrade'] })
      : undefined;
  let c: H2Connected;
  try {
    c = await h2Connect({
      url: url0,
      method,
      alpn: opts.alpn,
      settings: opts.settings,
      hpack: opts.hpack,
      autoCredit: opts.autoCredit,
      connectionWindow: opts.connectionWindow,
      autoAckSettings: opts.autoAckSettings,
      autoAckPing: opts.autoAckPing,
      validate: opts.validate,
      ignoreTlsErrors: opts.ignoreTlsErrors,
      connectTo: opts.connectTo,
      ca: opts.ca,
      timeoutMs: Math.min(timeout, 10_000),
      ...(method === 'upgrade' ? { upgradeRequest: { method: first.method, path: url0.pathname + url0.search, headers: first.headers, body: first.body } } : {}),
    });
  } catch (e) {
    if (upgradeEx) store.failExchange(upgradeEx.id, 'error', (e as Error).message, { total: round(now() - t0) });
    throw e;
  }
  const conn = c.conn;
  const pings: number[] = [];
  const pingSent = new Map<string, number>();
  conn.on('ping', (data, ack) => {
    const at = pingSent.get(data.toString('hex'));
    if (ack && at !== undefined) pings.push(round(now() - at)!);
  });
  const ping = () => {
    const data = Buffer.alloc(8);
    data.writeDoubleBE(now());
    pingSent.set(data.toString('hex'), now());
    conn.ping(data);
  };

  const events = new Map<string, Promise<void>>();
  const signal = new Map<string, () => void>();
  const waitFor = (key: string) => {
    if (!events.has(key)) events.set(key, new Promise<void>((r) => signal.set(key, r)));
    return events.get(key)!;
  };
  const fire = (key: string) => {
    waitFor(key);
    signal.get(key)!();
  };
  let open = 0;
  const waiting: Array<() => void> = [];
  const acquire = async () => {
    const limit = opts.concurrency && opts.concurrency > 0 ? opts.concurrency : Infinity;
    while (open >= limit) await new Promise<void>((r) => waiting.push(r));
    open++;
  };
  const releaseSlot = () => {
    open--;
    waiting.shift()?.();
  };

  const timers: NodeJS.Timeout[] = [];
  const at = (ms: number | undefined, fn: () => void) => {
    if (ms === undefined) return;
    timers.push(setTimeout(fn, Math.max(0, ms - (now() - t0))));
  };
  for (const ms of opts.pingAtMs ?? []) at(ms, ping);
  at(opts.goawayAtMs, () => conn.goaway(h2ErrorCode(opts.goawayCode ?? 'NO_ERROR'), 'sent by the plan', 0));
  at(opts.closeAtMs, () => conn.destroy());
  if (opts.tableSizeUpdate) at(opts.tableSizeUpdate.atMs, () => conn.encoder.queueSizeUpdate(opts.tableSizeUpdate!.size));

  // Hold and release groups, written in one TCP write for the single-packet gate.
  const gateMembers = rows.filter((r, i) => r.hold && r.releaseAtMs === undefined && !(method === 'upgrade' && i === 0)).length;
  const groups = new Map<string, Array<() => void>>();
  let gateBytes: number | undefined;
  const flushGroup = (key: string) => {
    const members = groups.get(key) ?? [];
    groups.delete(key);
    const sock = c.socket;
    const before = sock.bytesWritten;
    if (opts.gate === 'single-packet') sock.cork();
    for (const w of members) w();
    if (opts.gate === 'single-packet') {
      sock.uncork();
      if (key === 'gate') gateBytes = sock.bytesWritten - before;
    }
  };
  const holdFor = (key: string, write: () => void, atMs?: number) => {
    const list = groups.get(key) ?? [];
    list.push(write);
    groups.set(key, list);
    if (key === 'gate' && list.length >= gateMembers) flushGroup(key);
    if (atMs !== undefined && list.length === 1) at(atMs, () => flushGroup(key));
  };

  const finish = (ex: { id: string }, result: H3RowResult, res: CollectedResponse, s: H2Stream | undefined) => {
    result.streamId = s?.id ?? null;
    result.bodyBytes = res.body.length;
    if (res.reset && res.reset !== 'aborted' && res.reset.by === 'remote') result.resetByServer = h2ErrorName(res.reset.code);
    if (res.reset && !res.status) {
      result.error = res.reset === 'aborted' ? 'the connection closed before the response' : `${res.reset.by === 'remote' ? 'server' : 'plan'} reset the stream: ${h2ErrorName(res.reset.code)}`;
      result.timings.resetReceived = res.reset !== 'aborted' && res.reset.by === 'remote' ? rel(now()) : undefined;
      store.failExchange(ex.id, 'error', result.error, { total: round(now() - t0 - (result.timings.opened ?? 0)) });
      return;
    }
    result.status = res.status;
    result.timings.complete = rel(now());
    result.completedOrder = completed++;
    const trailers = res.trailers.length ? res.trailers : [];
    store.completeResponse(ex.id, { status: res.status, headers: [...res.headers, ...trailers.map(([k, v]) => [k, v] as [string, string])], body: res.body, timings: { total: round(now() - t0 - (result.timings.opened ?? 0)) } });
  };

  const runRow = async (row: H2PlanRequest, index: number): Promise<void> => {
    const url = new URL(row.url);
    const headers: HeaderList = row.priority ? [...row.headers.filter(([k]) => k.toLowerCase() !== 'priority'), ['priority', row.priority]] : row.headers;
    const fields = h2RequestFields(row.method, url, headers);
    const body = Buffer.from(row.body ?? new Uint8Array());
    const ex =
      index === 0 && upgradeEx
        ? upgradeEx
        : store.addRequest({ source: 'replay', startedAt: Date.now(), method: row.method.toUpperCase(), url: url.href, httpVersion: '2', headers: fields, body, replayOf: row.replayOf ?? null, flowId, tags: [tag] });
    const result: H3RowResult = { index, label: row.label ?? `${row.method} ${url.pathname}`, exchangeId: ex.id, connection: 0, streamId: null, status: null, bodyBytes: 0, early: false, timings: {}, completedOrder: null };
    results.push(result);
    if (index === 0 && c.upgradeStream) {
      // The upgraded request was sent as HTTP/1.1; its answer is stream 1.
      result.timings.opened = 0;
      result.timings.finSent = 0;
      try {
        finish(ex, result, await withTimeout(c.upgradeResponse ?? collectResponse(c.upgradeStream), timeout), c.upgradeStream);
      } finally {
        fire(`${index}:headers`);
        fire(`${index}:end`);
      }
      return;
    }

    if (row.after) await waitFor(`${row.after.row}:${row.after.event}`);
    if (row.openAtMs) await sleep(t0 + row.openAtMs - now());
    await acquire();
    let s: H2Stream | undefined;
    try {
      s = conn.openStream();
      result.streamId = s.id;
      result.timings.opened = rel(now());
      const stream = s;
      stream.once('headers', () => {
        result.timings.headersReceived ??= rel(now());
        fire(`${index}:headers`);
      });
      let received = 0;
      stream.on('data', (d: Buffer) => {
        result.timings.firstByte ??= rel(now());
        received += d.length;
        if (row.stopReadingAfterBytes !== undefined && received >= row.stopReadingAfterBytes) stream.holdCredit(true);
      });
      const collected = collectResponse(stream);
      for (const u of row.priorityUpdates ?? []) at(u.atMs, () => !stream.closed && stream.priority(u.priority));
      let resetDone!: () => void;
      const resetGrace = new Promise<CollectedResponse>((resolve) => {
        resetDone = () => setTimeout(() => resolve({ status: 0, headers: [], body: Buffer.alloc(0), trailers: [], informational: [], reset: { code: stream.resetCode ?? H2Error.CANCEL, by: 'local' } }), opts.resetGraceMs ?? 500).unref();
      });
      const resetNow = () => {
        if (stream.closed) return;
        stream.reset(h2ErrorCode(row.resetCode ?? 'CANCEL'));
        result.timings.resetSent = rel(now());
        resetDone();
      };
      at(row.resetAtMs, resetNow);

      const hasMore = body.length > 0 || !!row.trailers?.length || !!row.hold;
      stream.sendHeaders(fields, { endStream: !hasMore, continuationSize: row.continuationSize, padding: row.padding, ...(row.priorityFrame ? { priority: row.priorityFrame } : {}) });
      result.timings.headersSent = rel(now());
      for (const f of row.rawFrames ?? []) conn.writeRaw({ type: f.type, flags: f.flags ?? 0, stream: f.connection ? 0 : stream.id, payload: Buffer.from(f.payloadHex, 'hex') });
      if (!hasMore) result.timings.finSent = result.timings.headersSent;

      const end = () => {
        if (row.trailers?.length) stream.sendHeaders(row.trailers.map(([k, v]) => [k.toLowerCase(), v]), { endStream: true });
        else stream.write(Buffer.alloc(0), { endStream: true, padding: row.padding });
        result.timings.finSent = rel(now());
      };
      if (hasMore) {
        let toSend = body;
        if (row.resetAfterBytes !== undefined) toSend = body.subarray(0, row.resetAfterBytes);
        const keep = row.hold === 'last-byte' && toSend.length ? 1 : 0;
        const main = toSend.subarray(0, toSend.length - keep);
        const size = row.chunkSize && row.chunkSize > 0 ? row.chunkSize : undefined;
        if (row.chunkGapMs && size) {
          for (let off = 0; off < main.length; off += size) {
            stream.write(main.subarray(off, off + size), { padding: row.padding });
            if (off + size < main.length) await sleep(row.chunkGapMs);
          }
        } else if (main.length) stream.write(main, { chunkSize: size, padding: row.padding });
        if (row.resetAfterBytes !== undefined) resetNow();
        else if (row.hold) {
          const tail = toSend.subarray(toSend.length - keep);
          const release = () => {
            if (stream.closed) return;
            if (tail.length && !row.trailers?.length) stream.write(tail, { endStream: true, padding: row.padding });
            else {
              if (tail.length) stream.write(tail);
              end();
            }
            result.timings.released = rel(now());
            result.timings.finSent = result.timings.released;
          };
          if (row.releaseAtMs !== undefined) holdFor(`t:${row.releaseAtMs}`, release, row.releaseAtMs);
          else holdFor('gate', release);
        } else end();
      }
      const res = await withTimeout(Promise.race([collected, resetGrace]), timeout);
      finish(ex, result, res, stream);
    } catch (e) {
      result.error = (e as Error).message;
      store.failExchange(ex.id, 'error', result.error, { total: round(now() - t0 - (result.timings.opened ?? 0)) });
    } finally {
      fire(`${index}:headers`);
      fire(`${index}:end`);
      releaseSlot();
    }
  };

  // Abuse checks run before the plan's own rows, so their effect on the rows shows.
  const abuse = opts.abuse ?? {};
  if (cap(abuse.rapidReset)) {
    for (let i = 0; i < cap(abuse.rapidReset); i++) {
      const s = conn.openStream();
      s.sendHeaders(h2RequestFields('GET', url0, []), { endStream: true });
      s.reset(H2Error.CANCEL);
    }
  }
  for (let i = 0; i < cap(abuse.pingFlood); i++) conn.ping(Buffer.alloc(8, i % 256));
  for (let i = 0; i < cap(abuse.settingsFlood); i++) conn.sendSettings([]);
  if (cap(abuse.emptyData)) {
    const s = conn.openStream();
    s.sendHeaders(h2RequestFields('POST', url0, []));
    for (let i = 0; i < cap(abuse.emptyData); i++) conn.writeFrame({ type: 'DATA', stream: s.id, data: Buffer.alloc(0), endStream: false });
    s.reset(H2Error.CANCEL);
  }

  try {
    await Promise.all(rows.map((r, i) => runRow(r, i)));
  } finally {
    timers.forEach(clearTimeout);
    await sleep(20);
  }
  const report: H2ConnectionReport = {
    index: 0,
    method: c.method,
    alpn: c.alpn,
    serverSettings: Object.fromEntries([...conn.peerSettings].map(([k, v]) => [settingName(k), v])),
    frames: conn.log.slice(-3000).map((e) => ({ ...e, t: round(e.t - (t0 - conn.t0))! })),
    hpack: { encoder: conn.encoder.tableState, decoder: conn.decoder.tableState },
    goaway: conn.goawayReceived ? { lastStream: conn.goawayReceived.lastStream, code: h2ErrorName(conn.goawayReceived.code), debug: conn.goawayReceived.debug.toString('latin1').slice(0, 120) } : null,
    closed: conn.closed ? 'closed' : null,
    pingRttMs: pings,
    ...(c.upgradeHead ? { upgradeHead: c.upgradeHead } : {}),
    ...(gateBytes !== undefined ? { gateBytes } : {}),
  };
  conn.close();

  results.sort((a, b) => a.index - b.index);
  const starts = results.map((r) => r.timings.released ?? r.timings.finSent ?? r.timings.opened).filter((x): x is number => x !== undefined);
  const order = results.filter((r) => r.completedOrder !== null).sort((a, b) => a.completedOrder! - b.completedOrder!).map((r) => r.index);
  return {
    run,
    flowId,
    rows: results,
    connections: [report],
    spreadMs: starts.length ? round(Math.max(...starts) - Math.min(...starts))! : 0,
    reordered: order.some((v, i) => i > 0 && v < order[i - 1]!),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, j) => setTimeout(() => j(new Error('no response before the timeout')), ms).unref())]);
}
