/**
 * HTTP/3 capture: a UDP listener that terminates QUIC from a client (the
 * built-in browser), records each request the way the TCP interceptor does,
 * and forwards it upstream over HTTP/3, falling back to HTTPS over TCP when
 * the origin does not answer on UDP.
 */
import { EventEmitter } from 'node:events';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { decodeBody, type HeaderPairs, type InterceptorEvents, type InterceptorHooks, type ProxiedRequest, type Timings } from '../interceptor.js';
import type { LeafIssuer } from '../x509.js';
import { H3Server, h3Connect, requestFields, type H3Connection, type H3ServerRequest } from './index.js';
import type { Field } from './qpack.js';

export interface H3CaptureOptions {
  issuer: LeafIssuer;
  /** The CA certificate (PEM), sent after each leaf so clients can build the chain. */
  caCert: string;
  ignoreUpstreamTlsErrors(host: string): boolean;
  hooks?: InterceptorHooks;
  /** How long to wait for an upstream QUIC handshake before falling back to TCP (default 3 s). */
  upstreamH3TimeoutMs?: number;
  /** 'auto' tries HTTP/3 and falls back to HTTPS; 'tcp' always uses HTTPS. */
  upstream?: 'auto' | 'h3' | 'tcp';
  /** Drop datagrams from other machines (default true). */
  loopbackOnly?: boolean;
  /** Decide per client address instead of loopbackOnly. */
  acceptClient?(address: string): boolean;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'http2-settings', 'alt-svc']);
const clean = (h: HeaderPairs) => h.filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase()) && !k.startsWith(':'));
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
/** Origins that did not answer over QUIC stay on TCP for this long. */
const TCP_ONLY_MS = 5 * 60_000;

function splitAuthority(authority: string): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority) ?? /^([^:]+)(?::(\d+))?$/.exec(authority);
  if (!m) throw new Error(`bad :authority ${authority}`);
  return { host: m[1]!.toLowerCase(), port: m[2] ? Number(m[2]) : 443 };
}

export class H3Capture extends EventEmitter<InterceptorEvents> {
  readonly server: H3Server;
  private seq = 0;
  private pool = new Map<string, Promise<H3Connection>>();
  private tcpOnly = new Map<string, number>();

  constructor(private readonly opts: H3CaptureOptions) {
    super();
    this.server = new H3Server(
      {
        cert: (sni) => {
          const leaf = opts.issuer.issue(sni || 'localhost');
          return { cert: leaf.cert + opts.caCert, key: leaf.key };
        },
      },
      (req) => void this.onRequest(req).catch((err) => this.emit('error', err instanceof Error ? err : new Error(String(err)))),
    );
    const accept = opts.acceptClient ?? (opts.loopbackOnly !== false ? (a: string) => LOOPBACK.test(a) : undefined);
    if (accept) {
      this.server.quic.on('connection', (conn) => {
        if (!accept(conn.path.address)) conn.close(0x2, 'client not allowed');
      });
    }
  }

  get port(): number {
    return this.server.quic.socket.address().port;
  }

  listen(port: number, host = '127.0.0.1') {
    return this.server.listen(port, host);
  }

  async close(): Promise<void> {
    for (const p of this.pool.values()) void p.then((c) => c.close()).catch(() => undefined);
    this.pool.clear();
    await this.server.close();
  }

  private async onRequest(req: H3ServerRequest): Promise<void> {
    const startTime = Date.now();
    const t0 = performance.now();
    const rel = () => Math.round((performance.now() - t0) * 1000) / 1000;
    const timings: Timings = {};
    const id = `q${++this.seq}`;
    let finished = false;
    const abort = (kind: 'aborted' | 'error', message: string) => {
      if (finished) return;
      finished = true;
      timings.total = rel();
      this.emit('abort', { id, kind, message, timings });
    };

    const { host, port } = splitAuthority(req.authority);
    const url = new URL(`https://${req.authority}${req.path.startsWith('/') ? req.path : `/${req.path}`}`);
    const body = await req.body();
    if (req.stream.resetCode !== null) return;
    timings.requestBody = rel();
    const preq: ProxiedRequest = {
      id,
      method: req.method,
      url: url.href,
      httpVersion: '3',
      headers: req.headers.map(([k, v]) => [k, v]),
      body,
      remoteAddress: req.connection.path.address,
      startTime,
      hostname: host,
    };
    this.emit('request', preq);
    req.stream.once('reset', () => abort('aborted', 'stream reset by the client'));
    req.session.once('closed', () => abort('aborted', 'connection closed'));

    const hooks = this.opts.hooks?.wants(preq.url) ? this.opts.hooks : undefined;
    let method = preq.method;
    let outUrl = url;
    let headers = clean(preq.headers);
    let outBody = body;

    const reply = (status: number, hdrs: HeaderPairs, data: Buffer) => {
      if (finished) return;
      const out = clean(hdrs).filter(([k]) => k.toLowerCase() !== 'content-length');
      const hasBody = method !== 'HEAD' && status !== 204 && status !== 304;
      if (hasBody) out.push(['content-length', String(data.length)]);
      else {
        const len = hdrs.find(([k]) => k.toLowerCase() === 'content-length');
        if (len) out.push(['content-length', len[1]]);
      }
      const lower: Field[] = out.map(([k, v]) => [k.toLowerCase(), v]);
      req.respond(status, lower, hasBody ? data : undefined);
      timings.responseHeaders = rel();
      finished = true;
      timings.total = rel();
      this.emit('response', { id, status, headers: lower, body: hasBody ? data : Buffer.alloc(0), timings });
    };
    const closeByRule = () => {
      finished = true;
      timings.total = rel();
      this.emit('abort', { id, kind: 'aborted', message: 'closed by a rule', timings });
      req.stream.reset(0x10c);
    };

    if (hooks?.request) {
      try {
        const action = await hooks.request(preq, decodeBody(body, preq.headers) ?? body);
        if (action && 'close' in action) return closeByRule();
        if (action && 'respond' in action) return reply(action.respond.status, action.respond.headers, Buffer.from(action.respond.body));
        if (action && 'replace' in action) {
          method = action.replace.method;
          outUrl = new URL(action.replace.url);
          headers = clean(action.replace.headers);
          if (action.replace.body) {
            outBody = Buffer.from(action.replace.body);
            headers = headers.filter(([k]) => k.toLowerCase() !== 'content-encoding' && k.toLowerCase() !== 'content-length');
          }
        }
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }

    const target = outUrl.host === url.host ? { host, port } : { host: outUrl.hostname.replace(/^\[|\]$/g, ''), port: Number(outUrl.port) || 443 };
    let up: { status: number; headers: HeaderPairs; body: Buffer };
    try {
      up = await this.forward(target, method, outUrl, headers, outBody);
    } catch (err) {
      if (finished) return;
      const message = (err as Error).message;
      req.respond(502, [['content-type', 'text/plain']], `SiteInquisition could not reach ${target.host}:${target.port}: ${message}`);
      return abort('error', message);
    }
    if (finished) return;

    let { status, headers: upHeaders, body: data } = up;
    if (hooks?.response && (hooks.wantsResponse?.(preq, status) ?? true)) {
      try {
        const action = await hooks.response(preq, { status, headers: upHeaders, decodedBody: decodeBody(data, upHeaders) ?? data });
        if (action && 'close' in action) return closeByRule();
        if (action && 'replace' in action) {
          status = action.replace.status;
          upHeaders = action.replace.headers;
          if (action.replace.body) {
            data = Buffer.from(action.replace.body);
            upHeaders = upHeaders.filter(([k]) => k.toLowerCase() !== 'content-encoding');
          }
        }
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }
    reply(status, upHeaders, data);
  }

  /** Send upstream over HTTP/3 when the origin speaks it, otherwise HTTPS over TCP. */
  private async forward(target: { host: string; port: number }, method: string, url: URL, headers: HeaderPairs, body: Buffer) {
    const key = `${target.host}:${target.port}`;
    const mode = this.opts.upstream ?? 'auto';
    const tcpUntil = this.tcpOnly.get(key) ?? 0;
    if (mode !== 'tcp' && tcpUntil < Date.now()) {
      let conn: H3Connection | undefined;
      try {
        conn = await this.connection(target);
      } catch (err) {
        if (mode === 'h3') throw err;
        this.tcpOnly.set(key, Date.now() + TCP_ONLY_MS);
      }
      if (conn) {
        const fields = requestFields(method, url, headers.filter(([k]) => k.toLowerCase() !== 'content-length'));
        if (body.length) fields.push(['content-length', String(body.length)]);
        const stream = conn.session.request(fields, body.length ? body : undefined);
        if (stream) {
          const r = await stream.response();
          return { status: r.status, headers: r.headers, body: r.body };
        }
        // Out of streams on the pooled connection: start over on a new one next time.
        this.pool.delete(key);
        conn.close();
      }
    }
    return this.forwardTcp(target, method, url, headers, body);
  }

  private connection(target: { host: string; port: number }): Promise<H3Connection> {
    const key = `${target.host}:${target.port}`;
    let p = this.pool.get(key);
    if (!p) {
      p = h3Connect({
        host: target.host,
        port: target.port,
        serverName: isIP(target.host) ? undefined : target.host,
        rejectUnauthorized: !this.opts.ignoreUpstreamTlsErrors(target.host),
        handshakeTimeoutMs: this.opts.upstreamH3TimeoutMs ?? 3000,
      });
      this.pool.set(key, p);
      p.then(
        (c) => c.session.once('closed', () => this.pool.get(key) === p && this.pool.delete(key)),
        () => this.pool.get(key) === p && this.pool.delete(key),
      );
    }
    return p;
  }

  private forwardTcp(target: { host: string; port: number }, method: string, url: URL, headers: HeaderPairs, body: Buffer) {
    const out = headers.filter(([k]) => !['host', 'content-length'].includes(k.toLowerCase()));
    out.unshift(['host', url.host]);
    if (body.length || !['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(method)) out.push(['content-length', String(body.length)]);
    const insecure = this.opts.ignoreUpstreamTlsErrors(target.host);
    return new Promise<{ status: number; headers: HeaderPairs; body: Buffer }>((resolve, reject) => {
      const r = httpsRequest(
        {
          host: target.host,
          port: target.port,
          method,
          path: url.pathname + url.search,
          headers: out.flat() as unknown as Record<string, string>,
          setHost: false,
          servername: isIP(target.host) ? undefined : target.host,
          rejectUnauthorized: !insecure,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d: Buffer) => chunks.push(d));
          res.on('end', () => {
            const h: HeaderPairs = [];
            for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) h.push([res.rawHeaders[i]!.toLowerCase(), res.rawHeaders[i + 1]!]);
            resolve({ status: res.statusCode ?? 502, headers: h, body: Buffer.concat(chunks) });
          });
          res.on('error', reject);
        },
      );
      r.on('error', reject);
      r.end(body);
    });
  }
}
