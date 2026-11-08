import { bytesToString } from '@siteinquisition/codecs';
import { decodeSignalR, decodeSocketIO, detectProtocol } from '@siteinquisition/codecs/protocols';
import { pathTemplate } from './coverage.js';
import type { CaptureStore } from './store.js';

/**
 * A map of the APIs spoken over WebSockets: for each endpoint (host and path
 * template), which protocol it uses and every kind of message seen in each
 * direction, with counts, the fields they carry and an example. Message
 * kinds come from the protocol: Socket.IO event names, SignalR hub methods,
 * GraphQL over WebSocket operations, JSON-RPC methods, or the field a plain
 * JSON message uses to say what it is ("type", "event", "action"...).
 */

export type WsProtocol = 'socketio' | 'signalr' | 'graphql-ws' | 'json-rpc' | 'stomp' | 'json' | 'text' | 'binary' | 'none';

export interface WsMessageKind {
  /** What the message is, e.g. "chat:message", "SendMessage", "subscribe OnOrder", "type=ping". */
  name: string;
  direction: 'client' | 'server';
  count: number;
  /** Top-level fields of the message's data, when it is JSON. */
  fields: string[];
  example: string;
  /** The connection and message to open for an example. */
  exampleExchangeId: string;
  firstAt: number;
  lastAt: number;
}

export interface WsEndpoint {
  host: string;
  template: string;
  /** Sec-WebSocket-Protocol the server picked, if any. */
  subprotocols: string[];
  protocol: WsProtocol;
  connections: number;
  messages: number;
  firstAt: number;
  lastAt: number;
  exampleExchangeId: string;
  kinds: WsMessageKind[];
}

const DISCRIMINATORS = ['type', 'event', 'action', 'op', 'method', 'cmd', 'command', 'kind', 'msg', 'channel', 'topic', 't', 'e'];
const MAX_CONNECTIONS = 300;
const MAX_MESSAGES = 3000;

const keysOf = (v: unknown): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as object).slice(0, 40) : []);
const short = (s: string) => (s.length > 240 ? `${s.slice(0, 237)}...` : s);

/** What one message is, and the fields its data carries. */
export function classifyWsMessage(text: string | null, opcode: string, subprotocols: string[] = []): { protocol: WsProtocol; name: string; fields: string[] } | null {
  if (text === null) return { protocol: 'binary', name: `binary (${opcode})`, fields: [] };
  const which = detectProtocol(text);
  if (which === 'socketio') {
    const p = decodeSocketIO(text);
    // Engine.IO pings and pongs are transport noise, not the API.
    if (!p.type) return p.transport === 'open' ? { protocol: 'socketio', name: 'open (handshake)', fields: [] } : null;
    if (p.type === 'EVENT' || p.type === 'BINARY_EVENT') {
      const first = Array.isArray(p.data) ? p.data[0] : undefined;
      return { protocol: 'socketio', name: `${p.namespace && p.namespace !== '/' ? `${p.namespace} ` : ''}${p.event ?? '(event)'}`, fields: keysOf(first) };
    }
    return { protocol: 'socketio', name: `${p.type}${p.namespace && p.namespace !== '/' ? ` ${p.namespace}` : ''}`, fields: [] };
  }
  if (which === 'signalr') {
    const m = decodeSignalR(text);
    if ('handshake' in m) return { protocol: 'signalr', name: 'handshake', fields: Object.keys(m.handshake) };
    const x = m.find((r) => r.typeName !== 'Ping') ?? null;
    if (!x) return null;
    return { protocol: 'signalr', name: x.target ? `${x.typeName} ${x.target}` : x.typeName, fields: keysOf(x.arguments?.[0] ?? x.result) };
  }
  if (/^(CONNECT|STOMP|SEND|SUBSCRIBE|UNSUBSCRIBE|MESSAGE|CONNECTED|RECEIPT|ERROR|ACK|NACK|DISCONNECT)\r?\n/.test(text)) {
    const [cmd, ...lines] = text.split(/\r?\n/);
    const dest = lines.find((l) => l.startsWith('destination:'))?.slice(12);
    return { protocol: 'stomp', name: dest ? `${cmd} ${dest}` : cmd!, fields: lines.filter((l) => l.includes(':')).map((l) => l.split(':')[0]!).slice(0, 20) };
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { protocol: 'text', name: text.trim().split(/\s+/)[0]?.slice(0, 40) || 'text', fields: [] };
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const graphqlWs = subprotocols.some((p) => /graphql/i.test(p)) || (typeof o.type === 'string' && /^(connection_init|connection_ack|subscribe|start|next|data|complete|stop|ka|ping|pong|error)$/.test(o.type) && ('payload' in o || /^connection_|^ka$|^complete$/.test(o.type)));
    if (graphqlWs && typeof o.type === 'string') {
      if (o.type === 'ka' || o.type === 'ping' || o.type === 'pong') return null;
      const payload = (o.payload ?? {}) as Record<string, unknown>;
      const op = typeof payload.operationName === 'string' ? payload.operationName : typeof payload.query === 'string' ? /\b(query|mutation|subscription)\s+(\w+)/.exec(payload.query)?.[2] : undefined;
      return { protocol: 'graphql-ws', name: op ? `${o.type} ${op}` : o.type, fields: keysOf(payload.variables ?? (payload.data as object)) };
    }
    if (o.jsonrpc === '2.0' || ('method' in o && 'id' in o && 'params' in o)) {
      return { protocol: 'json-rpc', name: typeof o.method === 'string' ? o.method : 'error' in o ? 'error' : 'result', fields: keysOf(o.params ?? o.result) };
    }
    const d = DISCRIMINATORS.find((k) => typeof o[k] === 'string' || typeof o[k] === 'number');
    return { protocol: 'json', name: d ? `${d}=${String(o[d])}` : `{${Object.keys(o).slice(0, 4).join(', ')}}`, fields: keysOf(o) };
  }
  if (Array.isArray(v)) {
    // Phoenix channels and similar: [joinRef, ref, topic, event, payload], or ["event", data].
    if (v.length === 5 && typeof v[2] === 'string' && typeof v[3] === 'string') return { protocol: 'json', name: `${v[3]} ${v[2]}`, fields: keysOf(v[4]) };
    if (typeof v[0] === 'string') return { protocol: 'json', name: v[0], fields: keysOf(v[1]) };
    return { protocol: 'json', name: 'array', fields: [] };
  }
  return { protocol: 'json', name: typeof v, fields: [] };
}

function textOf(payload: Uint8Array, opcode: string): string | null {
  if (opcode !== 'text') {
    // Binary that is really UTF-8 JSON is common (some clients send everything as binary).
    const s = bytesToString(payload.subarray(0, 64 * 1024));
    return /^\s*[[{]/.test(s) && !s.includes('�') ? s : null;
  }
  return bytesToString(payload.subarray(0, 64 * 1024));
}

export function wsApiMap(store: CaptureStore, opts: { host?: string } = {}): WsEndpoint[] {
  const rows = store.search(`ws:true${opts.host ? ` host:${JSON.stringify(opts.host)}` : ''}`, { limit: MAX_CONNECTIONS }).filter((e) => e.isWebSocket && !e.scheme.startsWith('mqtt'));
  const map = new Map<string, WsEndpoint & { protos: Map<WsProtocol, number>; kindMap: Map<string, WsMessageKind> }>();
  for (const e of rows) {
    const template = pathTemplate(e.path);
    const key = `${e.host} ${template}`;
    const ex = store.getExchange(e.id);
    const sub = (ex?.responseHeaders ?? []).filter(([k]) => k.toLowerCase() === 'sec-websocket-protocol').map(([, v]) => v.trim());
    let ep = map.get(key);
    if (!ep) {
      ep = { host: e.host, template, subprotocols: [], protocol: 'none', connections: 0, messages: 0, firstAt: e.startedAt, lastAt: e.startedAt, exampleExchangeId: e.id, kinds: [], protos: new Map(), kindMap: new Map() };
      map.set(key, ep);
    }
    ep.connections++;
    ep.firstAt = Math.min(ep.firstAt, e.startedAt);
    ep.lastAt = Math.max(ep.lastAt, e.startedAt);
    for (const s of sub) if (!ep.subprotocols.includes(s)) ep.subprotocols.push(s);
    const stream = store.getStreamForExchange(e.id);
    if (!stream) continue;
    for (const m of store.getStreamMessages(stream.id, { limit: MAX_MESSAGES })) {
      if (m.opcode === 'ping' || m.opcode === 'pong' || m.opcode === 'close') continue;
      const text = textOf(m.payload, m.opcode);
      const c = classifyWsMessage(text, m.opcode, ep.subprotocols);
      if (!c) continue;
      ep.messages++;
      ep.protos.set(c.protocol, (ep.protos.get(c.protocol) ?? 0) + 1);
      const k = `${m.direction} ${c.name}`;
      let kind = ep.kindMap.get(k);
      if (!kind) {
        kind = { name: c.name, direction: m.direction, count: 0, fields: [], example: short(text ?? `${m.size} bytes`), exampleExchangeId: e.id, firstAt: m.at, lastAt: m.at };
        ep.kindMap.set(k, kind);
      }
      kind.count++;
      kind.lastAt = Math.max(kind.lastAt, m.at);
      for (const f of c.fields) if (!kind.fields.includes(f) && kind.fields.length < 40) kind.fields.push(f);
    }
  }
  return [...map.values()]
    .map(({ protos, kindMap, ...ep }) => {
      // The protocol most messages use; plain text or binary only when nothing better fits.
      const ranked = [...protos.entries()].sort((a, b) => b[1] - a[1]);
      const best = ranked.find(([p]) => p !== 'text' && p !== 'binary') ?? ranked[0];
      return {
        ...ep,
        protocol: best?.[0] ?? 'none',
        kinds: [...kindMap.values()].sort((a, b) => a.direction.localeCompare(b.direction) || b.count - a.count || a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => a.host.localeCompare(b.host) || a.template.localeCompare(b.template));
}
