/**
 * WebSocket replay scripts: a captured connection written out as steps you
 * can edit before sending it again. A script is the handshake (URL and
 * headers) plus a list of steps:
 *
 *   send    a message (text with Replay tokens, or binary), optionally as a
 *           frame preset (fragmented, slow drip, invalid UTF-8...)
 *   wait    until the server sends a message (any, or one matching text or a
 *           /regex/), optionally saving a value from it into a variable that
 *           later steps use with {{var:name}}
 *   frames  an exact frame plan, as the frame planner makes it
 *   close   the closing handshake with a code and reason
 *
 * Text messages are treated like Replay request bodies: tokens are filled in
 * first, then saved field codecs or a Fields spec encode JSON fields (inside
 * Socket.IO and SignalR framing too), then an Encode chain wraps the result.
 */
import { bytesToString, encodeFieldsText, type FieldCodec } from '@siteinquisition/codecs';
import { query } from '@siteinquisition/codecs/jsonpath';
import { encodeBody } from './send.js';
import type { HeaderList, StreamMessage } from './store.js';
import { batchPlan, hasTokens, resolveTokens, type TokenContext } from './tokens.js';
import { validatePlan, type PlanStep } from './wsplan.js';

interface StepBase {
  /** Off: kept in the script but skipped. */
  enabled?: boolean;
  /** Wait this long before the step. */
  delayMs?: number;
  note?: string;
}

export type WsScriptStep =
  | (StepBase & {
      kind: 'send';
      opcode: 'text' | 'binary';
      /** The message: text (tokens allowed), or bytes as base64 or hex. */
      payload: string;
      encoding?: 'text' | 'base64' | 'hex';
      /** Send it as this frame preset's frames instead of one frame. */
      preset?: string;
      presetOptions?: Record<string, number | string>;
    })
  | (StepBase & {
      kind: 'wait';
      /** Text the message contains (any case), or /regex/flags. Empty: any server message. */
      match?: string;
      /** How many matching messages to wait for. Default 1. */
      count?: number;
      /** Default 10 seconds. */
      timeoutMs?: number;
      /** What to do when it times out. Default continue. */
      onTimeout?: 'continue' | 'stop';
      /** Save a value from the matching message: a JSONPath into its JSON, or a /regex/ whose first group is the value. */
      extract?: { var: string; from: string };
    })
  | (StepBase & { kind: 'frames'; steps: PlanStep[] })
  | (StepBase & { kind: 'close'; code?: number; reason?: string });

export interface WsScript {
  url: string;
  headers: HeaderList;
  steps: WsScriptStep[];
}

export interface WsStepResult {
  index: number;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'timeout' | 'error';
  startedAt?: number;
  endedAt?: number;
  /** How many messages a send step sent (a batch token sends several). */
  sent?: number;
  /** For waits: how many matched. */
  matched?: number;
  /** A value saved into a variable. */
  value?: string;
  error?: string;
}

const RS = '\x1e';

/** Engine.IO ping/pong frames, which keep-alive answers on its own. */
export const isEngineIoHeartbeat = (text: string) => text === '2' || text === '3' || text === '2probe' || text === '3probe';
const isSignalRPing = (text: string) => /^\{\s*"type"\s*:\s*6\s*\}\x1e$/.test(text);
/** A message keep-alive deals with, so it is not counted or replayed. */
export const isHeartbeat = (text: string | null) => text !== null && (isEngineIoHeartbeat(text) || isSignalRPing(text));

/**
 * Apply fn to the JSON inside a message: plain JSON, a Socket.IO packet
 * (`42["event",{...}]`, `42/ns,7[...]`) or SignalR records (`{...}\x1e`).
 * Returns null when there is no JSON in it.
 */
export function mapJsonPart(text: string, fn: (json: string) => string): string | null {
  if (text.endsWith(RS)) {
    const recs = text.split(RS).slice(0, -1);
    if (!recs.length || !recs.every((r) => /^\s*[[{]/.test(r))) return null;
    return recs.map(fn).join(RS) + RS;
  }
  const sio = /^(\d(?:\d(?:\d+-)?(?:\/[^,[{]*,)?\d*)?)([[{].*)$/s.exec(text);
  if (sio && sio[1]) return sio[1] + fn(sio[2]!);
  if (/^\s*[[{]/.test(text)) return fn(text);
  return null;
}

/** Fill in tokens, encode fields, then wrap in an encode chain: the payload of one text message. */
export function prepareText(
  text: string,
  opts: { ctx?: TokenContext; tokens?: boolean; fields?: FieldCodec[]; encode?: string[] },
): Uint8Array {
  let out = opts.tokens !== false && opts.ctx && hasTokens(text) ? resolveTokens(text, opts.ctx) : text;
  if (opts.fields?.length) {
    const specs = opts.fields;
    const mapped = mapJsonPart(out, (json) => {
      const r = encodeFieldsText(json, specs);
      if (r.errors.length) throw new Error(`Could not encode fields: ${r.errors[0]}`);
      return r.text;
    });
    if (mapped !== null) out = mapped;
  }
  return opts.encode?.length ? encodeBody(opts.encode, out) : new TextEncoder().encode(out);
}

/** The bytes of a binary (base64 or hex) send step. */
export function stepBytes(step: Extract<WsScriptStep, { kind: 'send' }>): Uint8Array {
  if (step.encoding === 'hex') {
    const hex = step.payload.replace(/[^0-9a-f]/gi, '');
    if (hex.length % 2) throw new Error('hex needs an even number of digits');
    return Buffer.from(hex, 'hex');
  }
  if (step.encoding === 'base64') return Buffer.from(step.payload.replace(/\s+/g, ''), 'base64');
  return Buffer.from(step.payload, 'utf8');
}

/** The value sets a send step's batch tokens make: one message per set. */
export function sendBatch(step: Extract<WsScriptStep, { kind: 'send' }>, projectDir?: string, each?: (arg: string) => string[]): Array<Map<string, string>> {
  if ((step.encoding ?? 'text') !== 'text' || !hasTokens(step.payload)) return [new Map()];
  return batchPlan([step.payload], projectDir, 10_000, each);
}

/** Whether a message matches a wait's text or /regex/. */
export function waitMatches(match: string | undefined, text: string): boolean {
  if (!match) return true;
  const re = /^\/(.+)\/([a-z]*)$/s.exec(match);
  if (re) {
    try {
      return new RegExp(re[1]!, re[2]!.replace(/[gy]/g, '')).test(text);
    } catch {
      return false;
    }
  }
  return text.toLowerCase().includes(match.toLowerCase());
}

/** A value from a message: /regex/ (first group, or the whole match), or a JSONPath into its JSON (Socket.IO and SignalR framing are looked through). */
export function extractFromMessage(from: string, text: string): string | undefined {
  const re = /^\/(.+)\/([a-z]*)$/s.exec(from);
  if (re) {
    const m = new RegExp(re[1]!, re[2]!.replace(/[gy]/g, '')).exec(text);
    return m ? (m[1] ?? m[0]) : undefined;
  }
  const path = from.startsWith('$') ? from : `$.${from}`;
  let found: unknown;
  const look = (json: string) => {
    if (found !== undefined) return json;
    try {
      const hit = query(JSON.parse(json), path)[0];
      if (hit) found = hit.value;
    } catch {
      // not JSON
    }
    return json;
  };
  if (mapJsonPart(text, look) === null) look(text);
  if (found === undefined) return undefined;
  return typeof found === 'string' ? found : JSON.stringify(found);
}

/** Check a script from the outside world before running it. */
export function validateScript(script: unknown): WsScript {
  const s = script as WsScript;
  if (!s || typeof s !== 'object' || typeof s.url !== 'string' || !s.url) throw new Error('a WebSocket script needs a url');
  if (!Array.isArray(s.headers)) throw new Error('a WebSocket script needs a headers list');
  if (!Array.isArray(s.steps)) throw new Error('a WebSocket script needs a steps list');
  if (s.steps.length > 10_000) throw new Error('a WebSocket script can have at most 10000 steps');
  let wait = 0;
  for (const [i, st] of s.steps.entries()) {
    const at = `step ${i + 1}`;
    if (!st || typeof st !== 'object') throw new Error(`${at} is not an object`);
    wait += Math.max(0, Number(st.delayMs ?? 0));
    switch (st.kind) {
      case 'send':
        if (typeof st.payload !== 'string') throw new Error(`${at}: a send step needs a payload`);
        if (st.opcode !== 'text' && st.opcode !== 'binary') throw new Error(`${at}: opcode must be text or binary`);
        break;
      case 'wait':
        wait += Math.max(0, Number(st.timeoutMs ?? 10_000));
        if (st.extract && (typeof st.extract.var !== 'string' || !/^[\w.-]+$/.test(st.extract.var) || typeof st.extract.from !== 'string' || !st.extract.from)) {
          throw new Error(`${at}: extract needs a variable name (letters, digits, _ . -) and a JSONPath or /regex/`);
        }
        break;
      case 'frames':
        validatePlan(st.steps);
        break;
      case 'close':
        break;
      default:
        throw new Error(`${at}: kind must be send, wait, frames or close`);
    }
  }
  if (wait > 30 * 60_000) throw new Error('a WebSocket script can wait at most 30 minutes in total');
  return s;
}

/** The text of a recorded message, or null when it is binary. */
const textOf = (m: Pick<StreamMessage, 'opcode' | 'payload'>) => (m.opcode === 'text' ? bytesToString(m.payload) : null);

/**
 * Write a recorded conversation out as a script: each client message becomes
 * a send step. With `waits`, a wait step goes before each send for the server
 * messages the client had seen at that point, so the replay keeps pace with
 * the server rather than racing it. With `timing`, sends keep their original
 * gaps. With `keepAlive`, heartbeats (Engine.IO ping/pong, SignalR pings)
 * are left out, since the replay answers them itself.
 */
export function scriptFromMessages(
  url: string,
  headers: HeaderList,
  messages: Array<Pick<StreamMessage, 'id' | 'direction' | 'opcode' | 'payload' | 'at' | 'meta'>>,
  opts: { timing?: boolean; waits?: boolean; keepAlive?: boolean } = {},
): WsScript {
  const steps: WsScriptStep[] = [];
  const data = (m: (typeof messages)[number]) => m.opcode === 'text' || m.opcode === 'binary';
  let serverSince = 0;
  let lastServer: string | null = null;
  let lastClientAt: number | null = null;
  for (const m of messages) {
    if (m.direction === 'server') {
      if (!data(m)) continue;
      const t = textOf(m);
      if (opts.keepAlive !== false && isHeartbeat(t)) continue;
      serverSince++;
      lastServer = t;
      continue;
    }
    if (m.opcode === 'close') {
      const code = typeof m.meta?.code === 'number' ? m.meta.code : m.payload.length >= 2 ? Buffer.from(m.payload).readUInt16BE(0) : undefined;
      const reason = typeof m.meta?.reason === 'string' ? m.meta.reason : undefined;
      steps.push({ kind: 'close', ...(code !== undefined ? { code } : {}), ...(reason ? { reason } : {}) });
      break;
    }
    if (!data(m)) continue;
    const t = textOf(m);
    if (opts.keepAlive !== false && isHeartbeat(t)) continue;
    if (opts.waits && serverSince > 0) {
      steps.push({ kind: 'wait', count: serverSince, timeoutMs: 10_000, note: lastServer !== null ? `last was ${lastServer.slice(0, 60)}` : undefined });
    }
    serverSince = 0;
    const gap = opts.timing && lastClientAt !== null ? Math.max(0, m.at - lastClientAt) : 0;
    lastClientAt = m.at;
    const binary = m.opcode === 'binary' || t === null;
    steps.push({
      kind: 'send',
      opcode: binary ? 'binary' : 'text',
      payload: binary ? Buffer.from(m.payload).toString('base64') : t!,
      ...(binary ? { encoding: 'base64' as const } : {}),
      ...(gap ? { delayMs: gap } : {}),
    });
  }
  return { url, headers, steps };
}
