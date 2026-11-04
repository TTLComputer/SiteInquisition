/** QUIC v1 frames (RFC 9000 section 19) and DATAGRAM (RFC 9221). */
import { QuicError, Reader, TransportError, Writer } from './bytes.js';

/** Inclusive packet number ranges, largest first. */
export type AckRange = [low: number, high: number];

export type Frame =
  | { type: 'padding'; length: number }
  | { type: 'ping' }
  | { type: 'ack'; ranges: AckRange[]; delay: number; ecn?: [number, number, number] }
  | { type: 'reset_stream'; id: number; code: number; finalSize: number }
  | { type: 'stop_sending'; id: number; code: number }
  | { type: 'crypto'; offset: number; data: Buffer }
  | { type: 'new_token'; token: Buffer }
  | { type: 'stream'; id: number; offset: number; data: Buffer; fin: boolean }
  | { type: 'max_data'; max: number }
  | { type: 'max_stream_data'; id: number; max: number }
  | { type: 'max_streams'; bidi: boolean; max: number }
  | { type: 'data_blocked'; limit: number }
  | { type: 'stream_data_blocked'; id: number; limit: number }
  | { type: 'streams_blocked'; bidi: boolean; limit: number }
  | { type: 'new_connection_id'; seq: number; retirePriorTo: number; cid: Buffer; resetToken: Buffer }
  | { type: 'retire_connection_id'; seq: number }
  | { type: 'path_challenge'; data: Buffer }
  | { type: 'path_response'; data: Buffer }
  | { type: 'connection_close'; app: boolean; code: number; frameType: number; reason: string }
  | { type: 'handshake_done' }
  | { type: 'datagram'; data: Buffer };

export type FrameType = Frame['type'];

/** Frames that do not make a packet ack-eliciting. */
export const isAckEliciting = (f: Frame) => f.type !== 'ack' && f.type !== 'padding' && f.type !== 'connection_close';

const bad = (msg: string, t = 0) => new QuicError(TransportError.FRAME_ENCODING_ERROR, msg, t);

export function parseFrames(payload: Buffer): Frame[] {
  const r = new Reader(payload);
  const out: Frame[] = [];
  while (r.left > 0) {
    const t = r.varint();
    switch (true) {
      case t === 0x00: {
        let n = 1;
        while (r.left > 0 && payload[r.pos] === 0) {
          r.pos++;
          n++;
        }
        out.push({ type: 'padding', length: n });
        break;
      }
      case t === 0x01:
        out.push({ type: 'ping' });
        break;
      case t === 0x02 || t === 0x03: {
        const largest = r.varint();
        const delay = r.varint();
        const count = r.varint();
        let high = largest;
        let low = high - r.varint();
        if (low < 0) throw bad('ACK range below zero', t);
        const ranges: AckRange[] = [[low, high]];
        for (let i = 0; i < count; i++) {
          high = low - r.varint() - 2;
          low = high - r.varint();
          if (low < 0) throw bad('ACK range below zero', t);
          ranges.push([low, high]);
        }
        const f: Frame = { type: 'ack', ranges, delay };
        if (t === 0x03) f.ecn = [r.varint(), r.varint(), r.varint()];
        out.push(f);
        break;
      }
      case t === 0x04:
        out.push({ type: 'reset_stream', id: r.varint(), code: r.varint(), finalSize: r.varint() });
        break;
      case t === 0x05:
        out.push({ type: 'stop_sending', id: r.varint(), code: r.varint() });
        break;
      case t === 0x06: {
        const offset = r.varint();
        out.push({ type: 'crypto', offset, data: Buffer.from(r.vvec()) });
        break;
      }
      case t === 0x07:
        out.push({ type: 'new_token', token: Buffer.from(r.vvec()) });
        break;
      case t >= 0x08 && t <= 0x0f: {
        const id = r.varint();
        const offset = t & 0x04 ? r.varint() : 0;
        const data = Buffer.from(t & 0x02 ? r.vvec() : r.rest());
        out.push({ type: 'stream', id, offset, data, fin: (t & 0x01) !== 0 });
        break;
      }
      case t === 0x10:
        out.push({ type: 'max_data', max: r.varint() });
        break;
      case t === 0x11:
        out.push({ type: 'max_stream_data', id: r.varint(), max: r.varint() });
        break;
      case t === 0x12 || t === 0x13:
        out.push({ type: 'max_streams', bidi: t === 0x12, max: r.varint() });
        break;
      case t === 0x14:
        out.push({ type: 'data_blocked', limit: r.varint() });
        break;
      case t === 0x15:
        out.push({ type: 'stream_data_blocked', id: r.varint(), limit: r.varint() });
        break;
      case t === 0x16 || t === 0x17:
        out.push({ type: 'streams_blocked', bidi: t === 0x16, limit: r.varint() });
        break;
      case t === 0x18: {
        const seq = r.varint();
        const retirePriorTo = r.varint();
        const cid = Buffer.from(r.vec(1));
        if (cid.length < 1 || cid.length > 20) throw bad('bad NEW_CONNECTION_ID length', t);
        out.push({ type: 'new_connection_id', seq, retirePriorTo, cid, resetToken: Buffer.from(r.bytes(16)) });
        break;
      }
      case t === 0x19:
        out.push({ type: 'retire_connection_id', seq: r.varint() });
        break;
      case t === 0x1a:
        out.push({ type: 'path_challenge', data: Buffer.from(r.bytes(8)) });
        break;
      case t === 0x1b:
        out.push({ type: 'path_response', data: Buffer.from(r.bytes(8)) });
        break;
      case t === 0x1c || t === 0x1d: {
        const code = r.varint();
        const frameType = t === 0x1c ? r.varint() : 0;
        out.push({ type: 'connection_close', app: t === 0x1d, code, frameType, reason: r.vvec().toString('utf8') });
        break;
      }
      case t === 0x1e:
        out.push({ type: 'handshake_done' });
        break;
      case t === 0x30:
        out.push({ type: 'datagram', data: Buffer.from(r.rest()) });
        break;
      case t === 0x31:
        out.push({ type: 'datagram', data: Buffer.from(r.vvec()) });
        break;
      default:
        throw bad(`unknown frame type 0x${t.toString(16)}`, t);
    }
  }
  return out;
}

export function writeFrame(w: Writer, f: Frame): void {
  switch (f.type) {
    case 'padding':
      for (let i = 0; i < f.length; i++) w.u8(0);
      return;
    case 'ping':
      w.varint(0x01);
      return;
    case 'ack': {
      w.varint(f.ecn ? 0x03 : 0x02);
      const [low0, high0] = f.ranges[0]!;
      w.varint(high0).varint(f.delay).varint(f.ranges.length - 1).varint(high0 - low0);
      let prevLow = low0;
      for (const [low, high] of f.ranges.slice(1)) {
        w.varint(prevLow - high - 2).varint(high - low);
        prevLow = low;
      }
      if (f.ecn) w.varint(f.ecn[0]).varint(f.ecn[1]).varint(f.ecn[2]);
      return;
    }
    case 'reset_stream':
      w.varint(0x04).varint(f.id).varint(f.code).varint(f.finalSize);
      return;
    case 'stop_sending':
      w.varint(0x05).varint(f.id).varint(f.code);
      return;
    case 'crypto':
      w.varint(0x06).varint(f.offset).vvec(f.data);
      return;
    case 'new_token':
      w.varint(0x07).vvec(f.token);
      return;
    case 'stream':
      // Always with offset and length so frames can be coalesced in any order.
      w.varint(0x08 | 0x04 | 0x02 | (f.fin ? 1 : 0)).varint(f.id).varint(f.offset).vvec(f.data);
      return;
    case 'max_data':
      w.varint(0x10).varint(f.max);
      return;
    case 'max_stream_data':
      w.varint(0x11).varint(f.id).varint(f.max);
      return;
    case 'max_streams':
      w.varint(f.bidi ? 0x12 : 0x13).varint(f.max);
      return;
    case 'data_blocked':
      w.varint(0x14).varint(f.limit);
      return;
    case 'stream_data_blocked':
      w.varint(0x15).varint(f.id).varint(f.limit);
      return;
    case 'streams_blocked':
      w.varint(f.bidi ? 0x16 : 0x17).varint(f.limit);
      return;
    case 'new_connection_id':
      w.varint(0x18).varint(f.seq).varint(f.retirePriorTo).vec(1, f.cid).bytes(f.resetToken);
      return;
    case 'retire_connection_id':
      w.varint(0x19).varint(f.seq);
      return;
    case 'path_challenge':
      w.varint(0x1a).bytes(f.data);
      return;
    case 'path_response':
      w.varint(0x1b).bytes(f.data);
      return;
    case 'connection_close':
      w.varint(f.app ? 0x1d : 0x1c).varint(f.code);
      if (!f.app) w.varint(f.frameType);
      w.vvec(Buffer.from(f.reason, 'utf8'));
      return;
    case 'handshake_done':
      w.varint(0x1e);
      return;
    case 'datagram':
      w.varint(0x31).vvec(f.data);
      return;
  }
}

export function encodeFrames(frames: Frame[]): Buffer {
  const w = new Writer();
  for (const f of frames) writeFrame(w, f);
  return w.finish();
}

export const frameSize = (f: Frame): number => {
  const w = new Writer(64);
  writeFrame(w, f);
  return w.length;
};

/** Overhead of a STREAM frame header for sizing chunks. */
export const streamFrameOverhead = (id: number, offset: number, len: number): number => 1 + vl(id) + vl(offset) + vl(len);
export const cryptoFrameOverhead = (offset: number, len: number): number => 1 + vl(offset) + vl(len);
const vl = (v: number) => (v < 0x40 ? 1 : v < 0x4000 ? 2 : v < 0x40000000 ? 4 : 8);

/** Short description for frame logs. */
export function describeFrame(f: Frame): string {
  switch (f.type) {
    case 'stream':
      return `STREAM id=${f.id} off=${f.offset} len=${f.data.length}${f.fin ? ' FIN' : ''}`;
    case 'crypto':
      return `CRYPTO off=${f.offset} len=${f.data.length}`;
    case 'ack':
      return `ACK ${f.ranges.map(([l, h]) => (l === h ? `${l}` : `${l}-${h}`)).join(',')}`;
    case 'reset_stream':
      return `RESET_STREAM id=${f.id} code=0x${f.code.toString(16)} final=${f.finalSize}`;
    case 'stop_sending':
      return `STOP_SENDING id=${f.id} code=0x${f.code.toString(16)}`;
    case 'max_data':
      return `MAX_DATA ${f.max}`;
    case 'max_stream_data':
      return `MAX_STREAM_DATA id=${f.id} ${f.max}`;
    case 'max_streams':
      return `MAX_STREAMS ${f.bidi ? 'bidi' : 'uni'} ${f.max}`;
    case 'connection_close':
      return `CONNECTION_CLOSE${f.app ? ' (app)' : ''} 0x${f.code.toString(16)} ${f.reason}`;
    case 'padding':
      return `PADDING ${f.length}`;
    default:
      return f.type.toUpperCase();
  }
}
