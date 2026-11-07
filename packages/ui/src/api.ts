import type {
  ContractResult,
  ContractSummary,
  Identity,
  AuthRow,
  NegativeResult,
  ExchangeDiff,
  Resource,
  GlossaryEntry,
  SeenOperation,
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
  H2PlanOptions,
  H2PlanRequest,
  H2PlanResult,
  LadderStep,
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
  ContractResult,
  ContractSummary,
  Identity,
  AuthRow,
  NegativeResult,
  ExchangeDiff,
  Resource,
  GlossaryEntry,
  SeenOperation,
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
  H2PlanOptions,
  H2PlanRequest,
  H2PlanResult,
  LadderStep,
  ReplaceRule,
  RunResult,
  Script,
  ScriptStats,
  SendOptions,
  VarValue,
};

export type { Change, Exchange, ExchangeSummary, HeaderList, JarCookie, ScopeConfig, ScopeDecision, SeenHost, StreamMessage };
export type { ScopeRule, MatchCondition, MatchOp, RuleConditions } from '@siteinquisition/core';
export type { ErrorCause, ErrorFinding, ParsedJwt, JwtFlag, AwsRequestInfo, KeyInfo, SessionCookie, SessionFramework, SessionStructure } from '@siteinquisition/core';
export type { EvergreenEntry, EvergreenStatus, SignableKind } from '@siteinquisition/core';
export type { Transform, OverrideGroup, OverrideKind, OverrideRef, OverrideState, EndpointDetail, EndpointRef } from '@siteinquisition/core';
export type { Reproduction, ReproInput, ReproDefinition, ReproRevision, ReproRun, Assertion, AssertionResult, SessionProfile, EffectiveValue, ValueSource, RunState } from '@siteinquisition/core';
import type { Transform, OverrideGroup, OverrideState, OverrideRef, EndpointDetail, Reproduction, ReproInput, ReproRevision, ReproRun, SessionProfile, EffectiveValue } from '@siteinquisition/core';
import type { ParsedJwt, AwsRequestInfo, KeyInfo, SessionCookie, EvergreenEntry, EvergreenStatus, SignableKind, WsScript, WsScriptStep, WsRunState } from '@siteinquisition/core';
export type { WsScript, WsScriptStep, WsRunState, WsStepResult } from '@siteinquisition/core';

/** Send options for a WebSocket replay (the WS Replay tab). */
export interface WsRunOptions {
  ignoreTlsErrors?: boolean;
  refreshCookies?: boolean;
  keepAlive?: boolean;
  tokens?: boolean;
  speed?: number;
  closeAtEnd?: boolean;
  encode?: string[];
  fields?: Array<{ path: string; chain: string[] }>;
  flow?: string;
}
import type { TextRegion } from '@siteinquisition/codecs/regionedit';
export type { TextRegion } from '@siteinquisition/codecs/regionedit';
export interface RegionPlan {
  start: number;
  end: number;
  display: string;
  region: Omit<TextRegion, 'start' | 'end' | 'id'>;
}
export type { UpstreamTlsConfig, TrustedCert, PeerCertInfo, FieldCodecRule } from '@siteinquisition/core';
import type { UpstreamTlsConfig, PeerCertInfo, FieldCodecRule } from '@siteinquisition/core';
export type { CookieOverride, CsrfBinding, CsrfFinding, EffectiveTech, HostTechReport, PageCsrfToken, Signature, TechCategory, TechCheck, TechHit, TechOverride, TechOverview, TechOverviewEntry, GlossarySource } from '@siteinquisition/core';
import type { CookieOverride, CsrfBinding, CsrfFinding, ErrorFinding, HostTechReport, PageCsrfToken, Signature, TechHit, TechOverride, TechOverview, EffectiveTech } from '@siteinquisition/core';

/** A jar cookie, with why it belongs to the platform rather than the app (null when it is the app's). */
export type JarCookieInfo = JarCookie & { infra?: string | null };

export interface ExchangeTech {
  hits: Array<TechHit & { name: string }>;
  host: HostTechReport;
  csrf: CsrfFinding[];
  /** CSRF tokens this response's page hands out (a <meta name="csrf-token">). */
  pageTokens: PageCsrfToken[];
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
  /** How data at rest is protected (older cores leave it out). */
  protection?: {
    caKey: 'keyring' | 'file';
    secrets: 'keyring' | 'file';
    keyring: string | null;
    disk: { state: 'encrypted' | 'not-encrypted' | 'unknown'; detail: string };
  };
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
export interface LanState {
  enabled: boolean;
  allowed: string[];
  pending: Array<{ address: string; firstSeen: number; lastSeen: number; attempts: number; via: string }>;
}

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
  /** How many recorded requests a search matches (counting stops at max). */
  count = (query: string, max = 100_000) => this.call<number>('traffic.count', { query, max });
  /** The text a search looks for, and where, for highlighting. */
  searchTerms = (query: string) => this.call<SearchTerm[]>('traffic.terms', { query });
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
  techOverview = () => this.call<TechOverview>('tech.overview');
  techHost = (host: string) => this.call<HostTechReport>('tech.host', { host });
  techExchange = (id: string) => this.call<ExchangeTech>('tech.exchange', { id });
  techOverrides = () => this.call<TechOverride[]>('tech.overrides');
  setTechOverrides = (overrides: Array<Partial<TechOverride>>) => this.call<TechOverride[]>('tech.setOverrides', { overrides });
  techOverride = (host: string, tech: string, action: 'pin' | 'reject' | 'clear', note?: string) => this.call<TechOverride[]>('tech.override', { host, tech, action, ...(note ? { note } : {}) });
  cookieOverrides = () => this.call<CookieOverride[]>('tech.cookieOverrides');
  setCookieOverrides = (overrides: Array<Partial<CookieOverride>>) => this.call<CookieOverride[]>('tech.setCookieOverrides', { overrides });
  techRescan = () => this.call<{ exchanges: number; hosts: number }>('tech.rescan');
  techCheck = (host: string, tech: string, index: number, scheme: string) => this.call<ExchangeSummary>('tech.check', { host, tech, index, scheme });
  errors = (id: string) => this.call<ErrorFinding[]>('errors.get', { id });
  parseJwt = (token: string) => this.call<ParsedJwt>('jwt.parse', { token });
  signJwt = (p: { header: Record<string, unknown>; payload: Record<string, unknown>; keyName?: string; secret?: string; alg?: string }) => this.call<string>('jwt.sign', p);
  tryJwtSecrets = (token: string, secrets: string[]) => this.call<string | null>('jwt.trySecrets', { token, secrets });
  keys = () => this.call<KeyInfo[]>('keys.list');
  keysStatus = () => this.call<{ keys: KeyInfo[]; canSave: boolean; where: string | null; error: string | null }>('keys.status');
  setKeySecret = (name: string, secret: string, save = false) => this.call<KeyInfo[]>('keys.setSecret', { name, secret, save });
  setKeyPem = (name: string, pem: string, passphrase?: string, save = false) => this.call<KeyInfo[]>('keys.setPem', { name, pem, save, ...(passphrase ? { passphrase } : {}) });
  setKeySaved = (name: string, save: boolean) => this.call<KeyInfo[]>('keys.setSaved', { name, save });
  deleteKey = (name: string) => this.call<KeyInfo[]>('keys.delete', { name });
  awsRequestInfo = (id: string) => this.call<AwsRequestInfo>('aws.requestInfo', { id });
  decodeSessionCookie = (name: string, value: string) => this.call<SessionCookie>('cookies.decodeSession', { name, value });
  flaskTrySecrets = (value: string, secrets: string[]) => this.call<string | null>('cookies.flaskTrySecrets', { value, secrets });
  signFlaskCookie = (p: { payload: unknown; keyName?: string; secret?: string; compress?: boolean }) => this.call<string>('cookies.flaskSign', p);
  resignOpen = (value: string) => this.call<{ kind: SignableKind | null; alg?: string; header?: Record<string, unknown>; payload?: unknown; compress?: boolean }>('resign.open', { value });
  resignPreview = (p: { kind: SignableKind; payload: unknown; header?: Record<string, unknown>; alg?: string; ttlSeconds?: number; bumpIat?: boolean; bumpNbf?: boolean; compress?: boolean; salt?: string; keyName?: string; secret?: string }) => this.call<string>('resign.preview', p);
  evergreenList = () => this.call<EvergreenStatus[]>('evergreen.list');
  evergreenSave = (entry: EvergreenEntry) => this.call<EvergreenStatus[]>('evergreen.save', { entry });
  evergreenDelete = (name: string) => this.call<EvergreenStatus[]>('evergreen.delete', { name });
  evergreenRender = (name: string) => this.call<string>('evergreen.render', { name });
  errorCounts = () => this.call<Array<{ kind: string; severity: string; count: number }>>('errors.counts');
  csrfBindings = () => this.call<CsrfBinding[]>('csrf.bindings');
  setCsrfBindings = (bindings: Array<Partial<CsrfBinding>>) => this.call<CsrfBinding[]>('csrf.setBindings', { bindings });
  evaluate = (url: string) => this.call<ScopeDecision>('scope.evaluate', { url });
  replayWith = (req: WireRequest, options: SendOptions) =>
    this.call<ExchangeSummary>('replay.send', { ...wire(req), options });
  replayBatch = (req: WireRequest, options: SendOptions & { concurrency?: number }) =>
    this.call<{ batchId: string; sends: ExchangeSummary[]; errors: string[] }>('replay.batch', { ...wire(req), options, concurrency: options.concurrency });
  previewTokens = (texts: string[], url: string, attachments?: string[]) =>
    this.call<{ sends: number; resolved: Array<{ ok: boolean; text?: string; error?: string }> }>('tokens.preview', { texts, url, ...(attachments?.length ? { attachments: Object.fromEntries(attachments.map((a) => [a, ''])) } : {}) });
  /** Decode values (query params, headers, cookies) as far as they go; null where nothing is encoded. */
  decodeValues = (texts: string[]) => this.call<Array<DecodedValue | null>>('structure.decode', { texts });
  /** Encode an edited decoded value back through its layers. */
  encodeValue = (decoded: DecodedValue, shown: string) => this.call<string>('structure.encode', { decoded, shown });
  oauthProfiles = () => this.call<OAuthProfileView[]>('oauth.list');
  saveOAuth = (profile: OAuthProfile, previous?: string) => this.call<OAuthProfileView>('oauth.save', { profile, ...(previous ? { previous } : {}) });
  deleteOAuth = (name: string) => this.call<boolean>('oauth.delete', { name });
  clearOAuth = (name: string) => this.call<boolean>('oauth.clear', { name });
  fetchOAuth = (name: string, refresh = false, ignoreTlsErrors = false) => this.call<{ expiresAt: number | null; scope: string | null }>('oauth.fetch', { name, refresh, ignoreTlsErrors });
  beginOAuth = (name: string) => this.call<{ url: string; redirectUri: string; state: string }>('oauth.begin', { name });
  cancelOAuth = (name: string) => this.call<boolean>('oauth.cancel', { name });
  completeOAuth = (name: string, url: string, ignoreTlsErrors = false) => this.call<{ expiresAt: number | null; scope: string | null }>('oauth.complete', { name, url, ignoreTlsErrors });
  oauthToken = (ref: string) => this.call<string>('oauth.token', { ref });
  discoverOAuth = (issuer: string, ignoreTlsErrors = false) =>
    this.call<{ issuer: string; authUrl?: string; tokenUrl?: string; scopes?: string[]; pkceMethods?: string[]; grants?: string[] }>('oauth.discover', { issuer, ignoreTlsErrors });
  pkce = (method: 'S256' | 'plain' = 'S256', verifier?: string) => this.call<{ verifier: string; challenge: string; method: 'S256' | 'plain' }>('oauth.pkce', { method, ...(verifier ? { verifier } : {}) });
  codecList = () => this.call<Array<{ id: string; label: string; terminal: boolean }>>('codecs.list');
  detect = (bytes: Uint8Array) => this.call<string[]>('codecs.detect', { base64: bytesToBase64(bytes) });
  layers = (chain: string[], bytes: Uint8Array) =>
    this.call<Array<{ kind: 'bytes'; base64: string } | { kind: 'value'; value: unknown }>>('codecs.layers', { chain, base64: bytesToBase64(bytes) });
  encode = (chain: string[], value: unknown) =>
    this.call<{ base64: string }>('codecs.encode', value instanceof Uint8Array ? { chain, base64: bytesToBase64(value) } : { chain, value }).then((r) => base64ToBytes(r.base64));
  /** Expand JSON fields that hold more encoded JSON, as deep as they go. */
  expandNested = (value: unknown) => this.call<{ value: unknown; fields: NestedField[] }>('codecs.expand', { value });
  /** Put expanded fields back, encoded the way they came; untouched ones go back exactly. */
  collapseNested = (value: unknown, fields: NestedField[]) => this.call<{ value: unknown; changed: string[]; errors: string[] }>('codecs.collapse', { value, fields });
  replaceIn = (chain: string[], bytes: Uint8Array, o: { find: string; replace: string; regex?: boolean; matchCase?: boolean; keys?: boolean; scope?: 'layer' | 'all' }) =>
    this.call<{ base64: string; counts: number[] }>('codecs.replace', { chain, base64: bytesToBase64(bytes), ...o }).then((r) => ({ output: base64ToBytes(r.base64), counts: r.counts }));
  /** Decode start..end of a text in place: the span actually decoded (it can be widened or trimmed), what it reads as, and the region to mark. */
  decodeRegion = (text: string, start: number, end: number, chain?: string[]) => this.call<RegionPlan>('codecs.region.decode', { text, start, end, chain });
  /** Every region back to its encoded form; with blocks, regions holding {{tokens}} are encoded by the sender after the tokens are filled in. */
  encodeRegions = (text: string, regions: TextRegion[], blocks = false) => this.call<{ text: string; blocks: number }>('codecs.regions.encode', { text, regions, blocks });
  /** The JSONPath of the JSON field a region replaced, or null. */
  regionPath = (text: string, start: number, end: number) => this.call<string | null>('codecs.region.path', { text, start, end });
  /** A JSON body pretty printed with its saved field codecs decoded in place as regions; null when none apply. */
  fieldRegions = (text: string, url: string, side: 'request' | 'response') => this.call<{ text: string; regions: TextRegion[]; errors: string[] } | null>('fields.regions', { text, url, side });
  chains = () => this.call<SavedChain[]>('codecs.chains.get');
  setChains = (chains: SavedChain[]) => this.call<boolean>('codecs.chains.set', { chains });
  coverage = (host: string) => this.call<CoverageReport>('traffic.coverage', { host });
  vars = () => this.call<{ vars: Record<string, VarValue>; extractors: Extractor[] }>('vars.list');
  setVar = (name: string, value: string) => this.call<boolean>('vars.set', { name, value });
  deleteVar = (name: string) => this.call<boolean>('vars.delete', { name });
  setExtractors = (extractors: Array<Partial<Extractor>>) => this.call<Extractor[]>('vars.extractors', { extractors });
  /** This user's saved workspace for the project (open editors and drafts), or null. */
  workspace = () => this.call<{ version: number; savedAt: number; [k: string]: unknown } | null>('workspace.get');
  saveWorkspace = (snapshot: { version: number; [k: string]: unknown }) => this.call<{ savedAt: number; sealed: boolean }>('workspace.set', { snapshot });
  rules = () => this.call<{ rules: ReplaceRule[]; mocks: MockRule[]; breakpoints: Breakpoint[]; hits: Record<string, number> }>('rules.get');
  setRules = (rules: Array<Partial<ReplaceRule>>) => this.call<ReplaceRule[]>('rules.set', { rules });
  testRule = (rule: Partial<ReplaceRule>, exchangeId: string) => this.call<{ matched: boolean; count: number; before: string; after: string }>('rules.test', { rule, exchangeId });
  setMocks = (mocks: Array<Partial<MockRule>>) => this.call<MockRule[]>('mocks.set', { mocks });
  setBreakpoints = (breakpoints: Array<Partial<Breakpoint>>) => this.call<Breakpoint[]>('breakpoints.set', { breakpoints });
  reproductions = () => this.call<Reproduction[]>('repro.list');
  /** Save a reproduction; pass the revision you opened to refuse overwriting someone else's save. */
  saveReproduction = (reproduction: ReproInput, baseRevision?: number) => this.call<Reproduction>('repro.save', { reproduction, baseRevision });
  removeReproduction = (id: string) => this.call<boolean>('repro.remove', { id });
  reproductionRevision = (id: string, revision: number) => this.call<ReproRevision | undefined>('repro.revision', { id, revision });
  promoteReproduction = (id: string) => this.call<Reproduction>('repro.promote', { id });
  reproductionEffective = (id: string, profile?: string, inputs?: Record<string, string>) =>
    this.call<{ profile?: string; values: EffectiveValue[]; setupFlow?: string; target?: string }>('repro.effective', { id, profile, inputs });
  runReproduction = (id: string, opts: { inputs?: Record<string, string>; profile?: string } = {}) => this.call<ReproRun>('repro.run', { id, ...opts });
  reproductionRuns = (id?: string) => this.call<ReproRun[]>('repro.runs', { id });
  cancelReproductionRun = (runId: string) => this.call<boolean>('repro.cancel', { runId });
  sessionProfiles = () => this.call<SessionProfile[]>('profiles.get');
  setSessionProfiles = (profiles: Array<Omit<SessionProfile, 'id'> & { id?: string }>) => this.call<SessionProfile[]>('profiles.set', { profiles });
  overrideState = () => this.call<OverrideState>('overrides.state');
  /** Suspend or resume every override; their own on/off settings are left as they are. */
  suspendOverrides = (suspended: boolean) => this.call<OverrideState>('overrides.suspend', { suspended });
  setOverrideGroups = (groups: Array<Omit<OverrideGroup, 'id'> & { id?: string }>) => this.call<OverrideGroup[]>('overrides.setGroups', { groups });
  applyOverrideGroup = (id: string, on: boolean, dryRun = false) =>
    this.call<{ changed: OverrideRef[]; unchanged: OverrideRef[]; shared: Array<OverrideRef & { groups: string[] }> }>('overrides.applyGroup', { id, on, dryRun });
  /** What mocks, rules, breakpoints and hooks did to one exchange, in order. */
  transforms = (id: string) => this.call<Transform[]>('traffic.transforms', { id });
  paused = () => this.call<Paused[]>('intercept.list');
  resolvePaused = (id: string, action: 'forward' | 'drop' | 'forward-pause-response', edits?: Record<string, unknown>) => this.call<boolean>('intercept.resolve', { id, action, edits });
  releaseAll = () => this.call<number>('intercept.releaseAll');
  keepAlivePaused = () => this.call<number>('intercept.keepAlive');
  setKeepAlivePaused = (ms: number) => this.call<number>('intercept.setKeepAlive', { ms });
  scripts = () => this.call<{ scripts: Script[]; stats: Record<string, ScriptStats>; errors: Record<string, string>; untrusted?: string[] }>('scripts.get');
  trustScript = (id: string) => this.call<boolean>('scripts.trust', { id });
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
  h2Run = (requests: Array<Omit<H2PlanRequest, 'body'> & WireRequest>, options: H2PlanOptions) =>
    this.call<H2PlanResult>('h2.run', { requests: requests.map((r) => ({ ...r, ...wire(r), body: undefined })), options });
  protocolLadder = (url: string, ignoreTlsErrors = false) => this.call<LadderStep[]>('protocol.ladder', { url, ignoreTlsErrors });
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
  wsScript = (exchangeId: string, opts: { timing?: boolean; waits?: boolean; keepAlive?: boolean } = {}) => this.call<WsScript>('ws.script', { exchangeId, ...opts });
  wsRun = (script: WsScript, options: WsRunOptions, replayOf?: string | null) => this.call<{ exchangeId: string; state: WsRunState | undefined }>('ws.run', { script, options, ...(replayOf ? { replayOf } : {}) });
  wsRunMore = (exchangeId: string, steps: WsScriptStep[], options: Pick<WsRunOptions, 'tokens' | 'encode' | 'fields'> = {}) => this.call<WsRunState>('ws.runMore', { exchangeId, steps, options });
  wsRunState = (exchangeId: string) => this.call<WsRunState | null>('ws.runState', { exchangeId });
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
  tlsGet = () => this.call<UpstreamTlsConfig>('tls.get');
  tlsSet = (cfg: Partial<UpstreamTlsConfig>) => this.call<UpstreamTlsConfig>('tls.set', cfg);
  tlsTrust = (pem: string, name?: string) => this.call<UpstreamTlsConfig>('tls.trust', { pem, ...(name ? { name } : {}) });
  tlsUntrust = (id: string) => this.call<UpstreamTlsConfig>('tls.untrust', { id });
  tlsSkipHost = (host: string) => this.call<UpstreamTlsConfig>('tls.skipHost', { host });
  tlsPeerCert = (host: string, port = 443) => this.call<PeerCertInfo>('tls.peerCert', { host, port });
  fieldCodecs = () => this.call<FieldCodecRule[]>('fields.list');
  setFieldCodecs = (rules: Array<Partial<FieldCodecRule>>) => this.call<FieldCodecRule[]>('fields.set', { rules });
  fieldCodecsFor = (url: string, side: 'request' | 'response') => this.call<FieldCodecRule[]>('fields.for', { url, side });
  decodeExchangeFields = (id: string, side: 'request' | 'response') => this.call<{ text: string; counts: number[]; errors: string[]; rules: FieldCodecRule[] } | null>('fields.decodeExchange', { id, side });
  decodeFields = (text: string, specs: Array<{ path: string; chain: string[] }>) => this.call<{ text: string; counts: number[]; errors: string[] } | null>('fields.decode', { text, specs });
  encodeFields = (text: string, specs: Array<{ path: string; chain: string[] }>) => this.call<{ text: string; counts: number[]; errors: string[] }>('fields.encode', { text, specs });
  parseFieldSpecs = (spec: string) => this.call<Array<{ path: string; chain: string[] }>>('fields.parse', { spec });
  tags = () => this.call<Array<{ tag: string; count: number; newestId: string }>>('tags.list');
  moveTag = (tag: string, id: string) => this.call<string[]>('tags.move', { tag, id });
  tagValue = (ref: string) => this.call<string>('tags.value', { ref });
  contractCheck = (id: string) => this.call<ContractResult | null>('contract.check', { id });
  contractScan = (host: string) => this.call<ContractSummary>('contract.scan', { host });
  identities = () => this.call<Identity[]>('identities.get');
  setIdentities = (identities: Identity[]) => this.call<Identity[]>('identities.set', { identities });
  authMatrix = (ids: string[], identities?: string[], ignoreTlsErrors = false) => this.call<{ runId: string; rows: AuthRow[] }>('authmatrix.run', { ids, identities, ignoreTlsErrors });
  negativeTests = (id: string, max?: number, ignoreTlsErrors = false) => this.call<{ runId: string; baseline: number | null; results: NegativeResult[] }>('negative.run', { id, max, ignoreTlsErrors });
  diffExchanges = (a: string, b: string) => this.call<ExchangeDiff>('diff.exchanges', { a, b });
  lifecycle = (host: string) => this.call<Resource[]>('lifecycle.get', { host });
  glossary = (host?: string) => this.call<GlossaryEntry[]>('glossary.get', { host });
  graphqlImport = (p: { targetUrl: string; schemaUrl?: string; headers?: HeaderList; schemaHeaders?: HeaderList; method?: 'introspection' | 'suggestions' | 'traffic'; ignoreTlsErrors?: boolean }) =>
    this.call<ApiSpec>('graphql.import', p as unknown as Record<string, unknown>);
  graphqlOperations = (host?: string) => this.call<SeenOperation[]>('graphql.operations', { host });
  graphqlDrift = (targetUrl: string) => this.call<Array<{ field: string; type: string; count: number; exampleId: string }>>('graphql.drift', { targetUrl });
  curl = (id: string) => this.call<string>('export.curl', { id });
  deleteTraffic = (p: { ids: string[] } | { query: string }) => this.call<{ deleted: number }>('traffic.delete', p);
  lan = () => this.call<LanState>('lan.get');
  lanAllow = (address: string) => this.call<LanState>('lan.allow', { address });
  lanRemove = (address: string) => this.call<LanState>('lan.remove', { address });
  lanDeny = (address: string) => this.call<LanState>('lan.deny', { address });
  clearTraffic = () => this.call<{ deleted: number }>('traffic.clear');
  retention = () => this.call<{ maxAgeDays?: number; maxSizeMB?: number }>('retention.get');
  setRetention = (retention: { maxAgeDays?: number; maxSizeMB?: number }) => this.call<{ maxAgeDays?: number; maxSizeMB?: number }>('retention.set', { retention });
  exportHar = (p: { ids?: string[]; query?: string }) => this.call<Record<string, unknown>>('export.har', p);
  exportPostman = (p: { flow?: string; ids?: string[]; name?: string }) => this.call<Record<string, unknown>>('export.postman', p);
  flowToTest = (name: string) => this.call<Script>('flows.toTest', { name });
  endpointNotes = () => this.call<Record<string, { notes: string; tags: string[]; updatedAt: number; by: string }>>('notes.endpoints');
  /** Everything known about one endpoint reference, "host METHOD /template". */
  endpoint = (key: string) => this.call<EndpointDetail>('endpoint.get', { key });
  /** Make one endpoint reference an alias of another (null removes the alias). */
  setEndpointAlias = (from: string, to: string | null) => this.call<Record<string, string>>('endpoint.alias', { from, to });
  setEndpointNote = (key: string, notes: string, tags: string[] = []) => this.call<Record<string, { notes: string; tags: string[] }>>('notes.setEndpoint', { key, notes, tags });
  noteFor = (id: string) => this.call<{ key: string; notes: string; tags: string[] } | null>('notes.forExchange', { id });
}

export type SearchColumn = 'url' | 'req_headers' | 'req_body' | 'res_headers' | 'res_body';
export interface SearchTerm {
  value: string;
  in: SearchColumn[];
  negate: boolean;
}

/** A JSON field holding more encoded JSON, as the codecs package finds it. */
export interface NestedField {
  at: Array<string | number>;
  path: string;
  chain: string[];
  original: string;
  decoded: unknown;
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
  /** Files the body refers to with {{file:name}}. */
  attachments?: Record<string, Uint8Array>;
}

const wire = (r: WireRequest) => ({
  method: r.method,
  url: r.url,
  headers: r.headers,
  bodyBase64: r.body ? bytesToBase64(r.body) : undefined,
  replayOf: r.replayOf ?? undefined,
  ...(r.attachments && Object.keys(r.attachments).length ? { attachments: Object.fromEntries(Object.entries(r.attachments).map(([k, v]) => [k, bytesToBase64(v)])) } : {}),
});

/** One value decoded for the structured editors (see codecs/structure.ts). */
export interface DecodedValue {
  chain: string[];
  kind: 'json' | 'form' | 'text';
  display: string;
  original: string;
  fields: NestedField[];
  outer?: unknown;
}

export type OAuthGrant = 'authorization_code' | 'client_credentials' | 'password' | 'refresh_token';

export interface OAuthProfile {
  name: string;
  grant: OAuthGrant;
  authUrl?: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  audience?: string;
  redirectUri?: string;
  pkce?: boolean;
  pkceMethod?: 'S256' | 'plain';
  clientAuth?: 'basic' | 'body';
  username?: string;
  password?: string;
  extraAuthParams?: string;
  extraTokenParams?: string;
  issuer?: string;
}

export interface OAuthProfileView extends OAuthProfile {
  token: null | { tokenType?: string; scope?: string; expiresAt?: number; obtainedAt: number; hasRefresh: boolean; hasIdToken: boolean; preview: string; expired: boolean };
  waiting: boolean;
}

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
