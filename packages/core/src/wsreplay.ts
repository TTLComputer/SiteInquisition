import { EventEmitter } from 'node:events';
import type { FieldCodec } from '@siteinquisition/codecs';
import { MessageAssembler, UnexpectedResponse, connectWebSocket, type AssembledMessage, type WsConnection } from './websocket.js';
import { buildPlan, runPlan, validatePlan, type PlanStep, type SentStep } from './wsplan.js';
import type { CaptureStore, HeaderList, StreamMessage } from './store.js';
import { hasTokens, resolveTokens, type TokenContext } from './tokens.js';
import {
  extractFromMessage,
  isHeartbeat,
  prepareText,
  scriptFromMessages,
  sendBatch,
  stepBytes,
  validateScript,
  waitMatches,
  type WsScript,
  type WsScriptStep,
  type WsStepResult,
} from './wsscript.js';

/**
 * WebSocket replays: open a new connection like a captured one (same URL,
 * cookies and headers, or edited ones), then send messages or exact frame
 * plans on it and record both directions frame by frame.
 */
const SKIP = new Set(['host', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-accept', 'content-length', 'transfer-encoding']);

interface Open {
  ws: WsConnection;
  streamId: string;
  url: string;
  /** Plans still running, so close() can stop them. */
  running: Set<AbortController>;
  /** Server data messages in arrival order, for wait steps. */
  inbox: Array<{ text: string | null; payload: Buffer }>;
  /** Called when a server data message arrives. */
  waiters: Set<() => void>;
  keepAlive: boolean;
  timers: NodeJS.Timeout[];
}

/** What scripts need from the rest of the app: tokens, cookies, flows and variables. */
export interface WsReplayDeps {
  tokenContext(url: string, extra?: { vars?: Record<string, string>; flows?: Map<string, Record<string, string>> }): TokenContext;
  cookieHeader(url: string): string | null;
  /** Run the flows these texts refer to (and `flow`), once each; their variables fill {{flow:...}} and, for `flow`, {{var:...}}. */
  runFlows?(texts: string[], flow?: string): Promise<{ flows: Map<string, Record<string, string>>; vars?: Record<string, string> }>;
  /** Save a variable a wait step extracted, so other tools see it too. */
  setVar?(name: string, value: string): void;
  projectDir?: string;
  each?(arg: string): string[];
}

export interface WsRunOptions {
  ignoreTlsErrors?: boolean;
  /** Fill in Replay tokens in the URL, headers and text messages. Default on. */
  tokens?: boolean;
  /** Replace the Cookie header with the current cookie jar. */
  refreshCookies?: boolean;
  /** Answer Engine.IO (Socket.IO) pings and send its client pings, so a long script is not dropped. Default on. */
  keepAlive?: boolean;
  /** Divide every step's delay by this. Default 1. */
  speed?: number;
  /** Close the connection when the last step has run. Default off: it stays open to keep sending. */
  closeAtEnd?: boolean;
  /** Codec chain each text message is encoded with after tokens and fields. */
  encode?: string[];
  /** JSON fields of text messages to encode on send. */
  fields?: FieldCodec[];
  /** Run this flow first; its variables fill {{var:...}}. */
  flow?: string;
  replayOf?: string | null;
  timeoutMs?: number;
}

export interface WsRunState {
  exchangeId: string;
  running: boolean;
  steps: WsStepResult[];
  /** Variables the script set (wait steps with extract). */
  vars: Record<string, string>;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export class WsReplays extends EventEmitter<{ progress: [WsRunState] }> {
  private open = new Map<string, Open>();
  private runs = new Map<string, WsRunState>();
  deps?: WsReplayDeps;

  constructor(private readonly store: CaptureStore) {
    super();
  }

  async connect(req: { url: string; headers: HeaderList; replayOf?: string | null; ignoreTlsErrors?: boolean; timeoutMs?: number; keepAlive?: boolean }): Promise<{ exchangeId: string }> {
    const url = new URL(req.url.replace(/^http/, 'ws'));
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('a WebSocket URL starts with ws:// or wss://');
    // Keep the captured headers (Origin, cookies, subprotocols, custom ones) but let the client own the handshake fields.
    const headers = req.headers.filter(([k]) => !SKIP.has(k.toLowerCase()) && !k.startsWith(':'));
    const startedAt = Date.now();
    const ex = this.store.addRequest({ source: 'replay', startedAt, method: 'GET', url: url.href, httpVersion: '1.1', headers: req.headers, isWebSocket: true, replayOf: req.replayOf ?? null });
    let result: Awaited<ReturnType<typeof connectWebSocket>>;
    try {
      // autoPong off: the record should show exactly what we sent, and plans may test pings.
      result = await connectWebSocket(url, { headers, rejectUnauthorized: !req.ignoreTlsErrors, timeoutMs: req.timeoutMs ?? 15_000, autoPong: false });
    } catch (e) {
      if (e instanceof UnexpectedResponse) {
        this.store.completeResponse(ex.id, { status: e.status, headers: e.headers, body: e.body, timings: { total: Date.now() - startedAt } });
      } else this.store.failExchange(ex.id, 'error', (e as Error).message);
      throw e;
    }
    const { ws } = result;
    this.store.completeResponse(ex.id, { status: result.status, statusMessage: result.statusMessage, headers: result.headers, timings: { responseHeaders: Date.now() - startedAt, total: Date.now() - startedAt } });
    const streamId = this.store.openStream('websocket', ex.id, startedAt);
    const conn: Open = { ws, streamId, url: url.href, running: new Set(), inbox: [], waiters: new Set(), keepAlive: req.keepAlive ?? false, timers: [] };
    this.open.set(ex.id, conn);
    const asm = new MessageAssembler('server');
    ws.on('frame', (f) => {
      const m = asm.push(f);
      if (!m) return;
      const meta: Record<string, unknown> = {};
      if (m.fragments > 1) meta.fragments = m.fragments;
      if (m.violations.length) meta.violations = m.violations;
      if (m.close?.code !== undefined) meta.code = m.close.code;
      if (m.close?.reason) meta.reason = m.close.reason;
      this.store.addStreamMessage({ streamId, direction: 'server', opcode: m.opcode, at: Date.now(), payload: m.payload, ...(Object.keys(meta).length ? { meta } : {}) });
      if (m.opcode === 'text' || m.opcode === 'binary') this.onServerMessage(ex.id, conn, m);
    });
    ws.on('ping', (d) => ws.sendFrame({ opcode: 'pong', payload: d.subarray(0, 125) }));
    ws.on('close', (code, reason) => {
      for (const a of conn.running) a.abort();
      for (const t of conn.timers) clearInterval(t);
      for (const w of conn.waiters) w();
      this.store.closeStream(streamId, code, reason);
      this.open.delete(ex.id);
    });
    ws.on('error', () => undefined);
    // Let frames that came in with the handshake be recorded before anything is sent.
    await new Promise((r) => setImmediate(r));
    return { exchangeId: ex.id };
  }

  /** Keep-alive for Engine.IO, then hand the message to any waiting step. */
  private onServerMessage(exchangeId: string, conn: Open, m: AssembledMessage): void {
    const text = m.opcode === 'text' ? m.payload.toString('utf8') : null;
    if (conn.keepAlive && text !== null) {
      // Engine.IO 4: the server pings, the client answers.
      if (text === '2') this.sendAuto(exchangeId, conn, '3', 'Engine.IO pong');
      // Engine.IO 3: the client pings every pingInterval from the open packet.
      const open = /^0(\{.*\})$/s.exec(text);
      if (open && /[?&]EIO=3\b/.test(conn.url)) {
        try {
          const every = Number((JSON.parse(open[1]!) as { pingInterval?: number }).pingInterval);
          if (every > 0) {
            const t = setInterval(() => this.sendAuto(exchangeId, conn, '2', 'Engine.IO ping'), Math.max(1000, every));
            t.unref?.();
            conn.timers.push(t);
          }
        } catch {
          // not an Engine.IO open packet after all
        }
      }
    }
    if (conn.keepAlive && isHeartbeat(text)) return;
    conn.inbox.push({ text, payload: m.payload });
    for (const w of conn.waiters) w();
  }

  private sendAuto(exchangeId: string, conn: Open, text: string, note: string): void {
    if (!this.open.has(exchangeId)) return;
    conn.ws.send(text);
    this.store.addStreamMessage({ streamId: conn.streamId, direction: 'client', opcode: 'text', at: Date.now(), payload: Buffer.from(text), meta: { injected: true, auto: note } });
  }

  /** A captured connection written out as an editable script. */
  scriptFor(exchangeId: string, opts: { timing?: boolean; waits?: boolean; keepAlive?: boolean } = {}): WsScript {
    const ex = this.store.getExchange(exchangeId);
    if (!ex) throw new Error('exchange not found');
    if (!ex.isWebSocket) throw new Error('that exchange is not a WebSocket');
    const stream = this.store.getStreamForExchange(exchangeId);
    const msgs: StreamMessage[] = [];
    if (stream) for (let after = ''; ; ) {
      const page = this.store.getStreamMessages(stream.id, { after, limit: 1000 });
      msgs.push(...page);
      if (page.length < 1000) break;
      after = page[page.length - 1]!.id;
    }
    const headers = ex.requestHeaders.filter(([k]) => !SKIP.has(k.toLowerCase()) && !k.startsWith(':'));
    return scriptFromMessages(ex.url, headers, msgs, opts);
  }

  runState(exchangeId: string): WsRunState | undefined {
    return this.runs.get(exchangeId);
  }

  /**
   * Run a script: open a connection with its handshake (tokens filled in),
   * then run its steps in the background. Resolves with the new connection
   * once the server has switched protocols; follow the steps with runState()
   * or the "progress" event.
   */
  async run(script: WsScript, opts: WsRunOptions = {}): Promise<{ exchangeId: string }> {
    const s = validateScript(script);
    const deps = this.deps;
    const tokens = opts.tokens !== false && !!deps;
    const texts = [s.url, ...s.headers.map(([, v]) => v), ...s.steps.flatMap((st) => (st.kind === 'send' && (st.encoding ?? 'text') === 'text' ? [st.payload] : []))];
    const flowOut = tokens && deps?.runFlows && (opts.flow || texts.some((t) => /\{\{\s*flow:/i.test(t))) ? await deps.runFlows(texts, opts.flow) : undefined;
    const vars: Record<string, string> = { ...(flowOut?.vars ?? {}) };
    const ctxFor = (url: string): TokenContext | undefined => (tokens ? deps!.tokenContext(url, { vars, flows: flowOut?.flows }) : undefined);
    const ctx0 = ctxFor(s.url.replace(/^ws/, 'http'));
    const url = ctx0 && hasTokens(s.url) ? resolveTokens(s.url, ctx0) : s.url;
    const httpUrl = url.replace(/^ws/, 'http');
    const hctx = ctxFor(httpUrl);
    let headers: HeaderList = s.headers.map(([k, v]) => [k, hctx && hasTokens(v) ? resolveTokens(v, hctx) : v]);
    if (opts.refreshCookies && deps) {
      const cookie = deps.cookieHeader(httpUrl);
      headers = headers.filter(([k]) => k.toLowerCase() !== 'cookie');
      if (cookie) headers.push(['Cookie', cookie]);
    }
    const { exchangeId } = await this.connect({ url, headers, replayOf: opts.replayOf ?? null, ignoreTlsErrors: opts.ignoreTlsErrors, timeoutMs: opts.timeoutMs, keepAlive: opts.keepAlive !== false });
    const state: WsRunState = { exchangeId, running: true, steps: s.steps.map((_, index) => ({ index, status: 'pending' })), vars, startedAt: Date.now() };
    this.runs.set(exchangeId, state);
    // Forget old runs; their messages are in the store.
    if (this.runs.size > 50) this.runs.delete(this.runs.keys().next().value!);
    this.emit('progress', state);
    void this.runSteps(exchangeId, s.steps, opts, state, ctxFor).catch(() => undefined);
    return { exchangeId };
  }

  /** Run more steps on a connection that is open now, e.g. one typed into the composer. Resolves when they have run. */
  async runMore(exchangeId: string, steps: WsScriptStep[], opts: WsRunOptions = {}): Promise<WsRunState> {
    const conn = this.get(exchangeId);
    validateScript({ url: conn.url, headers: [], steps });
    const prev = this.runs.get(exchangeId);
    const vars = { ...(prev?.vars ?? {}) };
    const deps = this.deps;
    const ctxFor = (url: string) => (opts.tokens !== false && deps ? deps.tokenContext(url, { vars }) : undefined);
    const state: WsRunState = { exchangeId, running: true, steps: steps.map((_, index) => ({ index, status: 'pending' })), vars, startedAt: Date.now() };
    // Waits look at what arrives from now on.
    conn.inbox.length = 0;
    await this.runSteps(exchangeId, steps, { ...opts, closeAtEnd: false }, state, ctxFor);
    return state;
  }

  private async runSteps(exchangeId: string, steps: WsScriptStep[], opts: WsRunOptions, state: WsRunState, ctxFor: (url: string) => TokenContext | undefined): Promise<void> {
    const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
    const progress = () => this.emit('progress', state);
    let cursor = 0;
    try {
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i]!;
        const r = state.steps[i]!;
        const conn = this.open.get(exchangeId);
        if (!conn) {
          for (const x of state.steps.slice(i)) if (x.status === 'pending') x.status = 'skipped';
          state.error ??= 'the connection closed before the script finished';
          break;
        }
        if (st.enabled === false) {
          r.status = 'skipped';
          continue;
        }
        if (st.delayMs) await new Promise((res) => setTimeout(res, Math.min(st.delayMs! / speed, 10 * 60_000)));
        r.status = 'running';
        r.startedAt = Date.now();
        progress();
        try {
          if (st.kind === 'send') {
            const httpUrl = conn.url.replace(/^ws/, 'http');
            const binary = (st.encoding ?? 'text') !== 'text';
            const batch = binary ? [new Map<string, string>()] : sendBatch(st, this.deps?.projectDir, this.deps?.each);
            let n = 0;
            for (const values of batch) {
              const base = ctxFor(httpUrl);
              const ctx = base ? { ...base, batch: values } : undefined;
              const payload = binary ? stepBytes(st) : prepareText(st.payload, { ctx, tokens: opts.tokens, fields: opts.fields, encode: opts.encode });
              const opcode = st.encoding && st.encoding !== 'text' ? st.opcode : opts.encode?.length && st.opcode === 'text' && !isUtf8(payload) ? 'binary' : st.opcode;
              if (st.preset && st.preset !== 'single') {
                await this.sendPlan(exchangeId, buildPlan(st.preset, { payload, opcode }, st.presetOptions), { step: i + 1, of: steps.length });
              } else {
                conn.ws.send(opcode === 'text' ? Buffer.from(payload).toString('utf8') : payload, { binary: opcode === 'binary' });
                this.store.addStreamMessage({ streamId: conn.streamId, direction: 'client', opcode, at: Date.now(), payload, meta: { injected: true, step: i + 1, of: steps.length, ...(st.note ? { note: st.note } : {}) } });
              }
              n++;
            }
            r.sent = n;
            r.status = 'done';
          } else if (st.kind === 'frames') {
            await this.sendPlan(exchangeId, st.steps, { step: i + 1, of: steps.length });
            r.status = 'done';
          } else if (st.kind === 'close') {
            this.close(exchangeId, st.code ?? 1000, st.reason ?? '');
            r.status = 'done';
          } else {
            const want = Math.max(1, st.count ?? 1);
            const deadline = Date.now() + Math.max(0, st.timeoutMs ?? 10_000);
            let matched = 0;
            let value: string | undefined;
            for (;;) {
              while (cursor < conn.inbox.length && matched < want) {
                const m = conn.inbox[cursor++]!;
                const text = m.text ?? m.payload.toString('latin1');
                if (!waitMatches(st.match, text)) continue;
                matched++;
                if (st.extract && value === undefined) value = extractFromMessage(st.extract.from, text);
              }
              if (matched >= want || !this.open.has(exchangeId)) break;
              const left = deadline - Date.now();
              if (left <= 0) break;
              await new Promise<void>((res) => {
                const done = () => {
                  clearTimeout(t);
                  conn.waiters.delete(done);
                  res();
                };
                const t = setTimeout(done, left);
                conn.waiters.add(done);
              });
            }
            r.matched = matched;
            if (st.extract) {
              if (value !== undefined) {
                state.vars[st.extract.var] = value;
                r.value = value;
                try {
                  this.deps?.setVar?.(st.extract.var, value);
                } catch {
                  // a bad name is caught by validateScript; the script still has it
                }
              } else if (matched >= want) r.error = `nothing at ${st.extract.from} in the message`;
            }
            if (matched >= want) r.status = 'done';
            else {
              r.status = 'timeout';
              r.error = this.open.has(exchangeId) ? `saw ${matched} of ${want} after ${Math.round((st.timeoutMs ?? 10_000) / 1000)} s` : 'the connection closed';
              if (st.onTimeout === 'stop') {
                for (const x of state.steps.slice(i + 1)) x.status = 'skipped';
                state.error = `step ${i + 1} timed out`;
                break;
              }
            }
          }
        } catch (e) {
          r.status = 'error';
          r.error = (e as Error).message;
          for (const x of state.steps.slice(i + 1)) x.status = 'skipped';
          state.error = `step ${i + 1}: ${r.error}`;
          break;
        } finally {
          r.endedAt = Date.now();
          progress();
        }
      }
      if (opts.closeAtEnd && this.open.has(exchangeId)) this.close(exchangeId);
    } finally {
      state.running = false;
      state.endedAt = Date.now();
      progress();
    }
  }

  openIds(): string[] {
    return [...this.open.keys()];
  }

  isOpen(exchangeId: string): boolean {
    return this.open.has(exchangeId);
  }

  private get(exchangeId: string): Open {
    const c = this.open.get(exchangeId);
    if (!c) throw new Error('that WebSocket replay is not open');
    return c;
  }

  send(exchangeId: string, payload: Uint8Array, opcode: 'text' | 'binary'): void {
    const c = this.get(exchangeId);
    c.ws.send(opcode === 'text' ? Buffer.from(payload).toString('utf8') : payload, { binary: opcode === 'binary' });
    this.store.addStreamMessage({ streamId: c.streamId, direction: 'client', opcode, at: Date.now(), payload, meta: { injected: true } });
  }

  /** Send a frame plan, recording each step as it goes out. Resolves when the plan has run. */
  async sendPlan(exchangeId: string, steps: PlanStep[], scriptStep?: { step: number; of: number }): Promise<SentStep[]> {
    const c = this.get(exchangeId);
    const plan = validatePlan(steps);
    const abort = new AbortController();
    c.running.add(abort);
    const sock = c.ws.socket;
    try {
      return await runPlan(
        plan,
        { write: (b) => sock.write(b), end: () => sock.end(), destroy: () => sock.destroy(), alive: () => !sock.destroyed && sock.writable, defaultMask: true },
        (st) => {
          const step = plan[st.index]!;
          const payload = step.kind === 'frame' ? Buffer.from(step.payload, 'base64') : step.kind === 'raw' ? Buffer.from(step.bytes, 'base64') : new Uint8Array();
          this.store.addStreamMessage({
            streamId: c.streamId,
            direction: 'client',
            opcode: st.frame?.opcode ?? st.kind,
            at: st.at,
            payload,
            meta: {
              injected: true,
              ...(scriptStep ? { ...scriptStep, planStep: st.index + 1, planSteps: plan.length } : { step: st.index + 1, of: plan.length }),
              ...(st.frame ? { frame: st.frame } : {}),
              ...(st.note ? { note: st.note } : {}),
            },
          });
        },
        abort.signal,
      );
    } finally {
      c.running.delete(abort);
    }
  }

  /**
   * Replay a captured conversation: open a connection like the captured one
   * and send its client messages again, optionally with the original gaps
   * (scaled by speed) and each message turned into a preset's frames.
   */
  async replaySession(
    exchangeId: string,
    opts: { ignoreTlsErrors?: boolean; timing?: 'none' | 'original'; speed?: number; preset?: string; presetOptions?: Record<string, number | string> } = {},
  ): Promise<{ exchangeId: string; sent: number }> {
    const ex = this.store.getExchange(exchangeId);
    if (!ex) throw new Error('exchange not found');
    const stream = this.store.getStreamForExchange(exchangeId);
    if (!stream || stream.protocol !== 'websocket') throw new Error('that exchange has no recorded WebSocket messages');
    const msgs = this.store.getStreamMessages(stream.id).filter((m) => m.direction === 'client' && (m.opcode === 'text' || m.opcode === 'binary'));
    const { exchangeId: id } = await this.connect({ url: ex.url, headers: ex.requestHeaders, replayOf: ex.id, ignoreTlsErrors: opts.ignoreTlsErrors });
    const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
    const steps: PlanStep[] = [];
    msgs.forEach((m, i) => {
      const gap = opts.timing === 'original' && i > 0 ? Math.round((m.at - msgs[i - 1]!.at) / speed) : 0;
      const part = buildPlan(opts.preset ?? 'single', { payload: m.payload, opcode: m.opcode as 'text' | 'binary' }, opts.presetOptions);
      if (gap > 0 && part[0]) part[0] = { ...part[0], delayMs: (part[0].delayMs ?? 0) + gap };
      steps.push(...part);
    });
    if (!steps.length) return { exchangeId: id, sent: 0 };
    void this.sendPlan(id, steps).catch(() => undefined);
    return { exchangeId: id, sent: msgs.length };
  }

  close(exchangeId: string, code = 1000, reason = 'closed from SiteInquisition'): void {
    const c = this.open.get(exchangeId);
    if (!c || c.ws.readyState !== 1) return;
    c.ws.close(code, reason);
    this.store.addStreamMessage({
      streamId: c.streamId,
      direction: 'client',
      opcode: 'close',
      at: Date.now(),
      payload: Buffer.concat([Buffer.of((code >> 8) & 0xff, code & 0xff), Buffer.from(reason).subarray(0, 123)]),
      meta: { injected: true, code, ...(reason ? { reason } : {}) },
    });
  }

  closeAll(): void {
    for (const c of this.open.values()) {
      for (const t of c.timers) clearInterval(t);
      c.ws.terminate();
    }
    this.open.clear();
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
function isUtf8(b: Uint8Array): boolean {
  try {
    utf8.decode(b);
    return true;
  } catch {
    return false;
  }
}
