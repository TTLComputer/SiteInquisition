import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as tls from 'node:tls';
import mqttPacket from 'mqtt-packet';
import { getCA } from 'mockttp/dist/util/certificates';
import type { CertificateAuthority } from './ca.js';
import type { Scope } from './scope.js';
import type { SeenHosts } from './seen.js';
import type { CaptureStore, ExchangeSource, HeaderList } from './store.js';

/**
 * One MQTT listener. Devices connect to it as if it were their broker; every
 * byte is relayed unchanged to the real broker, and a copy is parsed and
 * recorded packet by packet (CONNECT, SUBSCRIBE, PUBLISH, acks, ...).
 */
export interface MqttListenerConfig {
  /** Port devices connect to. 0 picks a free port. */
  port: number;
  /** The real broker. */
  upstreamHost: string;
  /** Defaults to 8883 when upstreamTls is set, otherwise 1883. */
  upstreamPort?: number;
  /** Connect to the real broker over TLS. */
  upstreamTls?: boolean;
  /** Accept TLS from devices, using a certificate for `tlsHostname` signed by the project CA. */
  listenTls?: boolean;
  /** Name on the certificate presented to devices. Defaults to upstreamHost. */
  tlsHostname?: string;
  /** Skip certificate checks on the real broker. */
  ignoreUpstreamTlsErrors?: boolean;
  /** Accept devices on other machines. Loopback only when false (the default). */
  allowLan?: boolean;
  source?: ExchangeSource;
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

type Packet = mqttPacket.Packet;

/** The parts of a packet worth showing and searching, minus the payload. */
export function packetMeta(p: Packet): Record<string, unknown> {
  const { cmd: _cmd, length: _length, ...rest } = p as Packet & { payload?: unknown; password?: unknown };
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (k === 'payload') continue;
    if (Buffer.isBuffer(v)) meta[k] = { base64: v.toString('base64') };
    else if (k === 'will' && v && typeof v === 'object') {
      const w = v as { payload?: Buffer | string };
      meta.will = { ...w, payload: Buffer.isBuffer(w.payload) ? { base64: w.payload.toString('base64') } : w.payload };
    } else if (v !== undefined) meta[k] = v;
  }
  return meta;
}

const payloadOf = (p: Packet): Uint8Array => {
  if (p.cmd !== 'publish') return new Uint8Array();
  const payload = (p as mqttPacket.IPublishPacket).payload;
  return typeof payload === 'string' ? Buffer.from(payload) : new Uint8Array(payload);
};

export class MqttRelay extends EventEmitter<{ session: [string]; error: [Error] }> {
  private server?: net.Server;
  private sockets = new Set<net.Socket>();

  constructor(
    private readonly store: CaptureStore,
    private readonly scope: Scope,
    private readonly ca: CertificateAuthority,
    readonly config: MqttListenerConfig,
    private readonly seen?: SeenHosts,
  ) {
    super();
  }

  get port(): number {
    const addr = this.server?.address() as net.AddressInfo | undefined;
    if (!addr) throw new Error('mqtt listener is not running');
    return addr.port;
  }

  get upstreamPort(): number {
    return this.config.upstreamPort ?? (this.config.upstreamTls ? 8883 : 1883);
  }

  /** The broker URL used for scope checks and shown as the exchange URL. */
  get brokerUrl(): string {
    return `${this.config.upstreamTls ? 'mqtts' : 'mqtt'}://${this.config.upstreamHost}:${this.upstreamPort}/`;
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    const onSocket = (socket: net.Socket) => this.handle(socket);
    let server: net.Server;
    if (this.config.listenTls) {
      const ca = await getCA({ cert: this.ca.cert, key: this.ca.key });
      const leaf = await ca.generateCertificate(this.config.tlsHostname ?? this.config.upstreamHost);
      server = tls.createServer({ key: leaf.key, cert: leaf.cert, ca: [this.ca.cert] }, onSocket);
    } else {
      server = net.createServer(onSocket);
    }
    // Same rule as the HTTP proxy: refuse non-loopback clients before the handshake unless LAN access is on.
    server.prependListener('connection', (socket: net.Socket) => {
      if (!this.config.allowLan && !LOOPBACK.test(socket.remoteAddress ?? '')) socket.destroy();
    });
    server.on('tlsClientError', (err, socket) => {
      this.store.addTlsFailure({ host: this.config.tlsHostname ?? this.config.upstreamHost, clientAddr: socket.remoteAddress, cause: err.message });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.port, this.config.allowLan ? undefined : '127.0.0.1', () => resolve());
    });
    this.server = server;
    return this.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private connectUpstream(): net.Socket {
    const { upstreamHost: host, upstreamTls, ignoreUpstreamTlsErrors } = this.config;
    const port = this.upstreamPort;
    return upstreamTls
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !ignoreUpstreamTlsErrors })
      : net.connect({ host, port });
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

  private handle(client: net.Socket): void {
    const upstream = this.connectUpstream();
    let exchangeId: string | undefined;
    let streamId: string | undefined;
    let established = false;
    let recording = true;
    this.sockets.add(client);
    this.sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);

    let closed = false;
    const teardown = () => {
      if (!closed) {
        closed = true;
        client.destroy();
        upstream.destroy();
      }
      this.sockets.delete(client);
      this.sockets.delete(upstream);
    };
    client.on('close', teardown);
    upstream.on('close', teardown);
    client.on('error', () => teardown());
    upstream.on('error', (err) => {
      if (exchangeId && !established) this.store.failExchange(exchangeId, 'error', `broker: ${err.message}`);
      teardown();
    });

    if (!this.scope.evaluate(this.brokerUrl).record) {
      this.seen?.add(this.config.upstreamHost, 'mqtt');
      return;
    }

    // Parse copies of both directions. Parsing problems stop recording for this
    // session but never touch the relayed bytes.
    const fromClient = mqttPacket.parser();
    const fromBroker = mqttPacket.parser();
    const startedAt = Date.now();
    const clientAddr = client.remoteAddress ?? null;

    const record = (direction: 'client' | 'server') =>
      this.guard((p: Packet) => {
        if (!recording) return;
        if (direction === 'client' && p.cmd === 'connect' && !exchangeId) {
          const c = p as mqttPacket.IConnectPacket;
          const version = c.protocolVersion ?? 4;
          (fromBroker as unknown as { settings: { protocolVersion: number } }).settings.protocolVersion = version;
          const headers: HeaderList = [
            ['client-id', c.clientId],
            ['protocol', `${c.protocolId ?? 'MQTT'} ${version}`],
            ['keep-alive', String(c.keepalive ?? 0)],
            ['clean-session', String(c.clean ?? true)],
          ];
          if (c.username !== undefined) headers.push(['username', c.username]);
          if (c.password !== undefined) headers.push(['password', Buffer.from(c.password).toString('utf8')]);
          if (c.will) headers.push(['will-topic', c.will.topic]);
          const ex = this.store.addRequest({
            source: this.config.source ?? 'proxy',
            clientAddr,
            startedAt,
            method: 'CONNECT',
            url: this.brokerUrl,
            httpVersion: `MQTT/${version === 5 ? '5.0' : version === 3 ? '3.1' : '3.1.1'}`,
            headers,
          });
          exchangeId = ex.id;
          streamId = this.store.openStream('mqtt', ex.id, startedAt);
          this.emit('session', ex.id);
        }
        if (!streamId) return;
        this.store.addStreamMessage({ streamId, direction, opcode: p.cmd, at: Date.now(), payload: payloadOf(p), meta: packetMeta(p) });
        if (direction === 'server' && p.cmd === 'connack' && exchangeId && !established) {
          established = true;
          const code = (p as mqttPacket.IConnackPacket).reasonCode ?? (p as mqttPacket.IConnackPacket).returnCode ?? 0;
          if (code === 0) this.store.markEstablished(exchangeId, { responseHeaders: Date.now() - startedAt });
          else this.store.failExchange(exchangeId, 'error', `CONNACK refused with code ${code}`);
        }
      });

    const stopRecording = (err: Error) => {
      recording = false;
      this.emit('error', new Error(`mqtt parse error, recording stopped for this session: ${err.message}`));
    };
    fromClient.on('packet', record('client'));
    fromBroker.on('packet', record('server'));
    fromClient.on('error', stopRecording);
    fromBroker.on('error', stopRecording);
    client.on('data', (chunk: Buffer) => recording && fromClient.parse(chunk));
    upstream.on('data', (chunk: Buffer) => recording && fromBroker.parse(chunk));
    client.on(
      'close',
      this.guard(() => {
        if (streamId) this.store.closeStream(streamId, undefined, 'connection closed');
        streamId = undefined;
      }),
    );
  }
}
