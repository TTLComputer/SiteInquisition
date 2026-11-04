import { describe, expect, it } from '@siteinquisition/devkit/test';
import { Reader, Writer } from '../src/quic/bytes.js';
import { initialKeys, PacketKeys, SUITES } from '../src/quic/keys.js';
import { buildPacket, decodePacketNumber, openPacket, parseHeader } from '../src/quic/packet.js';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('QUIC varints', () => {
  it('round-trips the RFC 9000 examples', () => {
    const cases: Array<[string, number]> = [
      ['c2197c5eff14e88c', 151288809941952652],
      ['9d7f3e7d', 494878333],
      ['7bbd', 15293],
      ['25', 37],
    ];
    for (const [h, v] of cases) {
      expect(new Reader(hex(h)).varint()).toBe(v);
      if (v < 2 ** 53) expect(new Writer().varint(v).finish().toString('hex')).toBe(h);
    }
    expect(new Reader(hex('4025')).varint()).toBe(37);
  });

  it('decodes truncated packet numbers (RFC 9000 A.3)', () => {
    expect(decodePacketNumber(0xa82f30ea, 0x9b32, 16)).toBe(0xa82f9b32);
  });
});

describe('QUIC packet protection (RFC 9001 appendix A)', () => {
  const dcid = hex('8394c8f03e515708');

  it('derives the Initial keys', () => {
    const { client, server } = initialKeys(dcid);
    expect(client.secret.toString('hex')).toBe('c00cf151ca5be075ed0ebfb5c80323c42d6b7db67881289af4008f1f6c357aea');
    expect(client.key.toString('hex')).toBe('1f369613dd76d5467730efcbe3b1a22d');
    expect(client.iv.toString('hex')).toBe('fa044b2f42a3fd3b46fb255c');
    expect(client.hp.toString('hex')).toBe('9f50449e04a0e810283a1e9933adedd2');
    expect(server.secret.toString('hex')).toBe('3c199828fd139efd216c155ad844cc81fb82fa8d7446fa7d78be803acdda951b');
    expect(server.key.toString('hex')).toBe('cf3a5331653c364c88f0f379b6067e37');
    expect(server.iv.toString('hex')).toBe('0ac1493ca1905853b0bba03e');
    expect(server.hp.toString('hex')).toBe('c206b8d9b9f0f37644430b490eeaa314');
  });

  it('protects the server Initial', () => {
    const { server } = initialKeys(dcid);
    const payload = hex(
      '02000000000600405a020000560303eefce7f7b37ba1d1632e96677825ddf73988cfc79825df566dc5430b9a045a1200130100002e00330024001d00209d3c940d89690b84d08a60993c144eca684d1081287c834d5311bcf32bb9da1a002b00020304',
    );
    const pkt = buildPacket({ type: 'initial', dcid: Buffer.alloc(0), scid: hex('f067a5502a4262b5'), pn: 1, pnLen: 2, payload, keys: server });
    expect(pkt.toString('hex')).toBe(
      'cf000000010008f067a5502a4262b5004075c0d95a482cd0991cd25b0aac406a5816b6394100f37a1c69797554780bb38cc5a99f5ede4cf73c3ec2493a1839b3dbcba3f6ea46c5b7684df3548e7ddeb9c3bf9c73cc3f3bded74b562bfb19fb84022f8ef4cdd93795d77d06edbb7aaf2f58891850abbdca3d20398c276456cbc42158407dd074ee',
    );
    const h = parseHeader(pkt, 0, 0);
    const opened = openPacket(pkt, h, server, -1);
    expect(opened?.pn).toBe(1);
    expect(opened?.payload.equals(payload)).toBe(true);
  });

  it('protects a ChaCha20-Poly1305 short header packet', () => {
    const keys = new PacketKeys(SUITES[0x1303]!, hex('9ac312a7f877468ebe69422748ad00a15443f18203a07d6060f688f30f21632b'));
    expect(keys.key.toString('hex')).toBe('c6d98ff3441c3fe1b2182094f69caa2ed4b716b65488960a7a984979fb23e1c8');
    expect(keys.iv.toString('hex')).toBe('e0459b3474bdd0e44a41c144');
    expect(keys.hp.toString('hex')).toBe('25a282b9e82f06f21f488917a4fc8f1b73573685608597d0efcb076b0ab7a7a4');
    expect(keys.next().secret.toString('hex')).toBe('1223504755036d556342ee9361d253421a826c9ecdf3c7148684b36b714881f9');
    const pkt = buildPacket({ type: '1rtt', dcid: Buffer.alloc(0), pn: 654360564, pnLen: 3, payload: hex('01'), keys });
    expect(pkt.toString('hex')).toBe('4cfe4189655e5cd55c41f69080575d7999c25a5bfb');
    const opened = openPacket(pkt, parseHeader(pkt, 0, 0), keys, 654360563);
    expect(opened?.pn).toBe(654360564);
    expect(opened?.payload.toString('hex')).toBe('01');
  });
});
