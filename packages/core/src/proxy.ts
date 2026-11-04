import { EventEmitter } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import * as mockttp from 'mockttp';
import type { CertificateAuthority } from './ca.js';
import type { HookMessage } from './rules.js';
import type { Scope } from './scope.js';
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
}

const toHeaderObject = (list: HeaderList): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of list) {
    const cur = out[k];
    out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
};

interface Live {
  exchangeId: string;
  flowId: string;
  url: string;
  clientAddr: string | null;
}

/** Ask the OS for an unused port (mockttp's own default scans upwards from 8000, which collides easily). */
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
async function startWithRetry(server: mockttp.Mockttp, port: number, attempts = 5): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await server.start(port);
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

const pairs = (raw: Array<[string, string]> | undefined): HeaderList => (raw ?? []).map(([k, v]) => [k, v]);

const timingsFrom = (t: mockttp.TimingEvents): Timings => {
  const rel = (ts?: number) => (ts === undefined ? undefined : Math.round((ts - t.startTimestamp) * 1000) / 1000);
  return {
    requestBody: rel(t.bodyReceivedTimestamp),
    responseHeaders: rel(t.headersSentTimestamp),
    total: rel(t.responseSentTimestamp ?? t.wsAcceptedTimestamp),
  };
};

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
  private server?: mockttp.Mockttp;
  private live = new Map<string, Live>();
  private wsStreams = new Map<string, string>();
  private redirects = new Map<string, { exchangeId: string; flowId: string; expires: number }>();
  private listenPort?: number;
  private hooks?: ProxyHooks;
  /** Tags from hooks, by mockttp request id, waiting for the exchange to be recorded. */
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

  private passthroughHooks() {
    const hooks = this.hooks;
    if (!hooks) return {};
    const source = this.opts.source ?? 'proxy';
    const modifiable = (url: string) => {
      try {
        return this.scope.evaluate(url).modify;
      } catch {
        return false;
      }
    };
    const requestMsg = async (req: mockttp.CompletedRequest): Promise<HookMessage> => ({
      method: req.method,
      url: req.url,
      headers: pairs(req.rawHeaders),
      body: new Uint8Array((await req.body.getDecodedBuffer()) ?? req.body.buffer),
    });
    return {
      beforeRequest: hooks.request
        ? async (req: mockttp.CompletedRequest): Promise<mockttp.requestSteps.CallbackRequestResult | void> => {
            if (!modifiable(req.url)) return;
            try {
              const msg = await requestMsg(req);
              const before = JSON.stringify([msg.method, msg.url, msg.headers]);
              const beforeBody = Buffer.from(msg.body);
              const out = await hooks.request!(msg, { key: req.id, source });
              this.addTags(req.id, out.applied.map((a) => (a.includes(':') ? a : `rule:${a}`)));
              if (out.drop) return { response: 'close' };
              if (out.respond) {
                return { response: { statusCode: out.respond.status, statusMessage: out.respond.statusMessage, headers: toHeaderObject(out.respond.headers), rawBody: out.respond.body } };
              }
              const changedHead = before !== JSON.stringify([msg.method, msg.url, msg.headers]);
              const changedBody = !beforeBody.equals(Buffer.from(msg.body));
              if (!changedHead && !changedBody) return;
              return {
                method: msg.method,
                url: msg.url,
                // With a new body mockttp sets the length itself; a stale Content-Length makes the upstream reject it.
                headers: toHeaderObject(msg.headers.filter(([k]) => !k.startsWith(':') && !(changedBody && /^(content-length|transfer-encoding)$/i.test(k)))),
                ...(changedBody ? { body: msg.body } : {}),
              };
            } catch (err) {
              this.emit('error', err instanceof Error ? err : new Error(String(err)));
              return;
            }
          }
        : undefined,
      beforeResponse: hooks.response
        ? async (res: mockttp.requestSteps.PassThroughResponse, req: mockttp.CompletedRequest): Promise<mockttp.requestSteps.CallbackResponseResult | void> => {
            if (!modifiable(req.url)) return;
            try {
              const reqMsg = await requestMsg(req);
              const msg: HookMessage = {
                method: req.method,
                url: req.url,
                headers: pairs(res.rawHeaders),
                body: new Uint8Array((await res.body.getDecodedBuffer()) ?? res.body.buffer),
                status: res.statusCode,
                statusMessage: res.statusMessage,
              };
              const before = JSON.stringify([msg.status, msg.statusMessage, msg.headers]);
              const beforeBody = Buffer.from(msg.body);
              const out = await hooks.response!(reqMsg, msg, { key: req.id, source });
              this.addTags(req.id, out.applied.map((a) => (a.includes(':') ? a : `rule:${a}`)));
              if (out.drop) return 'close';
              const changedBody = !beforeBody.equals(Buffer.from(msg.body));
              if (before === JSON.stringify([msg.status, msg.statusMessage, msg.headers]) && !changedBody) return;
              return { statusCode: msg.status, statusMessage: msg.statusMessage, headers: toHeaderObject(changedBody ? msg.headers.filter(([k]) => !/^(content-length|transfer-encoding)$/i.test(k)) : msg.headers), ...(changedBody ? { body: msg.body } : {}) };
            } catch (err) {
              this.emit('error', err instanceof Error ? err : new Error(String(err)));
              return;
            }
          }
        : undefined,
    };
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
    const server = mockttp.getLocal({
      https: { cert: this.ca.cert, key: this.ca.key, tlsInterceptOnly: this.scope.decryptHosts().map((hostname) => ({ hostname })) },
      http2: 'fallback',
      socks: true,
      recordTraffic: false,
      cors: false,
    });
    const passthrough = { ignoreHostHttpsErrors: this.opts.ignoreUpstreamTlsErrors ?? false };
    await server.forAnyRequest().thenPassThrough({ ...passthrough, ...this.passthroughHooks() });
    await server.forAnyWebSocket().thenPassThrough(passthrough);
    await this.subscribe(server);
    const port = this.listenPort ?? (this.opts.port || (await freePort()));
    await startWithRetry(server, port);
    this.restrictClients(server);
    this.server = server;
    this.listenPort = server.port;
    return server.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await server.stop();
    this.live.clear();
    this.wsStreams.clear();
  }

  /** Restart on the same port, picking up new TLS decryption scope. */
  async restart(): Promise<number> {
    await this.stop();
    return this.start();
  }

  private restrictClients(server: mockttp.Mockttp): void {
    if (this.opts.allowLan) return;
    // mockttp listens on every interface and has no bind option, so drop
    // non-loopback sockets before any byte is read (this covers CONNECT
    // tunnels and TLS passthrough too, which never reach request rules).
    const net = (server as unknown as { server?: Server }).server;
    if (!net) throw new Error('cannot restrict proxy clients: mockttp internals changed');
    net.prependListener('connection', (socket: Socket) => {
      if (!LOOPBACK.test(socket.remoteAddress ?? '')) socket.destroy();
    });
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

  private recordRequest(req: mockttp.CompletedRequest, isWebSocket: boolean): void {
    const url = isWebSocket ? req.url.replace(/^http/, 'ws') : req.url;
    if (!this.scope.evaluate(url).record) {
      this.seen?.add(req.destination?.hostname ?? new URL(req.url).hostname, 'http');
      return;
    }
    const clientAddr = req.remoteIpAddress ?? null;
    const redirect = this.takeRedirect(clientAddr, req.url);
    const ex = this.store.addRequest({
      source: this.opts.source ?? 'proxy',
      clientAddr,
      startedAt: req.timingEvents.startTime,
      method: req.method,
      url,
      httpVersion: req.httpVersion,
      headers: pairs(req.rawHeaders),
      body: req.body.buffer,
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

  private async subscribe(server: mockttp.Mockttp): Promise<void> {
    await server.on('request', this.guard((req) => this.recordRequest(req, false)));
    await server.on('websocket-request', this.guard((req) => this.recordRequest(req, true)));

    await server.on(
      'response',
      this.guard((res) => {
        const live = this.live.get(res.id);
        this.pendingTags.delete(res.id);
        if (!live) return;
        this.live.delete(res.id);
        const headers = pairs(res.rawHeaders);
        const summary = this.store.completeResponse(live.exchangeId, {
          status: res.statusCode,
          statusMessage: res.statusMessage,
          headers,
          body: res.body.buffer,
          timings: timingsFrom(res.timingEvents),
        });
        if (res.statusCode >= 300 && res.statusCode < 400) {
          const location = headers.find(([k]) => k.toLowerCase() === 'location')?.[1];
          if (location) this.rememberRedirect(live, location);
        }
        this.emit('response', summary);
      }),
    );

    await server.on(
      'websocket-accepted',
      this.guard((res) => {
        const live = this.live.get(res.id);
        if (!live) return;
        this.live.delete(res.id);
        const summary = this.store.completeResponse(live.exchangeId, {
          status: res.statusCode,
          statusMessage: res.statusMessage,
          headers: pairs(res.rawHeaders),
          timings: timingsFrom(res.timingEvents),
        });
        this.wsStreams.set(res.id, this.store.openStream('websocket', live.exchangeId));
        this.emit('response', summary);
      }),
    );

    const onMessage = (direction: 'client' | 'server') =>
      this.guard((msg: mockttp.WebSocketMessage) => {
        const streamId = this.wsStreams.get(msg.streamId);
        if (!streamId) return;
        const at = Math.round(msg.timingEvents.startTime + (msg.eventTimestamp - msg.timingEvents.startTimestamp));
        this.store.addStreamMessage({ streamId, direction, opcode: msg.isBinary ? 'binary' : 'text', at, payload: msg.content });
      });
    // "received" means received by the proxy from the client; "sent" means sent by the proxy to the client.
    await server.on('websocket-message-received', onMessage('client'));
    await server.on('websocket-message-sent', onMessage('server'));

    await server.on(
      'websocket-close',
      this.guard((close) => {
        const streamId = this.wsStreams.get(close.streamId);
        if (!streamId) return;
        this.wsStreams.delete(close.streamId);
        this.store.closeStream(streamId, close.closeCode, close.closeReason);
      }),
    );

    await server.on(
      'abort',
      this.guard((req) => {
        const live = this.live.get(req.id);
        if (live) {
          this.live.delete(req.id);
          this.store.failExchange(live.exchangeId, 'aborted', req.error?.message ?? 'connection closed', timingsFrom(req.timingEvents));
        }
        const streamId = this.wsStreams.get(req.id);
        if (streamId) {
          this.wsStreams.delete(req.id);
          this.store.closeStream(streamId, undefined, req.error?.message ?? 'aborted');
        }
      }),
    );

    await server.on(
      'tls-passthrough-opened',
      this.guard((t) => this.seen?.add(t.tlsMetadata?.sniHostname ?? t.destination.hostname, 'tls')),
    );

    await server.on(
      'tls-client-error',
      this.guard((f) => {
        const host = f.tlsMetadata.sniHostname ?? f.destination?.hostname;
        this.store.addTlsFailure({ host, clientAddr: f.remoteIpAddress, cause: f.failureCause });
      }),
    );
  }
}
