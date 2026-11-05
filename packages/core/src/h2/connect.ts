/**
 * Opening HTTP/2 connections the ways a server can be asked for HTTP/2, for
 * the protocol lab, Replay and Race:
 *
 *  - alpn: TLS, offering the given ALPN list (default h2, http/1.1)
 *  - prior-knowledge: the preface straight away, over TCP or over TLS
 *    without ALPN
 *  - upgrade: an HTTP/1.1 request with Upgrade: h2c and HTTP2-Settings; on
 *    101 the request becomes stream 1
 *
 * and the ladder test, which tries each in turn and reports what the
 * server accepted.
 */
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { H2Connection, collectResponse, settingsList, type CollectedResponse, type H2ConnectionOptions, type H2Settings, type H2Stream } from './connection.js';
import { encodeFrame, serializeFrame } from './frames.js';
import { rootCertificates } from 'node:tls';
import { upstreamTls } from '../upstreamtls.js';

export type H2ConnectMethod = 'alpn' | 'prior-knowledge' | 'upgrade';

export interface H2ConnectOptions extends Omit<H2ConnectionOptions, 'role' | 'skipPreface'> {
  url: URL;
  method?: H2ConnectMethod;
  /** ALPN offer for method alpn (default ["h2", "http/1.1"]). */
  alpn?: string[];
  /** Connect here instead of the URL's host and port (the authority and SNI still come from the URL). */
  connectTo?: { host: string; port: number };
  ignoreTlsErrors?: boolean;
  ca?: string[];
  timeoutMs?: number;
  /** For upgrade: the request that carries the offer (default GET of the URL). */
  upgradeRequest?: { method: string; path: string; headers: Array<[string, string]>; body?: Uint8Array };
}

export interface H2Connected {
  conn: H2Connection;
  socket: Socket | TLSSocket;
  method: H2ConnectMethod;
  /** What ALPN picked, null when TLS carried no ALPN, undefined for cleartext. */
  alpn?: string | null;
  /** For upgrade: stream 1, the upgraded request's response. */
  upgradeStream?: H2Stream;
  /** For upgrade: the stream-1 response, collected from the moment of the upgrade (it can arrive before the caller returns). */
  upgradeResponse?: Promise<CollectedResponse>;
  /** For upgrade: the 101 response head. */
  upgradeHead?: string;
}

export class H2ConnectError extends Error {
  constructor(
    message: string,
    /** What the server did instead: the ALPN it picked, an HTTP/1.1 status line, a TLS alert. */
    readonly answer?: string,
  ) {
    super(message);
  }
}

const target = (o: H2ConnectOptions) => ({
  host: o.connectTo?.host ?? o.url.hostname.replace(/^\[|\]$/g, ''),
  port: o.connectTo?.port ?? (Number(o.url.port) || (o.url.protocol === 'https:' ? 443 : 80)),
});

function openSocket(o: H2ConnectOptions, alpn: string[] | undefined): Promise<Socket | TLSSocket> {
  const { host, port } = target(o);
  const secure = o.url.protocol === 'https:';
  const name = o.url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (s.destroy(), reject(new H2ConnectError('connect timed out'))), o.timeoutMs ?? 10_000);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    const s: Socket | TLSSocket = secure
      ? tlsConnect({
          host,
          port,
          servername: isIP(name) ? undefined : name,
          ...(alpn?.length ? { ALPNProtocols: alpn } : {}),
          ...tlsChecks(host, o),
        })
      : netConnect({ host, port });
    s.once('error', (err) => done(() => reject(new H2ConnectError(err.message, /no.application.protocol/i.test(err.message) ? 'no_application_protocol alert' : undefined))));
    s.once(secure ? 'secureConnect' : 'connect', () => done(() => resolve(s)));
  });
}

function tlsChecks(host: string, o: H2ConnectOptions) {
  const base = upstreamTls(host, !!o.ignoreTlsErrors);
  return o.ca?.length ? { ...base, ca: [...(base.ca ?? rootCertificates), ...o.ca] } : base;
}

/** Connect and start HTTP/2 the chosen way. Rejects with what the server did instead when it does not take HTTP/2. */
export async function h2Connect(o: H2ConnectOptions): Promise<H2Connected> {
  const method = o.method ?? (o.url.protocol === 'https:' ? 'alpn' : 'prior-knowledge');
  const secure = o.url.protocol === 'https:';
  if (method === 'upgrade' && secure) throw new H2ConnectError('h2c upgrade is cleartext only (RFC 9113 drops it over TLS); use an http:// URL');
  const alpn = method === 'alpn' ? (o.alpn ?? ['h2', 'http/1.1']) : undefined;
  const socket = await openSocket(o, alpn);
  const picked = secure ? ((socket as TLSSocket).alpnProtocol || null) : undefined;
  if (method === 'alpn' && picked !== 'h2') {
    socket.destroy();
    throw new H2ConnectError(`the server picked ${picked ?? 'no protocol'} by ALPN, not h2`, picked ?? 'no ALPN');
  }
  const base = { ...o, role: 'client' as const };
  if (method !== 'upgrade') {
    const conn = new H2Connection(socket, base);
    await ready(conn, o.timeoutMs ?? 10_000, 'the server did not answer the HTTP/2 preface with SETTINGS');
    return { conn, socket, method, ...(secure ? { alpn: picked } : {}) };
  }
  // h2c upgrade: our SETTINGS go base64url in HTTP2-Settings.
  const settingsPayload = encodeFrame(serializeFrame({ type: 'SETTINGS', ack: false, settings: settingsList(o.settings ?? {}) })).subarray(9);
  const r = o.upgradeRequest ?? { method: 'GET', path: o.url.pathname + o.url.search, headers: [] };
  const lines = [
    `${r.method} ${r.path} HTTP/1.1`,
    `Host: ${o.url.host}`,
    ...r.headers.filter(([k]) => !/^(host|connection|upgrade|http2-settings|content-length)$/i.test(k)).map(([k, v]) => `${k}: ${v}`),
    ...(r.body?.length ? [`Content-Length: ${r.body.length}`] : []),
    'Connection: Upgrade, HTTP2-Settings',
    'Upgrade: h2c',
    `HTTP2-Settings: ${settingsPayload.toString('base64url')}`,
  ];
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  if (r.body?.length) socket.write(r.body);
  const { head, rest } = await readHead(socket, o.timeoutMs ?? 10_000);
  const statusLine = head.split('\r\n')[0] ?? '';
  if (!/^HTTP\/1\.1 101\b/.test(statusLine)) {
    socket.destroy();
    throw new H2ConnectError(`the server answered the h2c upgrade with "${statusLine}"`, statusLine);
  }
  const conn = new H2Connection(socket, base);
  const upgradeStream = conn.adoptUpgradeStream();
  // Collect the response now: the server may answer stream 1 in the same chunk as its SETTINGS.
  const upgradeResponse = collectResponse(upgradeStream);
  if (rest.length) socket.unshift(rest);
  socket.resume();
  await ready(conn, o.timeoutMs ?? 10_000, 'the server switched protocols but sent no SETTINGS');
  return { conn, socket, method, upgradeStream, upgradeResponse, upgradeHead: head };
}

function ready(conn: H2Connection, ms: number, why: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => (conn.destroy(), reject(new H2ConnectError(why))), ms);
    conn.once('settings', () => (clearTimeout(t), resolve()));
    conn.once('close', () => (clearTimeout(t), reject(new H2ConnectError(`${why} (the connection closed)`))));
  });
}

function readHead(s: Socket, ms: number): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => fail(new H2ConnectError('no answer to the h2c upgrade')), ms);
    const fail = (e: Error) => {
      clearTimeout(t);
      s.off('data', onData);
      reject(e);
    };
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      clearTimeout(t);
      s.off('data', onData);
      s.pause();
      resolve({ head: buf.subarray(0, end).toString('latin1'), rest: buf.subarray(end + 4) });
    };
    s.on('data', onData);
    s.once('close', () => fail(new H2ConnectError('the connection closed during the h2c upgrade')));
  });
}

export interface LadderStep {
  method: string;
  ok: boolean;
  /** What the server did: the ALPN it picked, its answer to the upgrade, an error. */
  detail: string;
  ms: number;
}

/**
 * Try every way of getting HTTP/2 (and HTTP/3) from a server and report
 * which it accepted. Nothing is recorded; it only opens connections and
 * sends SETTINGS (and one GET for the upgrade step).
 */
export async function protocolLadder(url: URL, opts: { ignoreTlsErrors?: boolean; connectTo?: { host: string; port: number }; h3?: (url: URL) => Promise<{ ok: boolean; detail: string }> } = {}): Promise<LadderStep[]> {
  const out: LadderStep[] = [];
  const step = async (name: string, fn: () => Promise<string>) => {
    const t0 = Date.now();
    try {
      out.push({ method: name, ok: true, detail: await fn(), ms: Date.now() - t0 });
    } catch (e) {
      out.push({ method: name, ok: false, detail: (e as H2ConnectError).answer ? `${(e as H2ConnectError).answer}` : (e as Error).message, ms: Date.now() - t0 });
    }
  };
  const settings = (c: H2Connected) => {
    const s = [...c.conn.peerSettings].map(([k, v]) => `${k}=${v}`).join(' ');
    c.conn.close();
    return s;
  };
  const common = { ignoreTlsErrors: opts.ignoreTlsErrors, connectTo: opts.connectTo, timeoutMs: 5000 };
  if (url.protocol === 'https:') {
    await step('TLS, ALPN h2 + http/1.1', async () => {
      const s = await openSocket({ url, ...common }, ['h2', 'http/1.1']);
      const p = (s as TLSSocket).alpnProtocol;
      s.destroy();
      return `server picked ${p || 'no ALPN'}`;
    });
    await step('TLS, ALPN h2 only', async () => `h2, SETTINGS ${settings(await h2Connect({ url, method: 'alpn', alpn: ['h2'], ...common }))}`);
    await step('TLS, no ALPN, prior knowledge', async () => `h2, SETTINGS ${settings(await h2Connect({ url, method: 'prior-knowledge', ...common }))}`);
    if (opts.h3) await step('HTTP/3 (QUIC)', async () => {
      const r = await opts.h3!(url);
      if (!r.ok) throw new Error(r.detail);
      return r.detail;
    });
  } else {
    await step('h2c upgrade', async () => {
      const c = await h2Connect({ url, method: 'upgrade', ...common });
      return `101, then SETTINGS ${settings(c)}`;
    });
    await step('h2c prior knowledge', async () => `h2, SETTINGS ${settings(await h2Connect({ url, method: 'prior-knowledge', ...common }))}`);
  }
  return out;
}
