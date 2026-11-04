import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decodeLayers, detectChain, encodeChain, listCodecs, replaceThroughChain } from '@siteinquisition/codecs';
import { coverage } from './coverage.js';
import { parseSigV4 } from './sigv4.js';
import { batchPlan, flowRefs, resolveTokens } from './tokens.js';
import { pickValues, tagValue } from './values.js';
import type { AddressInfo } from 'node:net';
import { OPEN, serveWebSockets, type WsConnection as WebSocket } from './websocket.js';
import { PRESETS, buildPlan, validatePlan } from './wsplan.js';
import { cookieJar } from './cookies.js';
import { readBrowserHttp3Hosts, writeBrowserHttp3Hosts, type Core } from './core.js';
import { sendReplay } from './replay.js';
import type { HeaderList } from './store.js';
import type { Change } from './store.js';

/**
 * The core API: JSON-RPC 2.0 over a WebSocket on 127.0.0.1, guarded by a
 * random token. The UI, CLI, MCP server and scripts all talk to the core
 * through this one surface, and live changes are pushed as `change`
 * notifications to clients that call `events.subscribe`.
 */

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SavedView {
  name: string;
  query: string;
}

const DEFAULT_VIEWS: SavedView[] = [
  { name: 'Errors', query: 'status:>=400' },
  { name: 'Replays', query: 'source:replay' },
  { name: 'WebSockets', query: 'ws:true' },
  { name: 'MQTT sessions', query: 'scheme:mqtt' },
];

type Handler = (params: Record<string, unknown>, client: WebSocket) => unknown;

const b64 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');

const str = (p: Record<string, unknown>, k: string, required = true): string | undefined => {
  const v = p[k];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string') throw new RpcError(-32602, `param "${k}" must be a string`);
  return v;
};
const arr = (p: Record<string, unknown>, k: string): unknown[] => {
  const v = p[k];
  if (!Array.isArray(v)) throw new RpcError(-32602, `param "${k}" must be an array`);
  return v;
};

function sendRequest(p: Record<string, unknown>) {
  const headers = p.headers ?? [];
  if (!Array.isArray(headers) || !headers.every((h) => Array.isArray(h) && h.length === 2 && h.every((x) => typeof x === 'string'))) {
    throw new RpcError(-32602, 'headers must be [name, value] string pairs');
  }
  if (typeof p.method !== 'string' || typeof p.url !== 'string') throw new RpcError(-32602, 'method and url are required');
  return {
    method: p.method,
    url: p.url,
    headers: headers as HeaderList,
    body: typeof p.bodyBase64 === 'string' ? new Uint8Array(Buffer.from(p.bodyBase64, 'base64')) : undefined,
    replayOf: typeof p.replayOf === 'string' ? p.replayOf : null,
  };
}

const num = (p: Record<string, unknown>, k: string): number | undefined => {
  const v = p[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'number') throw new RpcError(-32602, `param "${k}" must be a number`);
  return v;
};

export class CoreApiServer {
  readonly token: string;
  private wss?: { clients: Set<WebSocket> };
  private http?: Server;
  private subscribers = new Set<WebSocket>();
  private readonly handlers: Record<string, Handler>;
  private readonly onChange = (c: Change) => {
    const msg = JSON.stringify({ jsonrpc: '2.0', method: 'change', params: c });
    for (const ws of this.subscribers) if (ws.readyState === OPEN) ws.send(msg);
  };

  constructor(
    private readonly core: Core,
    token?: string,
  ) {
    this.token = token ?? randomBytes(24).toString('hex');
    const store = core.store;
    this.handlers = {
      'core.info': () => core.info(),
      'traffic.search': (p) =>
        store.search(str(p, 'query', false) ?? '', {
          limit: num(p, 'limit'),
          before: str(p, 'before', false),
          order: p.order === 'oldest' ? 'oldest' : 'newest',
        }),
      'traffic.get': (p) => {
        const ex = store.getExchange(str(p, 'id')!);
        if (!ex) throw new RpcError(404, 'exchange not found');
        return { ...ex, stream: store.getStreamForExchange(ex.id) ?? null };
      },
      'traffic.body': (p) => {
        const side = p.side === 'request' ? 'request' : 'response';
        const body = store.getBody(str(p, 'id')!, side, p.decoded === true);
        if (!body) throw new RpcError(404, 'exchange not found');
        return { size: body.byteLength, base64: b64(body) };
      },
      'traffic.flow': (p) => store.getFlow(str(p, 'flowId')!),
      'traffic.siteMap': (p) => store.siteMap(num(p, 'limit')),
      'traffic.stats': () => store.stats(),
      'traffic.streamMessages': (p) => {
        const stream = store.getStreamForExchange(str(p, 'exchangeId')!);
        if (!stream) return [];
        return store
          .getStreamMessages(stream.id, { after: str(p, 'after', false), limit: num(p, 'limit') })
          .map(({ payload, ...m }) => ({ ...m, base64: b64(payload) }));
      },
      'traffic.tag': (p) => {
        if (!Array.isArray(p.tags) || !p.tags.every((t) => typeof t === 'string')) throw new RpcError(-32602, 'tags must be strings');
        store.tagExchange(str(p, 'id')!, p.tags as string[]);
        return true;
      },
      'traffic.notes': (p) => {
        store.setNotes(str(p, 'id')!, (str(p, 'notes', false) ?? null) as string | null);
        return true;
      },
      'replay.send': async (p) => {
        const req = sendRequest(p);
        const options = (p.options as Record<string, unknown> | undefined) ?? {};
        // Without options this is a plain send, exactly as given, as before.
        if (!p.options) return sendReplay(store, { ...req, ignoreTlsErrors: p.ignoreTlsErrors === true, protocol: p.protocol === 'h3' ? 'h3' : undefined });
        return core.tools.sender.send(req, { ...options, ignoreTlsErrors: p.ignoreTlsErrors === true || options.ignoreTlsErrors === true });
      },
      'replay.batch': (p) => {
        const options = (p.options as Record<string, unknown> | undefined) ?? {};
        return core.tools.sender.sendBatch(sendRequest(p), { ...options, ignoreTlsErrors: p.ignoreTlsErrors === true, concurrency: num(p, 'concurrency') });
      },
      'tokens.preview': (p) => {
        const texts = (p.texts as string[]) ?? [];
        const url = str(p, 'url', false) ?? 'http://localhost/';
        const plan = batchPlan(texts, core.projectDir, 10_000, (arg) => pickValues(store, arg));
        // A preview sends nothing, so flows show as placeholders instead of running.
        const flows = new Map(flowRefs(texts).map((n) => [n, new Proxy({} as Record<string, string>, { get: (_t, k) => (typeof k === 'string' ? `‹flow ${n}.${k}›` : undefined) })]));
        const ctx = core.tools.sender.tokenContext(url, { batch: plan[0], flows });
        return {
          sends: plan.length,
          resolved: texts.map((t) => {
            try {
              return { ok: true, text: resolveTokens(t, ctx) };
            } catch (e) {
              return { ok: false, error: (e as Error).message };
            }
          }),
        };
      },
      'codecs.list': () => listCodecs().map((c) => ({ id: c.id, label: c.label, terminal: !!c.terminal })),
      'codecs.detect': (p) => detectChain(Buffer.from(str(p, 'base64')!, 'base64')),
      'codecs.layers': (p) =>
        decodeLayers((p.chain as string[]) ?? [], Buffer.from(str(p, 'base64')!, 'base64')).map((v) =>
          v instanceof Uint8Array ? { kind: 'bytes', base64: b64(v) } : { kind: 'value', value: v },
        ),
      'codecs.encode': (p) => {
        const chain = (p.chain as string[]) ?? [];
        const value = p.base64 !== undefined ? Buffer.from(str(p, 'base64')!, 'base64') : p.value;
        return { base64: b64(encodeChain(chain, value)) };
      },
      'codecs.replace': (p) => {
        const r = replaceThroughChain((p.chain as string[]) ?? [], Buffer.from(str(p, 'base64')!, 'base64'), {
          find: str(p, 'find')!,
          replace: str(p, 'replace', false) ?? '',
          regex: p.regex === true,
          matchCase: p.matchCase === true,
          keys: p.keys === true,
          scope: p.scope === 'all' ? 'all' : 'layer',
        });
        return { base64: b64(r.output), counts: r.counts };
      },
      'codecs.chains.get': () => store.getMeta('codecChains') ?? [],
      'codecs.chains.set': (p) => {
        if (!Array.isArray(p.chains)) throw new RpcError(-32602, 'chains must be an array');
        store.setMeta('codecChains', p.chains);
        return true;
      },
      'traffic.coverage': (p) => coverage(store, str(p, 'host')!, num(p, 'limit')),
      'vars.list': () => ({ vars: core.tools.vars.all(), extractors: core.tools.vars.extractors() }),
      'vars.set': (p) => (core.tools.vars.set(str(p, 'name')!, str(p, 'value')!), true),
      'vars.delete': (p) => (core.tools.vars.delete(str(p, 'name')!), true),
      'vars.extractors': (p) => core.tools.vars.setExtractors(arr(p, 'extractors') as never),
      'rules.get': () => ({ rules: core.tools.replaceRules(), mocks: core.tools.mocks(), breakpoints: core.tools.breakpoints(), hits: core.tools.ruleHits() }),
      'rules.set': (p) => core.tools.setReplaceRules(arr(p, 'rules') as never),
      'rules.test': (p) => core.tools.testRule(p.rule as never, str(p, 'exchangeId')!),
      'mocks.set': (p) => core.tools.setMocks(arr(p, 'mocks') as never),
      'breakpoints.set': (p) => core.tools.setBreakpoints(arr(p, 'breakpoints') as never),
      'intercept.list': () => core.tools.intercept.list(),
      'intercept.resolve': (p) => core.tools.intercept.resolve(str(p, 'id')!, { action: (p.action as never) ?? 'forward', edits: p.edits as never }),
      'intercept.releaseAll': () => core.tools.intercept.releaseAll(),
      'scripts.get': () => ({
        scripts: core.tools.scriptList(),
        stats: Object.fromEntries(core.tools.scripts.stats),
        errors: Object.fromEntries(core.tools.scripts.compileErrors),
      }),
      'scripts.set': (p) => core.tools.setScripts(arr(p, 'scripts') as never),
      'scripts.logs': (p) => core.tools.scripts.logs.get(str(p, 'id')!) ?? [],
      'scripts.run': (p) => {
        const id = str(p, 'id', false);
        const script = id ? core.tools.scriptList().find((s) => s.id === id) : undefined;
        if (id && !script) throw new RpcError(404, 'script not found');
        return core.tools.runScript(script ?? { id: 'console', name: 'console', kind: 'script', code: str(p, 'code')! });
      },
      'flows.list': () => core.tools.flowList(),
      'flows.set': (p) => core.tools.setFlows(arr(p, 'flows') as never),
      'flows.save': (p) => core.tools.saveFlow(p.flow as never),
      'flows.run': (p) => core.tools.runFlow(str(p, 'name')!, (p.inputs as Record<string, string>) ?? {}),
      'flows.draft': (p) => core.tools.draftFlow(arr(p, 'ids') as string[], str(p, 'name', false)),
      'specs.list': () => core.tools.specs(),
      'specs.import': (p) => core.tools.importSpec(str(p, 'text')!, str(p, 'name', false)),
      'specs.delete': (p) => (core.tools.deleteSpec(str(p, 'id')!), true),
      'specs.coverage': (p) => core.tools.specCoverage(str(p, 'host')!),
      'specs.request': (p) => core.tools.specRequest(str(p, 'specId')!, str(p, 'key')!, { baseUrl: str(p, 'baseUrl', false), values: p.values as Record<string, string> | undefined }),
      'har.import': (p) => core.tools.importHar(str(p, 'text')!, str(p, 'tag', false)),
      'openapi.export': (p) => core.tools.exportOpenApi(str(p, 'host')!, str(p, 'title', false)),
      'values.catalog': (p) => core.tools.values({ host: str(p, 'host', false), query: str(p, 'query', false), limit: num(p, 'limit') }),
      'values.pick': (p) => pickValues(store, str(p, 'spec')!),
      'values.origin': (p) => core.tools.valueOrigin(str(p, 'value')!, str(p, 'beforeId', false)),
      'tags.move': (p) => core.tools.moveTag(str(p, 'tag')!, str(p, 'id')!),
      'tags.value': (p) => tagValue(store, str(p, 'ref')!),
      'contract.check': (p) => core.tools.contractCheck(str(p, 'id')!),
      'contract.scan': (p) => core.tools.contractScan(str(p, 'host')!),
      'identities.get': () => core.tools.identities(),
      'identities.set': (p) => core.tools.setIdentities(arr(p, 'identities') as never),
      'authmatrix.run': (p) => core.tools.authMatrix(arr(p, 'ids') as string[], p.identities as string[] | undefined, p.ignoreTlsErrors === true),
      'negative.run': (p) => core.tools.negativeTests(str(p, 'id')!, num(p, 'max'), p.ignoreTlsErrors === true),
      'diff.exchanges': (p) => core.tools.diff(str(p, 'a')!, str(p, 'b')!),
      'lifecycle.get': (p) => core.tools.lifecycle(str(p, 'host')!),
      'glossary.get': (p) => core.tools.glossary(str(p, 'host', false)),
      'graphql.import': (p) =>
        core.tools.graphqlImport({
          targetUrl: str(p, 'targetUrl')!,
          schemaUrl: str(p, 'schemaUrl', false),
          headers: p.headers as never,
          schemaHeaders: p.schemaHeaders as never,
          method: str(p, 'method', false) as never,
          ignoreTlsErrors: p.ignoreTlsErrors === true,
        }),
      'graphql.operations': (p) => core.tools.graphqlOperations(str(p, 'host', false)),
      'graphql.drift': (p) => core.tools.graphqlDrift(str(p, 'targetUrl')!),
      'export.curl': (p) => core.tools.curl(str(p, 'id')!),
      'export.har': (p) => core.tools.exportHar(p.query !== undefined ? store.search(String(p.query), { limit: num(p, 'limit') ?? 5000 }).map((e) => e.id) : (arr(p, 'ids') as string[])),
      'export.postman': (p) => core.tools.exportPostman({ flow: str(p, 'flow', false), ids: p.ids as string[] | undefined, name: str(p, 'name', false) }),
      'flows.toTest': (p) => core.tools.flowToTest(str(p, 'name')!),
      'notes.endpoints': () => core.tools.endpointNotes(),
      'notes.setEndpoint': (p) => core.tools.setEndpointNote(str(p, 'key')!, str(p, 'notes', false) ?? '', (p.tags as string[]) ?? []),
      'notes.forExchange': (p) => core.tools.noteFor(str(p, 'id')!),
      'macros.get': () => core.tools.macros(),
      'macros.set': (p) => core.tools.setMacros(arr(p, 'macros') as never),
      'macros.run': (p) => core.tools.sender.runMacro(str(p, 'id')!),
      'aws.get': () => ({ profiles: core.tools.awsProfiles(), sessionKeys: [...core.tools.awsKeys.keys()] }),
      'aws.set': (p) => core.tools.setAwsProfiles(arr(p, 'profiles') as never),
      'aws.setKeys': (p) => {
        core.tools.awsKeys.set(str(p, 'name')!, { accessKeyId: str(p, 'accessKeyId')!, secretAccessKey: str(p, 'secretAccessKey')!, sessionToken: str(p, 'sessionToken', false) });
        return true;
      },
      'aws.parse': (p) => {
        const ex = store.getExchange(str(p, 'id')!);
        return parseSigV4(ex?.requestHeaders.find(([k]) => k.toLowerCase() === 'authorization')?.[1]);
      },
      'race.run': (p) => {
        const reqs = arr(p, 'requests').map((r) => {
          const x = r as Record<string, unknown>;
          return { ...sendRequest(x), offsetMs: Number(x.offsetMs ?? 0) };
        });
        return core.tools.race(reqs, { sync: (p.sync as never) ?? 'last-byte', repeat: num(p, 'repeat'), jitterMs: num(p, 'jitterMs'), ignoreTlsErrors: p.ignoreTlsErrors === true });
      },
      'h3.run': (p) => {
        const rows = arr(p, 'requests').map((r) => {
          const x = r as Record<string, unknown>;
          return { ...x, ...sendRequest(x) };
        });
        return core.tools.h3Plan(rows as never, ((p.options as object) ?? {}) as never);
      },
      'h3.tickets': () => core.tools.h3Tickets(),
      'h3.clearTickets': () => {
        core.tools.clearH3Tickets();
        return true;
      },
      'browser.http3': () => ({ hosts: readBrowserHttp3Hosts(core.projectDir), port: core.browserProxy?.http3Port ?? null }),
      'browser.setHttp3Hosts': (p) => ({ hosts: writeBrowserHttp3Hosts(core.projectDir, arr(p, 'hosts').map(String)), restartNeeded: true }),
      'stream.live': () => core.tools.liveStreams(),
      'stream.connect': async (p) => {
        const id = str(p, 'exchangeId', false);
        const ex = id ? store.getExchange(id) : undefined;
        if (id && !ex) throw new RpcError(404, 'exchange not found');
        // Edited handshake headers win over the captured ones, e.g. to try another Origin.
        const headers = Array.isArray(p.headers) ? (p.headers as HeaderList) : (ex?.requestHeaders ?? []);
        return core.tools.ws.connect({ url: str(p, 'url', false) ?? ex?.url ?? '', headers, replayOf: ex?.id ?? null, ignoreTlsErrors: p.ignoreTlsErrors === true });
      },
      'stream.send': (p) => {
        const id = str(p, 'exchangeId')!;
        const payload = Buffer.from(str(p, 'base64')!, 'base64');
        core.tools.ws.send(id, payload, p.opcode === 'binary' ? 'binary' : 'text');
        return true;
      },
      'stream.close': (p) => (core.tools.ws.close(str(p, 'exchangeId')!, num(p, 'code') ?? 1000, str(p, 'reason', false) ?? 'closed from SiteInquisition'), true),
      'stream.presets': () => PRESETS,
      'stream.buildPlan': (p) =>
        buildPlan(str(p, 'preset')!, { payload: Buffer.from(str(p, 'base64', false) ?? '', 'base64'), opcode: p.opcode === 'binary' ? 'binary' : 'text' }, (p.options as Record<string, number | string>) ?? {}),
      'stream.sendPlan': async (p) => {
        const id = str(p, 'exchangeId')!;
        const steps = validatePlan(p.steps);
        if (core.tools.ws.isOpen(id)) return core.tools.ws.sendPlan(id, steps);
        const proxy = [core.proxy, core.browserProxy].find((x) => x?.liveWebSockets().includes(id));
        if (!proxy) throw new RpcError(409, 'that WebSocket is not open');
        return proxy.injectWebSocket(id, p.to === 'client' ? 'client' : 'server', steps);
      },
      'stream.replaySession': (p) =>
        core.tools.ws.replaySession(str(p, 'exchangeId')!, {
          ignoreTlsErrors: p.ignoreTlsErrors === true,
          timing: p.timing === 'original' ? 'original' : 'none',
          speed: num(p, 'speed'),
          preset: str(p, 'preset', false),
          presetOptions: (p.options as Record<string, number | string>) ?? undefined,
        }),
      'stream.isOpen': (p) => core.tools.ws.isOpen(str(p, 'exchangeId')!) || core.tools.liveStreams().mqtt.includes(str(p, 'exchangeId')!),
      'mqtt.publish': (p) => {
        const ok = core.tools.mqttPublish(str(p, 'exchangeId')!, {
          to: p.to === 'device' ? 'device' : 'broker',
          topic: str(p, 'topic')!,
          payload: Buffer.from(str(p, 'base64', false) ?? '', 'base64'),
          qos: p.qos === 1 ? 1 : 0,
          retain: p.retain === true,
        });
        if (!ok) throw new RpcError(409, 'that MQTT session is not live any more');
        return true;
      },
      'mcp.settings': () => core.tools.mcpSettings(),
      'mcp.setSettings': (p) => core.tools.setMcpSettings({ writeMode: p.writeMode as never }),
      'mcp.approvals': () => core.tools.mcp.approvals(),
      'mcp.decide': (p) => core.tools.mcp.decide(str(p, 'id')!, p.decision as never),
      'mcp.activity': () => core.tools.mcp.activity.slice(-200),
      'replay.history': (p) => store.search(`replayof:${JSON.stringify(str(p, 'of')!)}`, { limit: num(p, 'limit') ?? 100 }),
      'views.get': () => store.getMeta<SavedView[]>('savedViews') ?? DEFAULT_VIEWS,
      'views.set': (p) => {
        const views = p.views;
        if (!Array.isArray(views) || !views.every((v) => v && typeof v.name === 'string' && typeof v.query === 'string')) {
          throw new RpcError(-32602, 'views must be {name, query} objects');
        }
        store.setMeta('savedViews', views.map((v: SavedView) => ({ name: v.name, query: v.query })));
        return true;
      },
      'scope.get': () => core.scope.get(),
      'scope.seen': () => core.seenNotInScope(),
      'scope.evaluate': (p) => {
        try {
          return core.scope.evaluate(str(p, 'url')!);
        } catch {
          throw new RpcError(-32602, 'url must be an absolute URL');
        }
      },
      'cookies.list': () => cookieJar(store),
      'scope.set': async (p) => {
        await core.setScope(p.config as never);
        return core.scope.get();
      },
      'changes.since': (p) => store.changesSince(str(p, 'after', false) ?? null, num(p, 'limit')),
      'tls.failures': () => store.tlsFailureSummary(),
      'events.subscribe': (_p, client) => {
        this.subscribers.add(client);
        return true;
      },
      'events.unsubscribe': (_p, client) => {
        this.subscribers.delete(client);
        return true;
      },
    };
  }

  get port(): number {
    const addr = this.http?.address() as AddressInfo | undefined;
    if (!addr) throw new Error('api server is not running');
    return addr.port;
  }

  private authorized(req: IncomingMessage): boolean {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const supplied = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? req.headers['x-siq-token'] ?? bearer;
    if (typeof supplied !== 'string') return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** MCP over streamable HTTP: POST /mcp with one JSON-RPC message (or a batch), answered as JSON. */
  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    // Browsers can reach 127.0.0.1; refuse cross-site pages (DNS rebinding and CSRF).
    const origin = req.headers.origin;
    if (origin && !/^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|null|file:\/\/)$/.test(origin)) return send(403, { error: 'origin not allowed' });
    if (path !== '/mcp') return send(404, { error: 'not found' });
    if (!this.authorized(req)) return send(401, { error: 'missing or wrong token' });
    if (req.method === 'GET' || req.method === 'DELETE') return send(405);
    if (req.method !== 'POST') return send(405);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let msg: unknown;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    const list = Array.isArray(msg) ? msg : [msg];
    const out = (await Promise.all(list.map((m) => this.core.tools.mcp.handle(m as never)))).filter(Boolean);
    if (!out.length) return send(202);
    send(200, Array.isArray(msg) ? out : out[0]);
  }

  async start(port = 0): Promise<number> {
    const http = createServer((req, res) => {
      this.onHttp(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    const wss = serveWebSockets(
      http,
      (ws) => {
        ws.on('message', (data) => void this.handle(ws, data.toString()));
        ws.on('close', () => this.subscribers.delete(ws));
      },
      { maxPayload: 32 * 1024 * 1024, verify: (req: IncomingMessage) => this.authorized(req) },
    );
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, '127.0.0.1', () => resolve());
    });
    this.http = http;
    this.core.store.on('change', this.onChange);
    this.core.tools.live.on('change', this.onChange);
    this.wss = wss;
    return this.port;
  }

  async stop(): Promise<void> {
    this.core.store.off('change', this.onChange);
    this.core.tools.live.off('change', this.onChange);
    const wss = this.wss;
    this.wss = undefined;
    if (!wss) return;
    for (const ws of wss.clients) ws.terminate();
    const http = this.http;
    this.http = undefined;
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    this.subscribers.clear();
  }

  private async handle(ws: WebSocket, raw: string): Promise<void> {
    let req: RpcRequest;
    try {
      req = JSON.parse(raw) as RpcRequest;
    } catch {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    const reply = (body: object) => {
      if (req.id !== undefined && req.id !== null) ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }));
    };
    const handler = this.handlers[req.method];
    if (!handler) return reply({ error: { code: -32601, message: `unknown method ${req.method}` } });
    try {
      reply({ result: await handler(req.params ?? {}, ws) });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32000;
      reply({ error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}
