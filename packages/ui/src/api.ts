import type {
  ActivityEntry,
  ApiFlow,
  ApiSpec,
  FlowDraft,
  FlowRunResult,
  HarImport,
  SpecCoverage,
  ValueField,
  ValueOrigin,
  Approval,
  AwsProfile,
  Breakpoint,
  Change,
  CoverageReport,
  Decision,
  Exchange,
  ExchangeSummary,
  Extractor,
  HeaderList,
  JarCookie,
  LogLine,
  Macro,
  McpSettings,
  MockRule,
  ParsedSigV4,
  Paused,
  RaceResult,
  H3PlanOptions,
  H3PlanRequest,
  H3PlanResult,
  ReplaceRule,
  RunResult,
  ScopeConfig,
  ScopeDecision,
  Script,
  ScriptStats,
  SeenHost,
  SendOptions,
  StreamMessage,
  VarValue,
} from '@siteinquisition/core';

export type {
  ActivityEntry,
  ApiFlow,
  ApiSpec,
  FlowDraft,
  FlowRunResult,
  HarImport,
  SpecCoverage,
  ValueField,
  ValueOrigin,
  Approval,
  AwsProfile,
  Breakpoint,
  CoverageReport,
  Decision,
  Extractor,
  LogLine,
  Macro,
  McpSettings,
  MockRule,
  ParsedSigV4,
  Paused,
  RaceResult,
  H3PlanOptions,
  H3PlanRequest,
  H3PlanResult,
  ReplaceRule,
  RunResult,
  Script,
  ScriptStats,
  SendOptions,
  VarValue,
};

export type { Change, Exchange, ExchangeSummary, HeaderList, JarCookie, ScopeConfig, ScopeDecision, SeenHost, StreamMessage };
export type { ScopeRule } from '@siteinquisition/core';
export type { CookieOverride, CsrfBinding, CsrfFinding, EffectiveTech, HostTechReport, Signature, TechCategory, TechCheck, TechHit, TechOverride } from '@siteinquisition/core';
import type { CookieOverride, CsrfBinding, CsrfFinding, HostTechReport, Signature, TechHit, TechOverride, EffectiveTech } from '@siteinquisition/core';

/** A jar cookie, with why it belongs to the platform rather than the app (null when it is the app's). */
export type JarCookieInfo = JarCookie & { infra?: string | null };

export interface ExchangeTech {
  hits: Array<TechHit & { name: string }>;
  host: HostTechReport;
  csrf: CsrfFinding[];
  cookies: Array<{ name: string; value: string; set: boolean; infra: string | null }>;
}

export type HostTechSummary = { host: string; tech: Array<Pick<EffectiveTech, 'id' | 'name' | 'category' | 'status'>> };

export interface CoreInfo {
  version: string;
  projectDir: string;
  actor: string;
  proxyPort: number | null;
  /** The built-in browser's own listener; null outside the desktop app. */
  browserProxyPort?: number | null;
  apiPort: number | null;
  allowLan: boolean;
  ca: { certPath: string; fingerprint: string; expiresAt: string };
  decryptHosts: string[];
  stats: { exchanges: number; databaseBytes: number };
  mqtt: Array<{ port: number | null; broker: string; listenTls: boolean }>;
}

/** One step of a WebSocket frame plan (mirrors the core's PlanStep). */
export type PlanStep =
  | {
      kind: 'frame';
      opcode: string | number;
      payload: string;
      fin?: boolean;
      rsv1?: boolean;
      rsv2?: boolean;
      rsv3?: boolean;
      mask?: string;
      lengthField?: 'auto' | 16 | 64;
      declaredLength?: number;
      truncateTo?: number;
      delayMs?: number;
      note?: string;
    }
  | { kind: 'raw'; bytes: string; delayMs?: number; note?: string }
  | { kind: 'socket'; action: 'end' | 'destroy'; delayMs?: number; note?: string };

export interface FramePreset {
  id: string;
  name: string;
  expect: string;
  options?: Array<{ key: string; label: string; default: number | string }>;
}

export type ExchangeDetail = Exchange & { stream: { id: string; protocol: string; openedAt: number; closedAt: number | null; closeCode: number | null } | null };
export type WireStreamMessage = Omit<StreamMessage, 'payload'> & { base64: string };
export interface SiteMapHost {
  host: string;
  count: number;
  paths: Array<{ segment: string; count: number }>;
}

/** Where to reach the core: from the Electron preload, or from the page URL when run in a plain browser. */
export interface Connection {
  url: string;
  token: string;
}

/** State of one built-in browser tab, as the desktop app reports it. */
export interface BrowserTabState {
  id: number;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

export interface BrowserBridge {
  create(url: string): Promise<number>;
  close(id: number): Promise<void>;
  activate(id: number): Promise<void>;
  navigate(id: number, url: string): Promise<void>;
  back(id: number): Promise<void>;
  forward(id: number): Promise<void>;
  reload(id: number): Promise<void>;
  devtools(id: number): Promise<void>;
  /** Where the page sits in the window, in CSS pixels; null hides every tab. */
  setBounds(rect: { x: number; y: number; width: number; height: number } | null): Promise<void>;
  list(): Promise<BrowserTabState[]>;
  onTab(fn: (tab: BrowserTabState | { id: number; closed: true }) => void): () => void;
}

declare global {
  interface Window {
    siq?: {
      getConnection(): Promise<Connection>;
      setTheme(theme: 'system' | 'light' | 'dark'): Promise<void>;
      platform: string;
      browser?: BrowserBridge;
    };
  }
}

export async function resolveConnection(): Promise<Connection | null> {
  if (window.siq) return window.siq.getConnection();
  const params = new URLSearchParams(location.search);
  const url = params.get('api');
  const token = params.get('token');
  return url && token ? { url, token } : null;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Status = 'connecting' | 'open' | 'closed';

/**
 * JSON-RPC client for the core API. Reconnects with backoff and re-subscribes
 * to change events, so views can simply redraw from what the core says.
 */
export class CoreClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private changeListeners = new Set<(c: Change) => void>();
  private statusListeners = new Set<(s: Status) => void>();
  private retry = 0;
  private closedByUser = false;
  status: Status = 'connecting';

  constructor(readonly conn: Connection) {
    this.open();
  }

  private setStatus(s: Status) {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private open() {
    const ws = new WebSocket(`${this.conn.url}/?token=${encodeURIComponent(this.conn.token)}`);
    this.ws = ws;
    this.setStatus('connecting');
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
      void this.call('events.subscribe');
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
      if (msg.method === 'change') {
        for (const l of this.changeListeners) l(msg.params as Change);
        return;
      }
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('connection to core lost'));
      this.pending.clear();
      this.setStatus('closed');
      if (this.closedByUser) return;
      const delay = Math.min(5000, 250 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }

  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Wait for the socket rather than failing calls made during start-up or a reconnect.
      return new Promise<T>((resolve, reject) => {
        const off = this.onStatus((s) => {
          if (s === 'open') {
            off();
            this.call<T>(method, params).then(resolve, reject);
          }
        });
      });
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  onChange(fn: (c: Change) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onStatus(fn: (s: Status) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  // Typed helpers
  info = () => this.call<CoreInfo>('core.info');
  search = (query: string, opts: { limit?: number; before?: string } = {}) => this.call<ExchangeSummary[]>('traffic.search', { query, ...opts });
  get = (id: string) => this.call<ExchangeDetail>('traffic.get', { id });
  body = (id: string, side: 'request' | 'response', decoded = true) =>
    this.call<{ size: number; base64: string }>('traffic.body', { id, side, decoded }).then((b) => base64ToBytes(b.base64));
  streamMessages = (exchangeId: string, after?: string) => this.call<WireStreamMessage[]>('traffic.streamMessages', { exchangeId, after, limit: 1000 });
  siteMap = () => this.call<SiteMapHost[]>('traffic.siteMap', { limit: 200 });
  tag = (id: string, tags: string[]) => this.call<boolean>('traffic.tag', { id, tags });
  notes = (id: string, notes: string) => this.call<boolean>('traffic.notes', { id, notes });
  scope = () => this.call<ScopeConfig>('scope.get');
  setScope = (config: ScopeConfig) => this.call<ScopeConfig>('scope.set', { config });
  seen = () => this.call<SeenHost[]>('scope.seen');
  tlsFailures = () => this.call<Array<{ host: string | null; cause: string; count: number; lastAt: number }>>('tls.failures');
  replay = (req: { method: string; url: string; headers: HeaderList; body?: Uint8Array; replayOf?: string; ignoreTlsErrors?: boolean }) =>
    this.call<ExchangeSummary>('replay.send', {
      method: req.method,
      url: req.url,
      headers: req.headers,
      bodyBase64: req.body ? bytesToBase64(req.body) : undefined,
      replayOf: req.replayOf,
      ignoreTlsErrors: req.ignoreTlsErrors,
    });
  cookies = () => this.call<JarCookieInfo[]>('cookies.list');
  techSignatures = () => this.call<{ builtIn: Signature[]; custom: Signature[]; disabled: string[] }>('tech.signatures');
  setTechSignatures = (signatures: unknown[]) => this.call<Signature[]>('tech.setSignatures', { signatures });
  setTechDisabled = (ids: string[]) => this.call<string[]>('tech.setDisabled', { ids });
  techHosts = () => this.call<HostTechSummary[]>('tech.hosts');
  techHost = (host: string) => this.call<HostTechReport>('tech.host', { host });
  techExchange = (id: string) => this.call<ExchangeTech>('tech.exchange', { id });
  techOverrides = () => this.call<TechOverride[]>('tech.overrides');
  setTechOverrides = (overrides: Array<Partial<TechOverride>>) => this.call<TechOverride[]>('tech.setOverrides', { overrides });
  techOverride = (host: string, tech: string, action: 'pin' | 'reject' | 'clear', note?: string) => this.call<TechOverride[]>('tech.override', { host, tech, action, ...(note ? { note } : {}) });
  cookieOverrides = () => this.call<CookieOverride[]>('tech.cookieOverrides');
  setCookieOverrides = (overrides: Array<Partial<CookieOverride>>) => this.call<CookieOverride[]>('tech.setCookieOverrides', { overrides });
  techRescan = () => this.call<{ exchanges: number; hosts: number }>('tech.rescan');
  techCheck = (host: string, tech: string, index: number, scheme: string) => this.call<ExchangeSummary>('tech.check', { host, tech, index, scheme });
  csrfBindings = () => this.call<CsrfBinding[]>('csrf.bindings');
  setCsrfBindings = (bindings: Array<Partial<CsrfBinding>>) => this.call<CsrfBinding[]>('csrf.setBindings', { bindings });
  evaluate = (url: string) => this.call<ScopeDecision>('scope.evaluate', { url });
  replayWith = (req: WireRequest, options: SendOptions) =>
    this.call<ExchangeSummary>('replay.send', { ...wire(req), options });
  replayBatch = (req: WireRequest, options: SendOptions & { concurrency?: number }) =>
    this.call<{ batchId: string; sends: ExchangeSummary[]; errors: string[] }>('replay.batch', { ...wire(req), options, concurrency: options.concurrency });
  previewTokens = (texts: string[], url: string) =>
    this.call<{ sends: number; resolved: Array<{ ok: boolean; text?: string; error?: string }> }>('tokens.preview', { texts, url });
  codecList = () => this.call<Array<{ id: string; label: string; terminal: boolean }>>('codecs.list');
  detect = (bytes: Uint8Array) => this.call<string[]>('codecs.detect', { base64: bytesToBase64(bytes) });
  layers = (chain: string[], bytes: Uint8Array) =>
    this.call<Array<{ kind: 'bytes'; base64: string } | { kind: 'value'; value: unknown }>>('codecs.layers', { chain, base64: bytesToBase64(bytes) });
  encode = (chain: string[], value: unknown) =>
    this.call<{ base64: string }>('codecs.encode', value instanceof Uint8Array ? { chain, base64: bytesToBase64(value) } : { chain, value }).then((r) => base64ToBytes(r.base64));
  replaceIn = (chain: string[], bytes: Uint8Array, o: { find: string; replace: string; regex?: boolean; matchCase?: boolean; keys?: boolean; scope?: 'layer' | 'all' }) =>
    this.call<{ base64: string; counts: number[] }>('codecs.replace', { chain, base64: bytesToBase64(bytes), ...o }).then((r) => ({ output: base64ToBytes(r.base64), counts: r.counts }));
  chains = () => this.call<SavedChain[]>('codecs.chains.get');
  setChains = (chains: SavedChain[]) => this.call<boolean>('codecs.chains.set', { chains });
  coverage = (host: string) => this.call<CoverageReport>('traffic.coverage', { host });
  vars = () => this.call<{ vars: Record<string, VarValue>; extractors: Extractor[] }>('vars.list');
  setVar = (name: string, value: string) => this.call<boolean>('vars.set', { name, value });
  deleteVar = (name: string) => this.call<boolean>('vars.delete', { name });
  setExtractors = (extractors: Array<Partial<Extractor>>) => this.call<Extractor[]>('vars.extractors', { extractors });
  rules = () => this.call<{ rules: ReplaceRule[]; mocks: MockRule[]; breakpoints: Breakpoint[]; hits: Record<string, number> }>('rules.get');
  setRules = (rules: Array<Partial<ReplaceRule>>) => this.call<ReplaceRule[]>('rules.set', { rules });
  testRule = (rule: Partial<ReplaceRule>, exchangeId: string) => this.call<{ matched: boolean; count: number; before: string; after: string }>('rules.test', { rule, exchangeId });
  setMocks = (mocks: Array<Partial<MockRule>>) => this.call<MockRule[]>('mocks.set', { mocks });
  setBreakpoints = (breakpoints: Array<Partial<Breakpoint>>) => this.call<Breakpoint[]>('breakpoints.set', { breakpoints });
  paused = () => this.call<Paused[]>('intercept.list');
  resolvePaused = (id: string, action: 'forward' | 'drop' | 'forward-pause-response', edits?: Record<string, unknown>) => this.call<boolean>('intercept.resolve', { id, action, edits });
  releaseAll = () => this.call<number>('intercept.releaseAll');
  scripts = () => this.call<{ scripts: Script[]; stats: Record<string, ScriptStats>; errors: Record<string, string> }>('scripts.get');
  setScripts = (scripts: Array<Partial<Script>>) => this.call<Script[]>('scripts.set', { scripts });
  scriptLogs = (id: string) => this.call<LogLine[]>('scripts.logs', { id });
  runScript = (p: { id?: string; code?: string }) => this.call<RunResult>('scripts.run', p);
  macros = () => this.call<Macro[]>('macros.get');
  setMacros = (macros: Array<Partial<Macro>>) => this.call<Macro[]>('macros.set', { macros });
  runMacro = (id: string) => this.call<Array<{ step: number; exchangeId?: string; status: number | null; error?: string }>>('macros.run', { id });
  aws = () => this.call<{ profiles: AwsProfile[]; sessionKeys: string[] }>('aws.get');
  setAws = (profiles: AwsProfile[]) => this.call<AwsProfile[]>('aws.set', { profiles });
  setAwsKeys = (k: { name: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string }) => this.call<boolean>('aws.setKeys', k);
  parseSigV4 = (id: string) => this.call<ParsedSigV4 | null>('aws.parse', { id });
  race = (requests: Array<WireRequest & { offsetMs: number }>, opts: { sync: 'last-byte' | 'single-packet' | 'h3-single-datagram' | 'none'; repeat?: number; jitterMs?: number; ignoreTlsErrors?: boolean }) =>
    this.call<RaceResult>('race.run', { requests: requests.map((r) => ({ ...wire(r), offsetMs: r.offsetMs })), ...opts });
  h3Run = (requests: Array<Omit<H3PlanRequest, 'body'> & WireRequest>, options: H3PlanOptions) =>
    this.call<H3PlanResult>('h3.run', { requests: requests.map((r) => ({ ...r, ...wire(r), body: undefined })), options });
  h3Tickets = () => this.call<Array<{ origin: string; receivedAt: number; maxEarlyData: number; lifetimeSec: number }>>('h3.tickets');
  h3ClearTickets = () => this.call<boolean>('h3.clearTickets');
  browserHttp3 = () => this.call<{ hosts: string[]; port: number | null }>('browser.http3');
  setBrowserHttp3Hosts = (hosts: string[]) => this.call<{ hosts: string[]; restartNeeded: boolean }>('browser.setHttp3Hosts', { hosts });
  liveStreams = () => this.call<{ mqtt: string[]; ws: string[]; wsProxied: string[] }>('stream.live');
  streamConnect = (exchangeId: string, ignoreTlsErrors = false, headers?: Array<[string, string]>) => this.call<{ exchangeId: string }>('stream.connect', { exchangeId, ignoreTlsErrors, ...(headers ? { headers } : {}) });
  framePresets = () => this.call<FramePreset[]>('stream.presets');
  buildFramePlan = (preset: string, payload: Uint8Array, opcode: 'text' | 'binary', options: Record<string, number | string>) =>
    this.call<PlanStep[]>('stream.buildPlan', { preset, base64: bytesToBase64(payload), opcode, options });
  sendFramePlan = (exchangeId: string, steps: PlanStep[], to?: 'server' | 'client') => this.call<unknown[]>('stream.sendPlan', { exchangeId, steps, ...(to ? { to } : {}) });
  replayStreamSession = (exchangeId: string, opts: { ignoreTlsErrors?: boolean; timing?: 'none' | 'original'; speed?: number; preset?: string; options?: Record<string, number | string> }) =>
    this.call<{ exchangeId: string; sent: number }>('stream.replaySession', { exchangeId, ...opts });
  streamSend = (exchangeId: string, payload: Uint8Array, opcode: 'text' | 'binary') => this.call<boolean>('stream.send', { exchangeId, base64: bytesToBase64(payload), opcode });
  streamClose = (exchangeId: string, code?: number, reason?: string) => this.call<boolean>('stream.close', { exchangeId, code, reason });
  streamIsOpen = (exchangeId: string) => this.call<boolean>('stream.isOpen', { exchangeId });
  mqttPublish = (p: { exchangeId: string; to: 'broker' | 'device'; topic: string; payload: Uint8Array; qos: 0 | 1; retain: boolean }) =>
    this.call<boolean>('mqtt.publish', { ...p, payload: undefined, base64: bytesToBase64(p.payload) });
  mcpSettings = () => this.call<McpSettings>('mcp.settings');
  setMcpSettings = (s: McpSettings) => this.call<McpSettings>('mcp.setSettings', s as unknown as Record<string, unknown>);
  approvals = () => this.call<Approval[]>('mcp.approvals');
  decide = (id: string, decision: Decision) => this.call<boolean>('mcp.decide', { id, decision });
  mcpActivity = () => this.call<ActivityEntry[]>('mcp.activity');
  replayHistory = (of: string) => this.call<ExchangeSummary[]>('replay.history', { of });
  flows = () => this.call<ApiFlow[]>('flows.list');
  setFlows = (flows: Array<Partial<ApiFlow>>) => this.call<ApiFlow[]>('flows.set', { flows });
  saveFlow = (flow: Partial<ApiFlow>) => this.call<ApiFlow>('flows.save', { flow });
  runFlow = (name: string, inputs?: Record<string, string>) => this.call<FlowRunResult>('flows.run', { name, inputs });
  draftFlow = (ids: string[], name?: string) => this.call<FlowDraft>('flows.draft', { ids, name });
  specs = () => this.call<ApiSpec[]>('specs.list');
  importSpec = (text: string, name?: string) => this.call<ApiSpec>('specs.import', { text, name });
  deleteSpec = (id: string) => this.call<boolean>('specs.delete', { id });
  specCoverage = (host: string) => this.call<SpecCoverage>('specs.coverage', { host });
  specRequest = (specId: string, key: string, baseUrl?: string) => this.call<{ method: string; url: string; headers: HeaderList; body: string }>('specs.request', { specId, key, baseUrl });
  importHar = (text: string, tag?: string) => this.call<HarImport>('har.import', { text, tag });
  exportOpenApi = (host: string) => this.call<Record<string, unknown>>('openapi.export', { host });
  values = (p: { host?: string; query?: string; limit?: number } = {}) => this.call<ValueField[]>('values.catalog', p);
  valueOrigin = (value: string, beforeId?: string) => this.call<ValueOrigin[]>('values.origin', { value, beforeId });
  moveTag = (tag: string, id: string) => this.call<string[]>('tags.move', { tag, id });
  tagValue = (ref: string) => this.call<string>('tags.value', { ref });
}

export interface SavedChain {
  name: string;
  chain: string[];
}

export interface WireRequest {
  method: string;
  url: string;
  headers: HeaderList;
  body?: Uint8Array;
  replayOf?: string | null;
}

const wire = (r: WireRequest) => ({ method: r.method, url: r.url, headers: r.headers, bodyBase64: r.body ? bytesToBase64(r.body) : undefined, replayOf: r.replayOf ?? undefined });

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
