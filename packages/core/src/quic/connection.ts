/**
 * A QUIC v1 connection (RFC 9000, loss recovery from RFC 9002), independent
 * of sockets: the endpoint feeds datagrams in and sends what comes out.
 *
 * Besides normal behaviour it has the knobs the HTTP/3 lab needs: cork and
 * uncork (gather frames from many streams into as few datagrams as
 * possible), raw frame injection, withholding flow control credit or ACKs,
 * stream scheduling order, and a frame log.
 */
import { randomBytes } from 'node:crypto';
import { QuicError, TransportError, Writer } from './bytes.js';
import { cryptoFrameOverhead, describeFrame, encodeFrames, frameSize, isAckEliciting, parseFrames, streamFrameOverhead, type AckRange, type Frame } from './frames.js';
import { initialKeys, PacketKeys, QUIC_V1, type CipherSuite } from './keys.js';
import { buildPacket, minPayload, openPacket, packetNumberLength, packetOverhead, parseHeader, verifyRetry, type Header } from './packet.js';
import { decodeParams, encodeParams, type TransportParams } from './params.js';
import { TlsSession, type Level, type SessionTicket, type TlsClientOptions, type TlsServerOptions } from './tls.js';

export type Space = 'initial' | 'handshake' | 'app';
const SPACES: Space[] = ['initial', 'handshake', 'app'];
const spaceOf = (l: Level): Space => (l === 'initial' ? 'initial' : l === 'handshake' ? 'handshake' : 'app');

export interface PathAddr {
  address: string;
  port: number;
  family?: 'IPv4' | 'IPv6';
}

export interface PacketLogEntry {
  t: number;
  dir: 'in' | 'out';
  space: Space;
  type: string;
  pn: number;
  size: number;
  frames: string[];
}

export interface ConnectionOptions {
  /** Our transport parameters (merged over defaults). */
  params?: TransportParams;
  /** Give flow control credit back as the application reads (default true). */
  autoCredit?: boolean;
  /** Raise the peer's stream limit as streams close (default true). */
  autoStreamCredit?: boolean;
  /** Send ACKs (default true). Turning this off makes the peer retransmit and back off. */
  sendAcks?: boolean;
  /** How queued stream data shares packets (default fifo: in write order). */
  scheduler?: 'fifo' | 'round-robin';
  /** Largest datagram we build (default 1200). */
  maxDatagram?: number;
  /** Disable congestion control (default false). */
  noCongestion?: boolean;
  /** Keep this many packets in the log (default 2000). */
  logLimit?: number;
  idleTimeoutMs?: number;
}

export interface ClientConnectionOptions extends ConnectionOptions {
  serverName: string;
  alpn: string[];
  tls?: Partial<Omit<TlsClientOptions, 'serverName' | 'alpn' | 'transportParams'>>;
  session?: SessionTicket;
  earlyData?: boolean;
}

export interface ServerConnectionOptions extends ConnectionOptions {
  tls: Omit<TlsServerOptions, 'transportParams'>;
  originalDcid: Buffer;
  retryScid?: Buffer;
  /** The client's address was validated by a Retry token. */
  addressValidated?: boolean;
}

export interface ConnectionEvents {
  send(datagram: Buffer, to: PathAddr): void;
  handshake?(): void;
  /** New stream opened by the peer. */
  stream?(id: number): void;
  data?(id: number, data: Buffer, fin: boolean): void;
  reset?(id: number, code: number, finalSize: number): void;
  stopSending?(id: number, code: number): void;
  /** Peer raised our limit or flow control credit: blocked writers may continue. */
  writable?(id: number | null): void;
  datagram?(data: Buffer): void;
  ticket?(t: SessionTicket): void;
  close?(err: { code: number; app: boolean; reason: string; remote: boolean } | null): void;
  packet?(e: PacketLogEntry): void;
  pathValidated?(path: PathAddr): void;
  /** A connection ID we issued, so the endpoint can route it. */
  newCid?(cid: Buffer): void;
  terminated?(): void;
}

interface SentPacket {
  pn: number;
  time: number;
  size: number;
  ackEliciting: boolean;
  inFlight: boolean;
  frames: Frame[];
  zeroRtt: boolean;
}

class PnSpace {
  nextPn = 0;
  largestAcked = -1;
  largestRecv = -1;
  largestRecvTime = 0;
  /** Received packet numbers as sorted, merged ranges (ascending). */
  recv: AckRange[] = [];
  ackPending = false;
  ackElicitingSinceAck = 0;
  ackDeadline = Infinity;
  sent = new Map<number, SentPacket>();
  lossTime = Infinity;
  lastAckElicitingTime = 0;
  readKeys?: PacketKeys;
  writeKeys?: PacketKeys;
  discarded = false;
  /** Frames to send again (lost or probed). */
  retransmit: Frame[] = [];
  cryptoSend: Buffer[] = [];
  cryptoSendOffset = 0;
  cryptoRecv = new Map<number, Buffer>();
  cryptoRecvOffset = 0;

  hasRecv(pn: number) {
    return this.recv.some(([l, h]) => pn >= l && pn <= h);
  }
  addRecv(pn: number) {
    const r = this.recv;
    let i = 0;
    while (i < r.length && r[i]![1] < pn - 1) i++;
    if (i === r.length) r.push([pn, pn]);
    else if (pn < r[i]![0] - 1) r.splice(i, 0, [pn, pn]);
    else {
      r[i]![0] = Math.min(r[i]![0], pn);
      r[i]![1] = Math.max(r[i]![1], pn);
      if (i + 1 < r.length && r[i + 1]![0] <= r[i]![1] + 1) {
        r[i]![1] = Math.max(r[i]![1], r[i + 1]![1]);
        r.splice(i + 1, 1);
      }
    }
    if (r.length > 64) r.splice(0, r.length - 64);
  }
}

export class StreamState {
  // send side
  sendQueue: Buffer[] = [];
  sendQueued = 0;
  sendOffset = 0;
  sendMax = 0;
  finQueued = false;
  finSent = false;
  sendAckedBytes = 0;
  finAcked = false;
  finAckedPending = false;
  resetSent: { code: number } | null = null;
  stopSendingReceived: number | null = null;
  // receive side
  recvChunks = new Map<number, Buffer>();
  recvOffset = 0;
  recvHighest = 0;
  recvMax = 0;
  recvWindow = 0;
  finalSize: number | null = null;
  finDelivered = false;
  resetReceived: { code: number; finalSize: number } | null = null;
  stopSendingSent = false;
  closed = false;
  /** Times for the plan runner's report. */
  readonly openedAt = performance.now();
  constructor(
    readonly id: number,
    readonly local: boolean,
    readonly bidi: boolean,
  ) {}
  get canSend() {
    return this.local || this.bidi;
  }
  get canRecv() {
    return !this.local || this.bidi;
  }
}

const now = () => performance.now();
const kInitialRtt = 333;
const kGranularity = 1;
const kPacketThreshold = 3;
const kTimeThreshold = 9 / 8;
const kMinCwnd = 2 * 1200;

export class Connection {
  readonly isClient: boolean;
  readonly tls: TlsSession;
  readonly log: PacketLogEntry[] = [];
  readonly streams = new Map<number, StreamState>();
  readonly opts: ConnectionOptions;
  path: PathAddr;
  state: 'handshaking' | 'connected' | 'closing' | 'draining' | 'closed' = 'handshaking';
  handshakeConfirmed = false;
  localParams: TransportParams;
  peerParams: TransportParams | null = null;
  /** The ID the peer uses to reach us (all our active IDs are in localCids). */
  localCids = new Map<number, { cid: Buffer; resetToken: Buffer }>();
  peerCids = new Map<number, { cid: Buffer; resetToken?: Buffer }>();
  dcid: Buffer;
  dcidSeq = 0;
  readonly originalDcid: Buffer;
  private retryToken: Buffer = Buffer.alloc(0);
  private retried = false;
  private spaces: Record<Space, PnSpace> = { initial: new PnSpace(), handshake: new PnSpace(), app: new PnSpace() };
  private zeroRttWrite?: PacketKeys;
  private zeroRttRead?: PacketKeys;
  private keyPhase = 0;
  private nextReadKeys?: PacketKeys;
  private prevReadKeys?: PacketKeys;
  private appReadSecret?: { suite: CipherSuite; secret: Buffer };
  private appWriteSecret?: { suite: CipherSuite; secret: Buffer };
  // flow control
  private peerMaxData = 0;
  private sentData = 0;
  private localMaxData = 0;
  private recvData = 0;
  private consumedData = 0;
  private peerMaxStreams = { bidi: 0, uni: 0 };
  private nextStreamId = { bidi: 0, uni: 0 };
  private localMaxStreams = { bidi: 0, uni: 0 };
  private peerStreamsClosed = { bidi: 0, uni: 0 };
  private peerStreamsOpened = { bidi: 0, uni: 0 };
  private pendingControl: Frame[] = [];
  private blockedSent = new Set<string>();
  private sendOrder: number[] = [];
  private datagrams: Buffer[] = [];
  // recovery
  private srtt = kInitialRtt;
  private rttvar = kInitialRtt / 2;
  private minRtt = Infinity;
  private latestRtt = 0;
  private hasRttSample = false;
  private ptoCount = 0;
  private cwnd = 10 * 1200;
  private ssthresh = Infinity;
  private bytesInFlight = 0;
  private recoveryStart = -Infinity;
  // anti-amplification (server, before address validation)
  private addressValidated: boolean;
  private bytesReceived = 0;
  private bytesSent = 0;
  // timers and lifecycle
  private timer?: NodeJS.Timeout;
  private timerAt = Infinity;
  private lastActivity = now();
  private idleTimeout = 30_000;
  private corked = 0;
  private flushScheduled = false;
  private undecryptable: Array<{ buf: Buffer; from: PathAddr }> = [];
  private closeFrame?: Frame;
  private pathChallenges = new Map<string, { data: Buffer; path: PathAddr; sentAt: number }>();
  private probePath?: PathAddr;
  private closeEmitted = false;

  constructor(
    opts: ClientConnectionOptions | (ServerConnectionOptions & { server: true }),
    path: PathAddr,
    readonly ev: ConnectionEvents,
    cids: { scid: Buffer; dcid: Buffer },
  ) {
    this.opts = opts;
    this.isClient = !('server' in opts && opts.server);
    this.path = path;
    this.dcid = cids.dcid;
    this.originalDcid = this.isClient ? cids.dcid : (opts as ServerConnectionOptions).originalDcid;
    this.addressValidated = this.isClient || !!(opts as ServerConnectionOptions).addressValidated;
    const resetToken = randomBytes(16);
    this.scid = cids.scid;
    this.localCids.set(0, { cid: cids.scid, resetToken });
    this.peerCids.set(0, { cid: cids.dcid });
    this.idleTimeout = opts.idleTimeoutMs ?? 30_000;
    this.localParams = {
      maxIdleTimeout: this.idleTimeout,
      maxUdpPayloadSize: 1472,
      initialMaxData: 1 << 22,
      initialMaxStreamDataBidiLocal: 1 << 20,
      initialMaxStreamDataBidiRemote: 1 << 20,
      initialMaxStreamDataUni: 1 << 20,
      initialMaxStreamsBidi: 128,
      initialMaxStreamsUni: 16,
      ackDelayExponent: 3,
      maxAckDelay: 25,
      activeConnectionIdLimit: 4,
      initialScid: cids.scid,
      maxDatagramFrameSize: 65535,
      ...(this.isClient ? {} : { originalDcid: this.originalDcid, statelessResetToken: resetToken, retryScid: (opts as ServerConnectionOptions).retryScid }),
      ...opts.params,
    };
    this.localMaxData = this.localParams.initialMaxData ?? 0;
    this.localMaxStreams = { bidi: this.localParams.initialMaxStreamsBidi ?? 0, uni: this.localParams.initialMaxStreamsUni ?? 0 };
    this.nextStreamId = this.isClient ? { bidi: 0, uni: 2 } : { bidi: 1, uni: 3 };

    // After a Retry both sides derive Initial keys from the Retry's connection ID.
    const keys = initialKeys(this.isClient ? this.originalDcid : ((opts as ServerConnectionOptions).retryScid ?? this.originalDcid));
    this.spaces.initial.writeKeys = this.isClient ? keys.client : keys.server;
    this.spaces.initial.readKeys = this.isClient ? keys.server : keys.client;

    const cb = {
      send: (level: Level, data: Buffer) => this.queueCrypto(level, data),
      keys: (level: Level, dir: 'read' | 'write', suite: CipherSuite, secret: Buffer) => this.installKeys(level, dir, suite, secret),
      done: () => this.onHandshakeComplete(),
      ticket: (t: SessionTicket) => this.ev.ticket?.(t),
    };
    if (this.isClient) {
      const o = opts as ClientConnectionOptions;
      this.tls = new TlsSession(
        { ...o.tls, serverName: o.serverName, alpn: o.alpn, transportParams: encodeParams(this.localParams), session: o.session, earlyData: o.earlyData },
        cb,
      );
    } else {
      const o = opts as ServerConnectionOptions;
      this.tls = new TlsSession({ ...o.tls, server: true, transportParams: () => encodeParams(this.localParams) }, cb);
    }
  }

  // --- public API ---------------------------------------------------------

  /** Our first connection ID (long headers use it; every ID we issue has the same length). */
  readonly scid: Buffer;

  get rtt() {
    return { smoothed: this.srtt, min: this.minRtt, latest: this.latestRtt, variance: this.rttvar };
  }

  get stats() {
    return { cwnd: this.cwnd, bytesInFlight: this.bytesInFlight, sent: this.bytesSent, received: this.bytesReceived, peerMaxData: this.peerMaxData, sentData: this.sentData, localMaxData: this.localMaxData, recvData: this.recvData };
  }

  /** Client: send the first flight. */
  start(): void {
    this.tls.start();
    this.applyZeroRttParams();
    this.flush();
  }

  /** With 0-RTT the remembered server limits apply until the handshake finishes. */
  private applyZeroRttParams() {
    const o = this.opts as ClientConnectionOptions;
    if (!this.isClient || !o.earlyData || !this.zeroRttWrite || !o.session?.transportParams) return;
    try {
      this.applyPeerLimits(decodeParams(o.session.transportParams));
    } catch {
      // ignore: limits stay at zero and 0-RTT carries nothing
    }
  }

  private applyPeerLimits(p: TransportParams) {
    this.peerMaxData = Math.max(this.peerMaxData, p.initialMaxData ?? 0);
    this.peerMaxStreams.bidi = Math.max(this.peerMaxStreams.bidi, p.initialMaxStreamsBidi ?? 0);
    this.peerMaxStreams.uni = Math.max(this.peerMaxStreams.uni, p.initialMaxStreamsUni ?? 0);
    for (const s of this.streams.values()) if (s.canSend) s.sendMax = Math.max(s.sendMax, this.initialSendMax(s, p));
  }

  private initialSendMax(s: StreamState, p: TransportParams) {
    // Our bidi stream: the peer's limit for streams it did not open ("remote" from its side).
    if (!s.bidi) return p.initialMaxStreamDataUni ?? 0;
    return s.local ? (p.initialMaxStreamDataBidiRemote ?? 0) : (p.initialMaxStreamDataBidiLocal ?? 0);
  }

  get earlyDataAvailable(): boolean {
    return !!this.zeroRttWrite && !this.spaces.app.writeKeys;
  }

  /** Open a stream. Returns null when the peer's stream limit is reached. */
  openStream(bidi = true): number | null {
    const kind = bidi ? 'bidi' : 'uni';
    const id = this.nextStreamId[kind];
    if (Math.floor(id / 4) >= this.peerMaxStreams[kind]) {
      const key = `sb:${kind}`;
      if (!this.blockedSent.has(key)) {
        this.blockedSent.add(key);
        this.pendingControl.push({ type: 'streams_blocked', bidi, limit: this.peerMaxStreams[kind] });
        this.scheduleFlush();
      }
      return null;
    }
    this.nextStreamId[kind] += 4;
    this.getStream(id, true);
    return id;
  }

  canOpenStream(bidi = true): boolean {
    const kind = bidi ? 'bidi' : 'uni';
    return Math.floor(this.nextStreamId[kind] / 4) < this.peerMaxStreams[kind];
  }

  write(id: number, data: Uint8Array, fin = false): void {
    const s = this.streams.get(id);
    if (!s || !s.canSend) throw new Error(`stream ${id} cannot send`);
    if (s.finQueued || s.resetSent) throw new Error(`stream ${id} is finished`);
    if (data.length) {
      s.sendQueue.push(Buffer.from(data));
      s.sendQueued += data.length;
    }
    if (fin) s.finQueued = true;
    if (!this.sendOrder.includes(id)) this.sendOrder.push(id);
    this.scheduleFlush();
  }

  /** Bytes queued but not yet sent on a stream. */
  pending(id: number): number {
    return this.streams.get(id)?.sendQueued ?? 0;
  }

  resetStream(id: number, code: number): void {
    const s = this.streams.get(id);
    if (!s || !s.canSend || s.resetSent || s.finAcked) return;
    s.resetSent = { code };
    s.sendQueue = [];
    s.sendQueued = 0;
    this.pendingControl.push({ type: 'reset_stream', id, code, finalSize: s.sendOffset });
    this.sendOrder = this.sendOrder.filter((x) => x !== id);
    this.scheduleFlush();
    this.maybeClose(s);
  }

  stopSending(id: number, code: number): void {
    const s = this.streams.get(id);
    if (!s || !s.canRecv || s.stopSendingSent || s.finDelivered || s.resetReceived) return;
    s.stopSendingSent = true;
    this.pendingControl.push({ type: 'stop_sending', id, code });
    this.scheduleFlush();
  }

  /** Grant flow control credit by hand (used when autoCredit is off). */
  grant(id: number | null, bytes: number): void {
    if (id === null) {
      this.localMaxData += bytes;
      this.pendingControl.push({ type: 'max_data', max: this.localMaxData });
    } else {
      const s = this.streams.get(id);
      if (!s) return;
      s.recvMax += bytes;
      this.pendingControl.push({ type: 'max_stream_data', id, max: s.recvMax });
    }
    this.scheduleFlush();
  }

  grantStreams(bidi: boolean, count: number): void {
    const k = bidi ? 'bidi' : 'uni';
    this.localMaxStreams[k] += count;
    this.pendingControl.push({ type: 'max_streams', bidi, max: this.localMaxStreams[k] });
    this.scheduleFlush();
  }

  sendDatagram(data: Uint8Array): boolean {
    const max = this.peerParams?.maxDatagramFrameSize ?? 0;
    if (!max || data.length + 4 > max) return false;
    this.datagrams.push(Buffer.from(data));
    this.scheduleFlush();
    return true;
  }

  /** Send arbitrary frames in the app space (or another space) as soon as possible. */
  inject(frames: Frame[], space: Space = 'app'): void {
    if (space === 'app') this.pendingControl.push(...frames);
    else this.spaces[space].retransmit.push(...frames);
    this.scheduleFlush();
  }

  ping(): void {
    this.pendingControl.push({ type: 'ping' });
    this.scheduleFlush();
  }

  /** Hold all sending until uncork(); nested calls stack. */
  cork(): void {
    this.corked++;
  }

  uncork(): void {
    if (this.corked > 0) this.corked--;
    if (!this.corked) this.flush();
  }

  /** Start a key update (RFC 9001 section 6). */
  updateKeys(): void {
    const app = this.spaces.app;
    if (!app.writeKeys || !this.handshakeConfirmed) return;
    app.writeKeys = app.writeKeys.next();
    this.keyPhase ^= 1;
    this.prevReadKeys = app.readKeys;
    app.readKeys = this.nextReadKeys ?? app.readKeys!.next();
    this.nextReadKeys = app.readKeys.next();
  }

  /** Client: move to a new local path (the endpoint has rebound the socket). Optionally switch to a fresh connection ID. */
  migrate(newCid = true): boolean {
    if (!this.isClient || !this.handshakeConfirmed) return false;
    if (newCid) {
      const next = [...this.peerCids.entries()].filter(([seq]) => seq > this.dcidSeq).sort((a, b) => a[0] - b[0])[0];
      if (next) {
        this.pendingControl.push({ type: 'retire_connection_id', seq: this.dcidSeq });
        this.peerCids.delete(this.dcidSeq);
        this.dcidSeq = next[0];
        this.dcid = next[1].cid;
      }
    }
    // Probe the path and send something non-probing so the server switches over.
    const data = randomBytes(8);
    this.pathChallenges.set(data.toString('hex'), { data, path: this.path, sentAt: now() });
    this.pendingControl.push({ type: 'path_challenge', data }, { type: 'ping' });
    this.flush();
    return true;
  }

  close(code = 0, reason = '', app = true): void {
    if (this.state === 'closing' || this.state === 'draining' || this.state === 'closed') return;
    this.closeFrame = { type: 'connection_close', app: app && !!this.spaces.app.writeKeys, code: app && !this.spaces.app.writeKeys ? TransportError.APPLICATION_ERROR : code, frameType: 0, reason };
    this.state = 'closing';
    this.sendClose();
    this.emitClose({ code, app, reason, remote: false });
    this.setTimer(now() + 3 * this.pto());
  }

  // --- input --------------------------------------------------------------

  receive(buf: Buffer, from: PathAddr): void {
    if (this.state === 'closed' || this.state === 'draining') return;
    this.bytesReceived += buf.length;
    let off = 0;
    let first = true;
    while (off < buf.length) {
      let h: Header;
      try {
        h = parseHeader(buf, off, this.scid.length);
      } catch {
        return;
      }
      off = h.end;
      if (h.type === 'version-negotiation') {
        if (this.isClient && this.state === 'handshaking' && first && !h.versions?.includes(QUIC_V1)) this.fail(new QuicError(TransportError.CONNECTION_REFUSED, `server does not support QUIC v1 (offers ${h.versions?.map((v) => `0x${v.toString(16)}`).join(', ')})`));
        return;
      }
      first = false;
      if (h.type === 'retry') {
        this.handleRetry(buf, h);
        return;
      }
      if (h.version !== QUIC_V1) return;
      if (this.state === 'closing') {
        // Answer anything with the close again, rate limited by the timer.
        this.sendClose();
        return;
      }
      this.receivePacket(buf, h, from);
    }
    this.checkStatelessReset(buf);
    this.flush();
  }

  private checkStatelessReset(buf: Buffer) {
    if (buf.length < 21 || (buf[0]! & 0x80) || this.lastPacketOk) return;
    const tail = buf.subarray(buf.length - 16);
    for (const p of this.peerCids.values()) {
      if (p.resetToken?.equals(tail)) {
        this.state = 'draining';
        this.emitClose({ code: 0, app: false, reason: 'stateless reset', remote: true });
        this.terminate();
        return;
      }
    }
  }

  private lastPacketOk = false;

  private handleRetry(buf: Buffer, h: Header) {
    if (!this.isClient || this.retried || this.spaces.initial.largestRecv >= 0) return;
    if (!verifyRetry(buf, h, this.originalDcid)) return;
    this.retried = true;
    this.retryToken = h.token;
    this.dcid = h.scid;
    this.peerCids.set(0, { cid: h.scid });
    const keys = initialKeys(h.scid);
    const init = this.spaces.initial;
    init.writeKeys = keys.client;
    init.readKeys = keys.server;
    this.retryScid = h.scid;
    // Resend everything sent in Initial packets.
    for (const p of init.sent.values()) {
      if (p.inFlight) this.bytesInFlight -= p.size;
      init.retransmit.push(...p.frames.filter((f) => f.type === 'crypto'));
    }
    init.sent.clear();
    const app = this.spaces.app;
    for (const p of app.sent.values()) {
      if (p.inFlight) this.bytesInFlight -= p.size;
      app.retransmit.push(...p.frames.filter((f) => f.type === 'stream'));
    }
    app.sent.clear();
    this.flush();
  }

  private retryScid?: Buffer;

  private keysFor(h: Header): PacketKeys | ((phase: number) => PacketKeys | undefined) | undefined {
    if (h.type === 'initial') return this.spaces.initial.readKeys;
    if (h.type === 'handshake') return this.spaces.handshake.readKeys;
    if (h.type === '0rtt') return this.isClient ? undefined : this.zeroRttRead;
    const app = this.spaces.app;
    if (!app.readKeys) return undefined;
    return (phase: number) => {
      if (phase === -1) return app.readKeys;
      if (phase === this.keyPhase) return app.readKeys;
      // A flipped phase is either the peer's key update or an old packet.
      return this.nextReadKeys ?? (this.nextReadKeys = app.readKeys!.next());
    };
  }

  private receivePacket(buf: Buffer, h: Header, from: PathAddr) {
    this.lastPacketOk = false;
    const space = h.type === 'initial' ? 'initial' : h.type === 'handshake' ? 'handshake' : 'app';
    const sp = this.spaces[space];
    if (sp.discarded) return;
    if (h.type !== '1rtt' && h.type !== '0rtt' && !this.isClient && h.type === 'initial' && h.dcid.length < 8 && this.state === 'handshaking' && sp.largestRecv < 0) return;
    const keys = this.keysFor(h);
    if (!keys) {
      if (this.undecryptable.length < 16 && h.type !== 'initial') this.undecryptable.push({ buf: Buffer.from(buf.subarray(h.start, h.end)), from });
      return;
    }
    const opened = openPacket(buf, h, keys, sp.largestRecv);
    if (!opened) return;
    this.lastPacketOk = true;
    if (h.type === '1rtt' && opened.keyPhase !== this.keyPhase) {
      // The peer updated keys: follow it.
      if (this.nextReadKeys && opened.pn > sp.largestRecv) {
        this.prevReadKeys = sp.readKeys;
        sp.readKeys = this.nextReadKeys;
        this.nextReadKeys = sp.readKeys.next();
        sp.writeKeys = sp.writeKeys!.next();
        this.keyPhase = opened.keyPhase;
      }
    }
    const reserved = h.type === '1rtt' ? (opened.first >> 3) & 3 : (opened.first >> 2) & 3;
    if (reserved) return this.fail(new QuicError(TransportError.PROTOCOL_VIOLATION, 'reserved header bits set'));
    if (sp.hasRecv(opened.pn)) return;

    if (this.isClient && h.type === 'initial' && this.spaces.initial.largestRecv < 0) {
      // Switch to the server's chosen connection ID.
      this.dcid = h.scid;
      this.peerCids.set(0, { cid: h.scid });
      this.serverInitialScid = h.scid;
    }
    if (!this.isClient && h.type === 'handshake') {
      // A client Handshake packet proves its address and lets us drop Initial keys.
      this.addressValidated = true;
      this.discard('initial');
    }
    this.lastActivity = now();

    let frames: Frame[];
    try {
      frames = parseFrames(opened.payload);
      if (!frames.length) throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'packet with no frames');
    } catch (e) {
      return this.fail(e as Error);
    }
    this.logPacket('in', space, h.type, opened.pn, h.end - h.start, frames);

    const probingOnly = frames.every((f) => f.type === 'path_challenge' || f.type === 'path_response' || f.type === 'new_connection_id' || f.type === 'padding');
    if (space === 'app' && !this.isClient && (from.address !== this.path.address || from.port !== this.path.port)) {
      if (!probingOnly && opened.pn > sp.largestRecv) this.onPeerMigrated(from);
      else this.probePath = from;
    }

    const isNew = opened.pn > sp.largestRecv;
    sp.addRecv(opened.pn);
    if (isNew) {
      sp.largestRecv = opened.pn;
      sp.largestRecvTime = now();
    }
    const eliciting = frames.some(isAckEliciting);
    try {
      for (const f of frames) this.handleFrame(f, space, h.type, from);
    } catch (e) {
      return this.fail(e as Error);
    }
    if (eliciting) {
      sp.ackPending = true;
      sp.ackElicitingSinceAck++;
      const maxAckDelay = this.localParams.maxAckDelay ?? 25;
      if (space !== 'app' || sp.ackElicitingSinceAck >= 2 || !isNew) sp.ackDeadline = 0;
      else sp.ackDeadline = Math.min(sp.ackDeadline, now() + maxAckDelay);
    }
  }

  private serverInitialScid?: Buffer;

  private onPeerMigrated(from: PathAddr) {
    // RFC 9000 section 9.3: switch, then validate the new path.
    this.path = { ...from };
    const data = randomBytes(8);
    this.pathChallenges.set(data.toString('hex'), { data, path: { ...from }, sentAt: now() });
    this.pendingControl.push({ type: 'path_challenge', data });
    // Reset congestion state for the new path.
    this.cwnd = 10 * 1200;
    this.ssthresh = Infinity;
  }

  private handleFrame(f: Frame, space: Space, ptype: string, from: PathAddr) {
    const appOnly = () => {
      if (space !== 'app') throw new QuicError(TransportError.PROTOCOL_VIOLATION, `${f.type} outside 1-RTT`);
    };
    switch (f.type) {
      case 'padding':
      case 'ping':
        return;
      case 'ack':
        if (ptype === '0rtt') throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'ACK in 0-RTT');
        return this.onAck(f, space);
      case 'crypto': {
        if (ptype === '0rtt') throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'CRYPTO in 0-RTT');
        const sp = this.spaces[space];
        const end = f.offset + f.data.length;
        if (end <= sp.cryptoRecvOffset) return;
        if (end - sp.cryptoRecvOffset > 1 << 17) throw new QuicError(TransportError.CRYPTO_BUFFER_EXCEEDED, 'crypto data too far ahead');
        sp.cryptoRecv.set(f.offset, f.data);
        this.deliverCrypto(space);
        return;
      }
      case 'stream':
        appOnly();
        return this.onStreamFrame(f);
      case 'reset_stream': {
        appOnly();
        const s = this.peerStream(f.id, 'recv');
        if (!s) return;
        if (s.finalSize !== null && s.finalSize !== f.finalSize) throw new QuicError(TransportError.FINAL_SIZE_ERROR, 'final size changed');
        if (f.finalSize < s.recvHighest) throw new QuicError(TransportError.FINAL_SIZE_ERROR, 'final size below received data');
        if (s.resetReceived) return;
        this.recvData += f.finalSize - s.recvHighest;
        s.recvHighest = f.finalSize;
        s.finalSize = f.finalSize;
        s.resetReceived = { code: f.code, finalSize: f.finalSize };
        s.recvChunks.clear();
        this.ev.reset?.(f.id, f.code, f.finalSize);
        this.maybeClose(s);
        return;
      }
      case 'stop_sending': {
        appOnly();
        const s = this.peerStream(f.id, 'send');
        if (!s) return;
        s.stopSendingReceived = f.code;
        this.ev.stopSending?.(f.id, f.code);
        // RFC 9000 3.5: answer with RESET_STREAM.
        this.resetStream(f.id, f.code);
        return;
      }
      case 'new_token':
        if (!this.isClient) throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'NEW_TOKEN from a client');
        return;
      case 'max_data':
        appOnly();
        if (f.max > this.peerMaxData) {
          this.peerMaxData = f.max;
          this.blockedSent.delete('data');
          this.ev.writable?.(null);
        }
        return;
      case 'max_stream_data': {
        appOnly();
        const s = this.peerStream(f.id, 'send');
        if (s && f.max > s.sendMax) {
          s.sendMax = f.max;
          this.blockedSent.delete(`s:${f.id}`);
          this.ev.writable?.(f.id);
        }
        return;
      }
      case 'max_streams': {
        appOnly();
        const k = f.bidi ? 'bidi' : 'uni';
        if (f.max > 2 ** 60) throw new QuicError(TransportError.FRAME_ENCODING_ERROR, 'MAX_STREAMS too large');
        if (f.max > this.peerMaxStreams[k]) {
          this.peerMaxStreams[k] = f.max;
          this.blockedSent.delete(`sb:${k}`);
          this.ev.writable?.(null);
        }
        return;
      }
      case 'data_blocked':
      case 'stream_data_blocked':
      case 'streams_blocked':
        appOnly();
        return;
      case 'new_connection_id': {
        appOnly();
        if (!this.dcid.length) throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'NEW_CONNECTION_ID with zero-length IDs');
        if (f.retirePriorTo > f.seq) throw new QuicError(TransportError.FRAME_ENCODING_ERROR, 'retire_prior_to above sequence');
        if (!this.peerCids.has(f.seq)) this.peerCids.set(f.seq, { cid: f.cid, resetToken: f.resetToken });
        for (const seq of [...this.peerCids.keys()]) {
          if (seq < f.retirePriorTo) {
            this.peerCids.delete(seq);
            this.pendingControl.push({ type: 'retire_connection_id', seq });
            if (seq === this.dcidSeq) {
              const next = [...this.peerCids.entries()].sort((a, b) => a[0] - b[0])[0];
              if (next) {
                this.dcidSeq = next[0];
                this.dcid = next[1].cid;
              }
            }
          }
        }
        if (this.peerCids.size > (this.localParams.activeConnectionIdLimit ?? 2)) throw new QuicError(TransportError.CONNECTION_ID_LIMIT_ERROR, 'too many connection IDs');
        return;
      }
      case 'retire_connection_id': {
        appOnly();
        if (this.localCids.has(f.seq)) {
          this.localCids.delete(f.seq);
          this.issueCids();
        }
        return;
      }
      case 'path_challenge':
        appOnly();
        // Answer on the path it arrived on.
        this.sendOnPath(from, [{ type: 'path_response', data: f.data }]);
        return;
      case 'path_response': {
        appOnly();
        const c = this.pathChallenges.get(f.data.toString('hex'));
        if (c) {
          this.pathChallenges.delete(f.data.toString('hex'));
          this.addressValidated = true;
          this.ev.pathValidated?.(c.path);
        }
        return;
      }
      case 'connection_close':
        this.state = 'draining';
        this.emitClose({ code: f.code, app: f.app, reason: f.reason, remote: true });
        this.setTimer(now() + 3 * this.pto());
        return;
      case 'handshake_done':
        appOnly();
        if (!this.isClient) throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'HANDSHAKE_DONE from a client');
        if (!this.handshakeConfirmed) {
          this.handshakeConfirmed = true;
          this.discard('handshake');
        }
        return;
      case 'datagram':
        appOnly();
        if (!this.localParams.maxDatagramFrameSize) throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'DATAGRAM not negotiated');
        this.ev.datagram?.(f.data);
        return;
    }
  }

  private deliverCrypto(space: Space) {
    const sp = this.spaces[space];
    const level: Level = space === 'app' ? '1rtt' : space;
    for (;;) {
      let progressed = false;
      for (const [off, data] of sp.cryptoRecv) {
        if (off <= sp.cryptoRecvOffset) {
          sp.cryptoRecv.delete(off);
          const skip = sp.cryptoRecvOffset - off;
          if (skip < data.length) {
            const fresh = data.subarray(skip);
            sp.cryptoRecvOffset += fresh.length;
            this.tls.receive(level, fresh);
          }
          progressed = true;
        }
      }
      if (!progressed) return;
    }
  }

  private peerStream(id: number, dir: 'send' | 'recv'): StreamState | undefined {
    const local = (id & 1) === (this.isClient ? 0 : 1);
    const bidi = (id & 2) === 0;
    if (dir === 'recv' && local && !bidi) throw new QuicError(TransportError.STREAM_STATE_ERROR, `peer sent on our send-only stream ${id}`);
    if (dir === 'send' && !local && !bidi) throw new QuicError(TransportError.STREAM_STATE_ERROR, `frame for the peer's send-only stream ${id}`);
    if (local) {
      const kind = bidi ? 'bidi' : 'uni';
      if (id >= this.nextStreamId[kind]) throw new QuicError(TransportError.STREAM_STATE_ERROR, `stream ${id} not opened yet`);
      return this.streams.get(id);
    }
    return this.getStream(id, false);
  }

  private getStream(id: number, local: boolean): StreamState | undefined {
    const existing = this.streams.get(id);
    if (existing) return existing;
    const bidi = (id & 2) === 0;
    const kind = bidi ? 'bidi' : 'uni';
    if (!local) {
      const index = Math.floor(id / 4);
      if (index >= this.localMaxStreams[kind]) throw new QuicError(TransportError.STREAM_LIMIT_ERROR, `stream ${id} over the limit of ${this.localMaxStreams[kind]}`);
      if (index < this.peerStreamsOpened[kind]) return undefined; // already closed and forgotten
      // Opening stream N implicitly opens all lower ones of the same type.
      for (let i = this.peerStreamsOpened[kind]; i <= index; i++) {
        const sid = i * 4 + (id & 3);
        this.createStream(sid, false, bidi);
        this.ev.stream?.(sid);
      }
      this.peerStreamsOpened[kind] = index + 1;
      return this.streams.get(id);
    }
    return this.createStream(id, true, bidi);
  }

  private createStream(id: number, local: boolean, bidi: boolean): StreamState {
    const s = new StreamState(id, local, bidi);
    const p = this.peerParams ?? (this.isClient && (this.opts as ClientConnectionOptions).session?.transportParams && this.zeroRttWrite ? safeDecode((this.opts as ClientConnectionOptions).session!.transportParams!) : null);
    if (p && s.canSend) s.sendMax = this.initialSendMax(s, p);
    const lp = this.localParams;
    s.recvWindow = !bidi ? (lp.initialMaxStreamDataUni ?? 0) : local ? (lp.initialMaxStreamDataBidiLocal ?? 0) : (lp.initialMaxStreamDataBidiRemote ?? 0);
    s.recvMax = s.recvWindow;
    this.streams.set(id, s);
    return s;
  }

  private onStreamFrame(f: Extract<Frame, { type: 'stream' }>) {
    const s = this.peerStream(f.id, 'recv');
    if (!s) return;
    const end = f.offset + f.data.length;
    if (s.finalSize !== null && (end > s.finalSize || (f.fin && end !== s.finalSize))) throw new QuicError(TransportError.FINAL_SIZE_ERROR, `stream ${f.id} data past its final size`);
    if (f.fin) {
      if (end < s.recvHighest) throw new QuicError(TransportError.FINAL_SIZE_ERROR, 'FIN below received data');
      s.finalSize = end;
    }
    if (end > s.recvMax) throw new QuicError(TransportError.FLOW_CONTROL_ERROR, `stream ${f.id} over its flow control limit`);
    if (end > s.recvHighest) {
      this.recvData += end - s.recvHighest;
      s.recvHighest = end;
      if (this.recvData > this.localMaxData) throw new QuicError(TransportError.FLOW_CONTROL_ERROR, 'connection over its flow control limit');
    }
    if (s.resetReceived || s.stopSendingSent) return;
    if (end > s.recvOffset) s.recvChunks.set(f.offset, f.data);
    this.deliverStream(s);
  }

  private deliverStream(s: StreamState) {
    const parts: Buffer[] = [];
    for (;;) {
      let progressed = false;
      for (const [off, data] of s.recvChunks) {
        if (off <= s.recvOffset) {
          s.recvChunks.delete(off);
          const skip = s.recvOffset - off;
          if (skip < data.length) {
            parts.push(data.subarray(skip));
            s.recvOffset += data.length - skip;
          }
          progressed = true;
        }
      }
      if (!progressed) break;
    }
    const fin = s.finalSize !== null && s.recvOffset === s.finalSize && !s.finDelivered;
    if (!parts.length && !fin) return;
    const data = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
    if (fin) s.finDelivered = true;
    this.consumedData += data.length;
    if (this.opts.autoCredit !== false) {
      if (s.finalSize === null && s.recvMax - s.recvOffset < s.recvWindow / 2) {
        s.recvMax = s.recvOffset + s.recvWindow;
        this.pendingControl.push({ type: 'max_stream_data', id: s.id, max: s.recvMax });
      }
      const win = this.localParams.initialMaxData ?? 0;
      if (this.localMaxData - this.consumedData < win / 2) {
        this.localMaxData = this.consumedData + win;
        this.pendingControl.push({ type: 'max_data', max: this.localMaxData });
      }
    }
    this.ev.data?.(s.id, data, fin);
    this.maybeClose(s);
  }

  private maybeClose(s: StreamState) {
    if (s.closed) return;
    const sendDone = !s.canSend || s.finAcked || !!s.resetSent;
    const recvDone = !s.canRecv || s.finDelivered || !!s.resetReceived;
    if (!sendDone || !recvDone) return;
    s.closed = true;
    if (!s.local) {
      const k = s.bidi ? 'bidi' : 'uni';
      this.peerStreamsClosed[k]++;
      if (this.opts.autoStreamCredit !== false) {
        const initial = s.bidi ? (this.localParams.initialMaxStreamsBidi ?? 0) : (this.localParams.initialMaxStreamsUni ?? 0);
        const target = this.peerStreamsClosed[k] + initial;
        if (target - this.localMaxStreams[k] >= Math.max(1, Math.floor(initial / 2))) {
          this.localMaxStreams[k] = target;
          this.pendingControl.push({ type: 'max_streams', bidi: s.bidi, max: target });
        }
      }
    }
  }

  // --- TLS glue -----------------------------------------------------------

  private queueCrypto(level: Level, data: Buffer) {
    const sp = this.spaces[spaceOf(level)];
    sp.cryptoSend.push(data);
  }

  private installKeys(level: Level, dir: 'read' | 'write', suite: CipherSuite, secret: Buffer) {
    const keys = new PacketKeys(suite, secret);
    // A server knows the client's limits from its ClientHello: 0-RTT and 0.5-RTT data may use them.
    if (!this.isClient && !this.peerParams && this.tls?.peerTransportParams) {
      const p = safeDecode(this.tls.peerTransportParams);
      if (p) {
        this.peerParams = p;
        this.applyPeerLimits(p);
      }
    }
    if (level === '0rtt') {
      if (dir === 'write') this.zeroRttWrite = keys;
      else this.zeroRttRead = keys;
    } else {
      const sp = this.spaces[spaceOf(level)];
      if (dir === 'read') sp.readKeys = keys;
      else sp.writeKeys = keys;
      if (level === '1rtt' && dir === 'read') {
        this.appReadSecret = { suite, secret };
        this.nextReadKeys = keys.next();
      }
      if (level === '1rtt' && dir === 'write') this.appWriteSecret = { suite, secret };
    }
    // Retry packets that arrived before these keys.
    if (dir === 'read' && this.undecryptable.length) {
      const queued = this.undecryptable.splice(0);
      queueMicrotask(() => {
        for (const q of queued) this.receive(q.buf, q.from);
      });
    }
  }

  private onHandshakeComplete() {
    try {
      if (!this.tls.peerTransportParams) throw new QuicError(TransportError.TRANSPORT_PARAMETER_ERROR, 'no transport parameters');
      const p = decodeParams(this.tls.peerTransportParams);
      this.validatePeerParams(p);
      this.peerParams = p;
      if (this.isClient && this.tls.earlyDataOffered && !this.tls.earlyDataAccepted) this.zeroRttRejected();
      this.applyPeerLimits(p);
      if (p.maxIdleTimeout) this.idleTimeout = Math.min(this.idleTimeout || Infinity, p.maxIdleTimeout);
    } catch (e) {
      return this.fail(e as Error);
    }
    this.state = 'connected';
    if (!this.isClient) {
      this.handshakeConfirmed = true;
      this.pendingControl.push({ type: 'handshake_done' });
      this.tls.issueTicket();
      this.discard('handshake');
    }
    this.issueCids();
    this.ev.handshake?.();
    this.scheduleFlush();
  }

  /** Server refused 0-RTT: everything sent in it must go again in 1-RTT. */
  private zeroRttRejected() {
    const app = this.spaces.app;
    for (const [pn, p] of app.sent) {
      if (!p.zeroRtt) continue;
      app.sent.delete(pn);
      if (p.inFlight) this.bytesInFlight -= p.size;
      app.retransmit.push(...p.frames.filter((f) => f.type === 'stream' || f.type === 'reset_stream' || f.type === 'stop_sending'));
    }
    this.zeroRttWrite = undefined;
  }

  private validatePeerParams(p: TransportParams) {
    const bad = (m: string) => new QuicError(TransportError.TRANSPORT_PARAMETER_ERROR, m);
    if (this.isClient) {
      if (!p.originalDcid || !p.originalDcid.equals(this.originalDcid)) throw bad('original_destination_connection_id mismatch');
      if (!p.initialScid || !this.serverInitialScid || !p.initialScid.equals(this.serverInitialScid)) throw bad('initial_source_connection_id mismatch');
      if (this.retried && (!p.retryScid || !this.retryScid || !p.retryScid.equals(this.retryScid))) throw bad('retry_source_connection_id mismatch');
      if (p.statelessResetToken) this.peerCids.get(0)!.resetToken = p.statelessResetToken;
    } else {
      if (p.originalDcid || p.retryScid || p.statelessResetToken) throw bad('client sent a server-only transport parameter');
      if (!p.initialScid || !p.initialScid.equals(this.dcid)) throw bad('initial_source_connection_id mismatch');
    }
  }

  private issueCids() {
    if (this.state !== 'connected') return;
    const limit = Math.min(this.peerParams?.activeConnectionIdLimit ?? 2, 4);
    let seq = Math.max(...this.localCids.keys(), 0);
    while (this.localCids.size < limit) {
      seq++;
      const cid = randomBytes(this.scid.length);
      const resetToken = randomBytes(16);
      this.localCids.set(seq, { cid, resetToken });
      this.pendingControl.push({ type: 'new_connection_id', seq, retirePriorTo: 0, cid, resetToken });
      this.ev.newCid?.(cid);
    }
  }

  private discard(space: Space) {
    const sp = this.spaces[space];
    if (sp.discarded) return;
    sp.discarded = true;
    for (const p of sp.sent.values()) if (p.inFlight) this.bytesInFlight -= p.size;
    sp.sent.clear();
    sp.retransmit = [];
    sp.cryptoSend = [];
    sp.ackPending = false;
    sp.lossTime = Infinity;
    this.ptoCount = 0;
  }

  // --- recovery -----------------------------------------------------------

  private pto(): number {
    return this.srtt + Math.max(4 * this.rttvar, kGranularity) + (this.peerParams?.maxAckDelay ?? 25);
  }

  private onAck(f: Extract<Frame, { type: 'ack' }>, space: Space) {
    const sp = this.spaces[space];
    const largest = f.ranges[0]![1];
    if (largest >= sp.nextPn) throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'ACK for a packet never sent');
    const acked: SentPacket[] = [];
    for (const [low, high] of f.ranges) {
      if (high - low < sp.sent.size) {
        for (let pn = low; pn <= high; pn++) {
          const p = sp.sent.get(pn);
          if (p) acked.push(p);
        }
      } else for (const [pn, p] of sp.sent) if (pn >= low && pn <= high) acked.push(p);
    }
    if (!acked.length) return;
    if (largest > sp.largestAcked) sp.largestAcked = largest;
    const newest = acked.reduce((a, b) => (a.pn > b.pn ? a : b));
    if (newest.pn === largest && acked.some((p) => p.ackEliciting)) {
      this.latestRtt = now() - newest.time;
      const ackDelay = space === 'app' ? Math.min((f.delay * 2 ** (this.peerParams?.ackDelayExponent ?? 3)) / 1000, this.peerParams?.maxAckDelay ?? 25) : 0;
      this.updateRtt(ackDelay);
    }
    for (const p of acked) {
      sp.sent.delete(p.pn);
      if (p.inFlight) {
        this.bytesInFlight -= p.size;
        this.onPacketAckedCc(p);
      }
      this.onFramesAcked(p.frames);
    }
    this.detectLoss(space);
    this.ptoCount = 0;
  }

  private updateRtt(ackDelay: number) {
    if (!this.hasRttSample) {
      this.hasRttSample = true;
      this.minRtt = this.latestRtt;
      this.srtt = this.latestRtt;
      this.rttvar = this.latestRtt / 2;
      return;
    }
    this.minRtt = Math.min(this.minRtt, this.latestRtt);
    const adjusted = this.latestRtt >= this.minRtt + ackDelay ? this.latestRtt - ackDelay : this.latestRtt;
    this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - adjusted);
    this.srtt = 0.875 * this.srtt + 0.125 * adjusted;
  }

  private onFramesAcked(frames: Frame[]) {
    for (const f of frames) {
      if (f.type === 'stream') {
        const s = this.streams.get(f.id);
        if (!s) continue;
        s.sendAckedBytes += f.data.length;
        if (f.fin) s.finAckedPending = true;
        if (s.finAckedPending && s.sendAckedBytes >= s.sendOffset) {
          s.finAcked = true;
          this.maybeClose(s);
        }
      }
    }
  }

  private detectLoss(space: Space) {
    const sp = this.spaces[space];
    sp.lossTime = Infinity;
    if (sp.largestAcked < 0) return;
    const lossDelay = Math.max(kTimeThreshold * Math.max(this.latestRtt, this.srtt), kGranularity);
    const lostBefore = now() - lossDelay;
    const lost: SentPacket[] = [];
    for (const p of sp.sent.values()) {
      if (p.pn > sp.largestAcked) continue;
      if (p.time <= lostBefore || sp.largestAcked >= p.pn + kPacketThreshold) lost.push(p);
      else sp.lossTime = Math.min(sp.lossTime, p.time + lossDelay);
    }
    if (lost.length) this.onLost(space, lost);
  }

  private onLost(space: Space, lost: SentPacket[]) {
    const sp = this.spaces[space];
    let newestLost = 0;
    for (const p of lost) {
      sp.sent.delete(p.pn);
      if (p.inFlight) this.bytesInFlight -= p.size;
      newestLost = Math.max(newestLost, p.time);
      this.requeue(sp, p.frames);
    }
    if (newestLost > this.recoveryStart) {
      this.recoveryStart = now();
      this.ssthresh = Math.max(this.cwnd / 2, kMinCwnd);
      this.cwnd = this.ssthresh;
    }
  }

  /** Put the frames of a lost packet back, dropping ones that no longer matter. */
  private requeue(sp: PnSpace, frames: Frame[]) {
    for (const f of frames) {
      switch (f.type) {
        case 'ack':
        case 'padding':
        case 'path_challenge':
        case 'path_response':
          break;
        case 'stream': {
          const s = this.streams.get(f.id);
          if (s && !s.resetSent) sp.retransmit.push(f);
          break;
        }
        case 'max_data':
          if (f.max === this.localMaxData) sp.retransmit.push(f);
          break;
        case 'max_stream_data': {
          const s = this.streams.get(f.id);
          if (s && f.max === s.recvMax && s.finalSize === null) sp.retransmit.push(f);
          break;
        }
        default:
          sp.retransmit.push(f);
      }
    }
  }

  private onPacketAckedCc(p: SentPacket) {
    if (this.opts.noCongestion) return;
    if (p.time <= this.recoveryStart) return;
    if (this.cwnd < this.ssthresh) this.cwnd += p.size;
    else this.cwnd += (1200 * p.size) / this.cwnd;
  }

  private onTimer() {
    this.timer = undefined;
    this.timerAt = Infinity;
    const t = now();
    if (this.state === 'closing' || this.state === 'draining') {
      this.terminate();
      return;
    }
    if (t - this.lastActivity >= this.idleTimeout) {
      this.state = 'draining';
      this.emitClose({ code: 0, app: false, reason: 'idle timeout', remote: false });
      this.terminate();
      return;
    }
    // Loss timers first, then PTO.
    for (const s of SPACES) {
      const sp = this.spaces[s];
      if (sp.lossTime <= t) {
        this.detectLoss(s);
        this.flush();
        return;
      }
    }
    const pto = this.ptoDeadline();
    if (pto && pto.at <= t) {
      this.ptoCount++;
      const sp = this.spaces[pto.space];
      // Probe with the oldest unacknowledged data, or a PING.
      const inflight = [...sp.sent.values()].filter((p) => p.ackEliciting).sort((a, b) => a.pn - b.pn);
      const frames = inflight.slice(0, 2).flatMap((p) => p.frames);
      const before = sp.retransmit.length;
      this.requeue(sp, frames);
      if (sp.retransmit.length === before) sp.retransmit.push({ type: 'ping' });
      // Client before handshake confirmation: also probe Handshake if it has keys.
      if (this.isClient && !this.handshakeConfirmed && pto.space === 'initial' && this.spaces.handshake.writeKeys) this.spaces.handshake.retransmit.push({ type: 'ping' });
      this.flush(true);
      return;
    }
    this.flush();
  }

  private ptoDeadline(): { at: number; space: Space } | null {
    let best: { at: number; space: Space } | null = null;
    const backoff = 2 ** Math.min(this.ptoCount, 10);
    for (const s of SPACES) {
      const sp = this.spaces[s];
      if (sp.discarded || !sp.writeKeys) continue;
      if (s === 'app' && !this.handshakeConfirmed) continue;
      const eliciting = [...sp.sent.values()].some((p) => p.ackEliciting && p.inFlight);
      let at: number;
      if (eliciting) at = sp.lastAckElicitingTime + (this.pto() - (s === 'app' ? 0 : (this.peerParams?.maxAckDelay ?? 25))) * backoff;
      else if (this.isClient && !this.handshakeConfirmed && s !== 'app' && (s === 'handshake' || !this.spaces.handshake.writeKeys)) {
        // Anti-deadlock: keep probing until the server confirms the handshake.
        if (s === 'initial' && this.spaces.handshake.writeKeys) continue;
        at = Math.max(sp.lastAckElicitingTime, this.lastActivity) + (this.srtt + Math.max(4 * this.rttvar, kGranularity)) * backoff;
      } else continue;
      if (!best || at < best.at) best = { at, space: s };
    }
    return best;
  }

  private rearm() {
    if (this.state === 'closed') return;
    if (this.state === 'closing' || this.state === 'draining') return;
    let at = this.lastActivity + this.idleTimeout;
    for (const s of SPACES) {
      const sp = this.spaces[s];
      at = Math.min(at, sp.lossTime);
      if (sp.ackPending && this.opts.sendAcks !== false) at = Math.min(at, sp.ackDeadline);
    }
    const pto = this.ptoDeadline();
    if (pto) at = Math.min(at, pto.at);
    this.setTimer(at);
  }

  private setTimer(at: number) {
    if (at === this.timerAt && this.timer) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => this.onTimer(), Math.max(0, at - now()));
    this.timer.unref?.();
  }

  // --- output -------------------------------------------------------------

  private scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private ackFrame(sp: PnSpace): Frame | null {
    if (!sp.recv.length) return null;
    const ranges: AckRange[] = [...sp.recv].reverse().slice(0, 32).map(([l, h]) => [l, h]);
    const delayUs = Math.max(0, Math.round((now() - sp.largestRecvTime) * 1000));
    return { type: 'ack', ranges, delay: Math.floor(delayUs / 2 ** (this.localParams.ackDelayExponent ?? 3)) };
  }

  private maxDatagram(): number {
    const peerMax = this.peerParams?.maxUdpPayloadSize ?? 1200;
    return Math.min(this.opts.maxDatagram ?? 1200, peerMax);
  }

  private amplificationLeft(): number {
    if (this.addressValidated) return Infinity;
    return Math.max(0, 3 * this.bytesReceived - this.bytesSent);
  }

  /**
   * Build and send datagrams until nothing is left or limits stop us.
   * probe: send even if congestion control would block (PTO probes).
   */
  flush(probe = false): void {
    if (this.corked || this.state === 'closed' || this.state === 'draining' || this.state === 'closing') {
      if (this.state !== 'closed') this.rearm();
      return;
    }
    let budget = 64;
    while (budget-- > 0) {
      const dg = this.buildDatagram(probe);
      if (!dg) break;
      probe = false;
      this.bytesSent += dg.length;
      this.ev.send(dg, this.path);
    }
    this.rearm();
  }

  private buildDatagram(probe: boolean): Buffer | null {
    const max = Math.min(this.maxDatagram(), this.amplificationLeft());
    if (max < 64) return null;
    const ccRoom = this.opts.noCongestion || probe ? Infinity : this.cwnd - this.bytesInFlight;
    const parts: Array<{ space: Space; type: 'initial' | 'handshake' | '0rtt' | '1rtt'; frames: Frame[]; payloadLen: number; pnLen: 1 | 2 | 3 | 4; pn: number; keys: PacketKeys; overhead: number }> = [];
    let used = 0;
    const t = now();
    for (const space of SPACES) {
      const sp = this.spaces[space];
      if (sp.discarded) continue;
      let keys = sp.writeKeys;
      let type: 'initial' | 'handshake' | '0rtt' | '1rtt' = space === 'app' ? '1rtt' : space;
      if (space === 'app' && !keys && this.zeroRttWrite) {
        keys = this.zeroRttWrite;
        type = '0rtt';
      }
      if (!keys) continue;
      // Servers may not send 1-RTT before the handshake completes, except 0.5-RTT data. We allow it.
      const pn = sp.nextPn;
      const pnLen = packetNumberLength(pn, sp.largestAcked);
      const overhead = packetOverhead(type, this.dcid.length, this.scid.length, type === 'initial' ? (this.isClient ? this.retryToken.length : 0) : 0, pnLen);
      let room = max - used - overhead;
      if (room < 8) continue;
      const frames: Frame[] = [];
      let len = 0;
      const add = (f: Frame, size = frameSize(f)) => {
        frames.push(f);
        len += size;
        room -= size;
      };
      // ACK
      if (type !== '0rtt' && sp.ackPending && this.opts.sendAcks !== false && (sp.ackDeadline <= t || space !== 'app' || this.wantsToSend(space))) {
        const ack = this.ackFrame(sp);
        if (ack) {
          const size = frameSize(ack);
          if (size <= room) {
            add(ack, size);
            sp.ackPending = false;
            sp.ackElicitingSinceAck = 0;
            sp.ackDeadline = Infinity;
          }
        }
      }
      const elicitingRoom = ccRoom - used;
      if (elicitingRoom > 0) {
        // Retransmissions.
        while (sp.retransmit.length && room > 4) {
          const f = sp.retransmit[0]!;
          if (type === '0rtt' && !(f.type === 'stream' || f.type === 'ping' || f.type === 'reset_stream' || f.type === 'stop_sending' || f.type === 'max_data' || f.type === 'max_stream_data' || f.type === 'max_streams')) break;
          const size = frameSize(f);
          if (size > room) {
            if (f.type === 'stream' && room > 32) {
              // Split a too-large stream frame.
              const head = room - streamFrameOverhead(f.id, f.offset, room) - 1;
              if (head > 0) {
                sp.retransmit[0] = { ...f, offset: f.offset + head, data: f.data.subarray(head) };
                add({ type: 'stream', id: f.id, offset: f.offset, data: f.data.subarray(0, head), fin: false });
              }
            } else if (f.type === 'crypto' && room > 16) {
              const head = room - cryptoFrameOverhead(f.offset, room) - 1;
              if (head > 0) {
                sp.retransmit[0] = { ...f, offset: f.offset + head, data: f.data.subarray(head) };
                add({ type: 'crypto', offset: f.offset, data: f.data.subarray(0, head) });
              }
            }
            break;
          }
          sp.retransmit.shift();
          add(f, size);
        }
        // New CRYPTO data.
        while (sp.cryptoSend.length && room > 16 && type !== '0rtt') {
          const data = sp.cryptoSend[0]!;
          const head = Math.min(data.length, room - cryptoFrameOverhead(sp.cryptoSendOffset, room));
          if (head <= 0) break;
          add({ type: 'crypto', offset: sp.cryptoSendOffset, data: data.subarray(0, head) });
          sp.cryptoSendOffset += head;
          if (head === data.length) sp.cryptoSend.shift();
          else sp.cryptoSend[0] = data.subarray(head);
        }
        if (space === 'app') this.fillApp(add, () => room, type === '0rtt');
      }
      if (!frames.length) continue;
      // Make sure the header protection sample exists.
      if (len < minPayload(pnLen)) add({ type: 'padding', length: minPayload(pnLen) - len });
      sp.nextPn++;
      parts.push({ space, type, frames, payloadLen: len, pnLen, pn, keys, overhead });
      used += overhead + len;
      if (type === '0rtt' || type === '1rtt') break;
    }
    if (!parts.length) return null;
    // A datagram with an Initial is padded to 1200 bytes (RFC 9000 section 14.1).
    const hasInitial = parts.some((p) => p.type === 'initial');
    if (hasInitial && (this.isClient || parts.some((p) => p.type === 'initial' && p.frames.some(isAckEliciting))) && used < 1200) {
      const last = parts[parts.length - 1]!;
      const pad = 1200 - used;
      last.frames.push({ type: 'padding', length: pad });
      last.payloadLen += pad;
      used += pad;
    }
    const out: Buffer[] = [];
    for (const p of parts) {
      const payload = encodeFrames(p.frames);
      const pkt = buildPacket({
        type: p.type,
        dcid: this.dcid,
        scid: this.scid,
        token: this.isClient ? this.retryToken : undefined,
        pn: p.pn,
        pnLen: p.pnLen,
        payload,
        keys: p.keys,
        keyPhase: this.keyPhase,
      });
      out.push(pkt);
      const eliciting = p.frames.some(isAckEliciting);
      const sp = this.spaces[p.space];
      const sent: SentPacket = { pn: p.pn, time: t, size: pkt.length, ackEliciting: eliciting, inFlight: eliciting || p.frames.some((f) => f.type === 'padding'), frames: p.frames.filter((f) => f.type !== 'padding'), zeroRtt: p.type === '0rtt' };
      sp.sent.set(p.pn, sent);
      if (sent.inFlight) this.bytesInFlight += pkt.length;
      if (eliciting) sp.lastAckElicitingTime = t;
      this.logPacket('out', p.space, p.type, p.pn, pkt.length, p.frames);
      // RFC 9001 4.9.1: the client drops Initial keys when it first sends a Handshake packet.
      if (this.isClient && p.type === 'handshake') this.discardAfter.add('initial');
    }
    for (const s of this.discardAfter) this.discard(s);
    this.discardAfter.clear();
    return Buffer.concat(out);
  }

  private discardAfter = new Set<Space>();

  private wantsToSend(space: Space): boolean {
    if (space !== 'app') return true;
    return this.pendingControl.length > 0 || this.sendOrder.length > 0 || this.datagrams.length > 0;
  }

  /** Control frames, datagrams and stream data for an app-space packet. */
  private fillApp(add: (f: Frame, size?: number) => void, room: () => number, zeroRtt: boolean) {
    const allowed0rtt = new Set(['stream', 'reset_stream', 'stop_sending', 'max_data', 'max_stream_data', 'max_streams', 'data_blocked', 'stream_data_blocked', 'streams_blocked', 'ping', 'datagram']);
    const keep: Frame[] = [];
    while (this.pendingControl.length) {
      const f = this.pendingControl.shift()!;
      if (zeroRtt && !allowed0rtt.has(f.type)) {
        keep.push(f);
        continue;
      }
      if ((f.type === 'handshake_done' || f.type === 'new_connection_id') && !this.handshakeConfirmed && this.isClient) {
        keep.push(f);
        continue;
      }
      const size = frameSize(f);
      if (size > room()) {
        keep.push(f);
        break;
      }
      add(f, size);
    }
    this.pendingControl.unshift(...keep);
    while (this.datagrams.length && room() > this.datagrams[0]!.length + 4) add({ type: 'datagram', data: this.datagrams.shift()! });

    const order = this.sendOrder;
    let i = 0;
    let rotated = false;
    while (i < order.length && room() > 24) {
      const id = order[i]!;
      const s = this.streams.get(id);
      if (!s || s.resetSent) {
        order.splice(i, 1);
        continue;
      }
      const connRoom = this.peerMaxData - this.sentData;
      const streamRoom = s.sendMax - s.sendOffset;
      const r = room() - streamFrameOverhead(id, s.sendOffset, Math.min(room(), s.sendQueued));
      const n = Math.max(0, Math.min(s.sendQueued, connRoom, streamRoom, r));
      const finNow = s.finQueued && !s.finSent && n === s.sendQueued;
      if (n === 0 && !finNow) {
        if (s.sendQueued > 0) this.noteBlocked(s, connRoom, streamRoom);
        i++;
        continue;
      }
      const data = takeBytes(s, n);
      add({ type: 'stream', id, offset: s.sendOffset, data, fin: finNow });
      s.sendOffset += n;
      this.sentData += n;
      if (finNow) s.finSent = true;
      if (s.sendQueued === 0 && (!s.finQueued || s.finSent)) order.splice(i, 1);
      else if (this.opts.scheduler === 'round-robin' && !rotated) {
        // Next packet starts with the next stream.
        order.splice(i, 1);
        order.push(id);
        rotated = true;
      } else i++;
    }
  }

  private noteBlocked(s: StreamState, connRoom: number, streamRoom: number) {
    if (connRoom <= 0 && !this.blockedSent.has('data')) {
      this.blockedSent.add('data');
      this.pendingControl.push({ type: 'data_blocked', limit: this.peerMaxData });
    }
    if (streamRoom <= 0 && !this.blockedSent.has(`s:${s.id}`)) {
      this.blockedSent.add(`s:${s.id}`);
      this.pendingControl.push({ type: 'stream_data_blocked', id: s.id, limit: s.sendMax });
    }
  }

  /** Send frames on a specific path right away (path validation). */
  private sendOnPath(path: PathAddr, frames: Frame[]) {
    const sp = this.spaces.app;
    if (!sp.writeKeys) return;
    const pn = sp.nextPn++;
    const pnLen = packetNumberLength(pn, sp.largestAcked);
    let payload = encodeFrames(frames);
    // Path probes are padded to 1200 bytes (RFC 9000 section 8.2.1).
    const overhead = packetOverhead('1rtt', this.dcid.length, 0, 0, pnLen);
    if (payload.length + overhead < 1200) payload = Buffer.concat([payload, Buffer.alloc(1200 - overhead - payload.length)]);
    const pkt = buildPacket({ type: '1rtt', dcid: this.dcid, pn, pnLen, payload, keys: sp.writeKeys, keyPhase: this.keyPhase });
    sp.sent.set(pn, { pn, time: now(), size: pkt.length, ackEliciting: true, inFlight: false, frames: [], zeroRtt: false });
    this.logPacket('out', 'app', '1rtt', pn, pkt.length, frames);
    this.ev.send(pkt, path);
  }

  private sendClose() {
    if (!this.closeFrame) return;
    for (const space of [...SPACES].reverse()) {
      const sp = this.spaces[space];
      if (sp.discarded || !sp.writeKeys) continue;
      const f: Frame = space === 'app' || this.closeFrame.type !== 'connection_close' || !this.closeFrame.app ? this.closeFrame : { ...this.closeFrame, app: false, code: TransportError.APPLICATION_ERROR };
      const pn = sp.nextPn++;
      const pnLen = packetNumberLength(pn, sp.largestAcked);
      let payload = encodeFrames([f]);
      if (payload.length < 4) payload = Buffer.concat([payload, Buffer.alloc(4 - payload.length)]);
      const type = space === 'app' ? '1rtt' : space;
      const pkt = buildPacket({ type, dcid: this.dcid, scid: this.scid, token: this.isClient ? this.retryToken : undefined, pn, pnLen, payload, keys: sp.writeKeys, keyPhase: this.keyPhase });
      this.logPacket('out', space, type, pn, pkt.length, [f]);
      this.ev.send(space === 'initial' && this.isClient ? Buffer.concat([pkt, Buffer.alloc(Math.max(0, 1200 - pkt.length))]) : pkt, this.path);
      // One packet in the highest space we have is enough once the handshake is done.
      if (space === 'app') break;
    }
  }

  private fail(e: Error) {
    if (this.state === 'closed' || this.state === 'closing' || this.state === 'draining') return;
    const code = e instanceof QuicError ? e.code : TransportError.INTERNAL_ERROR;
    this.closeFrame = { type: 'connection_close', app: false, code, frameType: e instanceof QuicError ? e.frameType : 0, reason: e.message.slice(0, 200) };
    this.state = 'closing';
    this.sendClose();
    this.emitClose({ code, app: false, reason: e.message, remote: false });
    this.setTimer(now() + 3 * this.pto());
  }

  private emitClose(err: { code: number; app: boolean; reason: string; remote: boolean } | null) {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.closeReason = err;
    this.ev.close?.(err);
  }

  closeReason: { code: number; app: boolean; reason: string; remote: boolean } | null = null;

  /** Stop timers and drop all state. */
  terminate() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.state = 'closed';
    this.emitClose(null);
    this.ev.terminated?.();
  }

  private logPacket(dir: 'in' | 'out', space: Space, type: string, pn: number, size: number, frames: Frame[]) {
    const e: PacketLogEntry = { t: now(), dir, space, type, pn, size, frames: frames.map(describeFrame) };
    this.log.push(e);
    const limit = this.opts.logLimit ?? 2000;
    // Trim in batches: splicing one entry per packet is O(n) each time.
    if (this.log.length > limit * 1.25) this.log.splice(0, this.log.length - limit);
    this.ev.packet?.(e);
  }
}

function takeBytes(s: StreamState, n: number): Buffer {
  if (n === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let left = n;
  while (left > 0) {
    const head = s.sendQueue[0]!;
    if (head.length <= left) {
      parts.push(head);
      s.sendQueue.shift();
      left -= head.length;
    } else {
      parts.push(head.subarray(0, left));
      s.sendQueue[0] = head.subarray(left);
      left = 0;
    }
  }
  s.sendQueued -= n;
  return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
}

function safeDecode(b: Buffer): TransportParams | null {
  try {
    return decodeParams(b);
  } catch {
    return null;
  }
}

export { Writer };
