/** QUIC transport parameters (RFC 9000 section 18). */
import { QuicError, Reader, TransportError, Writer } from './bytes.js';

export interface TransportParams {
  originalDcid?: Buffer;
  maxIdleTimeout?: number;
  statelessResetToken?: Buffer;
  maxUdpPayloadSize?: number;
  initialMaxData?: number;
  initialMaxStreamDataBidiLocal?: number;
  initialMaxStreamDataBidiRemote?: number;
  initialMaxStreamDataUni?: number;
  initialMaxStreamsBidi?: number;
  initialMaxStreamsUni?: number;
  ackDelayExponent?: number;
  maxAckDelay?: number;
  disableActiveMigration?: boolean;
  activeConnectionIdLimit?: number;
  initialScid?: Buffer;
  retryScid?: Buffer;
  maxDatagramFrameSize?: number;
  /** Unknown or deliberately odd parameters, sent as-is (id to raw value). */
  extra?: Array<[number, Buffer]>;
}

const ID = {
  originalDcid: 0x00,
  maxIdleTimeout: 0x01,
  statelessResetToken: 0x02,
  maxUdpPayloadSize: 0x03,
  initialMaxData: 0x04,
  initialMaxStreamDataBidiLocal: 0x05,
  initialMaxStreamDataBidiRemote: 0x06,
  initialMaxStreamDataUni: 0x07,
  initialMaxStreamsBidi: 0x08,
  initialMaxStreamsUni: 0x09,
  ackDelayExponent: 0x0a,
  maxAckDelay: 0x0b,
  disableActiveMigration: 0x0c,
  activeConnectionIdLimit: 0x0e,
  initialScid: 0x0f,
  retryScid: 0x10,
  maxDatagramFrameSize: 0x20,
} as const;

const BYTES = new Set(['originalDcid', 'statelessResetToken', 'initialScid', 'retryScid']);

export function encodeParams(p: TransportParams): Buffer {
  const w = new Writer();
  for (const [name, id] of Object.entries(ID) as Array<[keyof typeof ID, number]>) {
    const v = p[name];
    if (v === undefined || v === false) continue;
    w.varint(id);
    if (v === true) w.varint(0);
    else if (BYTES.has(name)) w.vvec(v as Buffer);
    else {
      const n = new Writer(8).varint(v as number).finish();
      w.vvec(n);
    }
  }
  for (const [id, raw] of p.extra ?? []) w.varint(id).vvec(raw);
  // A reserved (greased) parameter so peers prove they ignore unknown ones.
  const grease = 31 * Math.floor(Math.random() * 1000) + 27;
  w.varint(grease).vvec(Buffer.alloc(0));
  return w.finish();
}

export function decodeParams(buf: Buffer): TransportParams {
  const r = new Reader(buf);
  const out: TransportParams = {};
  const seen = new Set<number>();
  const names = new Map<number, keyof typeof ID>(Object.entries(ID).map(([k, v]) => [v, k as keyof typeof ID]));
  try {
    while (r.left) {
      const id = r.varint();
      const val = Buffer.from(r.vvec());
      if (seen.has(id)) throw new QuicError(TransportError.TRANSPORT_PARAMETER_ERROR, `duplicate transport parameter 0x${id.toString(16)}`);
      seen.add(id);
      const name = names.get(id);
      if (!name) continue;
      if (name === 'disableActiveMigration') out.disableActiveMigration = true;
      else if (BYTES.has(name)) (out as Record<string, unknown>)[name] = val;
      else {
        const vr = new Reader(val);
        (out as Record<string, unknown>)[name] = vr.varint();
        if (vr.left) throw new QuicError(TransportError.TRANSPORT_PARAMETER_ERROR, `bad transport parameter ${name}`);
      }
    }
  } catch (e) {
    if (e instanceof QuicError && e.code === TransportError.TRANSPORT_PARAMETER_ERROR) throw e;
    throw new QuicError(TransportError.TRANSPORT_PARAMETER_ERROR, 'malformed transport parameters');
  }
  if (out.maxUdpPayloadSize !== undefined && out.maxUdpPayloadSize < 1200) throw new QuicError(TransportError.TRANSPORT_PARAMETER_ERROR, 'max_udp_payload_size below 1200');
  if (out.ackDelayExponent !== undefined && out.ackDelayExponent > 20) throw new QuicError(TransportError.TRANSPORT_PARAMETER_ERROR, 'ack_delay_exponent above 20');
  if (out.maxAckDelay !== undefined && out.maxAckDelay >= 2 ** 14) throw new QuicError(TransportError.TRANSPORT_PARAMETER_ERROR, 'max_ack_delay too large');
  if (out.activeConnectionIdLimit !== undefined && out.activeConnectionIdLimit < 2) throw new QuicError(TransportError.TRANSPORT_PARAMETER_ERROR, 'active_connection_id_limit below 2');
  if (out.statelessResetToken && out.statelessResetToken.length !== 16) throw new QuicError(TransportError.TRANSPORT_PARAMETER_ERROR, 'bad stateless_reset_token');
  for (const k of ['initialMaxStreamsBidi', 'initialMaxStreamsUni'] as const) {
    if ((out[k] ?? 0) > 2 ** 60) throw new QuicError(TransportError.TRANSPORT_PARAMETER_ERROR, `${k} too large`);
  }
  return out;
}
