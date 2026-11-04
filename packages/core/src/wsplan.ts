/**
 * Frame plans: a message spelled out as the exact frames (and pauses, raw
 * bytes and socket closes) to put on the wire. Presets turn one message into
 * plans that exercise how a server reassembles, validates and times out
 * WebSocket traffic; every step stays editable before it is sent.
 */
import { OPCODES, encodeFrame, opcodeName, type FrameSpec, type OpcodeName } from './websocket.js';

export type PlanStep =
  | {
      kind: 'frame';
      opcode: OpcodeName | number;
      /** Payload, base64. */
      payload: string;
      fin?: boolean;
      rsv1?: boolean;
      rsv2?: boolean;
      rsv3?: boolean;
      /** "auto" masks from clients only; "none", "random", "zero" or 8 hex digits. */
      mask?: 'auto' | 'none' | 'random' | 'zero' | string;
      lengthField?: 'auto' | 16 | 64;
      declaredLength?: number;
      truncateTo?: number;
      /** Wait this long before the step. */
      delayMs?: number;
      note?: string;
    }
  | { kind: 'raw'; bytes: string; delayMs?: number; note?: string }
  /** End the TCP connection: "end" sends FIN, "destroy" drops it at once. */
  | { kind: 'socket'; action: 'end' | 'destroy'; delayMs?: number; note?: string };

export interface PresetInfo {
  id: string;
  name: string;
  /** What it checks, and how a correct server reacts. */
  expect: string;
  options?: Array<{ key: string; label: string; default: number | string }>;
}

export const PRESETS: PresetInfo[] = [
  { id: 'single', name: 'One frame', expect: 'The message as a single frame, as a browser would send it.' },
  { id: 'fragment', name: 'Fragment', expect: 'Legal. The server must reassemble the fragments into one message.', options: [{ key: 'parts', label: 'Fragments', default: 3 }, { key: 'delayMs', label: 'Delay between (ms)', default: 0 }] },
  { id: 'fragment-size', name: 'Fragment by size', expect: 'Legal. Fixed-size fragments, e.g. 1 byte each to find buffering bugs.', options: [{ key: 'size', label: 'Bytes per fragment', default: 1 }, { key: 'delayMs', label: 'Delay between (ms)', default: 0 }] },
  { id: 'split-utf8', name: 'Split inside a character', expect: 'Legal. Fragments break a multi-byte UTF-8 character; servers that decode each fragment on its own get it wrong.' },
  { id: 'ping-between', name: 'Ping between fragments', expect: 'Legal. Control frames may arrive mid-message; the server should answer with a pong and still reassemble.' },
  { id: 'interleaved-data', name: 'New message mid-fragment', expect: 'Protocol error: a text frame before the fragmented message ends. Expect close 1002.' },
  { id: 'orphan-continuation', name: 'Continuation without start', expect: 'Protocol error. Expect close 1002.' },
  { id: 'never-finish', name: 'Never finish the message', expect: 'Fragments without a final one. Shows whether the server times out or holds memory forever.', options: [{ key: 'parts', label: 'Fragments', default: 3 }] },
  { id: 'slow-drip', name: 'Slow drip', expect: 'The frame one byte at a time. Tests read timeouts (slowloris).', options: [{ key: 'delayMs', label: 'Delay per byte (ms)', default: 200 }] },
  { id: 'burst', name: 'Burst', expect: 'The same message many times at once. Tests rate limits and queueing.', options: [{ key: 'count', label: 'Copies', default: 50 }] },
  { id: 'invalid-utf8', name: 'Invalid UTF-8 text', expect: 'A text frame that is not UTF-8. Expect close 1007.' },
  { id: 'unmasked', name: 'Unmasked client frame', expect: 'Clients must mask. Expect close 1002.' },
  { id: 'zero-mask', name: 'All-zero mask', expect: 'Legal but weak: the payload is readable on the wire. Should be accepted.' },
  { id: 'rsv1', name: 'RSV1 without an extension', expect: 'Reserved bit set with no extension negotiated. Expect close 1002.' },
  { id: 'reserved-opcode', name: 'Reserved opcode', expect: 'Opcode 3 is reserved. Expect close 1002.', options: [{ key: 'opcode', label: 'Opcode', default: 3 }] },
  { id: 'big-ping', name: 'Oversized ping', expect: 'Control frames carry at most 125 bytes. Expect close 1002.' },
  { id: 'fragmented-ping', name: 'Fragmented ping', expect: 'Control frames must not be fragmented. Expect close 1002.' },
  { id: 'long-length', name: 'Non-minimal length', expect: 'A 64-bit length for a short payload. Strict servers close with 1002; many accept it.' },
  { id: 'length-lie', name: 'Length larger than payload', expect: 'The header promises more bytes than are sent. The server should time out, not hang.', options: [{ key: 'extra', label: 'Missing bytes', default: 100 }] },
  { id: 'huge-length', name: 'Huge declared length', expect: 'A header claiming 4 GiB. The server should close (1009) rather than try to buffer it.' },
  { id: 'close-code', name: 'Close with a code', expect: 'Codes 1005, 1006, 1015, below 1000 or above 4999 are invalid on the wire and should get 1002.', options: [{ key: 'code', label: 'Code', default: 1000 }, { key: 'reason', label: 'Reason', default: '' }] },
  { id: 'close-1-byte', name: 'One-byte close', expect: 'A close payload must be 0 or at least 2 bytes. Expect 1002.' },
  { id: 'long-reason', name: 'Close reason over 123 bytes', expect: 'Makes the close frame too long for a control frame. Expect 1002.' },
  { id: 'data-after-close', name: 'Data after close', expect: 'A message after our close frame. The server must ignore it.' },
  { id: 'drop-mid-frame', name: 'Drop mid-frame', expect: 'Half a frame, then the TCP connection drops. Checks clean-up.' },
];

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

function chunks(payload: Buffer, parts: number): Buffer[] {
  const n = Math.max(1, Math.min(parts, payload.length || 1));
  const size = Math.ceil(payload.length / n) || 0;
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) out.push(payload.subarray(i * size, (i + 1) * size));
  return out;
}

/** Frames that carry a message in pieces: first with the opcode, the rest continuation, FIN only on the last (unless finish is false). */
function fragments(opcode: 'text' | 'binary', pieces: Buffer[], delayMs = 0, finish = true): PlanStep[] {
  return pieces.map((p, i) => ({
    kind: 'frame' as const,
    opcode: i === 0 ? opcode : 'continuation',
    payload: b64(p),
    fin: finish && i === pieces.length - 1,
    ...(i > 0 && delayMs ? { delayMs } : {}),
  }));
}

/** Build the steps for a preset. */
export function buildPlan(preset: string, message: { payload: Uint8Array; opcode: 'text' | 'binary' }, options: Record<string, number | string> = {}): PlanStep[] {
  const payload = Buffer.from(message.payload);
  const op = message.opcode;
  const num = (k: string, d: number) => {
    const v = Number(options[k]);
    return Number.isFinite(v) ? v : d;
  };
  const one = (extra: Partial<Extract<PlanStep, { kind: 'frame' }>> = {}): PlanStep => ({ kind: 'frame', opcode: op, payload: b64(payload), ...extra });
  switch (preset) {
    case 'single':
      return [one()];
    case 'fragment':
      return fragments(op, chunks(payload, num('parts', 3)), num('delayMs', 0));
    case 'fragment-size': {
      const size = Math.max(1, num('size', 1));
      const pieces: Buffer[] = [];
      for (let i = 0; i < payload.length; i += size) pieces.push(payload.subarray(i, i + size));
      return fragments(op, pieces.length ? pieces : [payload], num('delayMs', 0));
    }
    case 'split-utf8': {
      // Cut just after the first lead byte of a multi-byte character, or add one if there is none.
      let data = payload;
      let at = data.findIndex((b) => b >= 0xc0);
      if (at < 0) {
        data = Buffer.concat([payload, Buffer.from('€')]);
        at = payload.length;
      }
      return fragments('text', [data.subarray(0, at + 1), data.subarray(at + 1)]);
    }
    case 'ping-between': {
      const [a, ...rest] = chunks(payload, 2);
      const f = fragments(op, [a!, ...(rest.length ? rest : [Buffer.alloc(0)])]);
      return [f[0]!, { kind: 'frame', opcode: 'ping', payload: b64(Buffer.from('mid-message')) }, ...f.slice(1)];
    }
    case 'interleaved-data': {
      const f = fragments(op, chunks(payload, 2).concat(payload.length < 2 ? [Buffer.alloc(0)] : []));
      return [f[0]!, { kind: 'frame', opcode: 'text', payload: b64(Buffer.from('interloper')), note: 'not allowed here' }, ...f.slice(1)];
    }
    case 'orphan-continuation':
      return [{ kind: 'frame', opcode: 'continuation', payload: b64(payload) }];
    case 'never-finish':
      return fragments(op, chunks(payload, num('parts', 3)), 0, false);
    case 'slow-drip':
      return dripSteps(payload, op, num('delayMs', 200));
    case 'burst':
      return Array.from({ length: Math.max(1, Math.min(num('count', 50), 10_000)) }, () => one());
    case 'invalid-utf8':
      return [{ kind: 'frame', opcode: 'text', payload: b64(Buffer.concat([payload.subarray(0, 64), Buffer.from([0xc3, 0x28, 0xff, 0xfe])])) }];
    case 'unmasked':
      return [one({ mask: 'none' })];
    case 'zero-mask':
      return [one({ mask: 'zero' })];
    case 'rsv1':
      return [one({ rsv1: true })];
    case 'reserved-opcode':
      return [one({ opcode: num('opcode', 3) & 0x0f })];
    case 'big-ping':
      return [{ kind: 'frame', opcode: 'ping', payload: b64(Buffer.alloc(126, 0x61)) }];
    case 'fragmented-ping':
      return [
        { kind: 'frame', opcode: 'ping', payload: b64(Buffer.from('ping')), fin: false },
        { kind: 'frame', opcode: 'continuation', payload: b64(Buffer.from('-rest')) },
      ];
    case 'long-length':
      return [one({ lengthField: 64 })];
    case 'length-lie':
      return [one({ declaredLength: payload.length + Math.max(1, num('extra', 100)), lengthField: 'auto' })];
    case 'huge-length':
      return [one({ declaredLength: 2 ** 32, lengthField: 64, truncateTo: 14, note: 'header only' })];
    case 'close-code': {
      const code = num('code', 1000);
      return [{ kind: 'frame', opcode: 'close', payload: b64(Buffer.concat([Buffer.of((code >> 8) & 0xff, code & 0xff), Buffer.from(String(options.reason ?? ''))])) }];
    }
    case 'close-1-byte':
      return [{ kind: 'frame', opcode: 'close', payload: b64(Buffer.of(0x03)) }];
    case 'long-reason':
      return [{ kind: 'frame', opcode: 'close', payload: b64(Buffer.concat([Buffer.of(0x03, 0xe8), Buffer.alloc(124, 0x72)])) }];
    case 'data-after-close':
      return [{ kind: 'frame', opcode: 'close', payload: b64(Buffer.of(0x03, 0xe8)) }, one({ note: 'after close' })];
    case 'drop-mid-frame':
      return [one({ truncateTo: 2 + Math.floor(payload.length / 2) }), { kind: 'socket', action: 'destroy', delayMs: 50 }];
    default:
      throw new Error(`unknown preset "${preset}"`);
  }
}

/** One frame's bytes as raw steps, a byte at a time. */
function dripSteps(payload: Buffer, op: 'text' | 'binary', delayMs: number): PlanStep[] {
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i]! ^= mask[i & 3]!;
  const len = payload.length;
  const head = len > 0xffff ? [0x80 | OPCODES[op], 0x80 | 127] : len > 125 ? [0x80 | OPCODES[op], 0x80 | 126] : [0x80 | OPCODES[op], 0x80 | len];
  const ext = len > 0xffff ? Buffer.alloc(8) : len > 125 ? Buffer.alloc(2) : Buffer.alloc(0);
  if (len > 0xffff) ext.writeBigUInt64BE(BigInt(len));
  else if (len > 125) ext.writeUInt16BE(len);
  const bytes = Buffer.concat([Buffer.from(head), ext, mask, masked]);
  // Cap the drip so a big message cannot queue hours of steps.
  return [...bytes.subarray(0, 512)].map((b, i) => ({ kind: 'raw' as const, bytes: b64(Buffer.of(b)), ...(i ? { delayMs } : {}) })).concat(
    bytes.length > 512 ? [{ kind: 'raw' as const, bytes: b64(bytes.subarray(512)), delayMs }] : [],
  );
}

/** Turn a plan frame step into an encoder spec. */
export function stepToSpec(s: Extract<PlanStep, { kind: 'frame' }>): FrameSpec {
  const mask = s.mask ?? 'auto';
  return {
    opcode: s.opcode,
    payload: Buffer.from(s.payload, 'base64'),
    fin: s.fin,
    rsv1: s.rsv1,
    rsv2: s.rsv2,
    rsv3: s.rsv3,
    mask: mask === 'auto' ? undefined : mask === 'none' ? false : mask === 'random' ? true : mask === 'zero' ? Buffer.alloc(4) : Buffer.from(mask.replace(/[^0-9a-f]/gi, '').padEnd(8, '0').slice(0, 8), 'hex'),
    lengthField: s.lengthField,
    declaredLength: s.declaredLength,
    truncateTo: s.truncateTo,
  };
}

/** Check a plan from the outside world before running it. */
export function validatePlan(steps: unknown): PlanStep[] {
  if (!Array.isArray(steps) || !steps.length) throw new Error('a frame plan needs at least one step');
  if (steps.length > 10_000) throw new Error('a frame plan can have at most 10000 steps');
  let total = 0;
  for (const s of steps as PlanStep[]) {
    if (!s || typeof s !== 'object' || !['frame', 'raw', 'socket'].includes(s.kind)) throw new Error('each step needs kind frame, raw or socket');
    total += Math.max(0, Number(s.delayMs ?? 0));
    if (s.kind === 'frame' && typeof s.payload !== 'string') throw new Error('frame steps need a base64 payload');
    if (s.kind === 'raw' && typeof s.bytes !== 'string') throw new Error('raw steps need base64 bytes');
  }
  if (total > 10 * 60_000) throw new Error('a frame plan can wait at most 10 minutes in total');
  return steps as PlanStep[];
}

export interface SentStep {
  index: number;
  at: number;
  kind: PlanStep['kind'];
  /** For frames: what went on the wire, for the record. */
  frame?: { opcode: string; fin: boolean; rsv: string; masked: boolean; length: number; declaredLength?: number; truncated?: boolean };
  bytes: number;
  note?: string;
}

/**
 * Run a plan: write each step, waiting for its delay first. Stops early if
 * the connection goes away or `signal` aborts.
 */
export async function runPlan(
  steps: PlanStep[],
  io: { write(b: Buffer): boolean; end(): void; destroy(): void; alive(): boolean; defaultMask: boolean },
  onStep?: (s: SentStep) => void,
  signal?: AbortSignal,
  /** Awaited before each step, e.g. to wait for a frame boundary. */
  beforeStep?: () => Promise<void>,
): Promise<SentStep[]> {
  const sent: SentStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.delayMs) await new Promise((r) => setTimeout(r, Math.min(s.delayMs!, 60_000)));
    await beforeStep?.();
    if (signal?.aborted || !io.alive()) break;
    let rec: SentStep;
    if (s.kind === 'frame') {
      const spec = stepToSpec(s);
      const bytes = encodeFrame(spec, io.defaultMask);
      io.write(bytes);
      const masked = spec.mask === undefined ? io.defaultMask : spec.mask !== false;
      rec = {
        index: i,
        at: Date.now(),
        kind: 'frame',
        bytes: bytes.length,
        note: s.note,
        frame: {
          opcode: opcodeName(typeof s.opcode === 'number' ? s.opcode : OPCODES[s.opcode]),
          fin: s.fin !== false,
          rsv: [s.rsv1 ? '1' : '', s.rsv2 ? '2' : '', s.rsv3 ? '3' : ''].join(''),
          masked,
          length: Buffer.from(s.payload, 'base64').length,
          ...(s.declaredLength !== undefined ? { declaredLength: s.declaredLength } : {}),
          ...(s.truncateTo !== undefined ? { truncated: true } : {}),
        },
      };
    } else if (s.kind === 'raw') {
      const bytes = Buffer.from(s.bytes, 'base64');
      io.write(bytes);
      rec = { index: i, at: Date.now(), kind: 'raw', bytes: bytes.length, note: s.note };
    } else {
      if (s.action === 'end') io.end();
      else io.destroy();
      rec = { index: i, at: Date.now(), kind: 'socket', bytes: 0, note: s.note ?? s.action };
    }
    sent.push(rec);
    onStep?.(rec);
  }
  return sent;
}
