import * as http from 'node:http';
import * as https from 'node:https';
import { runH3Plan } from './quic/plan.js';
import { runH2Plan } from './h2/plan.js';
import type { H2ConnectMethod } from './h2/connect.js';
import type { CaptureStore, ExchangeSummary, HeaderList } from './store.js';
import { upstreamTls } from './upstreamtls.js';

export interface ReplayRequest {
  method: string;
  url: string;
  headers: HeaderList;
  body?: Uint8Array;
  /** Exchange this replays, so the UI can show "send N of N" and diff against it. */
  replayOf?: string | null;
  /** Skip certificate checks on the target. */
  ignoreTlsErrors?: boolean;
  timeoutMs?: number;
  /** How to send: HTTP/1.1, HTTP/2 (how it negotiates in h2Method), or HTTP/3. */
  protocol?: 'h1' | 'h2' | 'h3';
  /** For protocol 'h2': ALPN, h2c upgrade or prior knowledge (default by scheme). */
  h2Method?: H2ConnectMethod;
}

/** Headers Node manages per connection; sending captured values would break the request. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

/**
 * Send one request directly to its target and record it as a `replay`
 * exchange. Header order and case are kept as given. Content-Length is
 * corrected to match the body, because edited bodies rarely keep their size.
 * Replays are always recorded, whatever the scope, since the user asked for them.
 */
export async function sendReplay(store: CaptureStore, req: ReplayRequest): Promise<ExchangeSummary> {
  if (req.protocol === 'h3') return sendH3(store, req);
  if (req.protocol === 'h2') return sendH2(store, req);
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`cannot replay ${url.protocol} URLs yet`);
  const body = req.body ?? new Uint8Array();
  const method = req.method.toUpperCase();

  const headers: HeaderList = [];
  let hasHost = false;
  for (const [k, v] of req.headers) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'content-length') continue;
    if (lower === 'host') hasHost = true;
    // HTTP/2 and HTTP/3 pseudo-headers have no HTTP/1.1 equivalent: the request line carries them.
    if (k.startsWith(':')) continue;
    headers.push([k, v]);
  }
  if (!hasHost) headers.unshift(['Host', url.host]);
  if (body.byteLength || !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(method)) headers.push(['Content-Length', String(body.byteLength)]);

  const startedAt = Date.now();
  const t0 = performance.now();
  const ex = store.addRequest({
    source: 'replay',
    startedAt,
    method,
    url: url.href,
    httpVersion: '1.1',
    headers,
    body,
    replayOf: req.replayOf ?? null,
  });

  const lib = url.protocol === 'https:' ? https : http;
  try {
    const res = await new Promise<{ status: number; message: string; headers: HeaderList; body: Buffer; headersAt: number }>((resolve, reject) => {
      const r = lib.request(
        {
          method,
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || undefined,
          path: url.pathname + url.search,
          headers: headers.flat(),
          ...upstreamTls(url.hostname.replace(/^\[|\]$/g, ''), req.ignoreTlsErrors),
          servername: url.hostname,
          agent: false,
          timeout: req.timeoutMs ?? 30_000,
        },
        (incoming) => {
          const headersAt = performance.now();
          const chunks: Buffer[] = [];
          incoming.on('data', (c: Buffer) => chunks.push(c));
          incoming.on('end', () => {
            const raw = incoming.rawHeaders;
            const list: HeaderList = [];
            for (let i = 0; i < raw.length; i += 2) list.push([raw[i]!, raw[i + 1]!]);
            resolve({ status: incoming.statusCode ?? 0, message: incoming.statusMessage ?? '', headers: list, body: Buffer.concat(chunks), headersAt });
          });
          incoming.on('error', reject);
        },
      );
      r.on('timeout', () => r.destroy(new Error(`no response after ${req.timeoutMs ?? 30_000} ms`)));
      r.on('error', reject);
      r.end(body.byteLength ? body : undefined);
    });
    const total = performance.now() - t0;
    return store.completeResponse(ex.id, {
      status: res.status,
      statusMessage: res.message,
      headers: res.headers,
      body: res.body,
      timings: { responseHeaders: round(res.headersAt - t0), total: round(total) },
    });
  } catch (err) {
    store.failExchange(ex.id, 'error', err instanceof Error ? err.message : String(err), { total: round(performance.now() - t0) });
    return store.getSummary(ex.id)!;
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** One request over HTTP/2, recorded like any other replay. */
async function sendH2(store: CaptureStore, req: ReplayRequest): Promise<ExchangeSummary> {
  const r = await runH2Plan(store, [{ method: req.method, url: req.url, headers: req.headers.filter(([k]) => k.toLowerCase() !== 'content-length'), body: req.body, replayOf: req.replayOf }], {
    connect: req.h2Method,
    ignoreTlsErrors: req.ignoreTlsErrors,
    timeoutMs: req.timeoutMs,
  });
  return store.getSummary(r.runs[0]!.rows[0]!.exchangeId)!;
}

/** One request over HTTP/3, recorded like any other replay. */
async function sendH3(store: CaptureStore, req: ReplayRequest): Promise<ExchangeSummary> {
  const r = await runH3Plan(store, [{ method: req.method, url: req.url, headers: req.headers.filter(([k]) => k.toLowerCase() !== 'content-length'), body: req.body, replayOf: req.replayOf }], {
    ignoreTlsErrors: req.ignoreTlsErrors,
    timeoutMs: req.timeoutMs,
  });
  const id = r.runs[0]!.rows[0]!.exchangeId;
  return store.getSummary(id)!;
}
