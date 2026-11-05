/** UDP endpoints: a QUIC server that accepts connections and a client connector with socket rebinding. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { Connection, type ClientConnectionOptions, type ConnectionEvents, type PathAddr, type ServerConnectionOptions } from './connection.js';
import { QUIC_V1 } from './keys.js';
import { buildRetry, buildVersionNegotiation, parseHeader } from './packet.js';

const CID_LEN = 8;

export interface QuicServerOptions extends Omit<ServerConnectionOptions, 'originalDcid' | 'retryScid' | 'addressValidated'> {
  /** Send a Retry to validate client addresses before doing any work. */
  retry?: boolean;
}

/**
 * Accepts QUIC connections on one UDP socket. 'connection' fires with each
 * new Connection before its first packet is processed, so handlers can be
 * attached to conn.ev.
 */
/**
 * UDP has no connection to fail over with, so pick the address the way TCP's
 * happy eyeballs usually ends up: IPv4 first. Windows resolves localhost to ::1
 * first, which misses a dev server bound to 127.0.0.1.
 */
async function resolveUdp(host: string): Promise<string> {
  const all = await lookup(host, { all: true });
  return (all.find((a) => a.family === 4) ?? all[0]!).address;
}

export class QuicServer extends EventEmitter {
  readonly socket: dgram.Socket;
  private conns = new Map<string, Connection>();
  private tokenKey = randomBytes(32);

  constructor(private readonly opts: QuicServerOptions, type: 'udp4' | 'udp6' = 'udp4') {
    super();
    this.socket = dgram.createSocket({ type, reuseAddr: false });
    this.socket.on('message', (msg, rinfo) => this.onMessage(msg, { address: rinfo.address, port: rinfo.port, family: rinfo.family as 'IPv4' }));
    this.socket.on('error', (e) => this.emit('error', e));
  }

  listen(port = 0, host = '127.0.0.1'): Promise<PathAddr> {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(port, host, () => {
        this.socket.off('error', reject);
        const a = this.socket.address();
        resolve({ address: a.address, port: a.port });
      });
    });
  }

  get address(): PathAddr {
    const a = this.socket.address();
    return { address: a.address, port: a.port };
  }

  get connections(): Connection[] {
    return [...new Set(this.conns.values())];
  }

  close(): Promise<void> {
    for (const c of this.connections) {
      c.close(0, 'server shutting down');
      c.terminate();
    }
    return new Promise((r) => this.socket.close(() => r()));
  }

  private send(buf: Buffer, to: PathAddr) {
    this.socket.send(buf, to.port, to.address);
  }

  private onMessage(msg: Buffer, from: PathAddr) {
    let h;
    try {
      h = parseHeader(msg, 0, CID_LEN);
    } catch {
      return;
    }
    const existing = this.conns.get(h.dcid.toString('hex'));
    if (existing) {
      existing.receive(msg, from);
      return;
    }
    if (h.type === '1rtt' || h.type === 'version-negotiation' || h.type === 'retry') return;
    if (h.version !== QUIC_V1) {
      if (msg.length >= 1200) this.send(buildVersionNegotiation(h.scid, h.dcid, [QUIC_V1]), from);
      return;
    }
    if (h.type !== 'initial' || msg.length < 1200 || h.dcid.length < 8) return;

    let originalDcid = h.dcid;
    let retryScid: Buffer | undefined;
    if (this.opts.retry) {
      if (!h.token.length) {
        const scid = randomBytes(CID_LEN);
        this.send(buildRetry(h.scid, scid, this.sealToken(from, h.dcid), h.dcid), from);
        return;
      }
      const odcid = this.openToken(from, h.token);
      if (!odcid) return;
      originalDcid = odcid;
      retryScid = h.dcid;
    }
    const scid = randomBytes(CID_LEN);
    const ev: ConnectionEvents = {
      send: (buf, to) => this.send(buf, to),
      newCid: (cid) => this.conns.set(cid.toString('hex'), conn),
      terminated: () => {
        for (const [k, v] of this.conns) if (v === conn) this.conns.delete(k);
      },
    };
    const conn = new Connection({ ...this.opts, server: true, originalDcid, retryScid, addressValidated: !!retryScid }, from, ev, { scid, dcid: h.scid });
    this.conns.set(h.dcid.toString('hex'), conn);
    this.conns.set(scid.toString('hex'), conn);
    this.emit('connection', conn);
    conn.receive(msg, from);
  }

  private sealToken(from: PathAddr, odcid: Buffer): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.tokenKey, iv);
    c.setAAD(Buffer.from(`${from.address}:${from.port}`));
    const body = Buffer.concat([Buffer.alloc(8), odcid]);
    body.writeDoubleBE(Date.now(), 0);
    return Buffer.concat([iv, c.update(body), c.final(), c.getAuthTag()]);
  }

  private openToken(from: PathAddr, token: Buffer): Buffer | null {
    if (token.length < 12 + 8 + 16) return null;
    try {
      const d = createDecipheriv('aes-256-gcm', this.tokenKey, token.subarray(0, 12));
      d.setAAD(Buffer.from(`${from.address}:${from.port}`));
      d.setAuthTag(token.subarray(token.length - 16));
      const body = Buffer.concat([d.update(token.subarray(12, token.length - 16)), d.final()]);
      if (Date.now() - body.readDoubleBE(0) > 10_000) return null;
      return body.subarray(8);
    } catch {
      return null;
    }
  }
}

export interface QuicConnectOptions extends ClientConnectionOptions {
  host: string;
  port: number;
  /** Local address and port to bind (default any, random port). */
  localPort?: number;
  /** Fail if the handshake has not finished in this time (default 10 s). */
  handshakeTimeoutMs?: number;
}

/** A client connection and the UDP socket it runs on. */
export class QuicClient {
  socket!: dgram.Socket;
  readonly conn: Connection;
  readonly remote: PathAddr;
  private type: 'udp4' | 'udp6';
  private oldSockets: dgram.Socket[] = [];

  private constructor(opts: QuicConnectOptions, remote: PathAddr, extraEv: Partial<ConnectionEvents>) {
    this.remote = remote;
    this.type = isIP(remote.address) === 6 ? 'udp6' : 'udp4';
    const ev: ConnectionEvents = {
      ...extraEv,
      send: (buf, to) => this.socket.send(buf, to.port, to.address),
      terminated: () => this.closeSockets(),
    };
    this.conn = new Connection(opts, remote, ev, { scid: randomBytes(CID_LEN), dcid: randomBytes(8) });
  }

  static async connect(opts: QuicConnectOptions, ev: Partial<ConnectionEvents> = {}): Promise<QuicClient> {
    const address = isIP(opts.host) ? opts.host : await resolveUdp(opts.host);
    const c = new QuicClient(opts, { address, port: opts.port }, ev);
    c.socket = await c.bind(opts.localPort ?? 0);
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        c.conn.close(0, 'handshake timeout', false);
        c.conn.terminate();
        reject(new Error(`QUIC handshake with ${opts.host}:${opts.port} timed out (is UDP blocked, or does the server not speak HTTP/3?)`));
      }, opts.handshakeTimeoutMs ?? 10_000);
      const prevHs = c.conn.ev.handshake;
      const prevClose = c.conn.ev.close;
      c.conn.ev.handshake = () => {
        clearTimeout(timer);
        prevHs?.();
        resolve();
      };
      c.conn.ev.close = (err) => {
        clearTimeout(timer);
        prevClose?.(err);
        if (c.conn.state !== 'connected' && !c.conn.handshakeConfirmed) reject(new Error(err ? `QUIC connection closed: ${err.reason || `code 0x${err.code.toString(16)}`}` : 'QUIC connection closed'));
      };
    });
    c.conn.start();
    c.ready = done;
    // Callers that use 0-RTT continue before the handshake ends; others await ready.
    done.catch(() => undefined);
    return c;
  }

  ready!: Promise<void>;

  private bind(port: number): Promise<dgram.Socket> {
    const s = dgram.createSocket(this.type);
    s.on('message', (msg, rinfo) => {
      if (s !== this.socket && !this.oldSockets.includes(s)) return;
      this.conn.receive(msg, { address: rinfo.address, port: rinfo.port });
    });
    s.on('error', () => undefined);
    return new Promise((resolve, reject) => {
      s.once('error', reject);
      s.bind(port, () => {
        s.off('error', reject);
        resolve(s);
      });
    });
  }

  get localPort(): number {
    return this.socket.address().port;
  }

  /**
   * Move to a new local UDP port (as a phone does between networks) and
   * probe the path. newCid switches to a fresh connection ID as well.
   */
  async rebind(newCid = true): Promise<{ from: number; to: number }> {
    const from = this.localPort;
    const next = await this.bind(0);
    this.oldSockets.push(this.socket);
    this.socket = next;
    this.conn.migrate(newCid);
    // Keep the old socket briefly for packets already in flight.
    const old = this.oldSockets.at(-1)!;
    setTimeout(() => {
      this.oldSockets = this.oldSockets.filter((x) => x !== old);
      old.close();
    }, 2000).unref();
    return { from, to: this.localPort };
  }

  close(code = 0, reason = ''): void {
    this.conn.close(code, reason);
    setTimeout(() => this.conn.terminate(), 50).unref();
  }

  private closeSockets() {
    for (const s of [this.socket, ...this.oldSockets]) {
      try {
        s.close();
      } catch {
        // already closed
      }
    }
    this.oldSockets = [];
  }
}
