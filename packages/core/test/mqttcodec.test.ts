import { describe, expect, it } from '@siteinquisition/devkit/test';
import { MqttError, MqttParser, encodePacket, type Packet } from '../src/mqttcodec.js';
import { VECTORS } from './mqtt-vectors.js';

/** Same normal form the vectors were written in: Buffers as hex, keys sorted, nulls dropped. */
const norm = (o: unknown): unknown =>
  JSON.parse(
    JSON.stringify(o, function (this: Record<string, unknown>, k, v) {
      const raw = this[k];
      if (Buffer.isBuffer(raw)) return { hex: raw.toString('hex') };
      if (v === null) return undefined;
      if (v && typeof v === 'object' && !Array.isArray(v) && !('hex' in v)) return Object.fromEntries(Object.entries(v).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
      return v;
    }),
  );

const label = (x: (typeof VECTORS)[number]) => `v${x.v} ${String(x.packet.cmd)} ${x.hex.slice(0, 24)}`;

describe('MQTT codec', () => {
  it.each(VECTORS.map((x) => [label(x), x] as const))('decodes and re-encodes %s', (_name, x) => {
    const bytes = Buffer.from(x.hex, 'hex');
    const [packet, ...more] = new MqttParser(x.v).parse(bytes);
    expect(more).toEqual([]);
    expect(norm(packet)).toEqual(x.packet);
    expect(encodePacket(packet!, x.v).toString('hex')).toBe(x.hex);
  });

  it('parses packets split across chunks at every byte and several packets in one chunk', () => {
    const v4 = VECTORS.filter((x) => x.v === 4 && x.packet.cmd !== 'connect');
    const all = Buffer.concat(v4.map((x) => Buffer.from(x.hex, 'hex')));
    const parser = new MqttParser(4);
    const got: Packet[] = [];
    for (const b of all) got.push(...parser.parse(Buffer.of(b)));
    expect(parser.pending).toBe(0);
    expect(got.map((p) => norm(p))).toEqual(v4.map((x) => x.packet));
    expect(new MqttParser(4).parse(all)).toHaveLength(v4.length);
  });

  it('reports a half-received packet as pending', () => {
    const parser = new MqttParser(4);
    const bytes = Buffer.from(VECTORS.find((x) => x.packet.cmd === 'publish')!.hex, 'hex');
    expect(parser.parse(bytes.subarray(0, 5))).toEqual([]);
    expect(parser.pending).toBe(5);
    expect(parser.parse(bytes.subarray(5))).toHaveLength(1);
    expect(parser.pending).toBe(0);
  });

  it('takes the protocol version from CONNECT', () => {
    const connect = VECTORS.find((x) => x.v === 5 && x.packet.cmd === 'connect')!;
    const parser = new MqttParser();
    parser.parse(Buffer.from(connect.hex, 'hex'));
    expect(parser.protocolVersion).toBe(5);
  });

  it('rejects malformed input', () => {
    const bad = (hex: string, v = 4) => () => new MqttParser(v).parse(Buffer.from(hex, 'hex'));
    expect(bad('0000')).toThrow(MqttError); // reserved type 0
    expect(bad('8000')).toThrow(/header flags/); // SUBSCRIBE needs flags 0010
    expect(bad('36020000')).toThrow(/QoS/); // both QoS bits
    expect(bad('30ffffffff7f')).toThrow(/remaining length/);
    expect(bad('3003000261')).toThrow(/too short/); // topic length 2 but the packet ends after 1
    expect(bad('100c00045858585804020000000178')).toThrow(/protocol id/);
    expect(bad('f000')).toThrow(/MQTT 5/);
    expect(bad('82050001000100')).toThrow(/too short|unexpected/);
  });
});
