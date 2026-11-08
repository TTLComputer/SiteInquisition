/**
 * The HTTP/3 stream plan runner behind the HTTP/3 lab: many requests on one
 * QUIC connection with control over when each stream opens, what is held
 * back, what is reset, priorities, flow control, QPACK, 0-RTT and migration.
 */
import { newId } from '../ids.js';
import type { CaptureStore, HeaderList } from '../store.js';
import { errorName, frame as frameBytes, H3Error, type H3Settings, type H3Stream } from './h3.js';
import { h3Connect, requestFields, type H3Connection } from './index.js';
import type { TransportParams } from './params.js';
import type { EncoderPolicy, Field } from './qpack.js';
import type { SessionTicket } from './tls.js';
import { skipsTlsChecks, trustedPems } from '../upstreamtls.js';

export interface H3PlanRequest {
  label?: string;
  method: string;
  url: string;
  headers: HeaderList;
  body?: Uint8Array;
  replayOf?: string | null;
  /** Open the stream this many ms after the plan starts. */
  openAtMs?: number;
  /** Or wait for another row: its response headers, or its end. */
  after?: { row: number; event: 'headers' | 'end' };
  /**
   * Hold the request back once written: 'last-byte' keeps the final byte
   * of the stream (so the server cannot parse it), 'fin' sends everything
   * but the end of stream. Held rows are released at releaseAtMs, or all
   * together once every held row is open.
   */
  hold?: 'last-byte' | 'fin';
  releaseAtMs?: number;
  /** Split the body into DATA frames of this size, with a gap between them. */
  chunkSize?: number;
  chunkGapMs?: number;
  /** Reset our side of the stream after this many body bytes, or at a time. */
  resetAfterBytes?: number;
  resetAtMs?: number;
  resetCode?: number;
  /** STOP_SENDING the response after this many bytes have arrived. */
  stopSendingAfterBytes?: number;
  stopSendingCode?: number;
  /** RFC 9218 priority header value, such as "u=0, i". */
  priority?: string;
  /** PRIORITY_UPDATE frames while the stream is open. */
  priorityUpdates?: Array<{ atMs: number; value: string }>;
  /** Send this row in 0-RTT early data (needs a ticket from an earlier connection). */
  earlyData?: boolean;
  /** Extra frames written on the stream after the headers, as type and hex payload. */
  rawFrames?: Array<{ type: number; payloadHex: string }>;
}

export interface H3PlanOptions {
  /** At most this many of our streams open at once (default unlimited). */
  concurrency?: number;
  /** single-datagram: release held rows' final bytes in as few UDP datagrams as possible (usually one). */
  gate?: 'none' | 'single-datagram';
  /** Our transport parameters, e.g. small windows to apply back-pressure. */
  transport?: TransportParams;
  /** Give the server flow control credit back as we read (default true). Off = the server stalls once our windows fill. */
  autoCredit?: boolean;
  scheduler?: 'fifo' | 'round-robin';
  settings?: H3Settings;
  qpack?: EncoderPolicy;
  /** For 0-RTT rows: open this many connections with the same ticket and send the early rows on each (replay test). */
  zeroRttConnections?: number;
  /** Move to a new local port at this time. */
  migrateAtMs?: number;
  migrateNewCid?: boolean;
  /** Start a TLS key update at this time. */
  keyUpdateAtMs?: number;
  /** Close the connection with this error at a time, e.g. to test abandonment. */
  closeAtMs?: number;
  ignoreTlsErrors?: boolean;
  timeoutMs?: number;
  /** Connect here instead of the URL's host (the :authority and SNI still come from the URL). */
  connectTo?: { host: string; port: number };
  ca?: string[];
  repeat?: number;
  /** After the plan resets a stream, wait this long for a response anyway (default 500 ms). */
  resetGraceMs?: number;
}

export interface H3RowResult {
  index: number;
  label: string;
  exchangeId: string;
  connection: number;
  streamId: number | null;
  status: number | null;
  bodyBytes: number;
  error?: string;
  resetByServer?: string;
  early: boolean;
  /** ms after the plan started. */
  timings: { opened?: number; headersSent?: number; released?: number; finSent?: number; resetSent?: number; firstByte?: number; headersReceived?: number; complete?: number; resetReceived?: number };
  /** Position in the order responses completed (0 = first). */
  completedOrder: number | null;
}

export interface H3ConnectionReport {
  index: number;
  alpn: string | null;
  resumed: boolean;
  earlyDataAccepted: boolean | null;
  rttMs: number;
  localPorts: number[];
  serverSettings: Record<string, number>;
  qpack: { encoder: object; decoder: object };
  packets: Array<{ t: number; dir: 'in' | 'out'; type: string; pn: number; size: number; frames: string[] }>;
  control: Array<{ t: number; dir: 'in' | 'out'; type: number; detail: string }>;
  closed: string | null;
  /** Datagrams that carried the released bytes when the gate opened. */
  gateDatagrams?: number;
}

export interface H3PlanRun {
  run: number;
  flowId: string;
  rows: H3RowResult[];
  connections: H3ConnectionReport[];
  /** Spread between the first and last release (or open) of the rows. */
  spreadMs: number;
  /** Completion order differs from row order. */
  reordered: boolean;
}

export interface H3PlanResult {
  id: string;
  runs: H3PlanRun[];
}

/** Session tickets per origin, so later runs can use 0-RTT. */
const tickets = new Map<string, SessionTicket>();
export const h3Tickets = {
  get: (origin: string) => tickets.get(origin),
  clear: () => tickets.clear(),
  list: () => [...tickets.entries()].map(([origin, t]) => ({ origin, receivedAt: t.receivedAt, maxEarlyData: t.maxEarlyData, lifetimeSec: t.lifetimeSec })),
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const now = () => performance.now();
const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 1000) / 1000);

function encodeStream(s: H3Stream, fields: Field[], body: Uint8Array, row: H3PlanRequest): Buffer[] {
  // The exact bytes of the stream, so they can be held back or split.
  const parts: Buffer[] = [];
  const block = s.session.encoder.encode(s.id, fields);
  parts.push(frameBytes(0x1, block));
  for (const f of row.rawFrames ?? []) parts.push(frameBytes(f.type, Buffer.from(f.payloadHex, 'hex')));
  const size = row.chunkSize && row.chunkSize > 0 ? row.chunkSize : body.length || 1;
  for (let off = 0; off < body.length; off += size) parts.push(frameBytes(0x0, body.subarray(off, off + size)));
  return parts;
}


export async function runH3Plan(store: CaptureStore, rows: H3PlanRequest[], opts: H3PlanOptions = {}): Promise<H3PlanResult> {
  if (!rows.length) throw new Error('a plan needs at least one request');
  if (rows.length > 200) throw new Error('a plan can have at most 200 requests');
  const urls = rows.map((r) => new URL(r.url));
  for (const u of urls) {
    if (u.protocol !== 'https:') throw new Error(`HTTP/3 needs https URLs (${u.href})`);
    if (u.host !== urls[0]!.host) throw new Error('every request in a plan must go to the same host and port (one QUIC connection)');
  }
  rows.forEach((r, i) => {
    if (r.after && (r.after.row < 0 || r.after.row >= rows.length || r.after.row === i)) throw new Error(`row ${i + 1} waits for a row that does not exist`);
  });
  const id = newId();
  const runs: H3PlanRun[] = [];
  const repeat = Math.max(1, Math.min(opts.repeat ?? 1, 20));
  for (let run = 0; run < repeat; run++) runs.push(await runOnce(store, rows, opts, id, run));
  return { id, runs };
}

async function runOnce(store: CaptureStore, rows: H3PlanRequest[], opts: H3PlanOptions, planId: string, run: number): Promise<H3PlanRun> {
  const url0 = new URL(rows[0]!.url);
  const origin = url0.origin;
  const host = opts.connectTo?.host ?? url0.hostname.replace(/^\[|\]$/g, '');
  const port = opts.connectTo?.port ?? (Number(url0.port) || 443);
  const flowId = store.createFlow('h3-plan');
  const tag = `h3plan:${planId}`;
  const timeout = opts.timeoutMs ?? 30_000;
  const wantsEarly = rows.some((r) => r.earlyData);

  const connect = async (early: boolean, replayTicket?: SessionTicket): Promise<H3Connection> => {
    const ticket = early ? (replayTicket ?? tickets.get(origin)) : undefined;
    const c = await h3Connect({
      host,
      port,
      serverName: url0.hostname,
      ca: [...(opts.ca ?? []), ...trustedPems()],
      rejectUnauthorized: !(opts.ignoreTlsErrors || skipsTlsChecks(host)),
      params: opts.transport,
      autoCredit: opts.autoCredit,
      scheduler: opts.scheduler,
      settings: opts.settings,
      qpack: opts.qpack,
      session: ticket,
      earlyData: early && !!ticket,
      handshakeTimeoutMs: Math.min(timeout, 10_000),
    });
    c.client.conn.ev.ticket = (t) => {
      c.tickets.push(t);
      tickets.set(origin, t);
    };
    return c;
  };

  // 0-RTT needs a ticket: warm up with a plain connection when we have none.
  if (wantsEarly && !tickets.get(origin)) {
    const warm = await connect(false);
    for (let i = 0; i < 20 && !warm.tickets.length; i++) await sleep(25);
    warm.close();
    if (!warm.tickets.length) throw new Error('the server sent no session ticket, so 0-RTT cannot be tried');
  }

  const connCount = wantsEarly ? Math.max(1, Math.min(opts.zeroRttConnections ?? 1, 10)) : 1;
  // Every 0-RTT connection replays the same ticket: a connection that finishes
  // its handshake hands out a new one, which must not change what the next uses.
  const replayTicket = wantsEarly ? tickets.get(origin) : undefined;
  const conns: H3Connection[] = [await connect(wantsEarly, replayTicket)];
  const ports: number[][] = [[conns[0]!.client.localPort]];

  const results: H3RowResult[] = [];
  const exchanges = new Map<string, number>();
  let completed = 0;
  const t0 = now();
  const rel = (t: number | undefined) => (t === undefined ? undefined : round(t - t0));
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

  // Concurrency slots.
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

  // Hold and release. Rows released at the same moment form a group: the
  // untimed group opens once every member is held, a timed one at its time.
  const gateMembers = rows.reduce((n, r) => n + (r.hold && r.releaseAtMs === undefined ? (r.earlyData ? connCount : 1) : 0), 0);
  const groups = new Map<string, Array<{ conn: H3Connection; write: () => void }>>();
  let gateDatagrams: number | undefined;
  const flushGroup = (key: string) => {
    const members = groups.get(key) ?? [];
    groups.delete(key);
    const byConn = new Map<H3Connection, Array<() => void>>();
    for (const m of members) byConn.set(m.conn, [...(byConn.get(m.conn) ?? []), m.write]);
    for (const [c, writes] of byConn) {
      const conn = c.client.conn;
      const before = conn.datagramsSent;
      if (opts.gate === 'single-datagram') conn.cork();
      for (const w of writes) w();
      if (opts.gate === 'single-datagram') {
        conn.uncork();
        if (c === conns[0] && gateDatagrams === undefined) gateDatagrams = conn.datagramsSent - before;
      }
    }
  };
  const holdFor = (key: string, conn: H3Connection, write: () => void, atMs?: number) => {
    const list = groups.get(key) ?? [];
    list.push({ conn, write });
    groups.set(key, list);
    if (key === 'gate' && list.length >= gateMembers) flushGroup(key);
    if (atMs !== undefined && list.length === 1) at(atMs - (now() - t0), () => flushGroup(key));
  };

  // Timed connection actions.
  const timers: NodeJS.Timeout[] = [];
  const at = (ms: number | undefined, fn: () => void) => {
    if (ms === undefined) return;
    timers.push(setTimeout(fn, Math.max(0, ms)));
  };
  at(opts.migrateAtMs, () => {
    for (const [i, c] of conns.entries()) void c.client.rebind(opts.migrateNewCid !== false).then(({ to }) => ports[i]!.push(to));
  });
  at(opts.keyUpdateAtMs, () => conns.forEach((c) => c.client.conn.updateKeys()));
  at(opts.closeAtMs, () => conns.forEach((c) => c.session.close(H3Error.NO_ERROR, 'closed by plan')));

  const runRow = async (row: H3PlanRequest, index: number, ci: number): Promise<void> => {
    const c = conns[ci]!;
    const url = new URL(row.url);
    const early = !!row.earlyData && c.client.conn.earlyDataAvailable;
    const headers: HeaderList = row.priority ? [...row.headers.filter(([k]) => k.toLowerCase() !== 'priority'), ['priority', row.priority]] : row.headers;
    const fields = requestFields(row.method, url, headers);
    const body = row.body ?? new Uint8Array();
    const ex = store.addRequest({ source: 'replay', startedAt: Date.now(), method: row.method.toUpperCase(), url: url.href, httpVersion: '3', headers: fields, body, replayOf: row.replayOf ?? null, flowId, tags: [tag, ...(early ? ['0-rtt'] : []), ...(connCount > 1 ? [`conn:${ci + 1}`] : [])] });
    exchanges.set(ex.id, index);
    const result: H3RowResult = { index, label: row.label ?? `${row.method} ${url.pathname}`, exchangeId: ex.id, connection: ci, streamId: null, status: null, bodyBytes: 0, early, timings: {}, completedOrder: null };
    results.push(result);

    if (row.after) await waitFor(`${ci}:${row.after.row}:${row.after.event}`);
    if (row.openAtMs) await sleep(t0 + row.openAtMs - now());
    if (!row.earlyData && c.client.conn.state === 'handshaking') await c.client.ready;
    await acquire();
    let slotHeld = true;
    const done = () => {
      if (slotHeld) releaseSlot();
      slotHeld = false;
    };
    try {
      let s = c.session.openRequest();
      for (let tries = 0; !s && tries < 400; tries++) {
        // The server's stream limit: wait for MAX_STREAMS.
        await sleep(5);
        s = c.session.openRequest();
      }
      if (!s) throw new Error('the server stream limit stayed full');
      result.streamId = s.id;
      result.timings.opened = rel(now());
      s.once('headers', () => {
        result.timings.headersReceived = rel(now());
        fire(`${ci}:${index}:headers`);
      });
      let received = 0;
      s.on('data', (d: Buffer) => {
        received += d.length;
        if (row.stopSendingAfterBytes !== undefined && received >= row.stopSendingAfterBytes && s!.stopSendingCode === null) {
          s!.stopSending(row.stopSendingCode ?? H3Error.REQUEST_CANCELLED);
        }
      });
      for (const u of row.priorityUpdates ?? []) at(u.atMs - (now() - t0), () => c.session.priorityUpdate(s!.id, u.value));
      // After we reset, the server may never answer: give it a moment, then stop waiting.
      let onReset!: () => void;
      const resetGrace = new Promise<never>((_, j) => {
        onReset = () => setTimeout(() => j(new Error('reset by the plan; no response followed')), opts.resetGraceMs ?? 500).unref();
      });
      resetGrace.catch(() => undefined);
      const resetNow = () => {
        s!.reset(row.resetCode ?? H3Error.REQUEST_CANCELLED);
        result.timings.resetSent = rel(now());
        onReset();
      };
      at(row.resetAtMs === undefined ? undefined : row.resetAtMs - (now() - t0), resetNow);

      const parts = encodeStream(s, fields, body, row);
      const all = Buffer.concat(parts);
      result.timings.headersSent = rel(now());
      const resetAt = row.resetAfterBytes;
      // Bytes after the HEADERS frame that count as body for resetAfterBytes.
      const headerLen = parts[0]!.length;
      const write = async () => {
        if (row.chunkGapMs && parts.length > 2) {
          for (let i = 0; i < parts.length; i++) {
            const last = i === parts.length - 1;
            if (resetAt !== undefined && Buffer.concat(parts.slice(0, i + 1)).length - headerLen > resetAt) break;
            if (last && row.hold) return holdTail(parts[i]!);
            s!.writeRaw(parts[i]!, last);
            if (!last) await sleep(row.chunkGapMs);
          }
        } else {
          if (resetAt !== undefined) return s!.writeRaw(all.subarray(0, headerLen + resetAt));
          if (row.hold) return holdTail(all);
          s!.writeRaw(all, true);
        }
        result.timings.finSent = rel(now());
      };
      const holdTail = (bytes: Buffer) => {
        const keep = row.hold === 'last-byte' ? 1 : 0;
        if (bytes.length > keep) s!.writeRaw(bytes.subarray(0, bytes.length - keep));
        const tail = bytes.subarray(bytes.length - keep);
        const release = () => {
          if (s!.resetCode !== null || c.client.conn.state !== 'connected' && !c.client.conn.earlyDataAvailable) return;
          s!.writeRaw(tail, true);
          result.timings.released = rel(now());
          result.timings.finSent = result.timings.released;
        };
        if (row.releaseAtMs !== undefined) holdFor(`t:${row.releaseAtMs}`, c, release, row.releaseAtMs);
        else holdFor('gate', c, release);
      };
      await write();
      if (resetAt !== undefined) resetNow();

      const res = await Promise.race([
        s.response(),
        resetGrace,
        new Promise<never>((_, j) => setTimeout(() => j(new Error('no response before the timeout')), timeout).unref()),
      ]);
      result.status = res.status;
      result.bodyBytes = res.body.length;
      result.timings.complete = rel(now());
      result.completedOrder = completed++;
      store.completeResponse(ex.id, { status: res.status, headers: res.headers, body: res.body, timings: { total: round(now() - t0 - (result.timings.opened ?? 0)) } });
    } catch (e) {
      const s = result.streamId !== null ? c.session.streams.get(result.streamId) : undefined;
      if (s?.resetCode != null) result.resetByServer = errorName(s.resetCode);
      result.timings.resetReceived = rel(s?.timings.resetReceived);
      result.error = (e as Error).message;
      result.bodyBytes = s?.bodyLength ?? 0;
      result.timings.firstByte = rel(s?.timings.firstByte);
      store.failExchange(ex.id, 'error', result.error, { total: round(now() - t0 - (result.timings.opened ?? 0)) });
    } finally {
      const s = result.streamId !== null ? c.session.streams.get(result.streamId) : undefined;
      result.timings.firstByte ??= rel(s?.timings.firstByte);
      fire(`${ci}:${index}:end`);
      fire(`${ci}:${index}:headers`);
      done();
    }
  };

  try {
    const tasks: Array<Promise<void>> = [];
    for (let ci = 0; ci < connCount; ci++) {
      // Open each further 0-RTT connection only when its rows go out: its early
      // data has to be written in the same tick, before the handshake can finish
      // and turn the "early" request into an ordinary 1-RTT one.
      if (ci > 0) {
        const c = await connect(true, replayTicket);
        conns.push(c);
        ports.push([c.client.localPort]);
      }
      // With several 0-RTT connections only the early rows repeat on the extra ones.
      rows.forEach((r, i) => {
        if (ci === 0 || r.earlyData) tasks.push(runRow(r, i, ci));
      });
    }
    await Promise.all(tasks);
  } finally {
    timers.forEach(clearTimeout);
    await sleep(20);
  }

  const reports: H3ConnectionReport[] = conns.map((c, i) => {
    const conn = c.client.conn;
    return {
      index: i,
      alpn: conn.tls.alpn,
      resumed: conn.tls.resumed,
      earlyDataAccepted: conn.tls.earlyDataAccepted,
      rttMs: round(conn.rtt.smoothed)!,
      localPorts: ports[i]!,
      serverSettings: Object.fromEntries([...(c.session.peerSettings ?? new Map())].map(([k, v]) => [`0x${k.toString(16)}`, v])),
      qpack: { encoder: c.session.encoder.stats, decoder: c.session.decoder.stats },
      packets: conn.log.slice(-1500).map((e) => ({ ...e, t: round(e.t - t0)! })),
      control: c.session.controlLog.map((e) => ({ ...e, t: round(e.t - t0)! })),
      closed: conn.closeReason ? `${conn.closeReason.remote ? 'server' : 'client'}: ${conn.closeReason.reason || errorName(conn.closeReason.code)}` : null,
      gateDatagrams: i === 0 ? gateDatagrams : undefined,
    };
  });
  for (const c of conns) c.close();

  results.sort((a, b) => a.connection - b.connection || a.index - b.index);
  const starts = results.map((r) => r.timings.released ?? r.timings.finSent ?? r.timings.opened).filter((x): x is number => x !== undefined);
  const order = results.filter((r) => r.completedOrder !== null && r.connection === 0).sort((a, b) => a.completedOrder! - b.completedOrder!).map((r) => r.index);
  return {
    run,
    flowId,
    rows: results,
    connections: reports,
    spreadMs: starts.length ? round(Math.max(...starts) - Math.min(...starts))! : 0,
    reordered: order.some((v, i) => i > 0 && v < order[i - 1]!),
  };
}

