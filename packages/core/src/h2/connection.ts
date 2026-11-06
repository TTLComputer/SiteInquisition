/**
 * An HTTP/2 connection (RFC 9113) on any duplex byte stream, in the client
 * or server role. It does the protocol's bookkeeping (stream states, flow
 * control, SETTINGS, HPACK, CONTINUATION, PING, GOAWAY) and reports every
 * frame both ways, but leaves the choices to its user:
 *
 *  - The lab drives it to send what a normal client would not: raw frames,
 *    held credit, odd SETTINGS, headers split into many CONTINUATIONs.
 *  - The proxy runs two, one facing each side, and moves streams between
 *    them, so breakpoints and rules can stop or change anything in transit.
 *
 * `validate` (default on) refuses malformed requests and responses as RFC
 * 9113 section 8 says; the proxy turns it off so the far side judges them,
 * as it would without the proxy.
 */
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import {
  FrameError,
  FrameReader,
  H2Error,
  PREFACE,
  Setting,
  describeFrame,
  encodeFrame,
  frameTypeName,
  h2ErrorName,
  parseFrame,
  serializeFrame,
  type Frame,
  type PriorityInfo,
  type RawFrame,
} from './frames.js';
import { HpackDecoder, HpackEncoder, HpackError, type Field, type FieldRep, type HpackPolicy } from './hpack.js';

export type { Field } from './hpack.js';

export interface H2Settings {
  headerTableSize?: number;
  enablePush?: boolean;
  maxConcurrentStreams?: number;
  initialWindowSize?: number;
  maxFrameSize?: number;
  maxHeaderListSize?: number;
  enableConnectProtocol?: boolean;
  noRfc7540Priorities?: boolean;
  /** Further settings sent as they are: unknown ids (GREASE) or deliberately invalid values. */
  extra?: Array<[number, number]>;
}

export function settingsList(s: H2Settings): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (s.headerTableSize !== undefined) out.push([Setting.HEADER_TABLE_SIZE, s.headerTableSize]);
  if (s.enablePush !== undefined) out.push([Setting.ENABLE_PUSH, s.enablePush ? 1 : 0]);
  if (s.maxConcurrentStreams !== undefined) out.push([Setting.MAX_CONCURRENT_STREAMS, s.maxConcurrentStreams]);
  if (s.initialWindowSize !== undefined) out.push([Setting.INITIAL_WINDOW_SIZE, s.initialWindowSize]);
  if (s.maxFrameSize !== undefined) out.push([Setting.MAX_FRAME_SIZE, s.maxFrameSize]);
  if (s.maxHeaderListSize !== undefined) out.push([Setting.MAX_HEADER_LIST_SIZE, s.maxHeaderListSize]);
  if (s.enableConnectProtocol !== undefined) out.push([Setting.ENABLE_CONNECT_PROTOCOL, s.enableConnectProtocol ? 1 : 0]);
  if (s.noRfc7540Priorities !== undefined) out.push([Setting.NO_RFC7540_PRIORITIES, s.noRfc7540Priorities ? 1 : 0]);
  return [...out, ...(s.extra ?? [])];
}

/** The settings as numbers by id, starting from the RFC defaults. */
export type SettingsMap = Map<number, number>;
const defaults = (): SettingsMap =>
  new Map([
    [Setting.HEADER_TABLE_SIZE, 4096],
    [Setting.ENABLE_PUSH, 1],
    [Setting.MAX_CONCURRENT_STREAMS, 0xffffffff],
    [Setting.INITIAL_WINDOW_SIZE, 65_535],
    [Setting.MAX_FRAME_SIZE, 16_384],
    [Setting.MAX_HEADER_LIST_SIZE, 0xffffffff],
  ]);

export interface H2ConnectionOptions {
  role: 'client' | 'server';
  /** Our SETTINGS, sent first. */
  settings?: H2Settings;
  hpack?: HpackPolicy;
  /** Refuse malformed messages (default true). */
  validate?: boolean;
  /** Grant flow control credit back as data is read (default true). */
  autoCredit?: boolean;
  /** Answer SETTINGS with ACK (default true). Off tests a peer's SETTINGS_TIMEOUT. */
  autoAckSettings?: boolean;
  /** Answer PING with ACK (default true). */
  autoAckPing?: boolean;
  /** Raise the connection window to this right after the preface (default: leave it at 65535). */
  connectionWindow?: number;
  /** Client role: the preface is written already (h2c upgrade) or must not be (default false). */
  skipPreface?: boolean;
  /** Server role: the client's preface was consumed already (h2c upgrade). */
  prefaceRead?: boolean;
  /** Bytes of frame log kept (default 2 MB); older entries are dropped. */
  logLimit?: number;
}

export interface FrameLogEntry {
  /** ms since the connection started. */
  t: number;
  dir: 'in' | 'out';
  type: string;
  stream: number;
  flags: number;
  length: number;
  detail: string;
  /** Decoded header fields, for HEADERS, PUSH_PROMISE and CONTINUATION ending a block. */
  fields?: Field[];
  reps?: FieldRep[];
}

export interface HeadersInfo {
  endStream: boolean;
  priority?: PriorityInfo;
  /** 1xx response headers. */
  informational: boolean;
  /** A second HEADERS block after the message: trailers. */
  trailers: boolean;
}

type StreamState = 'idle' | 'open' | 'half-closed-local' | 'half-closed-remote' | 'closed' | 'reserved';

export interface SendHeadersOptions {
  endStream?: boolean;
  priority?: PriorityInfo;
  padding?: number;
  /** Split the header block into a HEADERS frame and CONTINUATIONs of this many bytes. */
  continuationSize?: number;
  /** Leave END_HEADERS off the last frame (the peer must then fail the connection). */
  omitEndHeaders?: boolean;
}

export interface WriteOptions {
  endStream?: boolean;
  padding?: number;
  /** DATA frames of at most this many bytes (default: the peer's max frame size). */
  chunkSize?: number;
}

export class H2Stream extends EventEmitter {
  state: StreamState = 'idle';
  /** What we may still send, and what the peer may still send us. */
  sendWindow: number;
  recvWindow: number;
  /** Bytes read but not yet credited back. */
  private unacked = 0;
  /** Hold flow-control credit for this stream: the peer stalls once our window fills. */
  creditHeld = false;
  receivedHeaders = false;
  /** Final (non-1xx) headers arrived; a later HEADERS block is trailers. */
  receivedFinalHeaders = false;
  receivedFinal = false;
  sentHeaders = false;
  resetCode?: number;
  resetBy?: 'local' | 'remote';
  private queue: Array<{ data: Buffer; endStream: boolean; padding?: number; chunkSize?: number; headers?: { fields: Field[]; opts: SendHeadersOptions } }> = [];
  readonly t0 = performance.now();

  constructor(
    readonly conn: H2Connection,
    readonly id: number,
  ) {
    super();
    this.sendWindow = conn.peerSetting(Setting.INITIAL_WINDOW_SIZE);
    this.recvWindow = conn.localSetting(Setting.INITIAL_WINDOW_SIZE);
  }

  get closed() {
    return this.state === 'closed';
  }

  /** HEADERS (and CONTINUATIONs). Used for requests, responses, interim responses and trailers. */
  sendHeaders(fields: Field[], opts: SendHeadersOptions = {}): void {
    // Trailers wait behind body bytes still waiting for credit.
    if (this.queue.length) {
      this.queue.push({ data: Buffer.alloc(0), endStream: false, headers: { fields, opts } });
      return;
    }
    this.conn.writeHeaders(this, fields, opts);
    this.sentHeaders = true;
    if (this.state === 'idle') this.state = 'open';
    if (opts.endStream) this.localEnded();
  }

  /** Body bytes, queued until the windows allow them. */
  write(data: Uint8Array, opts: WriteOptions = {}): void {
    this.queue.push({ data: Buffer.from(data), endStream: !!opts.endStream, padding: opts.padding, chunkSize: opts.chunkSize });
    this.flush();
  }

  end(data?: Uint8Array): void {
    this.write(data ?? Buffer.alloc(0), { endStream: true });
  }

  /** Bytes waiting for flow-control credit. */
  get queued(): number {
    return this.queue.reduce((n, q) => n + q.data.length, 0);
  }

  /** @internal Send what the windows allow. */
  flush(): void {
    while (this.queue.length && !this.closed && this.state !== 'half-closed-local') {
      const q = this.queue[0]!;
      if (q.headers) {
        this.queue.shift();
        this.sendHeaders(q.headers.fields, q.headers.opts);
        continue;
      }
      const max = Math.min(q.chunkSize ?? Infinity, this.conn.peerSetting(Setting.MAX_FRAME_SIZE) - (q.padding !== undefined ? q.padding + 1 : 0));
      const room = Math.min(this.sendWindow, this.conn.sendWindow);
      if (q.data.length > 0 && room <= 0) return;
      const n = Math.min(q.data.length, max, room);
      const chunk = q.data.subarray(0, n);
      q.data = q.data.subarray(n);
      const last = q.data.length === 0;
      if (last) this.queue.shift();
      this.sendWindow -= n;
      this.conn.sendWindow -= n;
      const endStream = last && q.endStream;
      this.conn.writeFrame({ type: 'DATA', stream: this.id, data: chunk, endStream, ...(q.padding !== undefined ? { padding: q.padding } : {}) });
      if (endStream) this.localEnded();
    }
  }

  reset(code: number = H2Error.CANCEL): void {
    if (this.closed) return;
    this.conn.writeFrame({ type: 'RST_STREAM', stream: this.id, code });
    this.resetCode = code;
    this.resetBy = 'local';
    this.close();
  }

  /** Change our receive window by hand (the lab's flow-control controls). */
  grant(increment: number): void {
    this.conn.writeFrame({ type: 'WINDOW_UPDATE', stream: this.id, increment });
    this.recvWindow += increment;
  }

  holdCredit(hold: boolean): void {
    this.creditHeld = hold;
    if (!hold) this.creditBack(0);
  }

  priority(p: PriorityInfo): void {
    this.conn.writeFrame({ type: 'PRIORITY', stream: this.id, priority: p });
  }

  /** @internal */
  creditBack(n: number): void {
    this.unacked += n;
    if (this.creditHeld || !this.conn.autoCredit || this.closed || this.receivedFinal) return;
    const initial = this.conn.localSetting(Setting.INITIAL_WINDOW_SIZE);
    if (this.unacked > 0 && (this.unacked >= initial / 2 || this.recvWindow < initial / 2)) {
      const inc = this.unacked;
      this.unacked = 0;
      this.grant(inc);
    }
  }

  private localEnded() {
    if (this.state === 'half-closed-remote') this.close();
    else if (this.state === 'open' || this.state === 'idle') this.state = 'half-closed-local';
  }

  /** @internal */
  remoteEnded() {
    this.receivedFinal = true;
    if (this.state === 'half-closed-local' || this.state === 'reserved') this.close();
    else if (this.state === 'open' || this.state === 'idle') this.state = 'half-closed-remote';
    this.emit('end');
  }

  /** @internal */
  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.queue = [];
    this.conn.forget(this);
    this.emit('close');
  }
}

export interface H2ConnectionEvents {
  /** A stream the peer opened: a request (server role) or a push (client role). */
  stream: [H2Stream, Field[], HeadersInfo];
  frame: [FrameLogEntry, Frame];
  /** The peer's SETTINGS were applied. */
  settings: [SettingsMap];
  settingsAck: [];
  ping: [Buffer, boolean];
  goaway: [{ lastStream: number; code: number; debug: Buffer }];
  /** A protocol error: ours ("local", we sent GOAWAY) or theirs. */
  error: [Error & { code?: number }];
  close: [];
}

let counter = 0;

export class H2Connection extends EventEmitter<H2ConnectionEvents> {
  readonly id = ++counter;
  readonly role: 'client' | 'server';
  readonly t0 = performance.now();
  readonly log: FrameLogEntry[] = [];
  private logBytes = 0;
  private reader = new FrameReader();
  readonly encoder: HpackEncoder;
  readonly decoder = new HpackDecoder();
  private local = defaults();
  private remote = defaults();
  /** Settings we sent and the peer has not acknowledged, oldest first. */
  private pendingLocal: Array<Array<[number, number]>> = [];
  private streams = new Map<number, H2Stream>();
  private nextId: number;
  private lastPeerStream = 0;
  sendWindow = 65_535;
  recvWindow = 65_535;
  private recvUnacked = 0;
  private continuing?: { stream: number; parts: Buffer[]; endStream: boolean; priority?: PriorityInfo; promised?: number };
  private prefaceLeft: number;
  autoCredit: boolean;
  goawaySent?: { lastStream: number; code: number };
  goawayReceived?: { lastStream: number; code: number; debug: Buffer };
  closed = false;
  /** The connection error that closed us, when we failed the connection. */
  lastError?: Error & { code?: number; local?: boolean };
  /** Peer streams refused because they went over our MAX_CONCURRENT_STREAMS. */
  refused = 0;

  constructor(
    readonly socket: Duplex,
    private readonly opts: H2ConnectionOptions,
  ) {
    super();
    this.role = opts.role;
    this.nextId = opts.role === 'client' ? 1 : 2;
    this.autoCredit = opts.autoCredit ?? true;
    this.encoder = new HpackEncoder(opts.hpack);
    this.prefaceLeft = opts.role === 'server' && !opts.prefaceRead ? PREFACE.length : 0;
    socket.on('data', (c: Buffer) => this.onData(c));
    socket.once('close', () => this.onClose());
    socket.once('end', () => this.onClose());
    socket.on('error', () => this.onClose());
    if (opts.role === 'client' && !opts.skipPreface) socket.write(PREFACE);
    const ours = settingsList(opts.settings ?? {});
    this.sendSettings(ours);
    if (opts.connectionWindow && opts.connectionWindow > 65_535) this.grantConnection(opts.connectionWindow - 65_535);
  }

  /**
   * The h2c upgrade's request is stream 1, half closed on the client's side
   * (RFC 7540 section 3.2). On the server, pass the upgraded request's fields
   * (from the HTTP/1.1 head) and a "stream" event fires for it, as if it had
   * arrived as HEADERS with END_STREAM.
   */
  adoptUpgradeStream(fields?: Field[]): H2Stream {
    const s = new H2Stream(this, 1);
    s.state = this.role === 'client' ? 'half-closed-local' : 'half-closed-remote';
    s.sentHeaders = this.role === 'client';
    s.receivedHeaders = this.role === 'server';
    s.receivedFinalHeaders = this.role === 'server';
    s.receivedFinal = this.role === 'server';
    this.streams.set(1, s);
    if (this.role === 'client') this.nextId = 3;
    else {
      this.lastPeerStream = 1;
      if (fields)
        queueMicrotask(() => {
          this.emit('stream', s, fields, { endStream: true, informational: false, trailers: false });
          // The upgraded request's body (if any) came over HTTP/1.1, so it is complete.
          s.emit('data', Buffer.alloc(0), true);
          s.emit('end');
        });
    }
    return s;
  }

  localSetting(id: number): number {
    return this.local.get(id) ?? 0;
  }
  peerSetting(id: number): number {
    return this.remote.get(id) ?? 0;
  }
  get peerSettings(): SettingsMap {
    return new Map(this.remote);
  }
  get openStreams(): number {
    return this.streams.size;
  }
  stream(id: number): H2Stream | undefined {
    return this.streams.get(id);
  }
  now(): number {
    return Math.round((performance.now() - this.t0) * 1000) / 1000;
  }

  // --- sending ----------------------------------------------------------

  /** Write one frame exactly as given (no checks), and log it. */
  writeFrame(f: Frame, extra: Pick<FrameLogEntry, 'fields' | 'reps'> = {}): void {
    this.writeRaw(serializeFrame(f), f, extra);
  }

  writeRaw(raw: RawFrame, typed?: Frame, extra: Pick<FrameLogEntry, 'fields' | 'reps'> = {}): void {
    if (this.socket.destroyed) return;
    const bytes = encodeFrame(raw);
    this.socket.write(bytes);
    let parsed = typed;
    if (!parsed) {
      try {
        parsed = parseFrame(raw);
      } catch {
        parsed = { type: 'UNKNOWN', stream: raw.stream, frameType: raw.type, flags: raw.flags, payload: raw.payload };
      }
    }
    this.record('out', raw, parsed, extra);
  }

  /** Bytes straight onto the connection, outside any frame (for malformed-input tests). */
  writeBytes(b: Uint8Array): void {
    if (!this.socket.destroyed) this.socket.write(b);
  }

  /** A new stream on our side; HEADERS go out when the caller sends them. */
  openStream(): H2Stream {
    const s = new H2Stream(this, this.nextId);
    this.nextId += 2;
    this.streams.set(s.id, s);
    return s;
  }

  /** Client role: open a stream and send the request headers. */
  request(fields: Field[], opts: SendHeadersOptions = {}): H2Stream {
    const s = this.openStream();
    s.sendHeaders(fields, opts);
    return s;
  }

  /** @internal */
  writeHeaders(s: H2Stream, fields: Field[], opts: SendHeadersOptions): void {
    const block = this.encoder.encode(fields);
    const max = this.peerSetting(Setting.MAX_FRAME_SIZE);
    const size = Math.max(1, Math.min(opts.continuationSize ?? max, max));
    const first = block.subarray(0, size);
    let rest = block.subarray(first.length);
    const onlyOne = rest.length === 0;
    this.writeFrame(
      { type: 'HEADERS', stream: s.id, block: first, endStream: !!opts.endStream, endHeaders: onlyOne && !opts.omitEndHeaders, ...(opts.priority ? { priority: opts.priority } : {}), ...(opts.padding !== undefined ? { padding: opts.padding } : {}) },
      onlyOne ? { fields } : {},
    );
    while (rest.length) {
      const part = rest.subarray(0, size);
      rest = rest.subarray(part.length);
      const last = rest.length === 0;
      this.writeFrame({ type: 'CONTINUATION', stream: s.id, block: part, endHeaders: last && !opts.omitEndHeaders }, last ? { fields } : {});
    }
  }

  sendSettings(list: Array<[number, number]>): void {
    this.pendingLocal.push(list);
    this.writeFrame({ type: 'SETTINGS', ack: false, settings: list });
  }

  ping(data: Buffer = Buffer.alloc(8)): void {
    this.writeFrame({ type: 'PING', ack: false, data });
  }

  goaway(code: number = H2Error.NO_ERROR, debug = '', lastStream = this.lastPeerStream): void {
    this.goawaySent = { lastStream, code };
    this.writeFrame({ type: 'GOAWAY', lastStream, code, debug: Buffer.from(debug) });
  }

  grantConnection(increment: number): void {
    this.recvWindow += increment;
    this.writeFrame({ type: 'WINDOW_UPDATE', stream: 0, increment });
  }

  /** GOAWAY (if not sent), then close the socket once written. */
  close(code: number = H2Error.NO_ERROR, debug = ''): void {
    if (this.closed) return;
    if (!this.goawaySent) this.goaway(code, debug);
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }

  // --- receiving --------------------------------------------------------

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    if (this.prefaceLeft) {
      const n = Math.min(this.prefaceLeft, chunk.length);
      const want = PREFACE.subarray(PREFACE.length - this.prefaceLeft, PREFACE.length - this.prefaceLeft + n);
      if (!chunk.subarray(0, n).equals(want)) return this.fail(new FrameError('the client did not send the HTTP/2 preface', H2Error.PROTOCOL_ERROR));
      this.prefaceLeft -= n;
      chunk = chunk.subarray(n);
      if (!chunk.length) return;
    }
    let frames: RawFrame[];
    try {
      this.reader.maxSize = Math.max(this.localSetting(Setting.MAX_FRAME_SIZE), 16_384);
      frames = this.reader.push(chunk);
    } catch (err) {
      return this.fail(err as FrameError);
    }
    for (const raw of frames) {
      if (this.closed) return;
      try {
        this.onFrame(raw);
      } catch (err) {
        const e = err as FrameError;
        if (e instanceof FrameError && e.stream !== undefined) {
          const s = this.streams.get(e.stream);
          if (s) s.reset(e.code);
          else this.writeFrame({ type: 'RST_STREAM', stream: e.stream, code: e.code });
        } else this.fail(e);
      }
    }
  }

  private fail(err: Error & { code?: number }): void {
    const code = err instanceof HpackError ? H2Error.COMPRESSION_ERROR : (err.code ?? H2Error.PROTOCOL_ERROR);
    if (!this.goawaySent) this.goaway(code, err.message);
    this.lastError = Object.assign(err, { code, local: true });
    // A connection error is reflected in GOAWAY, the socket closing and every
    // open stream aborting, so a caller that is not listening for 'error'
    // still sees it. Emitting to no listener would crash the process (Node
    // rethrows), which a tool pointed at a broken server must never do.
    if (this.listenerCount('error') > 0) this.emit('error', this.lastError);
    this.socket.end();
    this.onClose();
  }

  private record(dir: 'in' | 'out', raw: RawFrame, f: Frame, extra: Pick<FrameLogEntry, 'fields' | 'reps'> = {}): void {
    const entry: FrameLogEntry = { t: this.now(), dir, type: frameTypeName(raw.type), stream: raw.stream, flags: raw.flags, length: raw.payload.length, detail: describeFrame(f), ...extra };
    const cost = 64 + entry.detail.length + (entry.fields?.reduce((n, [k, v]) => n + k.length + v.length, 0) ?? 0);
    this.log.push(entry);
    this.logBytes += cost;
    const limit = this.opts.logLimit ?? 2 * 1024 * 1024;
    while (this.logBytes > limit && this.log.length > 1) this.logBytes -= 64 + this.log.shift()!.detail.length;
    this.emit('frame', entry, f);
  }

  private onFrame(raw: RawFrame): void {
    const f = parseFrame(raw);
    if (this.continuing && (f.type !== 'CONTINUATION' || f.stream !== this.continuing.stream)) {
      throw new FrameError(`expected CONTINUATION on stream ${this.continuing.stream}, got ${frameTypeName(raw.type)}`, H2Error.PROTOCOL_ERROR);
    }
    let extra: Pick<FrameLogEntry, 'fields' | 'reps'> = {};
    const finishBlock = (stream: number, parts: Buffer[]) => {
      const d = this.decoder.decode(Buffer.concat(parts));
      extra = { fields: d.fields, reps: d.reps };
      return d.fields;
    };
    switch (f.type) {
      case 'DATA': {
        this.record('in', raw, f);
        // Padding counts against flow control too.
        const flowed = raw.payload.length;
        this.recvWindow -= flowed;
        if (this.recvWindow < 0) throw new FrameError('the peer sent more than the connection window', H2Error.FLOW_CONTROL_ERROR);
        this.connectionCredit(flowed);
        const s = this.streams.get(f.stream);
        if (!s) {
          if (f.stream > this.highestSeen(f.stream)) throw new FrameError(`DATA on idle stream ${f.stream}`, H2Error.PROTOCOL_ERROR);
          throw new FrameError(`DATA on closed stream ${f.stream}`, H2Error.STREAM_CLOSED, f.stream);
        }
        if (s.state === 'half-closed-remote') throw new FrameError(`DATA after the end of stream ${f.stream}`, H2Error.STREAM_CLOSED, f.stream);
        if (!s.receivedHeaders && this.opts.validate !== false) throw new FrameError(`DATA before HEADERS on stream ${f.stream}`, H2Error.PROTOCOL_ERROR, f.stream);
        s.recvWindow -= flowed;
        if (s.recvWindow < 0) throw new FrameError(`stream ${f.stream} went over its window`, H2Error.FLOW_CONTROL_ERROR, f.stream);
        if (f.data.length) s.emit('data', f.data, f.endStream);
        else if (f.endStream) s.emit('data', f.data, true);
        s.creditBack(flowed);
        if (f.endStream) s.remoteEnded();
        return;
      }
      case 'HEADERS': {
        if (!f.endHeaders) {
          this.continuing = { stream: f.stream, parts: [f.block], endStream: f.endStream, ...(f.priority ? { priority: f.priority } : {}) };
          this.record('in', raw, f);
          return;
        }
        const fields = finishBlock(f.stream, [f.block]);
        this.record('in', raw, f, extra);
        return this.onHeaders(f.stream, fields, f.endStream, f.priority);
      }
      case 'CONTINUATION': {
        if (!this.continuing) throw new FrameError('CONTINUATION without HEADERS', H2Error.PROTOCOL_ERROR);
        this.continuing.parts.push(f.block);
        if (!f.endHeaders) return this.record('in', raw, f);
        const c = this.continuing;
        this.continuing = undefined;
        const fields = finishBlock(c.stream, c.parts);
        this.record('in', raw, f, extra);
        if (c.promised !== undefined) return this.onPush(c.stream, c.promised, fields);
        return this.onHeaders(c.stream, fields, c.endStream, c.priority);
      }
      case 'PRIORITY':
        this.record('in', raw, f);
        if (f.priority.dependsOn === f.stream) throw new FrameError('stream depends on itself', H2Error.PROTOCOL_ERROR, f.stream);
        this.streams.get(f.stream)?.emit('priority', f.priority);
        return;
      case 'RST_STREAM': {
        this.record('in', raw, f);
        const s = this.streams.get(f.stream);
        if (!s && f.stream > this.highestSeen(f.stream)) throw new FrameError(`RST_STREAM on idle stream ${f.stream}`, H2Error.PROTOCOL_ERROR);
        if (s) {
          s.resetCode = f.code;
          s.resetBy = 'remote';
          s.emit('reset', f.code);
          s.close();
        }
        return;
      }
      case 'SETTINGS':
        this.record('in', raw, f);
        if (f.ack) {
          const list = this.pendingLocal.shift();
          if (list) this.applyLocal(list);
          this.emit('settingsAck');
          return;
        }
        this.applyRemote(f.settings);
        if (this.opts.autoAckSettings !== false) this.writeFrame({ type: 'SETTINGS', ack: true, settings: [] });
        this.emit('settings', new Map(this.remote));
        return;
      case 'PUSH_PROMISE': {
        if (this.role === 'server') throw new FrameError('a client sent PUSH_PROMISE', H2Error.PROTOCOL_ERROR);
        if (!this.localSetting(Setting.ENABLE_PUSH)) throw new FrameError('PUSH_PROMISE with push disabled', H2Error.PROTOCOL_ERROR);
        if (!f.endHeaders) {
          this.continuing = { stream: f.stream, parts: [f.block], endStream: false, promised: f.promised };
          return this.record('in', raw, f);
        }
        const fields = finishBlock(f.stream, [f.block]);
        this.record('in', raw, f, extra);
        return this.onPush(f.stream, f.promised, fields);
      }
      case 'PING':
        this.record('in', raw, f);
        this.emit('ping', f.data, f.ack);
        if (!f.ack && this.opts.autoAckPing !== false) this.writeFrame({ type: 'PING', ack: true, data: f.data });
        return;
      case 'GOAWAY':
        this.record('in', raw, f);
        this.goawayReceived = { lastStream: f.lastStream, code: f.code, debug: f.debug };
        this.emit('goaway', this.goawayReceived);
        // Streams we opened above lastStream were never processed: the peer refused them.
        for (const s of [...this.streams.values()]) {
          if (this.ours(s.id) && s.id > f.lastStream) {
            s.resetCode = H2Error.REFUSED_STREAM;
            s.resetBy = 'remote';
            s.emit('reset', H2Error.REFUSED_STREAM);
            s.close();
          }
        }
        return;
      case 'WINDOW_UPDATE': {
        this.record('in', raw, f);
        if (f.increment === 0) throw new FrameError('WINDOW_UPDATE of 0', H2Error.PROTOCOL_ERROR, f.stream || undefined);
        if (f.stream === 0) {
          this.sendWindow += f.increment;
          if (this.sendWindow > 0x7fffffff) throw new FrameError('connection window over 2^31-1', H2Error.FLOW_CONTROL_ERROR);
          for (const s of this.streams.values()) s.flush();
        } else {
          const s = this.streams.get(f.stream);
          if (!s) return;
          s.sendWindow += f.increment;
          if (s.sendWindow > 0x7fffffff) throw new FrameError(`stream ${f.stream} window over 2^31-1`, H2Error.FLOW_CONTROL_ERROR, f.stream);
          s.flush();
        }
        return;
      }
      case 'UNKNOWN':
        // Unknown frame types are ignored (RFC 9113 section 4.1), but the lab and proxy still see them.
        this.record('in', raw, f);
        this.streams.get(f.stream)?.emit('unknown', f);
        return;
    }
  }

  private ours(id: number) {
    return (id % 2 === 1) === (this.role === 'client');
  }

  /** The highest stream id the other side of `id` has used, to tell idle streams from closed ones. */
  private highestSeen(id: number): number {
    return this.ours(id) ? this.nextId - 2 : this.lastPeerStream;
  }

  private onHeaders(id: number, fields: Field[], endStream: boolean, priority?: PriorityInfo): void {
    let s = this.streams.get(id);
    let isNew = false;
    if (!s) {
      if (this.ours(id)) {
        if (id <= this.nextId - 2) throw new FrameError(`HEADERS on closed stream ${id}`, H2Error.STREAM_CLOSED, id);
        throw new FrameError(`HEADERS on idle stream ${id} of ours`, H2Error.PROTOCOL_ERROR);
      }
      if (this.role === 'client') throw new FrameError('a server opened a stream with HEADERS', H2Error.PROTOCOL_ERROR);
      if (id <= this.lastPeerStream) throw new FrameError(`stream ${id} was already used`, H2Error.STREAM_CLOSED);
      this.lastPeerStream = id;
      if (this.goawaySent && id > this.goawaySent.lastStream) return;
      s = new H2Stream(this, id);
      s.state = 'open';
      if (this.streams.size >= this.localSetting(Setting.MAX_CONCURRENT_STREAMS)) {
        this.refused++;
        this.writeFrame({ type: 'RST_STREAM', stream: id, code: H2Error.REFUSED_STREAM });
        return;
      }
      this.streams.set(id, s);
      isNew = true;
    }
    if (s.state === 'half-closed-remote' || s.closed) throw new FrameError(`HEADERS after the end of stream ${id}`, H2Error.STREAM_CLOSED, id);
    const status = Number(fields.find(([k]) => k === ':status')?.[1]);
    const informational = this.role === 'client' && status >= 100 && status < 200;
    const trailers = s.receivedFinalHeaders && !informational;
    if (this.opts.validate !== false) {
      const why = validateFields(fields, this.role === 'server' ? (trailers ? 'trailers' : 'request') : trailers ? 'trailers' : 'response');
      if (why) throw new FrameError(why, H2Error.PROTOCOL_ERROR, id);
      if (trailers && !endStream) throw new FrameError('trailers without END_STREAM', H2Error.PROTOCOL_ERROR, id);
    }
    s.receivedHeaders = true;
    if (!informational) s.receivedFinalHeaders = true;
    const info: HeadersInfo = { endStream, informational, trailers, ...(priority ? { priority } : {}) };
    if (isNew) this.emit('stream', s, fields, info);
    else s.emit('headers', fields, info);
    if (endStream) s.remoteEnded();
  }

  private onPush(id: number, promised: number, fields: Field[]): void {
    const parent = this.streams.get(id);
    if (!parent) throw new FrameError(`PUSH_PROMISE on unknown stream ${id}`, H2Error.PROTOCOL_ERROR);
    const s = new H2Stream(this, promised);
    s.state = 'reserved';
    this.streams.set(promised, s);
    parent.emit('push', s, fields);
  }

  private applyRemote(list: Array<[number, number]>): void {
    for (const [id, v] of list) {
      if (id === Setting.ENABLE_PUSH && v > 1) throw new FrameError('ENABLE_PUSH over 1', H2Error.PROTOCOL_ERROR);
      if (id === Setting.INITIAL_WINDOW_SIZE && v > 0x7fffffff) throw new FrameError('INITIAL_WINDOW_SIZE over 2^31-1', H2Error.FLOW_CONTROL_ERROR);
      if (id === Setting.MAX_FRAME_SIZE && (v < 16_384 || v > 16_777_215)) throw new FrameError(`MAX_FRAME_SIZE ${v} out of range`, H2Error.PROTOCOL_ERROR);
      if (id === Setting.INITIAL_WINDOW_SIZE) {
        const delta = v - this.peerSetting(Setting.INITIAL_WINDOW_SIZE);
        for (const s of this.streams.values()) s.sendWindow += delta;
      }
      if (id === Setting.HEADER_TABLE_SIZE) this.encoder.setPeerMax(v);
      this.remote.set(id, v);
    }
    for (const s of this.streams.values()) s.flush();
  }

  private applyLocal(list: Array<[number, number]>): void {
    for (const [id, v] of list) {
      if (id === Setting.INITIAL_WINDOW_SIZE) {
        const delta = v - this.localSetting(Setting.INITIAL_WINDOW_SIZE);
        for (const s of this.streams.values()) s.recvWindow += delta;
      }
      if (id === Setting.HEADER_TABLE_SIZE) this.decoder.setLimit(v);
      this.local.set(id, v);
    }
  }

  private connectionCredit(n: number): void {
    this.recvUnacked += n;
    if (!this.autoCredit) return;
    if (this.recvUnacked >= 32_768 || this.recvWindow < 32_768) {
      const inc = this.recvUnacked;
      this.recvUnacked = 0;
      this.grantConnection(inc);
    }
  }

  /** @internal */
  forget(s: H2Stream): void {
    this.streams.delete(s.id);
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of [...this.streams.values()]) {
      if (!s.closed) {
        s.emit('aborted');
        s.close();
      }
    }
    this.emit('close');
  }
}

const CONNECTION_SPECIFIC = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);
const REQUEST_PSEUDO = new Set([':method', ':scheme', ':authority', ':path', ':protocol']);

/** RFC 9113 section 8.2 and 8.3: why a field list is malformed, or undefined. */
export function validateFields(fields: Field[], kind: 'request' | 'response' | 'trailers'): string | undefined {
  let regular = false;
  const seen = new Set<string>();
  for (const [k, v] of fields) {
    if (k !== k.toLowerCase()) return `header name "${k}" is not lowercase`;
    if (/[\r\n\0]/.test(v)) return `header "${k}" has a CR, LF or NUL in its value`;
    if (k.startsWith(':')) {
      if (regular) return `pseudo-header ${k} after a regular header`;
      if (kind === 'trailers') return `pseudo-header ${k} in trailers`;
      const allowed = kind === 'request' ? REQUEST_PSEUDO.has(k) : k === ':status';
      if (!allowed) return `pseudo-header ${k} is not allowed in a ${kind}`;
      if (seen.has(k)) return `pseudo-header ${k} appears twice`;
      seen.add(k);
      continue;
    }
    regular = true;
    if (CONNECTION_SPECIFIC.has(k)) return `connection-specific header "${k}"`;
    if (k === 'te' && v.trim().toLowerCase() !== 'trailers') return `te: ${v} (only "trailers" is allowed)`;
  }
  if (kind === 'request') {
    const method = fields.find(([k]) => k === ':method')?.[1];
    if (!method) return 'request without :method';
    if (method !== 'CONNECT' && (!seen.has(':scheme') || !seen.has(':path'))) return 'request without :scheme or :path';
    if (seen.has(':path') && fields.find(([k]) => k === ':path')![1] === '') return 'empty :path';
  }
  if (kind === 'response' && !seen.has(':status')) return 'response without :status';
  return undefined;
}

export { h2ErrorName, H2Error };

export interface CollectedResponse {
  status: number;
  headers: Field[];
  body: Buffer;
  trailers: Field[];
  informational: Array<{ status: number; headers: Field[] }>;
  /** Set when the stream was reset or the connection closed before the end. */
  reset?: { code: number; by: 'local' | 'remote' } | 'aborted';
}

/** Gather a response on a client stream: interim responses, headers, body and trailers. */
export function collectResponse(s: H2Stream): Promise<CollectedResponse> {
  return new Promise((resolve) => {
    const out: CollectedResponse = { status: 0, headers: [], body: Buffer.alloc(0), trailers: [], informational: [] };
    const parts: Buffer[] = [];
    const done = () => {
      out.body = Buffer.concat(parts);
      resolve(out);
    };
    s.on('headers', (fields: Field[], info: HeadersInfo) => {
      const status = Number(fields.find(([k]) => k === ':status')?.[1]);
      if (info.informational) out.informational.push({ status, headers: fields.filter(([k]) => !k.startsWith(':')) });
      else if (info.trailers) out.trailers = fields;
      else {
        out.status = status;
        out.headers = fields.filter(([k]) => !k.startsWith(':'));
      }
    });
    s.on('data', (d: Buffer) => parts.push(d));
    s.once('end', done);
    s.once('reset', (code: number) => {
      out.reset = { code, by: 'remote' };
      done();
    });
    s.once('aborted', () => {
      out.reset = 'aborted';
      done();
    });
    s.once('close', () => {
      if (s.resetBy === 'local') out.reset = { code: s.resetCode ?? 0, by: 'local' };
      done();
    });
  });
}
