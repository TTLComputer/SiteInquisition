import { EventEmitter } from 'node:events';
import { SecretBox } from './secrets.js';
import { bytesToString, decodeChain, detectChain } from '@siteinquisition/codecs';
import { coverage, pathTemplate } from './coverage.js';
import { checkExchange, contractScan } from './contract.js';
import { exchangeCurl, exchangesToPostman, exportHar, flowToPostman, flowToTest } from './exporters.js';
import { harvestOperations, introspect, probeSuggestions, schemaDrift, schemaFromOperations, schemaToSpec, type GqlSchema } from './graphql.js';
import { diffExchanges, glossary, lifecycle } from './insight.js';
import { runAuthMatrix, runNegative, type Identity } from './probes.js';
import { findEndpoint } from './contract.js';
import { draftFlow, FlowRunner, normalizeFlow, type ApiFlow } from './flows.js';
import { exportOpenApi, importHar, parseSpec, requestForEndpoint, specCoverage, type ApiSpec } from './specs.js';
import { FieldCodecs } from './fieldcodecs.js';
import { moveTag, pickValues, tagValue, valueCatalog, valueOrigin } from './values.js';
import { cookieJar } from './cookies.js';
import type { Core } from './core.js';
import { newId } from './ids.js';
import { applyEdits, Intercept, normalizeBreakpoint, type Breakpoint } from './intercept.js';
import { McpServer, type McpSettings, type ToolDef } from './mcp.js';
import type { ProxyHooks } from './proxy.js';
import { runRace, type RaceOptions, type RaceRequest } from './race.js';
import { h3Tickets, runH3Plan, type H3PlanOptions, type H3PlanRequest } from './quic/plan.js';
import { runH2Plan, type H2PlanOptions, type H2PlanRequest } from './h2/plan.js';
import { protocolLadder as runProtocolLadder } from './h2/connect.js';
import { applyRule, conditionsMatch, requestSubject, responseSubject, normalizeMock, normalizeReplaceRule, type HookMessage, type MockRule, type ReplaceRule, type RuleInput } from './rules.js';
import { normalizeScript, ScriptEngine, type Script, type Sdk } from './scripts.js';
import { TrustedScripts } from './trust.js';
import { cookieHeaderFor, Sender, type AwsProfile, type Macro, type SendOptions, type SendRequest } from './send.js';
import { parseSigV4, type AwsCredentials } from './sigv4.js';
import type { Change, HeaderList, Transform } from './store.js';
import { resolveTokens } from './tokens.js';
import { ErrorService } from './errors.js';
import { awsRequestInfo, parsePresignedUrl } from './awsinfo.js';
import { EXAMPLE_SECRETS, parseJwt, signJwt, tryHmacSecrets, verifyJwt, type SigningKey } from './jwt.js';
import { KeyStore, type KeyVault, type PersistedKey } from './keys.js';
import { Evergreen, renderEvergreen, signableKind, type EvergreenEntry, type SignableKind } from './evergreen.js';
import { decodeSessionCookie, signFlaskCookie, tryFlaskSecrets, verifyFlaskCookie } from './sessioncookies.js';
import { TechService } from './tech.js';
import { OAuthService } from './oauth.js';
import { Vars } from './vars.js';
import { endpointDetail, setEndpointAlias } from './endpoints.js';
import { Reproductions } from './reproductions.js';
import { OverrideControl, replaceTransform, revisionOf, targetText } from './overrides.js';
import { WsReplays } from './wsreplay.js';
import type { WsScript } from './wsscript.js';

/**
 * Everything beyond capture: match and replace, mocks, breakpoints, scripts,
 * tokens and variables, login macros, SigV4, race-timed replay, stream
 * composers and the MCP server. Config lives in the project's meta table, so
 * it travels with the project and every change reaches clients as a
 * `meta.set` change event.
 */
export class PowerTools {
  readonly vars: Vars;
  readonly tech: TechService;
  readonly fieldCodecs: FieldCodecs;
  readonly errors: ErrorService;
  readonly scripts: ScriptEngine;
  private readonly trust: TrustedScripts;
  readonly intercept: Intercept;
  readonly sender: Sender;
  readonly ws: WsReplays;
  readonly mcp: McpServer;
  readonly flows: FlowRunner;
  /** Ephemeral events (paused requests, approvals) for API clients; not written to the change log. */
  readonly live = new EventEmitter<{ change: [Change] }>();
  private hits = new Map<string, number>();
  readonly awsKeys = new Map<string, AwsCredentials>();
  /** Signing keys: session-only unless the user saves one to the encrypted project. */
  readonly keys: KeyStore;
  /** Saved evergreen signed tokens (JWTs and session cookies), re-minted on each send. */
  readonly evergreen: Evergreen;
  /** OAuth 2.0 profiles and their tokens, for {{oauth:name}}. */
  readonly oauth: OAuthService;
  /** The master switch, groups and explanations for everything that changes live traffic. */
  readonly overrides: OverrideControl;
  /** Saved reproductions, their runs and session profiles. */
  readonly repros: Reproductions;

  constructor(private readonly core: Core) {
    const store = core.store;
    this.overrides = new OverrideControl(store, (kinds) => {
      // Hooks are compiled, so a group that turns one on or off reloads them.
      if (kinds.includes('hook')) void this.scripts.load(this.scriptList());
    });
    // Saved signing keys are encrypted with the keyring master key, like saved identities.
    const vault: KeyVault = {
      get canEncrypt() {
        return !!core.secrets;
      },
      get where() {
        return core.secrets?.keyring.name ?? null;
      },
      load: () => {
        const raw = store.getMeta<PersistedKey[] | string>('signingKeys');
        if (raw === undefined) return { keys: [] };
        if (!SecretBox.isSealed(raw)) return { keys: raw as PersistedKey[] };
        if (!core.secrets) return { keys: [], error: 'Saved signing keys are encrypted with a key from the OS keyring, which is not available here. Unlock the keyring and reopen the project.' };
        try {
          return { keys: JSON.parse(core.secrets.open(raw).toString('utf8')) as PersistedKey[] };
        } catch {
          return { keys: [], error: 'Saved signing keys were encrypted on another computer or with another keyring and cannot be read here. Save new ones to replace them.' };
        }
      },
      save: (keys) => store.setMeta('signingKeys', core.secrets && keys.length ? core.secrets.seal(JSON.stringify(keys)) : keys),
    };
    this.keys = new KeyStore(vault);
    this.evergreen = new Evergreen(store, this.keys);
    this.vars = new Vars(store);
    this.oauth = new OAuthService(store, () => core.secrets);
    this.errors = new ErrorService(store);
    this.tech = new TechService(store, this.vars, this.errors);
    this.fieldCodecs = new FieldCodecs(store);
    // Projects recorded before detection (or a newer set of detections) existed get scanned once, in the background.
    // Bump SCAN_VERSION when a release adds detections that old traffic should get.
    const SCAN_VERSION = 2;
    if ((store.getMeta<number>('techScanVersion') ?? 0) >= SCAN_VERSION) {
      // up to date
    } else if (store.stats().exchanges === 0) store.setMeta('techScanVersion', SCAN_VERSION);
    else {
      setImmediate(() => {
        try {
          if (!store.db.isOpen) return;
          this.tech.rescan(2000);
          store.setMeta('techScanVersion', SCAN_VERSION);
        } catch {
          // the project may have closed in the meantime
        }
      });
    }
    this.intercept = new Intercept(() => this.breakpoints());
    this.ws = new WsReplays(store);
    this.sender = new Sender({
      store,
      vars: this.vars,
      projectDir: core.projectDir,
      rules: () => this.replaceRules(),
      macros: () => this.macros(),
      awsProfiles: () => this.awsProfiles(),
      sessionKeys: this.awsKeys,
      countHit: (id) => this.countHit(id),
      tech: this.tech,
      fieldCodecs: this.fieldCodecs,
      sign: (name) => this.evergreen.resolve(name),
      signCookie: (host, name) => this.evergreen.resignCookie(host, name)?.value ?? null,
      oauth: this.oauth,
    });
    // Search values can use the same tokens as Replay. Flows are left out: a search never sends requests.
    store.resolveTokens = (text) => resolveTokens(text, this.sender.tokenContext('http://localhost/'));
    this.flows = new FlowRunner({
      store,
      sender: () => this.sender,
      flows: () => this.flowList(),
      runScript: (code, name, vars) => this.scripts.execute({ id: `flow:${name}`, name, kind: 'script', code }, this.sdk(), { vars }),
      globalVars: () => this.vars.values(),
      setGlobalVar: (k, v, src) => this.vars.set(k, v, src),
    });
    this.sender.flows = this.flows;
    this.ws.deps = {
      tokenContext: (url, extra) => this.sender.tokenContext(url, extra),
      cookieHeader: (url) => cookieHeaderFor(store, url),
      runFlows: (texts, flow) => this.sender.runFlows({ method: 'GET', url: 'http://localhost/', headers: [], body: new TextEncoder().encode(texts.join('\n')) }, { flow }),
      setVar: (name, value) => this.vars.set(name, value, 'websocket'),
      projectDir: core.projectDir,
      each: (arg) => pickValues(store, arg),
    };
    this.trust = new TrustedScripts(core.dataDir, core.projectDir);
    this.scripts = new ScriptEngine({ values: () => this.vars.values(), set: (name, value) => this.vars.set(name, value, 'script') }, (s) => this.trust.has(s.code));
    void this.scripts.load(this.scriptList());
    this.repros = new Reproductions({
      store,
      sender: () => this.sender,
      flows: () => this.flows,
      ws: () => this.ws,
      flowList: () => this.flowList(),
      macros: () => this.macros(),
      saveFlow: (f) => this.saveFlow(f),
      projectVars: () => this.vars.values(),
    });
    this.mcp = new McpServer(this.mcpTools(), () => this.mcpSettings());

    // Extraction rules watch every completed response, including replays.
    store.on('change', (c) => {
      if (c.kind !== 'exchange.response') return;
      try {
        const ex = store.getExchange(c.entityId);
        if (ex) this.vars.extract(ex);
      } catch {
        // a bad extractor must not break capture
      }
    });
    const emit = (kind: string, entityId: string, data: unknown) =>
      this.live.emit('change', { id: newId(), actor: store.actor, at: Date.now(), kind, entity: kind.split('.')[0]!, entityId, data });
    this.intercept.on('paused', (p) => emit('intercept.paused', p.id, p));
    this.intercept.on('resolved', (id) => emit('intercept.resolved', id, null));
    this.mcp.on('approval', (a) => emit('mcp.approval', a.id, a));
    this.mcp.on('decided', (id, d) => emit('mcp.decided', id, d));
    this.mcp.on('activity', (a) => emit('mcp.activity', a.tool, a));
    this.ws.on('progress', (st) => emit('wsreplay.progress', st.exchangeId, st));
    this.oauth.on('updated', (name) => emit('oauth.updated', name, null));
  }

  // ---------- config ----------
  private meta<T>(key: string, fallback: T): T {
    return this.core.store.getMeta<T>(key) ?? fallback;
  }

  replaceRules(): ReplaceRule[] {
    return this.meta<ReplaceRule[]>('replaceRules', []);
  }
  setReplaceRules(list: Array<RuleInput<ReplaceRule>>): ReplaceRule[] {
    const out = list.map(normalizeReplaceRule);
    this.core.store.setMeta('replaceRules', out);
    return out;
  }
  mocks(): MockRule[] {
    return this.meta<MockRule[]>('mocks', []);
  }
  setMocks(list: Array<RuleInput<MockRule>>): MockRule[] {
    const out = list.map(normalizeMock);
    this.core.store.setMeta('mocks', out);
    return out;
  }
  breakpoints(): Breakpoint[] {
    return this.meta<Breakpoint[]>('breakpoints', []);
  }
  setBreakpoints(list: Array<Omit<Breakpoint, 'id'> & { id?: string }>): Breakpoint[] {
    const out = list.map(normalizeBreakpoint);
    this.core.store.setMeta('breakpoints', out);
    return out;
  }
  /** PING interval (ms) for HTTP/2 and HTTP/3 connections held at a breakpoint; 0 is off. */
  pausedKeepAlive(): number {
    return this.core.proxy.pausedKeepAlive;
  }
  setPausedKeepAlive(ms: number): number {
    const clean = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
    this.core.store.setMeta('pausedKeepAliveMs', clean);
    this.core.proxy.setPausedKeepAlive(clean);
    this.core.browserProxy?.setPausedKeepAlive(clean);
    return clean;
  }
  /** Scripts that ask to run without the sandbox but whose code nobody on this computer trusted yet; they run sandboxed. */
  untrustedScripts(): string[] {
    return this.scriptList()
      .filter((s) => s.sandbox === false && !this.trust.has(s.code))
      .map((s) => s.id);
  }
  async trustScript(id: string): Promise<boolean> {
    const s = this.scriptList().find((x) => x.id === id);
    if (!s) throw new Error('script not found');
    this.trust.add(s.code);
    await this.scripts.load(this.scriptList());
    return true;
  }
  scriptList(): Script[] {
    return this.meta<Script[]>('scripts', []);
  }
  /** Save the scripts and recompile hooks; resolves once compile errors are known. */
  async setScripts(list: Array<Omit<Script, 'id'> & { id?: string }>): Promise<Script[]> {
    const out = list.map(normalizeScript);
    // Saving a script with the sandbox off, through the app or API on this computer, is the user trusting that code.
    for (const s of out) if (s.sandbox === false) this.trust.add(s.code);
    this.core.store.setMeta('scripts', out);
    await this.scripts.load(out);
    return out;
  }
  macros(): Macro[] {
    return this.meta<Macro[]>('macros', []);
  }
  setMacros(list: Array<Omit<Macro, 'id'> & { id?: string }>): Macro[] {
    const out = list.map((m) => {
      if (!m.name?.trim() || !m.host?.trim()) throw new Error('a macro needs a name and a host');
      if (!Array.isArray(m.steps) || !m.steps.length) throw new Error('a macro needs at least one step');
      return { ...m, id: m.id ?? newId() };
    });
    this.core.store.setMeta('macros', out);
    return out;
  }
  flowList(): ApiFlow[] {
    return this.meta<ApiFlow[]>('flows', []);
  }
  setFlows(list: Array<Omit<ApiFlow, 'id'> & { id?: string }>): ApiFlow[] {
    const out = list.map(normalizeFlow);
    const names = new Set<string>();
    for (const f of out) {
      if (names.has(f.name)) throw new Error(`two flows are called "${f.name}"`);
      names.add(f.name);
    }
    this.core.store.setMeta('flows', out);
    return out;
  }
  /** Add or replace one flow (by id, then by name). */
  saveFlow(f: Omit<ApiFlow, 'id'> & { id?: string }): ApiFlow {
    const list = this.flowList();
    const i = list.findIndex((x) => (f.id && x.id === f.id) || x.name === f.name);
    const next = normalizeFlow(i === -1 ? f : { ...f, id: list[i]!.id });
    const all = i === -1 ? [...list, next] : list.map((x, k) => (k === i ? next : x));
    this.setFlows(all);
    return next;
  }
  runFlow(nameOrId: string, inputs: Record<string, string> = {}) {
    return this.flows.run(nameOrId, inputs);
  }
  draftFlow(exchangeIds: string[], name?: string) {
    return draftFlow(this.core.store, exchangeIds, name);
  }

  // ---------- API descriptions ----------
  specs(): ApiSpec[] {
    return this.meta<ApiSpec[]>('specs', []);
  }
  importSpec(text: string, name?: string): ApiSpec {
    const spec = parseSpec(text, name);
    // Re-importing the same API replaces it.
    const list = this.specs().filter((s) => !(s.name === spec.name && s.format === spec.format));
    this.core.store.setMeta('specs', [...list, spec]);
    return spec;
  }
  deleteSpec(id: string): void {
    this.core.store.setMeta('specs', this.specs().filter((s) => s.id !== id));
  }
  specCoverage(host: string) {
    return specCoverage(this.specs(), coverage(this.core.store, host));
  }
  specRequest(specId: string, key: string, opts: { baseUrl?: string; values?: Record<string, string> } = {}) {
    const spec = this.specs().find((s) => s.id === specId);
    const ep = spec?.endpoints.find((e) => e.key === key);
    if (!spec || !ep) throw new Error('no such endpoint');
    // Fill path parameters with real recorded values where a field of the same name exists.
    const values: Record<string, string> = { ...(opts.values ?? {}) };
    // First choice: a recorded call to this very endpoint, with its path segments.
    const names = [...ep.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    if (names.some((n) => values[n] === undefined)) {
      const literal = `${spec.basePath}${ep.path.split('{')[0]}`;
      const re = new RegExp(`^${spec.basePath.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}${ep.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}|\{[^}]+\}/g, '([^/]+)')}/?$`);
      for (const e of this.core.store.search(`path:${literal} method:${ep.method}`, { limit: 200 })) {
        const m = re.exec(e.path.split('?')[0]!);
        if (!m) continue;
        names.forEach((n, i) => {
          if (values[n] === undefined && m[i + 1]) values[n] = decodeURIComponent(m[i + 1]!);
        });
        break;
      }
    }
    const fields = ep.params.some((p) => p.in === 'path' && values[p.name] === undefined) ? valueCatalog(this.core.store, { limit: 800 }) : [];
    for (const p of ep.params.filter((x) => x.in === 'path' && values[x.name] === undefined)) {
      const want = p.name.toLowerCase().replace(/[_-]/g, '');
      const f = fields.find((x) => x.side === 'response' && x.name.toLowerCase().replace(/[_-]/g, '') === want) ?? (want.endsWith('id') ? fields.find((x) => x.side === 'response' && x.name === 'id' && x.template.toLowerCase().includes(want.slice(0, -2))) : undefined);
      if (f?.samples[0]) values[p.name] = f.samples[0];
    }
    return requestForEndpoint(spec, ep, { ...opts, values });
  }
  importHar(text: string, tag?: string) {
    return importHar(this.core.store, text, tag);
  }
  exportOpenApi(host: string, title?: string) {
    return exportOpenApi(this.core.store, host, { title });
  }

  // ---------- values and tags ----------
  values(opts: { host?: string; query?: string; limit?: number } = {}) {
    return valueCatalog(this.core.store, opts);
  }
  valueOrigin(value: string, beforeId?: string) {
    return valueOrigin(this.core.store, value, { beforeId });
  }
  moveTag(tag: string, toId: string) {
    return moveTag(this.core.store, tag, toId);
  }

  // ---------- extras: contracts, probes, insight, GraphQL, exports, notes ----------
  contractCheck(id: string) {
    return checkExchange(this.core.store, this.specs(), id);
  }
  contractScan(host: string) {
    return contractScan(this.core.store, this.specs(), host);
  }
  identities(): Identity[] {
    const fallback: Identity[] = [{ name: 'no auth', headers: [], anonymous: true }];
    const raw = this.core.store.getMeta<Identity[] | string>('identities');
    if (raw === undefined) return fallback;
    if (!SecretBox.isSealed(raw)) return raw as Identity[];
    if (!this.core.secrets) throw new Error('Saved identities are encrypted with a key from the OS keyring, which is not available. Unlock the keyring and try again.');
    try {
      return JSON.parse(this.core.secrets.open(raw).toString('utf8')) as Identity[];
    } catch {
      throw new Error("Saved identities were encrypted on another computer or with another keyring and cannot be read here. Save new ones to replace them.");
    }
  }
  setIdentities(list: Identity[]): Identity[] {
    for (const i of list) if (!i.name?.trim()) throw new Error('an identity needs a name');
    // Identities hold tokens and passwords: keep them encrypted when there is a keyring.
    this.core.store.setMeta('identities', this.core.secrets ? this.core.secrets.seal(JSON.stringify(list)) : list);
    return list;
  }
  authMatrix(exchangeIds: string[], identities?: string[], ignoreTlsErrors?: boolean) {
    const all = this.identities();
    const chosen = identities?.length ? all.filter((i) => identities.includes(i.name)) : all;
    if (!chosen.length) throw new Error('add at least one identity (another user, or no auth)');
    return runAuthMatrix(this.core.store, this.sender, { exchangeIds, identities: chosen, ignoreTlsErrors });
  }
  negativeTests(id: string, max?: number, ignoreTlsErrors?: boolean) {
    const ex = this.core.store.getSummary(id);
    const hit = ex ? findEndpoint(this.specs(), ex) : undefined;
    return runNegative(this.core.store, this.sender, id, { schema: hit?.ep.requestSchema, max, ignoreTlsErrors });
  }
  diff(a: string, b: string) {
    return diffExchanges(this.core.store, a, b);
  }
  lifecycle(host: string) {
    return lifecycle(this.core.store, this.specs(), host);
  }
  glossary(host?: string) {
    return glossary(this.core.store, { host });
  }
  async graphqlImport(opts: { targetUrl: string; schemaUrl?: string; headers?: HeaderList; schemaHeaders?: HeaderList; method?: 'introspection' | 'suggestions' | 'traffic'; ignoreTlsErrors?: boolean }) {
    const from = opts.schemaUrl || opts.targetUrl;
    let schema: GqlSchema;
    let note = '';
    if (opts.method === 'traffic') {
      const ops = harvestOperations(this.core.store, { host: new URL(opts.targetUrl).hostname });
      if (!ops.length) throw new Error('no GraphQL operations in recorded traffic for this host');
      schema = schemaFromOperations(ops);
      note = `${ops.length} operations seen in traffic`;
    } else if (opts.method === 'suggestions') {
      const r = await probeSuggestions(this.sender, this.core.store, { url: from, headers: opts.schemaHeaders ?? opts.headers, ignoreTlsErrors: opts.ignoreTlsErrors });
      if (!r.suggestionsWork) throw new Error('the server gives no "Did you mean" suggestions; try traffic instead');
      schema = r.schema;
      note = `rebuilt from suggestions in ${r.requests} requests`;
    } else {
      schema = (await introspect(this.sender, this.core.store, { url: from, headers: opts.schemaHeaders ?? opts.headers, ignoreTlsErrors: opts.ignoreTlsErrors })).schema;
    }
    const spec = schemaToSpec(schema, { targetUrl: opts.targetUrl, schemaFrom: from });
    // Requests to the target carry the target's headers (auth for pre-prod), not the schema server's.
    if (opts.headers?.length) for (const ep of spec.endpoints) if (ep.draft) ep.draft.headers = [...ep.draft.headers, ...opts.headers.filter(([k]) => k.toLowerCase() !== 'content-type')];
    if (note) spec.warnings.push(note);
    const list = this.specs().filter((s) => !(s.format === 'graphql' && s.servers[0] === opts.targetUrl));
    this.core.store.setMeta('specs', [...list, spec]);
    return spec;
  }
  graphqlOperations(host?: string) {
    return harvestOperations(this.core.store, { host });
  }
  graphqlDrift(targetUrl: string) {
    return schemaDrift(this.core.store, targetUrl);
  }
  curl(id: string) {
    return exchangeCurl(this.core.store, id);
  }
  exportHar(ids: string[]) {
    return exportHar(this.core.store, ids);
  }
  exportPostman(p: { flow?: string; ids?: string[]; name?: string }) {
    if (p.flow) {
      const f = this.flows.find(p.flow);
      if (!f) throw new Error(`no flow "${p.flow}"`);
      return flowToPostman(f);
    }
    return exchangesToPostman(this.core.store, p.ids ?? [], p.name);
  }
  /** Save a test-suite script that checks a flow; returns the script. */
  async flowToTest(name: string): Promise<Script> {
    const f = this.flows.find(name);
    if (!f) throw new Error(`no flow "${name}"`);
    const scriptName = `test ${f.name}`;
    const list = this.scriptList().filter((x) => x.name !== scriptName);
    const saved = await this.setScripts([...list, { name: scriptName, kind: 'test', code: flowToTest(f) }]);
    return saved.find((x) => x.name === scriptName)!;
  }
  endpointNotes(): Record<string, { notes: string; tags: string[]; updatedAt: number; by: string }> {
    return this.meta('endpointNotes', {});
  }
  /** Notes on an endpoint template: key "host METHOD /template". An empty note and no tags removes it. */
  setEndpointNote(key: string, notes: string, tags: string[] = []) {
    const all = this.endpointNotes();
    if (!notes.trim() && !tags.length) delete all[key];
    else all[key] = { notes, tags, updatedAt: Date.now(), by: this.core.store.actor };
    this.core.store.setMeta('endpointNotes', all);
    return all;
  }
  /** Everything known about one endpoint reference, "host METHOD /template". */
  endpoint(key: string) {
    return endpointDetail(
      { store: this.core.store, specs: this.specs(), notes: this.endpointNotes(), mocks: this.mocks(), rules: this.replaceRules(), breakpoints: this.breakpoints(), flows: this.flowList() },
      key,
    );
  }
  setEndpointAlias(from: string, to: string | null) {
    return setEndpointAlias(this.core.store, from, to);
  }
  noteFor(exchangeId: string) {
    const ex = this.core.store.getSummary(exchangeId);
    if (!ex) return null;
    const key = `${ex.host} ${ex.method} ${pathTemplate(ex.path)}`;
    return { key, ...(this.endpointNotes()[key] ?? { notes: '', tags: [] }) };
  }

  awsProfiles(): AwsProfile[] {
    return this.meta<AwsProfile[]>('awsProfiles', []);
  }
  setAwsProfiles(list: AwsProfile[]): AwsProfile[] {
    for (const p of list) {
      if (!p.name || !p.region || !p.service) throw new Error('an AWS profile needs a name, region and service');
      if (!/^(profile:.*|env|session)$/.test(p.source)) throw new Error('source must be "profile:<name>", "env" or "session"');
    }
    this.core.store.setMeta('awsProfiles', list);
    return list;
  }
  mcpSettings(): McpSettings {
    return this.meta<McpSettings>('mcpSettings', { writeMode: 'ask' });
  }
  setMcpSettings(s: McpSettings): McpSettings {
    if (s.writeMode !== 'ask' && s.writeMode !== 'allow') throw new Error('writeMode must be "ask" or "allow"');
    this.core.store.setMeta('mcpSettings', { writeMode: s.writeMode });
    return this.mcpSettings();
  }
  ruleHits(): Record<string, number> {
    return Object.fromEntries(this.hits);
  }
  private countHit(id: string) {
    this.hits.set(id, (this.hits.get(id) ?? 0) + 1);
  }

  // ---------- inline hooks ----------
  private resolver(url: string) {
    return (s: string) => {
      try {
        return resolveTokens(s, this.sender.tokenContext(url));
      } catch {
        return s;
      }
    };
  }

  /** `req` is the request a response answers; omit it for the request phase. */
  private applyRules(phase: 'request' | 'response', msg: HookMessage, req?: HookMessage, transforms?: Transform[]): string[] {
    const applied: string[] = [];
    const reqUrl = req?.url ?? msg.url;
    for (const rule of this.replaceRules()) {
      if (rule.enabled === false || rule.phase !== phase) continue;
      // Re-read each time: an earlier rule may have changed what later ones match on.
      if (!conditionsMatch(rule, phase === 'request' ? requestSubject(msg) : responseSubject(req, msg))) continue;
      const before = transforms ? targetText(msg, rule) : '';
      if (applyRule(rule, msg, this.resolver(reqUrl))) {
        this.countHit(rule.id);
        applied.push(`rule:${rule.name}`);
        transforms?.push(replaceTransform(phase, rule, before, targetText(msg, rule)));
      }
    }
    return applied;
  }

  /** What a breakpoint did, for the exchange's explanation. */
  private pauseTransform(phase: 'request' | 'response', paused: { breakpointId?: string; action?: string; edits?: unknown } | null | undefined): Transform | null {
    if (!paused) return null;
    const bp = this.breakpoints().find((b) => b.id === paused.breakpointId);
    const outcome = paused.action === 'drop' ? 'dropped' : paused.edits ? 'edited' : 'forwarded';
    const name = bp ? [bp.method, `${bp.host ?? ''}${bp.path ?? bp.pathPrefix ?? ''}`].filter(Boolean).join(' ') || 'every request' : 'paused by hand';
    return { phase, kind: 'breakpoint', ...(bp ? { ruleId: bp.id, revision: revisionOf(bp) } : {}), name, outcome, at: Date.now() };
  }

  private hookTransforms(phase: 'request' | 'response', names: string[]): Transform[] {
    const list = this.scriptList();
    return names.map((n) => {
      const s = list.find((x) => x.name === n);
      return { phase, kind: 'hook', ...(s ? { ruleId: s.id, revision: revisionOf(s) } : {}), name: n, outcome: 'changed', at: Date.now() } satisfies Transform;
    });
  }

  /** Try a rule (saved or not) against a recorded exchange without changing anything. */
  testRule(input: RuleInput<ReplaceRule>, exchangeId: string): { matched: boolean; count: number; before: string; after: string } {
    const rule = normalizeReplaceRule(input);
    const store = this.core.store;
    const ex = store.getExchange(exchangeId);
    if (!ex) throw new Error('no such exchange');
    const req = rule.phase === 'request';
    const msg: HookMessage = {
      method: ex.method,
      url: ex.url,
      headers: [...((req ? ex.requestHeaders : ex.responseHeaders) ?? [])],
      body: store.getBody(exchangeId, req ? 'request' : 'response', true) ?? new Uint8Array(),
      status: req ? undefined : (ex.status ?? undefined),
    };
    const render = (m: HookMessage) => {
      const first = req ? `${m.method} ${m.url}` : `${m.status ?? ''}`;
      return [first, ...m.headers.map(([k, v]) => `${k}: ${v}`), '', bytesToString(m.body.subarray(0, 64 * 1024))].join('\n');
    };
    const before = render(msg);
    const reqSide = { headers: [...(ex.requestHeaders ?? [])], body: store.getBody(exchangeId, 'request', true) ?? new Uint8Array() };
    const subject = req
      ? requestSubject({ method: ex.method, url: ex.url, ...reqSide })
      : responseSubject({ method: ex.method, url: ex.url, ...reqSide }, { ...msg, headers: [...msg.headers] });
    const matched = conditionsMatch(rule, subject);
    const count = matched ? applyRule(rule, msg, this.resolver(ex.url)) : 0;
    return { matched, count, before, after: render(msg) };
  }

  readonly hooks: ProxyHooks = {
    request: async (msg, ctx) => {
      // The redirect back from an OAuth sign-in that is waiting for its code.
      const signedIn = this.oauth.capture(msg.url);
      if (signedIn) return { applied: ['oauth:callback'], respond: signedIn };
      const applied: string[] = [];
      const transforms: Transform[] = [];
      // Suspended: nothing new pauses or changes. Traffic already paused stays paused until someone answers it.
      const off = this.overrides.suspended;
      if (off) applied.push('overrides:suspended');
      const paused = off ? null : await this.intercept.check('request', msg, ctx.source, ctx.key);
      const bp = this.pauseTransform('request', paused);
      if (bp) transforms.push(bp);
      if (paused?.action === 'drop') return { applied: [...applied, 'breakpoint:dropped'], transforms, drop: true };
      if (paused) {
        applyEdits(msg, paused);
        if (paused.edits) applied.push('breakpoint:edited');
      }
      const mock = off ? undefined : this.mocks().find((m) => m.enabled !== false && conditionsMatch({ ...m, status: undefined }, requestSubject(msg)));
      if (mock) {
        this.countHit(mock.id);
        if (mock.delayMs) await new Promise((r) => setTimeout(r, Math.min(mock.delayMs!, 60_000)));
        const body = new TextEncoder().encode(this.resolver(msg.url)(mock.body));
        transforms.push({ phase: 'request', kind: 'mock', ruleId: mock.id, name: mock.name, revision: revisionOf(mock), outcome: 'answered', target: `status ${mock.status}`, at: Date.now() });
        return { applied: [...applied, `mock:${mock.name}`], transforms, respond: { status: mock.status, headers: mock.headers, body } };
      }
      if (!off) applied.push(...this.applyRules('request', msg, undefined, transforms));
      applied.push(...this.evergreenCookies(msg));
      if (!off && this.scripts.active) {
        const names = await this.scripts.run('request', msg);
        applied.push(...names.map((n) => `script:${n}`));
        transforms.push(...this.hookTransforms('request', names));
      }
      return { applied, transforms };
    },
    wantsResponse: (req, ctx) =>
      !this.overrides.suspended &&
      (this.scripts.active ||
        this.intercept.wouldPauseResponse(req, ctx.key) ||
        this.replaceRules().some((r) => r.enabled !== false && r.phase === 'response' && conditionsMatch(r, { ...req, phase: 'response' }, { lenient: true }))),
    response: async (req, res, ctx) => {
      if (this.overrides.suspended) return { applied: [] };
      const transforms: Transform[] = [];
      const applied = this.applyRules('response', res, req, transforms);
      if (this.scripts.active) {
        const names = await this.scripts.run('response', req, res);
        applied.push(...names.map((n) => `script:${n}`));
        transforms.push(...this.hookTransforms('response', names));
      }
      const paused = await this.intercept.check('response', res, ctx.source, ctx.key, req);
      const bp = this.pauseTransform('response', paused);
      if (bp) transforms.push(bp);
      if (paused?.action === 'drop') return { applied: [...applied, 'breakpoint:dropped'], transforms, drop: true };
      if (paused) {
        applyEdits(res, paused);
        if (paused.edits) applied.push('breakpoint:edited');
      }
      return { applied, transforms };
    },
    wantsWsMessages: (url) => !this.overrides.suspended && this.intercept.wantsWsMessages(url),
    wsMessage: async (m, ctx) => {
      if (this.overrides.suspended) return;
      const r = await this.intercept.checkWs(m.url, { exchangeId: m.exchangeId, direction: m.from, opcode: m.opcode, fragments: m.fragments, payload: m.payload }, ctx.source);
      if (!r || r.action !== 'drop' && !r.edits) return;
      if (r.action === 'drop') return { drop: true };
      const payload = r.edits?.bodyBase64 !== undefined ? Buffer.from(r.edits.bodyBase64, 'base64') : m.payload;
      const opcode = r.edits?.opcode ?? (m.opcode === 'binary' ? 'binary' : 'text');
      if (payload.equals(m.payload) && opcode === m.opcode) return;
      return { replace: { opcode, payload } };
    },
  };

  // ---------- SDK for scripts and MCP ----------
  private textBody(id: string, side: 'request' | 'response') {
    const b = this.core.store.getBody(id, side, true);
    return b ? bytesToString(b) : null;
  }

  sdk(): Sdk {
    const store = this.core.store;
    const fullSdk = {
      search: (query = '', limit = 100) => store.search(String(query), { limit: Number(limit) }),
      get: (id: string) => store.getExchange(String(id)) ?? null,
      body: (id: string, side: 'request' | 'response' = 'response') => this.textBody(String(id), side),
      json: (id: string, side: 'request' | 'response' = 'response') => {
        const t = this.textBody(String(id), side);
        return t ? (JSON.parse(t) as unknown) : null;
      },
      send: async (req: SendRequest & { body?: string | Uint8Array }, opts: SendOptions = {}) => {
        const body = typeof req.body === 'string' ? new TextEncoder().encode(req.body) : req.body;
        const res = await this.sender.send({ ...req, headers: req.headers ?? [], body }, opts);
        return { ...res, body: this.textBody(res.id, 'response') };
      },
      resend: async (id: string, opts: SendOptions = {}) => {
        const ex = store.getExchange(String(id));
        if (!ex) throw new Error(`no exchange ${id}`);
        const res = await this.sender.send({ method: ex.method, url: ex.url, headers: ex.requestHeaders, body: store.getBody(ex.id, 'request', false), replayOf: ex.id }, opts);
        return { ...res, body: this.textBody(res.id, 'response') };
      },
      race: (requests: RaceRequest[], opts: RaceOptions) => runRace(store, requests, opts),
      websocket: {
        script: (id: string, opts: { waits?: boolean; timing?: boolean } = {}) => this.ws.scriptFor(String(id), opts),
        run: async (script: WsScript, opts: Record<string, unknown> = {}) => {
          const { exchangeId } = await this.ws.run(script, { ...(opts as object), closeAtEnd: opts.closeAtEnd !== false });
          while (this.ws.runState(exchangeId)?.running) await new Promise((r) => setTimeout(r, 50));
          return this.ws.runState(exchangeId);
        },
      },
      h3: (requests: Array<H3PlanRequest & { body?: string | Uint8Array }>, opts: H3PlanOptions = {}) =>
        runH3Plan(store, requests.map((r) => ({ ...r, headers: r.headers ?? [], body: typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body })), opts),
      vars: () => this.vars.values(),
      getVar: (name: string) => this.vars.values()[name],
      setVar: (name: string, value: string) => this.vars.set(String(name), String(value), 'script'),
      cookies: () => this.tech.annotateJar(),
      tech: (host?: string) => (host ? this.tech.hostReport(String(host)) : this.tech.allHosts()),
      csrf: (id: string) => this.tech.csrfFindings(String(id)),
      errors: (id: string) => this.errors.findings(String(id)),
      jwt: (token: string) => parseJwt(String(token)),
      signJwt: (header: Record<string, unknown>, payload: Record<string, unknown>, key: SigningKey, alg?: string) => signJwt(header, payload, key, alg),
      sessionCookie: (name: string, value: string) => decodeSessionCookie(String(name), String(value)),
      aws: (id: string) => {
        const ex = this.core.store.getExchange(String(id));
        if (!ex) throw new Error(`no exchange ${id}`);
        return awsRequestInfo({ url: ex.url, headers: ex.requestHeaders });
      },
      tag: (id: string, tags: string[]) => store.tagExchange(String(id), tags.map(String)),
      notes: (id: string, notes: string) => store.setNotes(String(id), String(notes)),
      scope: () => this.core.scope.get(),
      flow: (flowId: string) => store.getFlow(String(flowId)),
      runMacro: (id: string) => this.sender.runMacro(String(id)),
      flows: {
        list: () => this.flowList(),
        run: async (name: string, inputs: Record<string, string> = {}) => {
          const r = await this.flows.run(String(name), inputs);
          if (!r.ok) throw new Error(`flow "${name}" failed: ${r.error}`);
          return r.vars;
        },
        result: (name: string, inputs: Record<string, string> = {}) => this.flows.run(String(name), inputs),
        save: (f: Omit<ApiFlow, 'id'>) => this.saveFlow(f),
        draft: (ids: string[], name?: string) => this.draftFlow(ids.map(String), name),
      },
      values: (host?: string) => this.values({ host }),
      pick: (spec: string) => pickValues(store, String(spec)),
      origin: (value: string) => this.valueOrigin(String(value)),
      tagged: (ref: string) => tagValue(store, String(ref)),
      moveTag: (tag: string, id: string) => this.moveTag(String(tag), String(id)),
      resolve: (text: string, url = 'http://localhost/') => resolveTokens(String(text), this.sender.tokenContext(String(url))),
      specs: () => this.specs(),
      specRequest: (specId: string, key: string) => this.specRequest(String(specId), String(key)),
      contract: (id: string) => this.contractCheck(String(id)),
      contractScan: (host: string) => this.contractScan(String(host)),
      authMatrix: (ids: string[], identities?: string[]) => this.authMatrix(ids.map(String), identities),
      negative: (id: string, max?: number) => this.negativeTests(String(id), max),
      diff: (a: string, b: string) => this.diff(String(a), String(b)),
      lifecycle: (host: string) => this.lifecycle(String(host)),
      glossary: (host?: string) => this.glossary(host),
      curl: (id: string) => this.curl(String(id)),
      graphql: {
        import: (o: Parameters<PowerTools['graphqlImport']>[0]) => this.graphqlImport(o),
        operations: (host?: string) => this.graphqlOperations(host),
        drift: (url: string) => this.graphqlDrift(String(url)),
      },
    };
    return fullSdk as unknown as Sdk;
  }

  runScript(script: Pick<Script, 'id' | 'name' | 'kind' | 'code' | 'sandbox'>) {
    return this.scripts.execute(script, this.sdk());
  }

  /** Send a technology's optional check to a host, on the user's say-so. Probes are GET, HEAD or OPTIONS only. */
  async runCheck(host: string, tech: string, index = 0, scheme: 'http' | 'https' = 'https') {
    const probes = (this.tech.signature(tech)?.checks ?? []).filter((c) => c.probe);
    const probe = probes[index]?.probe;
    if (!probe) throw new Error(`no check ${index} for ${tech}`);
    if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) throw new Error('invalid host');
    const res = await this.sender.send({ method: probe.method, url: `${scheme}://${host}${probe.path}`, headers: [] }, { refreshCookies: true, tokens: false });
    addTags(this.core.store, res.id, ['check', `check:${tech}`]);
    return this.core.store.getSummary(res.id) ?? res;
  }

  // ---------- race and streams ----------
  race(requests: RaceRequest[], opts: RaceOptions) {
    return runRace(this.core.store, requests, opts);
  }

  /** HTTP/3 stream plan (the protocol lab). */
  h3Plan(rows: H3PlanRequest[], opts: H3PlanOptions) {
    return runH3Plan(this.core.store, rows, opts);
  }

  /** HTTP/2 stream plan (the protocol lab). */
  h2Plan(rows: H2PlanRequest[], opts: H2PlanOptions) {
    return runH2Plan(this.core.store, rows, opts);
  }

  /** Try every way of getting HTTP/2 (and HTTP/3) from a server and report which it accepts. */
  protocolLadder(url: string, opts: { ignoreTlsErrors?: boolean } = {}) {
    return runProtocolLadder(new URL(url), { ignoreTlsErrors: opts.ignoreTlsErrors, h3: async (u) => {
      try {
        const r = await runH3Plan(this.core.store, [{ method: 'GET', url: u.href, headers: [] }], { ignoreTlsErrors: opts.ignoreTlsErrors, timeoutMs: 5000 });
        const row = r.runs[0]!.rows[0]!;
        return row.status !== null ? { ok: true, detail: `HTTP/3, status ${row.status}` } : { ok: false, detail: row.error ?? 'no response' };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    } });
  }

  h3Tickets() {
    return h3Tickets.list();
  }

  clearH3Tickets() {
    h3Tickets.clear();
  }

  mqttPublish(exchangeId: string, msg: { to: 'broker' | 'device'; topic: string; payload: Uint8Array; qos?: 0 | 1; retain?: boolean }): boolean {
    for (const relay of this.core.mqtt) if (relay.publish(exchangeId, msg)) return true;
    return false;
  }

  /** Open streams. ws holds replay connections and proxied WebSockets; wsProxied only the proxied ones, which take frames in either direction. */
  liveStreams(): { mqtt: string[]; ws: string[]; wsProxied: string[] } {
    const proxied = [...this.core.proxy.liveWebSockets(), ...(this.core.browserProxy?.liveWebSockets() ?? [])];
    return { mqtt: this.core.mqtt.flatMap((m) => m.liveSessions()), ws: [...this.ws.openIds(), ...proxied], wsProxied: proxied };
  }

  /** The bearer JWT on an exchange's Authorization header, else throw. */
  private bearerOf(id: string): string {
    const ex = this.core.store.getExchange(id);
    const auth = ex?.requestHeaders.find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? '';
    const m = /^Bearer\s+(\S+)/i.exec(auth);
    if (!m) throw new Error('no bearer token on this request');
    return m[1]!;
  }

  // ---------- JWT and signing keys ----------

  /** Re-sign a token after the user edited its header or payload, with a key they hold. */
  resignJwt(header: Record<string, unknown>, payload: Record<string, unknown>, keyRef: { keyName?: string; secret?: string }, alg?: string): string {
    let key: SigningKey;
    if (keyRef.secret !== undefined) key = { kind: 'hmac', secret: keyRef.secret };
    else if (keyRef.keyName) {
      const resolved = this.keys.resolve(keyRef.keyName);
      if (!resolved) throw new Error(`no signing key "${keyRef.keyName}"`);
      key = resolved;
    } else throw new Error('a secret or a key name is required');
    return signJwt(header, payload, key, alg);
  }

  /** Confirm a token is signed with one of the given secrets (plus a few framework placeholders). */
  jwtSecret(token: string, extra: string[] = []): string | null {
    return tryHmacSecrets(token, [...extra, ...this.hmacSecrets(), ...EXAMPLE_SECRETS]);
  }

  // ---------- Session cookies ----------

  /** The HMAC secrets held in the key store, for confirming a signed cookie or token. */
  private hmacSecrets(): string[] {
    return this.keys
      .names()
      .map((n) => this.keys.resolve(n))
      .filter((k): k is { kind: 'hmac'; secret: string | Buffer } => k?.kind === 'hmac')
      .map((k) => (typeof k.secret === 'string' ? k.secret : k.secret.toString('utf8')));
  }

  /** Confirm a Flask session cookie is signed with a held or supplied secret. */
  flaskSecret(value: string, extra: string[] = []): string | null {
    return tryFlaskSecrets(value, [...extra, ...this.hmacSecrets(), ...EXAMPLE_SECRETS]);
  }

  /** Re-sign a Flask session cookie after the user edited it, with a key they hold. */
  resignFlaskCookie(payload: unknown, keyRef: { keyName?: string; secret?: string }, opts: { compress?: boolean } = {}): string {
    let secret: string;
    if (keyRef.secret !== undefined) secret = keyRef.secret;
    else if (keyRef.keyName) {
      const resolved = this.keys.resolve(keyRef.keyName);
      if (!resolved) throw new Error(`no signing key "${keyRef.keyName}"`);
      if (resolved.kind !== 'hmac') throw new Error('a Flask cookie needs an HMAC secret, not a PEM key');
      secret = typeof resolved.secret === 'string' ? resolved.secret : resolved.secret.toString('utf8');
    } else throw new Error('a secret or a key name is required');
    return signFlaskCookie(payload, secret, opts);
  }

  // ---------- Re-signing and evergreen tokens ----------

  private keyFromRef(keyRef: { keyName?: string; secret?: string }): SigningKey {
    if (keyRef.secret !== undefined) return { kind: 'hmac', secret: keyRef.secret };
    if (keyRef.keyName) {
      const resolved = this.keys.resolve(keyRef.keyName);
      if (!resolved) throw new Error(`no signing key "${keyRef.keyName}"`);
      return resolved;
    }
    throw new Error('a secret or a key name is required');
  }

  /** Open a value for re-signing: what kind it is, and the parts the user can edit. */
  resignOpen(value: string): { kind: SignableKind | null; alg?: string; header?: Record<string, unknown>; payload?: unknown; compress?: boolean } {
    const kind = signableKind(value);
    if (kind === 'jwt') {
      const p = parseJwt(value);
      return { kind, alg: p.alg, header: p.header, payload: p.payload };
    }
    if (kind === 'flask') {
      const s = decodeSessionCookie('session', value);
      return { kind, payload: s.payload, ...(s.compressed ? { compress: true } : {}) };
    }
    return { kind: null };
  }

  /** Re-sign a value once (a preview, or a token to copy), without saving it. */
  resignPreview(spec: Omit<EvergreenEntry, 'name' | 'keyName' | 'updatedAt' | 'cookie'>, keyRef: { keyName?: string; secret?: string }, now = Date.now()): string {
    return renderEvergreen(spec, this.keyFromRef(keyRef), now);
  }

  /** Rewrite the outgoing Cookie header on a proxied request so evergreen-bound cookies go out freshly signed. */
  private evergreenCookies(msg: HookMessage): string[] {
    const bindings = this.evergreen.all().filter((e) => e.cookie);
    if (!bindings.length) return [];
    const idx = msg.headers.findIndex(([k]) => k.toLowerCase() === 'cookie');
    if (idx === -1) return [];
    let host: string;
    try {
      host = new URL(msg.url).hostname.toLowerCase();
    } catch {
      return [];
    }
    const applied: string[] = [];
    const pairs = msg.headers[idx]![1].split(/;\s*/).map((p) => {
      const eq = p.indexOf('=');
      if (eq <= 0) return p;
      const name = p.slice(0, eq).trim();
      const fresh = this.evergreen.resignCookie(host, name);
      if (!fresh) return p;
      applied.push(`evergreen:${fresh.token}`);
      return `${name}=${fresh.value}`;
    });
    if (applied.length) msg.headers[idx] = ['Cookie', pairs.join('; ')];
    return applied;
  }

  // ---------- MCP tools ----------
  private mcpTools(): ToolDef[] {
    const store = this.core.store;
    const str = { type: 'string' } as const;
    const headersSchema = { type: 'array', items: { type: 'array', items: str, minItems: 2, maxItems: 2 }, description: 'Headers as [name, value] pairs' };
    const summarize = (id: string) => {
      const ex = store.getExchange(id);
      if (!ex) throw new Error(`no exchange ${id}`);
      return ex;
    };
    return [
      {
        name: 'search_traffic',
        description:
          'Search recorded exchanges. Query syntax: host:*.example.com method:POST status:>=400 path:/api/ url:token= body:"text" header:"x-api-key" req:/res: (one side, headers and body) reqbody: resbody: reqheader: resheader: resjson:/reqjson:/json:$.path[=|!=|~|!~|>|>=|<|<=value] (JSONPath into bodies, also inside encoded JSON fields; a bare $.path works too) {{tokens}} as in Replay source:browser|proxy|replay ws:true tag:x tech:django error:sql|high|any since:<ISO or ms> "free text" (text matches any part of a word, ignoring case, in the URL, headers and decoded bodies); prefix a filter with - to negate. Newest first.',
        inputSchema: { type: 'object', properties: { query: str, limit: { type: 'number', description: 'Default 50, max 500' } } },
        write: false,
        run: (a) => store.search(String(a.query ?? ''), { limit: Math.min(Number(a.limit ?? 50), 500) }).map((e) => ({ id: e.id, method: e.method, url: e.url, status: e.status, state: e.state, source: e.source, startedAt: new Date(e.startedAt).toISOString(), durationMs: e.durationMs, tags: e.tags })),
      },
      {
        name: 'get_exchange',
        description: 'Get one exchange: request and response headers, status, timings, notes, and (when includeBodies is true) the decoded bodies as text, truncated to 64 KB each.',
        inputSchema: { type: 'object', properties: { id: str, includeBodies: { type: 'boolean' } }, required: ['id'] },
        write: false,
        run: (a) => {
          const ex = summarize(String(a.id));
          if (!a.includeBodies) return ex;
          const cut = (t: string | null) => (t && t.length > 65_536 ? `${t.slice(0, 65_536)}\n... truncated` : t);
          return { ...ex, requestBody: cut(this.textBody(ex.id, 'request')), responseBody: cut(this.textBody(ex.id, 'response')) };
        },
      },
      {
        name: 'site_map',
        description: 'Hosts with their exchange counts and most used first path segments.',
        inputSchema: { type: 'object', properties: {} },
        write: false,
        run: () => store.siteMap(100),
      },
      {
        name: 'endpoint_coverage',
        description: 'Distinct endpoints seen for a host (method, path with ids collapsed, status codes, count, which query and body parameters were used), to see what has and has not been exercised.',
        inputSchema: { type: 'object', properties: { host: str }, required: ['host'] },
        write: false,
        run: (a) => coverage(store, String(a.host)),
      },
      {
        name: 'api_values',
        description: 'Fields seen in recorded JSON bodies, per endpoint and JSONPath, with sample values. Id-like fields (sku, order number, cart id) come first. Use a field in a request with {{pick:METHOD /path $.json.path}}.',
        inputSchema: { type: 'object', properties: { host: str, query: { type: 'string', description: 'Search filter, e.g. path:/api/products' } } },
        write: false,
        run: (a) => this.values({ host: a.host ? String(a.host) : undefined, query: a.query ? String(a.query) : undefined }).slice(0, 300),
      },
      {
        name: 'value_origin',
        description: 'Which earlier response first handed out a value (an id, a token), with the JSONPath or header it was in.',
        inputSchema: { type: 'object', properties: { value: str, beforeId: { type: 'string', description: 'Only look at exchanges before this one' } }, required: ['value'] },
        write: false,
        run: (a) => this.valueOrigin(String(a.value), a.beforeId ? String(a.beforeId) : undefined),
      },
      {
        name: 'tag_value',
        description: 'Read a field of the newest exchange with a tag, as the {{$tag.field}} token does. Field: JSONPath, key name, header.Name, query.name, status, req.<field>.',
        inputSchema: { type: 'object', properties: { ref: { type: 'string', description: 'e.g. my-tag.PO_number' } }, required: ['ref'] },
        write: false,
        run: (a) => tagValue(store, String(a.ref)),
      },
      {
        name: 'api_specs',
        description: 'Imported API descriptions (OpenAPI, Swagger, Postman) and, for a host, which documented endpoints were called, never called, or called but undocumented.',
        inputSchema: { type: 'object', properties: { host: str } },
        write: false,
        run: (a) => (a.host ? this.specCoverage(String(a.host)) : this.specs().map((s) => ({ id: s.id, name: s.name, format: s.format, servers: s.servers, endpoints: s.endpoints.length }))),
      },
      {
        name: 'list_flows',
        description: 'Saved flows: named multi-step setups (log in, create an order) whose variables requests use as {{flow:name.var}}.',
        inputSchema: { type: 'object', properties: {} },
        write: false,
        run: () => this.flowList(),
      },
      {
        name: 'run_flow',
        description: 'Run a saved flow and return its variables and the exchange of each step.',
        inputSchema: { type: 'object', properties: { name: str, inputs: { type: 'object' } }, required: ['name'] },
        write: true,
        summary: (a) => `Run flow ${String(a.name)}`,
        run: (a) => this.flows.run(String(a.name), (a.inputs as Record<string, string>) ?? {}),
      },
      {
        name: 'list_reproductions',
        description: 'Saved reproductions (a request, flow or WebSocket conversation kept by name with inputs, assertions and a session profile), with their latest runs. Pass name for one, with its effective input values and where each comes from.',
        inputSchema: { type: 'object', properties: { name: str, profile: str } },
        write: false,
        run: (a) =>
          a.name
            ? { ...this.repros.get(String(a.name)), history: undefined, effective: this.repros.effective(String(a.name), { profile: a.profile ? String(a.profile) : undefined }), runs: this.repros.runs(this.repros.get(String(a.name)).id).slice(-10) }
            : this.repros.list().map((r) => ({ id: r.id, name: r.name, kind: r.definition.kind, revision: r.revision, assertions: r.assertions.length, profile: r.profile, lastRun: this.repros.runs(r.id).at(-1) ?? null })),
      },
      {
        name: 'run_reproduction',
        description: 'Run a saved reproduction with explicit inputs and an optional session profile. Returns the run: state (passed, failed, canceled), the definition revision it ran, exchange ids and assertion results.',
        inputSchema: { type: 'object', properties: { name: str, inputs: { type: 'object' }, profile: str }, required: ['name'] },
        write: true,
        summary: (a) => `Run reproduction ${String(a.name)}${a.profile ? ` as ${String(a.profile)}` : ''}`,
        run: (a) => this.repros.run(String(a.name), { inputs: (a.inputs as Record<string, string>) ?? {}, profile: a.profile ? String(a.profile) : undefined }),
      },
      {
        name: 'contract_check',
        description: 'Check recorded exchanges of a host against the imported API files: wrong types, missing required fields, enum and format violations, undocumented fields and statuses. Pass id to check one exchange.',
        inputSchema: { type: 'object', properties: { host: str, id: str } },
        write: false,
        run: (a) => (a.id ? this.contractCheck(String(a.id)) : this.contractScan(String(a.host ?? ''))),
      },
      {
        name: 'resource_lifecycle',
        description: 'Per resource (collection and item paths), which of list, create, read, replace, update and delete were seen, succeeded, or are documented. Missing operations are a hint where to look.',
        inputSchema: { type: 'object', properties: { host: str }, required: ['host'] },
        write: false,
        run: (a) => this.lifecycle(String(a.host)),
      },
      {
        name: 'field_glossary',
        description: 'Every field name seen in JSON responses with its types, whether it is ever null, the few values an enum-like field takes, numeric ranges, string lengths, formats, and where it appears.',
        inputSchema: { type: 'object', properties: { host: str } },
        write: false,
        run: (a) => this.glossary(a.host ? String(a.host) : undefined),
      },
      {
        name: 'diff_exchanges',
        description: 'Compare two exchanges: URL and query changes, header changes, and JSON-aware body changes on both sides.',
        inputSchema: { type: 'object', properties: { a: str, b: str }, required: ['a', 'b'] },
        write: false,
        run: (a) => {
          const d = this.diff(String(a.a), String(a.b));
          return { ...d, request: { ...d.request, textA: undefined, textB: undefined }, response: { ...d.response, textA: undefined, textB: undefined } };
        },
      },
      {
        name: 'endpoint_notes',
        description: 'Notes and tags people wrote about endpoints, keyed "host METHOD /template".',
        inputSchema: { type: 'object', properties: {} },
        write: false,
        run: () => this.endpointNotes(),
      },
      {
        name: 'graphql_operations',
        description: 'GraphQL operations the app sent (and query text in its scripts), with root fields and persisted-query hashes.',
        inputSchema: { type: 'object', properties: { host: str } },
        write: false,
        run: (a) => this.graphqlOperations(a.host ? String(a.host) : undefined).map(({ document: _d, ...o }) => o),
      },
      {
        name: 'copy_as_curl',
        description: 'A recorded request as a curl command.',
        inputSchema: { type: 'object', properties: { id: str }, required: ['id'] },
        write: false,
        run: (a) => this.curl(String(a.id)),
      },
      {
        name: 'auth_matrix',
        description: 'Replay exchanges as each saved identity (another user, no auth) and report who gets what. "same" means an identity got the same successful answer as the original: possible broken access control.',
        inputSchema: { type: 'object', properties: { ids: { type: 'array', items: str }, identities: { type: 'array', items: str } }, required: ['ids'] },
        write: true,
        summary: (a) => `Auth matrix over ${(a.ids as string[]).length} requests`,
        run: (a) => this.authMatrix((a.ids as string[]).map(String), a.identities as string[] | undefined),
      },
      {
        name: 'negative_tests',
        description: 'Send a recorded request again with each field broken in turn (missing, null, wrong type, boundary numbers, long and special strings, bad ids) and report what the server accepted, rejected, or failed on.',
        inputSchema: { type: 'object', properties: { id: str, max: { type: 'number' } }, required: ['id'] },
        write: true,
        summary: (a) => `Negative tests on ${String(a.id)}`,
        run: (a) => this.negativeTests(String(a.id), a.max ? Number(a.max) : undefined),
      },
      {
        name: 'decode',
        description: 'Detect and undo the encoding chain of a value (url, base64, base64url, hex, gzip, deflate, br, jwt, json, form).',
        inputSchema: { type: 'object', properties: { value: str }, required: ['value'] },
        write: false,
        run: (a) => {
          const chain = detectChain(String(a.value));
          return { chain, decoded: chain.length ? decodeChain(chain, String(a.value)) : String(a.value) };
        },
      },
      {
        name: 'list_cookies',
        description: 'The cookie jar built from recorded Set-Cookie headers. Platform cookies (load balancer stickiness, bot management) carry an "infra" reason.',
        inputSchema: { type: 'object', properties: { domain: str } },
        write: false,
        run: (a) => this.tech.annotateJar().filter((c) => !a.domain || c.domain.endsWith(String(a.domain))),
      },
      {
        name: 'detect_technologies',
        description:
          'What a host is built on (cloud, CDN, server, framework, auth provider, protocols), detected passively from captured traffic, with confidence and evidence, after the user\'s pins and rejections. Without a host, lists every host with its technologies.',
        inputSchema: { type: 'object', properties: { host: str } },
        write: false,
        run: (a) => (a.host ? this.tech.hostReport(String(a.host)) : this.tech.allHosts()),
      },
      {
        name: 'find_errors',
        description:
          'Server errors recognized in responses (SQL and NoSQL errors, template, XML, command and file errors, stack traces, framework debug pages), each with the request parts that most likely caused it and why. Pass an exchange id for one exchange, or a History query (default "error:any") to list them.',
        inputSchema: { type: 'object', properties: { id: str, query: str, limit: { type: 'number' } } },
        write: false,
        run: (a) => {
          if (a.id) return this.errors.findings(String(a.id));
          const q = String(a.query ?? '') || 'error:any';
          return store.search(q.includes('error:') ? q : `${q} error:any`, { limit: Math.min(Number(a.limit ?? 50), 200) }).map((e) => ({
            id: e.id,
            method: e.method,
            url: e.url,
            status: e.status,
            errors: this.errors.findings(e.id).map((f) => ({ name: f.name, kind: f.kind, severity: f.severity, excerpt: f.excerpt, causes: f.causes.map((c) => ({ in: c.in, name: c.name, value: c.value, confidence: c.confidence, reasons: c.reasons })) })),
          }));
        },
      },
      {
        name: 'decode_jwt',
        description: 'Decode a JWT (header, payload, claims) and list what is risky about it (alg none, symmetric alg, jku/x5u/jwk, no expiry, expired). Pass a token, or an exchange id to read the Authorization bearer token.',
        inputSchema: { type: 'object', properties: { token: str, id: str } },
        write: false,
        run: (a) => parseJwt(a.token ? String(a.token) : this.bearerOf(String(a.id))),
      },
      {
        name: 'decode_session_cookie',
        description: 'Decode a framework session cookie (Flask, Django, Rails, Laravel, Express): name the framework, split the parts, and show the payload when it is signed-but-readable. Pass the cookie name and value.',
        inputSchema: { type: 'object', properties: { name: str, value: str }, required: ['name', 'value'] },
        write: false,
        run: (a) => decodeSessionCookie(String(a.name), String(a.value)),
      },
      {
        name: 'aws_request_info',
        description: 'AWS-specific details of a request: a presigned URL and when it expires, the service operation an X-Amz-Target call makes, the S3 bucket and key, and API Gateway api id and stage.',
        inputSchema: { type: 'object', properties: { id: str }, required: ['id'] },
        write: false,
        run: (a) => {
          const ex = store.getExchange(String(a.id));
          if (!ex) throw new Error(`no exchange ${a.id}`);
          return awsRequestInfo({ url: ex.url, headers: ex.requestHeaders });
        },
      },
      {
        name: 'csrf_tokens',
        description: 'Where a recorded request carries CSRF tokens, which response handed each one out, and whether a CSRF binding keeps it fresh on replay.',
        inputSchema: { type: 'object', properties: { id: str }, required: ['id'] },
        write: false,
        run: (a) => this.tech.csrfFindings(String(a.id)),
      },
      {
        name: 'run_tech_check',
        description: 'Send one of the optional checks a detected technology suggests (for example GET /actuator on Spring). Checks are never sent automatically.',
        inputSchema: { type: 'object', properties: { host: str, tech: str, index: { type: 'number' }, scheme: str }, required: ['host', 'tech'] },
        write: true,
        summary: (a) => {
          const p = this.tech.signature(String(a.tech))?.checks?.filter((c) => c.probe)[Number(a.index ?? 0)]?.probe;
          return p ? `${p.method} ${String(a.host)}${p.path}` : `Check for ${String(a.tech)} on ${String(a.host)}`;
        },
        run: async (a) => {
          const res = await this.runCheck(String(a.host), String(a.tech), Number(a.index ?? 0), a.scheme === 'http' ? 'http' : 'https');
          store.tagExchange(res.id, [...(store.getSummary(res.id)?.tags ?? []), 'mcp']);
          return { ...summarize(res.id), responseBody: this.textBody(res.id, 'response')?.slice(0, 16_384) ?? null };
        },
      },
      {
        name: 'get_scope',
        description: 'The scope rules that decide which hosts are decrypted and recorded.',
        inputSchema: { type: 'object', properties: {} },
        write: false,
        run: () => this.core.scope.get(),
      },
      {
        name: 'parse_sigv4',
        description: 'Parse the AWS SigV4 Authorization header of an exchange (key id, date, region, service, signed headers).',
        inputSchema: { type: 'object', properties: { id: str }, required: ['id'] },
        write: false,
        run: (a) => parseSigV4(summarize(String(a.id)).requestHeaders.find(([k]) => k.toLowerCase() === 'authorization')?.[1]) ?? 'no SigV4 signature on this request',
      },
      {
        name: 'replay_request',
        description:
          'Send an HTTP request and record it (source "replay"). Supports tokens such as {{cookie:name}}, {{var:name}}, {{uuid}}. Options: refreshCookies, applyRules, followRedirects, loginMacro, sigv4 ("auto" or a profile).',
        inputSchema: {
          type: 'object',
          properties: { method: str, url: str, headers: headersSchema, body: str, replayOf: str, options: { type: 'object' } },
          required: ['method', 'url'],
        },
        write: true,
        summary: (a) => `${String(a.method).toUpperCase()} ${String(a.url)}`,
        run: async (a) => {
          const res = await this.sender.send(
            {
              method: String(a.method),
              url: String(a.url),
              headers: (a.headers as HeaderList) ?? [],
              body: typeof a.body === 'string' ? new TextEncoder().encode(a.body) : undefined,
              replayOf: (a.replayOf as string) ?? null,
            },
            (a.options as SendOptions) ?? {},
          );
          store.tagExchange(res.id, [...res.tags, 'mcp']);
          return { ...summarize(res.id), responseBody: this.textBody(res.id, 'response')?.slice(0, 65_536) ?? null };
        },
      },
      {
        name: 'resend_exchange',
        description: 'Send a recorded exchange again, unchanged, optionally with fresh cookies from the jar.',
        inputSchema: { type: 'object', properties: { id: str, refreshCookies: { type: 'boolean' } }, required: ['id'] },
        write: true,
        summary: (a) => {
          const ex = store.getSummary(String(a.id));
          return ex ? `Resend ${ex.method} ${ex.url}` : `Resend ${String(a.id)}`;
        },
        run: async (a) => {
          const ex = summarize(String(a.id));
          const res = await this.sender.send({ method: ex.method, url: ex.url, headers: ex.requestHeaders, body: store.getBody(ex.id, 'request', false), replayOf: ex.id }, { refreshCookies: !!a.refreshCookies });
          store.tagExchange(res.id, [...res.tags, 'mcp']);
          return { ...summarize(res.id), responseBody: this.textBody(res.id, 'response')?.slice(0, 65_536) ?? null };
        },
      },
      {
        name: 'protocol_lab',
        description:
          'Drive a plan of requests on one HTTP/2 or HTTP/3 connection and record each stream. Use it to test how a server handles concurrency, stream resets, priority, flow control, trailers and header compression. requests: [{method, url, headers, body, hold ("fin"|"last-byte"), resetAfterBytes, resetCode, priority, trailers, continuationSize, openAtMs, after}]. options: {protocol ("h2"|"h3"), connect ("alpn"|"upgrade"|"prior-knowledge"), concurrency, gate ("single-packet"), settings, goawayAtMs}. Returns per-stream results and the connection frame log.',
        inputSchema: {
          type: 'object',
          properties: { protocol: { type: 'string', enum: ['h2', 'h3'] }, requests: { type: 'array', items: { type: 'object' } }, options: { type: 'object' } },
          required: ['requests'],
        },
        write: true,
        summary: (a) => `${String(a.protocol ?? 'h2').toUpperCase()} lab: ${(a.requests as unknown[] | undefined)?.length ?? 0} requests`,
        run: async (a) => {
          const rows = ((a.requests as Array<Record<string, unknown>>) ?? []).map((r) => ({ ...r, method: String(r.method ?? 'GET'), url: String(r.url), headers: (r.headers as HeaderList) ?? [], body: typeof r.body === 'string' ? new TextEncoder().encode(r.body) : undefined }));
          const opts = (a.options as Record<string, unknown>) ?? {};
          const result = String(a.protocol ?? opts.protocol ?? 'h2') === 'h3' ? await this.h3Plan(rows as never, opts as never) : await this.h2Plan(rows as never, opts as never);
          for (const run of (result as { runs: Array<{ rows: Array<{ exchangeId: string }> }> }).runs) for (const row of run.rows) store.tagExchange(row.exchangeId, [...(store.getSummary(row.exchangeId)?.tags ?? []), 'mcp']);
          return result;
        },
      },
      {
        name: 'protocol_support',
        description: 'Try every way of getting HTTP/2 and HTTP/3 from a server (TLS ALPN, h2c upgrade, prior knowledge, QUIC) and report which it accepts, with the server\'s SETTINGS. Reads only; opens connections but records nothing.',
        inputSchema: { type: 'object', properties: { url: str, ignoreTlsErrors: { type: 'boolean' } }, required: ['url'] },
        write: false,
        run: (a) => this.protocolLadder(String(a.url), { ignoreTlsErrors: a.ignoreTlsErrors === true }),
      },
      {
        name: 'websocket_script',
        description:
          'A recorded WebSocket connection written out as an editable replay script: {url, headers, steps}. Steps are {kind:"send", opcode, payload, encoding?, delayMs?, preset?}, {kind:"wait", match?, count?, timeoutMs?, extract?:{var, from}}, {kind:"frames", steps}, {kind:"close", code?, reason?}. Edit it and pass it to replay_websocket.',
        inputSchema: { type: 'object', properties: { id: str, waits: { type: 'boolean', description: 'Wait for the server between sends, like the original' }, timing: { type: 'boolean', description: 'Keep the original gaps between sends' } }, required: ['id'] },
        write: false,
        run: (a) => this.ws.scriptFor(String(a.id), { waits: a.waits !== false, timing: a.timing === true }),
      },
      {
        name: 'replay_websocket',
        description:
          'Open a new WebSocket connection and run a replay script on it (from websocket_script, edited or not). Text payloads take Replay tokens such as {{cookie:session}} and {{var:name}}. Returns the step results and the messages of the new connection once the script has run (or after waitSeconds).',
        inputSchema: {
          type: 'object',
          properties: {
            script: { type: 'object' },
            id: { ...str, description: 'Recorded WebSocket exchange to replay as captured, when no script is given' },
            refreshCookies: { type: 'boolean' },
            waitSeconds: { type: 'number', description: 'How long to wait for the script, default 30' },
          },
        },
        write: true,
        summary: (a) => `Replay WebSocket ${a.script ? String((a.script as WsScript).url) : String(a.id)}`,
        run: async (a) => {
          const script = (a.script as WsScript | undefined) ?? this.ws.scriptFor(String(a.id), { waits: true });
          const { exchangeId } = await this.ws.run(script, { refreshCookies: !!a.refreshCookies, replayOf: typeof a.id === 'string' ? a.id : null, closeAtEnd: true });
          store.tagExchange(exchangeId, [...(store.getSummary(exchangeId)?.tags ?? []), 'mcp']);
          const until = Date.now() + Math.min(Math.max(1, Number(a.waitSeconds ?? 30)), 300) * 1000;
          while (this.ws.runState(exchangeId)?.running && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
          const stream = store.getStreamForExchange(exchangeId);
          const messages = stream
            ? store.getStreamMessages(stream.id, { limit: 500 }).map((m) => ({ direction: m.direction, opcode: m.opcode, at: m.at, text: m.opcode === 'binary' ? `<${m.size} bytes>` : bytesToString(m.payload).slice(0, 4096), meta: m.meta }))
            : [];
          return { exchangeId, state: this.ws.runState(exchangeId), messages };
        },
      },
      {
        name: 'tag_exchange',
        description: 'Set the tags on an exchange (replaces existing tags).',
        inputSchema: { type: 'object', properties: { id: str, tags: { type: 'array', items: str } }, required: ['id', 'tags'] },
        write: true,
        summary: (a) => `Tag ${String(a.id)}: ${(a.tags as string[]).join(', ')}`,
        run: (a) => (store.tagExchange(String(a.id), (a.tags as string[]).map(String)), 'ok'),
      },
      {
        name: 'set_notes',
        description: 'Write notes on an exchange.',
        inputSchema: { type: 'object', properties: { id: str, notes: str }, required: ['id', 'notes'] },
        write: true,
        summary: (a) => `Notes on ${String(a.id)}`,
        run: (a) => (store.setNotes(String(a.id), String(a.notes)), 'ok'),
      },
      {
        name: 'add_scope_host',
        description: 'Add a host glob to the scope so its traffic is decrypted and recorded.',
        inputSchema: { type: 'object', properties: { host: str }, required: ['host'] },
        write: true,
        summary: (a) => `Add ${String(a.host)} to scope`,
        run: async (a) => {
          const cur = this.core.scope.get();
          await this.core.setScope({ ...cur, rules: [...cur.rules, { id: newId(), action: 'include', host: String(a.host) }] });
          return this.core.scope.get();
        },
      },
      {
        name: 'run_script',
        description: 'Run JavaScript with the `siq` SDK (siq.search, siq.get, siq.body, siq.json, siq.send, siq.resend, siq.race, siq.h3, siq.setVar, siq.cookies, ...). The value of a final `return` is returned along with console output.',
        inputSchema: { type: 'object', properties: { code: str }, required: ['code'] },
        write: true,
        summary: (a) => `Run a sandboxed script (${String(a.code).split('\n').length} lines): it can read traffic and send requests through the SDK`,
        noGrant: true,
        // Agents' scripts always run sandboxed, whatever the project's own scripts use.
        run: (a) => this.runScript({ id: 'mcp', name: 'mcp', kind: 'script', code: String(a.code), sandbox: true }),
      },
    ];
  }

  close(): void {
    this.intercept.releaseAll();
    this.ws.closeAll();
    this.scripts.close();
  }
}

export type { HeaderList };

function addTags(store: Core['store'], id: string, tags: string[]) {
  store.tagExchange(id, [...(store.getSummary(id)?.tags ?? []), ...tags]);
}
