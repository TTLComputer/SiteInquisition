import { EventEmitter } from 'node:events';
import { bytesToString, decodeChain, detectChain } from '@siteinquisition/codecs';
import { coverage } from './coverage.js';
import { cookieJar } from './cookies.js';
import type { Core } from './core.js';
import { newId } from './ids.js';
import { applyEdits, Intercept, normalizeBreakpoint, type Breakpoint } from './intercept.js';
import { McpServer, type McpSettings, type ToolDef } from './mcp.js';
import type { ProxyHooks } from './proxy.js';
import { runRace, type RaceOptions, type RaceRequest } from './race.js';
import { h3Tickets, runH3Plan, type H3PlanOptions, type H3PlanRequest } from './quic/plan.js';
import { applyRule, conditionsMatch, normalizeMock, normalizeReplaceRule, type HookMessage, type MockRule, type ReplaceRule, type RuleInput } from './rules.js';
import { normalizeScript, ScriptEngine, type Script, type Sdk } from './scripts.js';
import { Sender, type AwsProfile, type Macro, type SendOptions, type SendRequest } from './send.js';
import { parseSigV4, type AwsCredentials } from './sigv4.js';
import type { Change, HeaderList } from './store.js';
import { resolveTokens } from './tokens.js';
import { TechService } from './tech.js';
import { Vars } from './vars.js';
import { WsReplays } from './wsreplay.js';

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
  readonly scripts: ScriptEngine;
  readonly intercept: Intercept;
  readonly sender: Sender;
  readonly ws: WsReplays;
  readonly mcp: McpServer;
  /** Ephemeral events (paused requests, approvals) for API clients; not written to the change log. */
  readonly live = new EventEmitter<{ change: [Change] }>();
  private hits = new Map<string, number>();
  readonly awsKeys = new Map<string, AwsCredentials>();

  constructor(private readonly core: Core) {
    const store = core.store;
    this.vars = new Vars(store);
    this.tech = new TechService(store, this.vars);
    // Projects recorded before detection existed get scanned once, in the background.
    if (!store.hostTech().length && store.stats().exchanges > 0) {
      setImmediate(() => {
        try {
          if (store.db.isOpen && !store.hostTech().length) this.tech.rescan(2000);
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
    });
    this.scripts = new ScriptEngine(() => this.hookSdk());
    this.scripts.load(this.scriptList());
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
  scriptList(): Script[] {
    return this.meta<Script[]>('scripts', []);
  }
  setScripts(list: Array<Omit<Script, 'id'> & { id?: string }>): Script[] {
    const out = list.map(normalizeScript);
    this.core.store.setMeta('scripts', out);
    this.scripts.load(out);
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
        return resolveTokens(s, { url, cookies: () => cookieJar(this.core.store), vars: () => this.vars.values(), projectDir: this.core.projectDir });
      } catch {
        return s;
      }
    };
  }

  private applyRules(phase: 'request' | 'response', msg: HookMessage, reqUrl: string, method: string): string[] {
    const applied: string[] = [];
    for (const rule of this.replaceRules()) {
      if (rule.enabled === false || rule.phase !== phase) continue;
      if (!conditionsMatch(rule, { method, url: reqUrl, status: msg.status })) continue;
      if (applyRule(rule, msg, this.resolver(reqUrl))) {
        this.countHit(rule.id);
        applied.push(`rule:${rule.name}`);
      }
    }
    return applied;
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
    const matched = conditionsMatch(rule, { method: ex.method, url: ex.url, status: ex.status ?? undefined });
    const count = matched ? applyRule(rule, msg, this.resolver(ex.url)) : 0;
    return { matched, count, before, after: render(msg) };
  }

  readonly hooks: ProxyHooks = {
    request: async (msg, ctx) => {
      const applied: string[] = [];
      const paused = await this.intercept.check('request', msg, ctx.source, ctx.key);
      if (paused?.action === 'drop') return { applied: ['breakpoint:dropped'], drop: true };
      if (paused) {
        applyEdits(msg, paused);
        if (paused.edits) applied.push('breakpoint:edited');
      }
      const mock = this.mocks().find((m) => m.enabled !== false && conditionsMatch({ host: m.host, method: m.method, pathPrefix: m.pathPrefix }, msg));
      if (mock) {
        this.countHit(mock.id);
        if (mock.delayMs) await new Promise((r) => setTimeout(r, Math.min(mock.delayMs!, 60_000)));
        const body = new TextEncoder().encode(this.resolver(msg.url)(mock.body));
        return { applied: [...applied, `mock:${mock.name}`], respond: { status: mock.status, headers: mock.headers, body } };
      }
      applied.push(...this.applyRules('request', msg, msg.url, msg.method));
      if (this.scripts.active) applied.push(...this.scripts.run('request', msg).map((n) => `script:${n}`));
      return { applied };
    },
    wantsResponse: (req, ctx) =>
      this.scripts.active ||
      this.intercept.wouldPauseResponse(req, ctx.key) ||
      this.replaceRules().some((r) => r.enabled !== false && r.phase === 'response' && conditionsMatch(r, req)),
    response: async (req, res, ctx) => {
      const applied = this.applyRules('response', res, req.url, req.method);
      if (this.scripts.active) applied.push(...this.scripts.run('response', req, res).map((n) => `script:${n}`));
      const paused = await this.intercept.check('response', res, ctx.source, ctx.key);
      if (paused?.action === 'drop') return { applied: [...applied, 'breakpoint:dropped'], drop: true };
      if (paused) {
        applyEdits(res, paused);
        if (paused.edits) applied.push('breakpoint:edited');
      }
      return { applied };
    },
  };

  // ---------- SDK for scripts and MCP ----------
  private textBody(id: string, side: 'request' | 'response') {
    const b = this.core.store.getBody(id, side, true);
    return b ? bytesToString(b) : null;
  }

  /** Hooks get a synchronous subset: variables and tags. */
  private hookSdk(): Sdk {
    return {
      getVar: ((name: string) => this.vars.values()[name]) as never,
      setVar: ((name: string, value: string) => this.vars.set(String(name), String(value), 'script')) as never,
    };
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
      h3: (requests: Array<H3PlanRequest & { body?: string | Uint8Array }>, opts: H3PlanOptions = {}) =>
        runH3Plan(store, requests.map((r) => ({ ...r, headers: r.headers ?? [], body: typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body })), opts),
      vars: () => this.vars.values(),
      getVar: (name: string) => this.vars.values()[name],
      setVar: (name: string, value: string) => this.vars.set(String(name), String(value), 'script'),
      cookies: () => this.tech.annotateJar(),
      tech: (host?: string) => (host ? this.tech.hostReport(String(host)) : this.tech.allHosts()),
      csrf: (id: string) => this.tech.csrfFindings(String(id)),
      tag: (id: string, tags: string[]) => store.tagExchange(String(id), tags.map(String)),
      notes: (id: string, notes: string) => store.setNotes(String(id), String(notes)),
      scope: () => this.core.scope.get(),
      flow: (flowId: string) => store.getFlow(String(flowId)),
      runMacro: (id: string) => this.sender.runMacro(String(id)),
    };
    return fullSdk as unknown as Sdk;
  }

  runScript(script: Pick<Script, 'id' | 'name' | 'kind' | 'code'>) {
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

  /** HTTP/3 stream plan (the HTTP/3 lab). */
  h3Plan(rows: H3PlanRequest[], opts: H3PlanOptions) {
    return runH3Plan(this.core.store, rows, opts);
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
          'Search recorded exchanges. Query syntax: host:*.example.com method:POST status:>=400 path:/api/ url:token= body:"text" header:"x-api-key" source:browser|proxy|replay ws:true tag:x since:<ISO or ms> "free text"; prefix a filter with - to negate. Newest first.',
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
        summary: (a) => `Run a script (${String(a.code).split('\n').length} lines)`,
        run: (a) => this.runScript({ id: 'mcp', name: 'mcp', kind: 'script', code: String(a.code) }),
      },
    ];
  }

  close(): void {
    this.intercept.releaseAll();
    this.ws.closeAll();
  }
}

export type { HeaderList };

function addTags(store: Core['store'], id: string, tags: string[]) {
  store.tagExchange(id, [...(store.getSummary(id)?.tags ?? []), ...tags]);
}
