// HTTP(S) and WebSocket clients that go through the capture proxy, for tests.
// Plain HTTP sends absolute-URI requests to the proxy; HTTPS and WebSocket
// open a CONNECT tunnel first, like browsers and devices do.
import { Agent, request as httpRequest, type AgentOptions, type ClientRequestArgs, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

const DECODERS: Record<string, (b: Buffer) => Buffer> = { gzip: gunzipSync, 'x-gzip': gunzipSync, deflate: inflateSync, br: brotliDecompressSync };

/** Open a CONNECT tunnel through the proxy to host:port. */
export function tunnel(proxyUrl: string, host: string, port: number): Promise<Duplex> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${host}:${port}`, headers: { host: `${host}:${port}` } });
    req.once('connect', (res: IncomingMessage, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`proxy refused CONNECT with ${res.statusCode}`));
      }
      resolve(socket);
    });
    req.once('error', reject);
    req.end();
  });
}

/** An agent whose connections are CONNECT tunnels through the proxy, optionally with TLS on top. */
export class TunnelAgent extends Agent {
  constructor(
    private readonly proxyUrl: string,
    private readonly tls?: ConnectionOptions,
    opts: AgentOptions = {},
  ) {
    super({ keepAlive: false, ...opts });
  }

  override createConnection(options: ClientRequestArgs, cb: (err: Error | null, socket?: Duplex) => void): undefined {
    const host = String(options.hostname ?? options.host ?? 'localhost');
    const port = Number(options.port ?? (this.tls ? 443 : 80));
    tunnel(this.proxyUrl, host, port).then(
      (socket) => {
        if (!this.tls) return cb(null, socket);
        const secure = tlsConnect({ socket, servername: host, ...this.tls });
        secure.once('secureConnect', () => cb(null, secure));
        secure.once('error', (err) => cb(err));
      },
      (err: Error) => cb(err),
    );
    return undefined;
  }
}

export interface ProxyClientOptions {
  uri: string;
  /** TLS options for HTTPS targets, e.g. { ca } to trust the project CA. */
  requestTls?: ConnectionOptions;
}

/** A small fetch through the proxy: follows redirects like fetch does, and returns a standard Response. */
export class ProxyClient {
  private readonly https: TunnelAgent;

  constructor(private readonly opts: ProxyClientOptions) {
    this.https = new TunnelAgent(opts.uri, opts.requestTls ?? {});
  }

  async fetch(url: string, init: { method?: string; body?: string | Uint8Array; headers?: Record<string, string> } = {}, redirects = 20): Promise<Response> {
    const target = new URL(url);
    const proxy = new URL(this.opts.uri);
    const method = init.method ?? 'GET';
    const body = init.body === undefined ? undefined : Buffer.from(init.body);
    const headers = { ...init.headers, ...(body ? { 'content-length': String(body.length) } : {}) };
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req =
        target.protocol === 'https:'
          ? // TLS happens inside the tunnel agent, so this is an ordinary request on that socket.
            httpRequest({ host: target.hostname, port: target.port || 443, method, path: target.pathname + target.search, headers: { host: target.host, ...headers }, agent: this.https })
          : httpRequest({ host: proxy.hostname, port: proxy.port, method, path: target.href, headers: { host: target.host, ...headers }, agent: false });
      req.once('response', resolve);
      req.once('error', reject);
      req.end(body);
    });
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location && redirects > 0) {
      const next = new URL(location, target).href;
      const keepBody = status === 307 || status === 308;
      return this.fetch(next, keepBody ? init : { headers: init.headers }, redirects - 1);
    }
    // Undo Content-Encoding like fetch does, so tests see the body the server meant.
    let data = Buffer.concat(chunks);
    const encodings = (res.headers['content-encoding'] ?? '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => e && e !== 'identity');
    for (const enc of encodings.reverse()) {
      const decode = DECODERS[enc];
      if (!decode) throw new Error(`unsupported content-encoding ${enc}`);
      data = decode(data);
    }
    const out = new Headers();
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      const name = res.rawHeaders[i]!.toLowerCase();
      if (encodings.length && (name === 'content-encoding' || name === 'content-length')) continue;
      out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
    }
    return new Response(status === 204 || status === 304 ? null : data, { status, statusText: res.statusMessage, headers: out });
  }

  close(): void {
    this.https.destroy();
  }
}
