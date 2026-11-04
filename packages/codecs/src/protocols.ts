/**
 * Decoders for application protocols carried over HTTP and WebSockets:
 * Socket.IO / Engine.IO frames, SignalR messages, and ASP.NET ViewState.
 * They register as codecs so find/replace and the inspector can read them,
 * and so a value wrapped in one can be edited as structured data.
 */
import type { Codec } from './index.js';

// A local copy of these helpers (no Node imports) keeps this module usable in
// the browser renderer, which must not pull in the zlib-backed codecs in index.
const enc = new TextEncoder();
const dec = new TextDecoder();
const bytesToString = (b: Uint8Array): string => dec.decode(b);

// ---------- Engine.IO / Socket.IO ----------

const EIO_TYPES = ['open', 'close', 'ping', 'pong', 'message', 'upgrade', 'noop'];
const SIO_TYPES = ['CONNECT', 'DISCONNECT', 'EVENT', 'ACK', 'CONNECT_ERROR', 'BINARY_EVENT', 'BINARY_ACK'];

export interface SioPacket {
  /** The Engine.IO packet kind. */
  transport: string;
  /** For a "message", the Socket.IO packet kind. */
  type?: string;
  namespace?: string;
  /** Acknowledgement id, when present. */
  ack?: number;
  /** Number of binary attachments, for BINARY_EVENT/ACK. */
  attachments?: number;
  /** The event name, for EVENT and BINARY_EVENT. */
  event?: string;
  /** The payload: the array after the event name, or the raw remainder. */
  data?: unknown;
  /** The raw text, kept so re-encoding is exact when nothing was edited. */
  raw: string;
}

/** Parse one Engine.IO frame (which may wrap a Socket.IO packet). */
export function decodeSocketIO(text: string): SioPacket {
  const transport = EIO_TYPES[Number(text[0])] ?? `type${text[0]}`;
  const pkt: SioPacket = { transport, raw: text };
  if (text[0] !== '4') return pkt; // only "message" frames carry Socket.IO
  let rest = text.slice(1);
  const typeDigit = Number(rest[0]);
  pkt.type = SIO_TYPES[typeDigit] ?? `type${rest[0]}`;
  rest = rest.slice(1);
  // Binary attachment count, e.g. 51-["ev",...]
  const att = /^(\d+)-/.exec(rest);
  if (att && (typeDigit === 5 || typeDigit === 6)) {
    pkt.attachments = Number(att[1]);
    rest = rest.slice(att[0].length);
  }
  // Namespace, e.g. /admin,
  if (rest.startsWith('/')) {
    const comma = rest.indexOf(',');
    const end = comma === -1 ? rest.length : comma;
    pkt.namespace = rest.slice(0, end);
    rest = comma === -1 ? '' : rest.slice(comma + 1);
  }
  // Ack id (leading digits before the JSON).
  const ack = /^(\d+)/.exec(rest);
  if (ack) {
    pkt.ack = Number(ack[1]);
    rest = rest.slice(ack[0].length);
  }
  if (rest) {
    try {
      const parsed = JSON.parse(rest) as unknown;
      if (Array.isArray(parsed) && (typeDigit === 2 || typeDigit === 5)) {
        pkt.event = typeof parsed[0] === 'string' ? parsed[0] : undefined;
        pkt.data = parsed.slice(1);
      } else pkt.data = parsed;
    } catch {
      pkt.data = rest;
    }
  }
  return pkt;
}

/** Rebuild an Engine.IO/Socket.IO frame from a packet. */
export function encodeSocketIO(pkt: SioPacket): string {
  const tIndex = EIO_TYPES.indexOf(pkt.transport);
  const transport = tIndex === -1 ? (/^type(\d)$/.exec(pkt.transport)?.[1] ?? '4') : String(tIndex);
  if (transport !== '4' || pkt.type === undefined) return pkt.data !== undefined ? `${transport}${typeof pkt.data === 'string' ? pkt.data : JSON.stringify(pkt.data)}` : transport;
  const typeIndex = SIO_TYPES.indexOf(pkt.type);
  let out = `4${typeIndex === -1 ? (/^type(\d)$/.exec(pkt.type)?.[1] ?? '2') : typeIndex}`;
  if (pkt.attachments !== undefined) out += `${pkt.attachments}-`;
  if (pkt.namespace) out += `${pkt.namespace},`;
  if (pkt.ack !== undefined) out += String(pkt.ack);
  if (pkt.event !== undefined) out += JSON.stringify([pkt.event, ...((pkt.data as unknown[]) ?? [])]);
  else if (pkt.data !== undefined) out += typeof pkt.data === 'string' ? pkt.data : JSON.stringify(pkt.data);
  return out;
}

// ---------- SignalR ----------

const SIGNALR_RS = '\x1e';
const SIGNALR_TYPES: Record<number, string> = { 1: 'Invocation', 2: 'StreamItem', 3: 'Completion', 4: 'StreamInvocation', 5: 'CancelInvocation', 6: 'Ping', 7: 'Close' };

export interface SignalRMessage {
  type: number;
  typeName: string;
  /** For invocations: the hub method called. */
  target?: string;
  invocationId?: string;
  /** Invocation arguments. */
  arguments?: unknown[];
  /** For a Completion/StreamItem, the result or item. */
  result?: unknown;
  error?: string;
  /** The whole decoded record, for anything not lifted into the fields above. */
  record: Record<string, unknown>;
}

/** Decode the newline (record-separator) framed JSON SignalR protocol, including the handshake. */
export function decodeSignalR(text: string): SignalRMessage[] | { handshake: Record<string, unknown> } {
  const parts = text.split(SIGNALR_RS).filter((p) => p.length);
  const msgs: SignalRMessage[] = [];
  for (const p of parts) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(p) as Record<string, unknown>;
    } catch {
      continue;
    }
    // The handshake request/response has no "type".
    if (typeof rec.type !== 'number') return { handshake: rec };
    const type = rec.type;
    msgs.push({
      type,
      typeName: SIGNALR_TYPES[type] ?? `type${type}`,
      ...(typeof rec.target === 'string' ? { target: rec.target } : {}),
      ...(typeof rec.invocationId === 'string' ? { invocationId: rec.invocationId } : {}),
      ...(Array.isArray(rec.arguments) ? { arguments: rec.arguments } : {}),
      ...('result' in rec ? { result: rec.result } : {}),
      ...(typeof rec.error === 'string' ? { error: rec.error } : {}),
      record: rec,
    });
  }
  return msgs;
}

export function encodeSignalR(value: SignalRMessage[] | { handshake: Record<string, unknown> }): string {
  if ('handshake' in value) return JSON.stringify(value.handshake) + SIGNALR_RS;
  return value.map((m) => JSON.stringify(m.record)).join(SIGNALR_RS) + SIGNALR_RS;
}

// ---------- ASP.NET ViewState (ObjectStateFormatter / LosFormatter) ----------

export interface ViewState {
  value: unknown;
  /** True when a 20+ byte MAC is appended (the body is integrity-protected). */
  macProtected: boolean;
  /** Format marker: "binary" (0xFF 0x01) or "los" (legacy base64 of a different shape). */
  format: string;
}

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array) {}
  u8() {
    return this.b[this.pos++]!;
  }
  /** 7-bit encoded length prefix, as .NET writes it. */
  len7(): number {
    let n = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      n |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return n;
      shift += 7;
    }
  }
  str(): string {
    const n = this.len7();
    const s = bytesToString(this.b.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  int32(): number {
    const v = (this.b[this.pos]! | (this.b[this.pos + 1]! << 8) | (this.b[this.pos + 2]! << 16) | (this.b[this.pos + 3]! << 24)) | 0;
    this.pos += 4;
    return v;
  }
}

/** Parse the ObjectStateFormatter token stream. Covers the tokens the page framework emits. */
function readToken(r: Reader): unknown {
  const t = r.u8();
  switch (t) {
    case 0x02: // IndexedString table ref (int-encoded)
      return r.len7();
    case 0x05: // string
      return r.str();
    case 0x0b: // string table reference
      return { $ref: r.len7() };
    case 0x0f: { // Pair
      return { pair: [readToken(r), readToken(r)] };
    }
    case 0x10: { // Triplet
      return { triplet: [readToken(r), readToken(r), readToken(r)] };
    }
    case 0x15: { // ArrayList / typed array of objects
      const n = r.len7();
      return Array.from({ length: n }, () => readToken(r));
    }
    case 0x16: { // object array
      const n = r.len7();
      return Array.from({ length: n }, () => readToken(r));
    }
    case 0x18: { // control state / Hashtable-like: count then key,value pairs
      const n = r.len7();
      const o: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const k = readToken(r);
        o[String(k)] = readToken(r);
      }
      return o;
    }
    case 0x1b: // typed value: type name then value — keep both
      return { typed: r.str() };
    case 0x1e: // short string (string table add)
      return r.str();
    case 0x28: // string formatted
      return r.str();
    case 0x64: // null
      return null;
    case 0x65: // empty
      return '';
    case 0x66: // empty ArrayList
      return [];
    case 0x67: // true
      return true;
    case 0x68: // false
      return false;
    case 0x6a: // Int32
      return r.int32();
    default:
      return { token: t };
  }
}

export function decodeViewState(b: Uint8Array): ViewState {
  // Values that still carry a MAC are 20 (HMACSHA1) or 32 (SHA256) bytes longer; detect by the trailing bytes after a complete parse is hard, so expose the signal and parse the leading object.
  if (b[0] === 0xff && b[1] === 0x01) {
    const r = new Reader(b);
    r.pos = 2;
    let value: unknown;
    try {
      value = readToken(r);
    } catch {
      value = { partial: true };
    }
    const trailing = b.length - r.pos;
    return { value, macProtected: trailing === 20 || trailing === 32, format: 'binary' };
  }
  // Legacy LOS: a different, text-based triplet format; return it as text for inspection.
  return { value: bytesToString(b), macProtected: false, format: 'los' };
}

// ---------- registration ----------

const terminalText = (id: string, label: string, decode: (text: string) => unknown, encode: (value: unknown) => string): Codec => ({
  id,
  label,
  terminal: true,
  decode: (b) => decode(bytesToString(b)),
  encode: (v) => enc.encode(encode(v)),
});

/** The protocol codecs. index.ts registers these once it has defined register(). */
export const PROTOCOL_CODEC_DEFS: Codec[] = [
  terminalText('socketio', 'Socket.IO / Engine.IO frame', decodeSocketIO, (v) => encodeSocketIO(v as SioPacket)),
  terminalText('signalr', 'SignalR messages', decodeSignalR, (v) => encodeSignalR(v as SignalRMessage[] | { handshake: Record<string, unknown> })),
  {
    id: 'viewstate',
    label: 'ASP.NET ViewState (decode only)',
    terminal: true,
    decode: (b) => decodeViewState(b),
    encode: () => {
      throw new Error('ViewState is decode-only: re-encoding the ObjectStateFormatter stream is not supported');
    },
  },
];

export const PROTOCOL_CODECS = PROTOCOL_CODEC_DEFS.map((c) => c.id);

/**
 * Best-effort guess of which protocol a WebSocket text frame speaks, or null.
 * Conservative: only returns a codec id when the shape is distinctive, so it is
 * safe to use for auto-decoding a stream.
 */
export function detectProtocol(text: string): 'socketio' | 'signalr' | null {
  if (!text) return null;
  if (text.includes(SIGNALR_RS)) {
    const first = text.split(SIGNALR_RS)[0]!;
    if (/^\{.*"type"\s*:\s*[1-7]/.test(first) || /^\{.*"protocol"\s*:/.test(first)) return 'signalr';
  }
  // Engine.IO: a single leading digit, and for "message" (4) a Socket.IO type digit, often followed by [ or { or a namespace.
  if (/^[0-6]/.test(text)) {
    if (text[0] !== '4') return /^[0-3]$/.test(text) ? 'socketio' : null;
    if (/^4[0-6](\d+-)?(\/[^,]*,)?\d*[[{]/.test(text) || /^4[0-6]\/[^,]*,?$/.test(text)) return 'socketio';
  }
  return null;
}

/** A short human summary of a decoded Socket.IO or SignalR frame, for a list. */
export function summarizeFrame(text: string): string | null {
  const which = detectProtocol(text);
  if (which === 'socketio') {
    const p = decodeSocketIO(text);
    if (p.type === 'EVENT' || p.type === 'BINARY_EVENT') return `${p.namespace ? p.namespace + ' ' : ''}${p.event ?? '(event)'}${p.ack !== undefined ? ` ack#${p.ack}` : ''}`;
    if (p.type) return `${p.type}${p.namespace ? ' ' + p.namespace : ''}`;
    return p.transport;
  }
  if (which === 'signalr') {
    const m = decodeSignalR(text);
    if ('handshake' in m) return 'handshake';
    return m.map((x) => (x.target ? `${x.typeName} ${x.target}` : x.typeName)).join(', ') || null;
  }
  return null;
}
