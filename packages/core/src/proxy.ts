import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { leafIssuer, type CertificateAuthority } from './ca.js';
import { Interceptor, decodeBody, type InterceptorHooks, type ProxiedRequest, type Timings as WireTimings } from './interceptor.js';
import type { HookMessage } from './rules.js';
import { globToRegExp, type Scope } from './scope.js';
import type { PlanStep, SentStep } from './wsplan.js';
import type { SeenHosts } from './seen.js';
import type { CaptureStore, ExchangeSource, ExchangeSummary, HeaderList, Timings } from './store.js';

export interface ProxyOptions {
  /** Port to listen on. 0 or undefined lets the OS pick a free port. */
  port?: number;
  /**
   * Accept connections from other machines (phones, IoT devices). When false
   * (the default) only loopback clients can connect.
   */
  allowLan?: boolean;
  /** Skip upstream certificate checks for these hosts (true for all), e.g. dev servers with self-signed certs. */
  ignoreUpstreamTlsErrors?: string[] | boolean;
  /** Recorded as the exchange source. The built-in browser gets its own listener with source "browser". */
  source?: ExchangeSource;
  /** How long a redirect waits for the client to follow it before the chain is forgotten. */
  redirectWindowMs?: number;
}

/**
 * Inline hooks for in-scope traffic whose scope rule allows modify: breakpoints,
 * match and replace, mocks and scripts. Hooks change the message in place and
 * return the names of what changed it (they become `rule:` style tags), or a
 * canned response / drop for requests.
 */
export interface ProxyHooks {
  request?(msg: HookMessage, ctx: { key: string; source: ExchangeSource }): Promise<{ applied: string[]; respond?: { status: number; statusMessage?: string; headers: HeaderList; body: Uint8Array }; drop?: boolean }>;
  response?(req: HookMessage, res: HookMessage, ctx: { key: string; source: ExchangeSource }): Promise<{ applied: string[]; drop?: boolean }>;
  /**
   * Whether the response hook needs this response. Responses it does not need
   * stream straight through (server-sent events, long downloads); the others
   * are buffered so the hook sees the whole body. Missing means always.
   */
  wantsResponse?(req: { method: string; url: string; status: number }, ctx: { key: string }): boolean;
}

interface Live {
  exchangeId: string;
  flowId: string;
  url: string;
  clientAddr: string | null;
}

/** Ask the OS for an unused port. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/**
 * A restart frees the port for a moment before re-binding it, so retry
 * briefly if something grabbed it in between, then fail with a clear message.
 */
async function startWithRetry(server: Interceptor, port: number, attempts = 5): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await server.listen(port);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || i >= attempts) {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`proxy port ${port} is in use by another program`);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * i));
    }
  }
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

const timingsFrom = (t: WireTimings): Timings => ({ requestBody: t.requestBody, responseHeaders: t.responseHeaders, total: t.total });

/**
 * The intercepting proxy. Traffic always flows through; scope only decides
 * whether TLS is decrypted and whether an exchange is written to the store.
 * Changing which hosts are decrypted needs a restart, because TLS interception
 * is configured on the listener.
 */
export class ProxyEngine extends EventEmitter<{
  exchange: [ExchangeSummary];
  response: [ExchangeSummary];
  error: [Error];
}> {
  private server?: Interceptor;
  private live = new Map<string, Live>();
  private wsStreams = new Map<string, string>();
  /** Recorded exchange id to proxy request id, for open WebSockets. */
  private wsExchanges = new Map<string, string>();
  private redirects = new Map<string, { exchangeId: string; flowId: string; expires: number }>();
  private listenPort?: number;
  private hooks?: ProxyHooks;
  /** Tags from hooks, by proxy request id, waiting for the exchange to be recorded. */
  private pendingTags = new Map<string, string[]>();

  constructor(
    private readonly store: CaptureStore,
    private readonly scope: Scope,
    private readonly ca: CertificateAuthority,
    private readonly opts: ProxyOptions = {},
    private readonly seen?: SeenHosts,
  ) {
    super();
  }

  /** Install hooks; takes effect on the next start or restart. */
  setHooks(hooks: ProxyHooks | undefined): void {
    this.hooks = hooks;
  }

  private addTags(reqId: string, tags: string[]): void {
    if (!tags.length) return;
    const live = this.live.get(reqId);
    if (live) {
      const ex = this.store.getSummary(live.exchangeId);
      if (ex) this.store.tagExchange(ex.id, [...new Set([...ex.tags, ...tags])]);
      return;
    }
    this.pendingTags.set(reqId, [...(this.pendingTags.get(reqId) ?? []), ...tags]);
  }

  private interceptorHooks(): InterceptorHooks | undefined {
    const hooks = this.hooks;
    if (!hooks) return undefined;
    const source = this.opts.source ?? 'proxy';
    const fail = (err: unknown) => this.emit('error', err instanceof Error ? err : new Error(String(err)));
    const tagsOf = (applied: string[]) => applied.map((a) => (a.includes(':') ? a : `rule:${a}`));
    const requestMsg = (req: ProxiedRequest, body: Buffer): HookMessage => ({ method: req.method, url: req.url, headers: req.headers.map(([k, v]) => [k, v]), body: new Uint8Array(body) });
    return {
      wants: (url) => {
        try {
          return this.scope.evaluate(url).modify;
        } catch {
          return false;
        }
      },
      request: hooks.request
        ? async (req, body) => {
            try {
              const msg = requestMsg(req, body);
              const before = JSON.stringify([msg.method, msg.url, msg.headers]);
              const out = await hooks.request!(msg, { key: req.id, source });
              this.addTags(req.id, tagsOf(out.applied));
              if (out.drop) return { close: true };
              if (out.respond) return { respond: out.respond };
              const changedBody = !body.equals(Buffer.from(msg.body));
              if (before === JSON.stringify([msg.method, msg.url, msg.headers]) && !changedBody) return;
              return { replace: { method: msg.method, url: msg.url, headers: msg.headers.filter(([k]) => !k.startsWith(':')), ...(changedBody ? { body: msg.body } : {}) } };
            } catch (err) {
              fail(err);
              return;
            }
          }
        : undefined,
      wantsResponse: hooks.wantsResponse ? (req, status) => hooks.wantsResponse!({ method: req.method, url: req.url, status }, { key: req.id }) : undefined,
      response: hooks.response
        ? async (req, res) => {
            try {
              const reqMsg = requestMsg(req, decodeBody(req.body, req.headers) ?? req.body);
              const msg: HookMessage = { method: req.method, url: req.url, headers: res.headers.map(([k, v]) => [k, v]), body: new Uint8Array(res.decodedBody), status: res.status, statusMessage: res.statusMessage };
              const before = JSON.stringify([msg.status, msg.statusMessage, msg.headers]);
              const out = await hooks.response!(reqMsg, msg, { key: req.id, source });
              this.addTags(req.id, tagsOf(out.applied));
              if (out.drop) return { close: true };
              const changedBody = !res.decodedBody.equals(Buffer.from(msg.body));
              if (before === JSON.stringify([msg.status, msg.statusMessage, msg.headers]) && !changedBody) return;
              return { replace: { status: msg.status ?? res.status, statusMessage: msg.statusMessage, headers: msg.headers, ...(changedBody ? { body: msg.body } : {}) } };
            } catch (err) {
              fail(err);
              return;
            }
          }
        : undefined,
    };
  }

  /** Exchange ids of recorded WebSockets the proxy is relaying right now. */
  liveWebSockets(): string[] {
    const open = new Set(this.server?.liveWebSockets() ?? []);
    return [...this.wsExchanges].filter(([, id]) => open.has(id)).map(([ex]) => ex);
  }

  /** Inject a frame plan into a live relayed WebSocket, to the server (as the client) or to the client (as the server). */
  injectWebSocket(exchangeId: string, to: 'server' | 'client', steps: PlanStep[]): Promise<SentStep[]> {
    const id = this.wsExchanges.get(exchangeId);
    if (!id || !this.server) return Promise.reject(new Error('that WebSocket is not open through the proxy'));
    return this.server.injectWebSocket(id, to, steps);
  }

  get port(): number {
    if (this.listenPort === undefined) throw new Error('proxy is not running');
    return this.listenPort;
  }

  get running(): boolean {
    return !!this.server;
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    const decrypt = this.scope.decryptHosts().map(globToRegExp);
    const ignore = this.opts.ignoreUpstreamTlsErrors ?? false;
    const ignoreHosts = Array.isArray(ignore) ? new Set(ignore.map((h) => h.toLowerCase())) : undefined;
    const server = new Interceptor({
      issuer: leafIssuer(this.ca),
      shouldDecrypt: (host) => decrypt.some((re) => re.test(host)),
      ignoreUpstreamTlsErrors: (host) => (ignoreHosts ? ignoreHosts.has(host.toLowerCase()) : ignore === true),
      // Refuse other machines before any byte is read unless LAN access is on (this covers tunnels and TLS passthrough too).
      acceptClient: this.opts.allowLan ? undefined : (socket) => LOOPBACK.test(socket.remoteAddress ?? ''),
      hooks: this.interceptorHooks(),
    });
    this.subscribe(server);
    const port = this.listenPort ?? (this.opts.port || (await freePort()));
    await startWithRetry(server, port);
    this.server = server;
    this.listenPort = server.port;
    return server.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await server.close();
    this.live.clear();
    this.wsStreams.clear();
  }

  /** Restart on the same port, picking up new TLS decryption scope. */
  async restart(): Promise<number> {
    await this.stop();
    return this.start();
  }

  private takeRedirect(clientAddr: string | null, url: string) {
    const key = `${clientAddr ?? ''} ${url}`;
    const hit = this.redirects.get(key);
    if (!hit) return undefined;
    this.redirects.delete(key);
    return hit.expires >= Date.now() ? hit : undefined;
  }

  private rememberRedirect(live: Live, location: string): void {
    let target: string;
    try {
      target = new URL(location, live.url).href;
    } catch {
      return;
    }
    const now = Date.now();
    for (const [k, v] of this.redirects) if (v.expires < now) this.redirects.delete(k);
    this.redirects.set(`${live.clientAddr ?? ''} ${target}`, {
      exchangeId: live.exchangeId,
      flowId: live.flowId,
      expires: now + (this.opts.redirectWindowMs ?? 30_000),
    });
  }

  private guard<T extends unknown[]>(fn: (...args: T) => void) {
    return (...args: T) => {
      try {
        fn(...args);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    };
  }

  private recordRequest(req: ProxiedRequest, isWebSocket: boolean): void {
    if (!this.scope.evaluate(req.url).record) {
      this.seen?.add(req.hostname, 'http');
      return;
    }
    const clientAddr = req.remoteAddress;
    // Redirect chains are keyed by the http(s) URL a client follows.
    const redirect = this.takeRedirect(clientAddr, isWebSocket ? req.url.replace(/^ws/, 'http') : req.url);
    const ex = this.store.addRequest({
      source: this.opts.source ?? 'proxy',
      clientAddr,
      startedAt: req.startTime,
      method: req.method,
      url: req.url,
      httpVersion: req.httpVersion,
      headers: req.headers,
      body: req.body,
      isWebSocket,
      flowId: redirect?.flowId,
      parentId: redirect?.exchangeId,
    });
    this.live.set(req.id, { exchangeId: ex.id, flowId: ex.flowId, url: req.url, clientAddr });
    const tags = this.pendingTags.get(req.id);
    if (tags) {
      this.pendingTags.delete(req.id);
      this.store.tagExchange(ex.id, [...new Set([...ex.tags, ...tags])]);
    }
    this.emit('exchange', ex);
  }

  private subscribe(server: Interceptor): void {
    server.on('request', this.guard((req) => this.recordRequest(req, false)));
    server.on('websocket-request', this.guard((req) => this.recordRequest(req, true)));
    server.on('error', (err) => this.emit('error', err));

    server.on(
      'response',
      this.guard((res) => {
        const live = this.live.get(res.id);
        this.pendingTags.delete(res.id);
        if (!live) return;
        this.live.delete(res.id);
        const summary = this.store.completeResponse(live.exchangeId, {
          status: res.status,
          statusMessage: res.statusMessage,
          headers: res.headers,
          body: res.body,
          timings: timingsFrom(res.timings),
        });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.find(([k]) => k.toLowerCase() === 'location')?.[1];
          if (location) this.rememberRedirect(live, location);
        }
        this.emit('response', summary);
      }),
    );

    server.on(
      'websocket-accepted',
      this.guard((res) => {
        const live = this.live.get(res.id);
        if (!live) return;
        this.live.delete(res.id);
        const summary = this.store.completeResponse(live.exchangeId, {
          status: res.status,
          statusMessage: res.statusMessage,
          headers: res.headers,
          timings: timingsFrom(res.timings),
        });
        this.wsStreams.set(res.id, this.store.openStream('websocket', live.exchangeId));
        this.wsExchanges.set(live.exchangeId, res.id);
        this.emit('response', summary);
      }),
    );

    server.on(
      'websocket-message',
      this.guard((msg) => {
        const streamId = this.wsStreams.get(msg.id);
        if (!streamId) return;
        this.store.addStreamMessage({ streamId, direction: msg.from, opcode: msg.opcode, at: msg.at, payload: msg.data, ...(msg.meta ? { meta: msg.meta } : {}) });
      }),
    );

    server.on(
      'websocket-close',
      this.guard((close) => {
        const streamId = this.wsStreams.get(close.id);
        for (const [ex, id] of this.wsExchanges) if (id === close.id) this.wsExchanges.delete(ex);
        if (!streamId) return;
        this.wsStreams.delete(close.id);
        this.store.closeStream(streamId, close.code, close.reason);
      }),
    );

    server.on(
      'abort',
      this.guard((a) => {
        this.pendingTags.delete(a.id);
        const live = this.live.get(a.id);
        if (live) {
          this.live.delete(a.id);
          this.store.failExchange(live.exchangeId, a.kind, a.message, timingsFrom(a.timings));
        }
        const streamId = this.wsStreams.get(a.id);
        if (streamId) {
          this.wsStreams.delete(a.id);
          this.store.closeStream(streamId, undefined, a.message);
        }
      }),
    );

    server.on(
      'tls-passthrough',
      this.guard((t) => this.seen?.add(t.host, 'tls')),
    );

    server.on(
      'tls-client-error',
      this.guard((f) => this.store.addTlsFailure({ host: f.host ?? undefined, clientAddr: f.remoteAddress ?? undefined, cause: f.cause })),
    );
  }
}
