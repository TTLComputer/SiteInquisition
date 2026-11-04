/** QUIC v1 packet headers and protection (RFC 9000 section 17, RFC 9001 section 5.4). */
import { Reader, Writer, QuicError, TransportError } from './bytes.js';
import { PacketKeys, QUIC_V1, retryTag } from './keys.js';

export type PacketType = 'initial' | '0rtt' | 'handshake' | 'retry' | '1rtt' | 'version-negotiation';
const LONG_TYPES: PacketType[] = ['initial', '0rtt', 'handshake', 'retry'];

export interface Header {
  type: PacketType;
  version: number;
  dcid: Buffer;
  scid: Buffer;
  token: Buffer;
  /** Offset of the packet number within the datagram. */
  pnOffset: number;
  /** Start and end of this packet within the datagram (long headers can be coalesced). */
  start: number;
  end: number;
  /** For Version Negotiation: the versions offered. */
  versions?: number[];
  /** For Retry: the integrity tag. */
  retryTag?: Buffer;
}

/** Parse the unprotected part of a header. Short headers need the DCID length we issued. */
export function parseHeader(buf: Buffer, start: number, shortDcidLen: number): Header {
  const r = new Reader(buf, start);
  const first = r.u8();
  if (first & 0x80) {
    const version = r.u32();
    const dcid = Buffer.from(r.vec(1));
    const scid = Buffer.from(r.vec(1));
    if (dcid.length > 20 || scid.length > 20) throw new QuicError(TransportError.PROTOCOL_VIOLATION, 'connection ID too long');
    if (version === 0) {
      const versions: number[] = [];
      while (r.left >= 4) versions.push(r.u32());
      return { type: 'version-negotiation', version, dcid, scid, token: Buffer.alloc(0), pnOffset: r.pos, start, end: buf.length, versions };
    }
    const type = LONG_TYPES[(first >> 4) & 3]!;
    if (type === 'retry') {
      const token = Buffer.from(r.bytes(r.left - 16));
      return { type, version, dcid, scid, token, pnOffset: r.pos, start, end: buf.length, retryTag: Buffer.from(r.bytes(16)) };
    }
    const token = type === 'initial' ? Buffer.from(r.vvec()) : Buffer.alloc(0);
    const length = r.varint();
    if (r.pos + length > buf.length) throw new QuicError(TransportError.FRAME_ENCODING_ERROR, 'packet length past datagram');
    return { type, version, dcid, scid, token, pnOffset: r.pos, start, end: r.pos + length };
  }
  const dcid = Buffer.from(r.bytes(shortDcidLen));
  return { type: '1rtt', version: QUIC_V1, dcid, scid: Buffer.alloc(0), token: Buffer.alloc(0), pnOffset: r.pos, start, end: buf.length };
}

/** RFC 9000 appendix A.3. */
export function decodePacketNumber(largest: number, truncated: number, bits: number): number {
  const expected = largest + 1;
  const win = 2 ** bits;
  const half = win / 2;
  const candidate = Math.floor(expected / win) * win + truncated;
  if (candidate <= expected - half && candidate < 2 ** 62 - win) return candidate + win;
  if (candidate > expected + half && candidate >= win) return candidate - win;
  return candidate;
}

/** Bytes needed to encode pn given the largest acknowledged (RFC 9000 appendix A.2). */
export function packetNumberLength(pn: number, largestAcked: number): 1 | 2 | 3 | 4 {
  const unacked = largestAcked < 0 ? pn + 1 : pn - largestAcked;
  const bits = Math.log2(unacked) + 1;
  return bits <= 8 ? 1 : bits <= 16 ? 2 : bits <= 24 ? 3 : 4;
}

export interface Opened {
  pn: number;
  keyPhase: number;
  spin: number;
  payload: Buffer;
  /** First byte after header protection was removed, for reserved-bit checks. */
  first: number;
}

/** Remove header protection (on a copy) and return the header bytes and packet number. */
export function removeHeaderProtection(buf: Buffer, h: Header, hp: PacketKeys, largestPn: number): { header: Buffer; pn: number; first: number; sealed: Buffer } | null {
  const pkt = Buffer.from(buf.subarray(h.start, h.end));
  const pnOff = h.pnOffset - h.start;
  if (pnOff + 4 + 16 > pkt.length) return null;
  const mask = hp.mask(pkt.subarray(pnOff + 4, pnOff + 20));
  const long = (pkt[0]! & 0x80) !== 0;
  pkt[0]! ^= mask[0]! & (long ? 0x0f : 0x1f);
  const pnLen = (pkt[0]! & 3) + 1;
  let truncated = 0;
  for (let i = 0; i < pnLen; i++) {
    pkt[pnOff + i]! ^= mask[1 + i]!;
    truncated = truncated * 256 + pkt[pnOff + i]!;
  }
  return { header: pkt.subarray(0, pnOff + pnLen), pn: decodePacketNumber(largestPn, truncated, pnLen * 8), first: pkt[0]!, sealed: pkt.subarray(pnOff + pnLen) };
}

export function openPacket(buf: Buffer, h: Header, keys: PacketKeys | ((phase: number) => PacketKeys | undefined), largestPn: number): Opened | null {
  const hpKeys = typeof keys === 'function' ? keys(-1) : keys;
  if (!hpKeys) return null;
  const hp = removeHeaderProtection(buf, h, hpKeys, largestPn);
  if (!hp) return null;
  const keyPhase = h.type === '1rtt' ? (hp.first >> 2) & 1 : 0;
  const k = typeof keys === 'function' ? keys(keyPhase) : keys;
  if (!k) return null;
  const payload = k.open(hp.pn, hp.header, hp.sealed);
  if (!payload) return null;
  return { pn: hp.pn, keyPhase, spin: (hp.first >> 5) & 1, payload, first: hp.first };
}

export interface BuildOptions {
  type: Exclude<PacketType, 'retry' | 'version-negotiation'>;
  version?: number;
  dcid: Uint8Array;
  scid?: Uint8Array;
  token?: Uint8Array;
  pn: number;
  pnLen: 1 | 2 | 3 | 4;
  payload: Uint8Array;
  keys: PacketKeys;
  keyPhase?: number;
  spin?: number;
  /** Set reserved bits (peers must treat that as PROTOCOL_VIOLATION) for negative tests. */
  reservedBits?: number;
}

/** Minimum payload so the header protection sample exists. */
export const minPayload = (pnLen: number) => Math.max(0, 4 - pnLen);

export function buildPacket(o: BuildOptions): Buffer {
  const w = new Writer(o.payload.length + 64);
  const pnBytes = Buffer.alloc(o.pnLen);
  pnBytes.writeUIntBE(o.pn % 2 ** (8 * o.pnLen), 0, o.pnLen);
  const res = (o.reservedBits ?? 0) & 3;
  if (o.type === '1rtt') {
    w.u8(0x40 | ((o.spin ?? 0) << 5) | (res << 3) | ((o.keyPhase ?? 0) << 2) | (o.pnLen - 1));
    w.bytes(o.dcid);
  } else {
    const t = LONG_TYPES.indexOf(o.type);
    w.u8(0xc0 | (t << 4) | (res << 2) | (o.pnLen - 1));
    w.u32(o.version ?? QUIC_V1);
    w.vec(1, o.dcid).vec(1, o.scid ?? Buffer.alloc(0));
    if (o.type === 'initial') w.vvec(o.token ?? Buffer.alloc(0));
    // Always a 2-byte length so the header size is known before sealing.
    w.varint(o.pnLen + o.payload.length + 16, 2);
  }
  const pnOffset = w.length;
  w.bytes(pnBytes);
  const header = w.finish();
  const sealed = o.keys.seal(o.pn, header, o.payload);
  const pkt = Buffer.concat([header, sealed]);
  const mask = o.keys.mask(pkt.subarray(pnOffset + 4, pnOffset + 20));
  pkt[0]! ^= mask[0]! & (o.type === '1rtt' ? 0x1f : 0x0f);
  for (let i = 0; i < o.pnLen; i++) pkt[pnOffset + i]! ^= mask[1 + i]!;
  return pkt;
}

/** Bytes of header and tag around a payload, for sizing packets. */
export function packetOverhead(type: BuildOptions['type'], dcidLen: number, scidLen: number, tokenLen: number, pnLen: number): number {
  if (type === '1rtt') return 1 + dcidLen + pnLen + 16;
  const tokenField = type === 'initial' ? (tokenLen < 64 ? 1 : tokenLen < 16384 ? 2 : 4) + tokenLen : 0;
  return 1 + 4 + 1 + dcidLen + 1 + scidLen + tokenField + 2 + pnLen + 16;
}

export function buildVersionNegotiation(dcid: Uint8Array, scid: Uint8Array, versions: number[]): Buffer {
  const w = new Writer().u8(0x80 | (Math.random() * 0x7f)).u32(0).vec(1, dcid).vec(1, scid);
  for (const v of versions) w.u32(v);
  return w.finish();
}

export function buildRetry(dcid: Uint8Array, scid: Uint8Array, token: Uint8Array, odcid: Uint8Array): Buffer {
  const w = new Writer().u8(0xf0).u32(QUIC_V1).vec(1, dcid).vec(1, scid).bytes(token);
  const body = w.finish();
  return Buffer.concat([body, retryTag(odcid, body)]);
}

export function verifyRetry(buf: Buffer, h: Header, odcid: Uint8Array): boolean {
  if (!h.retryTag) return false;
  const body = buf.subarray(h.start, h.end - 16);
  return retryTag(odcid, body).equals(h.retryTag);
}
