/**
 * A small MQTT 3.1, 3.1.1 and 5.0 packet codec: enough to record both
 * directions of a relayed session and to inject publishes into it. Decoded
 * packets use the field names of the common `mqtt-packet` library (cmd,
 * messageId, subscriptions, granted, properties...), which is also the shape
 * stored as stream message metadata.
 */

export type QoS = 0 | 1 | 2;
export type PacketCmd =
  | 'connect'
  | 'connack'
  | 'publish'
  | 'puback'
  | 'pubrec'
  | 'pubrel'
  | 'pubcomp'
  | 'subscribe'
  | 'suback'
  | 'unsubscribe'
  | 'unsuback'
  | 'pingreq'
  | 'pingresp'
  | 'disconnect'
  | 'auth';

export type UserProperties = Record<string, string | string[]>;
export type Properties = Record<string, unknown> & { userProperties?: UserProperties };

export interface Packet {
  cmd: PacketCmd;
  retain?: boolean;
  qos?: QoS;
  dup?: boolean;
  /** Remaining length, set by the parser. */
  length?: number;
  messageId?: number;
  properties?: Properties;
  reasonCode?: number;
  [key: string]: unknown;
}

export interface ConnectPacket extends Packet {
  cmd: 'connect';
  protocolId?: 'MQTT' | 'MQIsdp';
  protocolVersion?: 3 | 4 | 5;
  bridgeMode?: boolean;
  clean?: boolean;
  keepalive?: number;
  clientId: string;
  username?: string;
  password?: Buffer;
  will?: { topic: string; payload: Buffer; qos?: QoS; retain?: boolean; properties?: Properties };
}

export interface PublishPacket extends Packet {
  cmd: 'publish';
  topic: string;
  payload: Buffer;
  qos: QoS;
  retain: boolean;
  dup: boolean;
}

export interface ConnackPacket extends Packet {
  cmd: 'connack';
  sessionPresent: boolean;
  returnCode?: number;
}

export interface Subscription {
  topic: string;
  qos: QoS;
  nl?: boolean;
  rap?: boolean;
  rh?: number;
}

const TYPES: Array<PacketCmd | undefined> = [
  undefined,
  'connect',
  'connack',
  'publish',
  'puback',
  'pubrec',
  'pubrel',
  'pubcomp',
  'subscribe',
  'suback',
  'unsubscribe',
  'unsuback',
  'pingreq',
  'pingresp',
  'disconnect',
  'auth',
];
const CODES = Object.fromEntries(TYPES.map((t, i) => [t, i])) as Record<PacketCmd, number>;

/** Fixed header flags the spec requires for each packet type (publish carries its own). */
const REQUIRED_FLAGS: Partial<Record<PacketCmd, number>> = { pubrel: 2, subscribe: 2, unsubscribe: 2 };

type PropType = 'byte' | 'int8' | 'int16' | 'int32' | 'var' | 'string' | 'pair' | 'binary';
const PROPS: Array<[number, string, PropType]> = [
  [1, 'payloadFormatIndicator', 'byte'],
  [2, 'messageExpiryInterval', 'int32'],
  [3, 'contentType', 'string'],
  [8, 'responseTopic', 'string'],
  [9, 'correlationData', 'binary'],
  [11, 'subscriptionIdentifier', 'var'],
  [17, 'sessionExpiryInterval', 'int32'],
  [18, 'assignedClientIdentifier', 'string'],
  [19, 'serverKeepAlive', 'int16'],
  [21, 'authenticationMethod', 'string'],
  [22, 'authenticationData', 'binary'],
  [23, 'requestProblemInformation', 'byte'],
  [24, 'willDelayInterval', 'int32'],
  [25, 'requestResponseInformation', 'byte'],
  [26, 'responseInformation', 'string'],
  [28, 'serverReference', 'string'],
  [31, 'reasonString', 'string'],
  [33, 'receiveMaximum', 'int16'],
  [34, 'topicAliasMaximum', 'int16'],
  [35, 'topicAlias', 'int16'],
  [36, 'maximumQoS', 'int8'],
  [37, 'retainAvailable', 'byte'],
  [38, 'userProperties', 'pair'],
  [39, 'maximumPacketSize', 'int32'],
  [40, 'wildcardSubscriptionAvailable', 'byte'],
  [41, 'subscriptionIdentifiersAvailable', 'byte'],
  [42, 'sharedSubscriptionAvailable', 'byte'],
];
const PROP_BY_ID = new Map(PROPS.map(([id, name, type]) => [id, { name, type }]));
const PROP_BY_NAME = new Map(PROPS.map(([id, name, type]) => [name, { id, type }]));

export class MqttError extends Error {}

/** Reads one packet body. Every read checks bounds so a short packet fails cleanly. */
class Reader {
  pos = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new MqttError('packet too short');
  }

  byte(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  varint(): number {
    let value = 0;
    for (let i = 0, mul = 1; i < 4; i++, mul *= 128) {
      const b = this.byte();
      value += (b & 0x7f) * mul;
      if (!(b & 0x80)) return value;
    }
    throw new MqttError('invalid variable byte integer');
  }

  bytes(): Buffer {
    const n = this.u16();
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  string(): string {
    return this.bytes().toString('utf8');
  }

  rest(): Buffer {
    const out = this.buf.subarray(this.pos);
    this.pos = this.buf.length;
    return out;
  }

  properties(): Properties | undefined {
    const len = this.varint();
    this.need(len);
    const end = this.pos + len;
    const out: Properties = {};
    while (this.pos < end) {
      const id = this.byte();
      const prop = PROP_BY_ID.get(id);
      if (!prop) throw new MqttError(`unknown property ${id}`);
      if (prop.type === 'pair') {
        const k = this.string();
        const v = this.string();
        const up = (out.userProperties ??= Object.create(null) as UserProperties);
        const cur = up[k];
        up[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
        continue;
      }
      const v = this.prop(prop.type);
      const cur = out[prop.name];
      out[prop.name] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
    }
    if (this.pos !== end) throw new MqttError('malformed properties');
    return Object.keys(out).length ? out : undefined;
  }

  private prop(type: PropType): unknown {
    switch (type) {
      case 'byte':
        return this.byte() !== 0;
      case 'int8':
        return this.byte();
      case 'int16':
        return this.u16();
      case 'int32':
        return this.u32();
      case 'var':
        return this.varint();
      case 'string':
        return this.string();
      case 'binary':
        return Buffer.from(this.bytes());
      default:
        throw new MqttError('bad property type');
    }
  }
}

function decodeBody(cmd: PacketCmd, flags: number, body: Buffer, version: number): Packet {
  const r = new Reader(body);
  const v5 = version === 5;
  const p: Packet = { cmd, retain: (flags & 1) !== 0, qos: ((flags >> 1) & 3) as QoS, dup: (flags & 8) !== 0, length: body.length };
  if (((flags >> 1) & 3) === 3) throw new MqttError('packet must not have both QoS bits set');
  const required = REQUIRED_FLAGS[cmd];
  if (cmd !== 'publish' && flags !== (required ?? 0)) throw new MqttError(`invalid header flags for ${cmd}`);
  const setProps = () => {
    const props = r.properties();
    if (props) p.properties = props;
  };
  switch (cmd) {
    case 'connect': {
      const c = p as ConnectPacket;
      const protocolId = r.string();
      if (protocolId !== 'MQTT' && protocolId !== 'MQIsdp') throw new MqttError('invalid protocol id');
      c.protocolId = protocolId;
      let pv = r.byte();
      if (pv >= 128) {
        c.bridgeMode = true;
        pv -= 128;
      }
      if (pv !== 3 && pv !== 4 && pv !== 5) throw new MqttError('invalid protocol version');
      c.protocolVersion = pv;
      const f = r.byte();
      if (f & 1) throw new MqttError('connect flag bit 0 must be 0');
      const hasWill = (f & 0x04) !== 0;
      const willQos = ((f >> 3) & 3) as QoS;
      const willRetain = (f & 0x20) !== 0;
      if (!hasWill && (willQos || willRetain)) throw new MqttError('will QoS and retain must be 0 without a will');
      c.clean = (f & 0x02) !== 0;
      c.keepalive = r.u16();
      if (pv === 5) setProps();
      c.clientId = r.string();
      if (hasWill) {
        const props = pv === 5 ? r.properties() : undefined;
        c.will = { retain: willRetain, qos: willQos, ...(props ? { properties: props } : {}), topic: r.string(), payload: Buffer.from(r.bytes()) };
      }
      if (f & 0x80) c.username = r.string();
      if (f & 0x40) c.password = Buffer.from(r.bytes());
      break;
    }
    case 'connack': {
      const c = p as ConnackPacket;
      const f = r.byte();
      if (f > 1) throw new MqttError('invalid connack flags');
      c.sessionPresent = (f & 1) !== 0;
      if (v5) {
        c.reasonCode = r.remaining ? r.byte() : 0;
        if (r.remaining) setProps();
      } else c.returnCode = r.byte();
      break;
    }
    case 'publish': {
      p.topic = r.string();
      if (p.qos) p.messageId = r.u16();
      if (v5) setProps();
      p.payload = Buffer.from(r.rest());
      break;
    }
    case 'puback':
    case 'pubrec':
    case 'pubrel':
    case 'pubcomp': {
      p.messageId = r.u16();
      if (v5) {
        p.reasonCode = r.remaining ? r.byte() : 0;
        if (r.remaining) setProps();
      }
      break;
    }
    case 'subscribe': {
      p.messageId = r.u16();
      if (v5) setProps();
      if (!r.remaining) throw new MqttError('subscribe without topics');
      const subs: Subscription[] = [];
      while (r.remaining) {
        const topic = r.string();
        const o = r.byte();
        if (o & (v5 ? 0xc0 : 0xfc)) throw new MqttError('invalid subscribe option bits');
        const qos = (o & 3) as QoS;
        if (qos > 2) throw new MqttError('invalid subscribe QoS');
        const sub: Subscription = { topic, qos };
        if (v5) {
          sub.nl = (o & 0x04) !== 0;
          sub.rap = (o & 0x08) !== 0;
          sub.rh = (o >> 4) & 3;
          if (sub.rh > 2) throw new MqttError('invalid retain handling');
        }
        subs.push(sub);
      }
      p.subscriptions = subs;
      break;
    }
    case 'suback':
    case 'unsuback': {
      p.messageId = r.u16();
      if (v5) setProps();
      if (cmd === 'suback' || v5) {
        const granted: number[] = [];
        while (r.remaining) granted.push(r.byte());
        p.granted = granted;
      }
      break;
    }
    case 'unsubscribe': {
      p.messageId = r.u16();
      if (v5) setProps();
      if (!r.remaining) throw new MqttError('unsubscribe without topics');
      const topics: string[] = [];
      while (r.remaining) topics.push(r.string());
      p.unsubscriptions = topics;
      break;
    }
    case 'disconnect':
    case 'auth': {
      if (cmd === 'auth' && !v5) throw new MqttError('AUTH needs MQTT 5');
      if (v5) {
        p.reasonCode = r.remaining ? r.byte() : 0;
        if (r.remaining) setProps();
      }
      break;
    }
    case 'pingreq':
    case 'pingresp':
      break;
  }
  if (r.remaining) throw new MqttError(`${r.remaining} unexpected bytes after ${cmd}`);
  return p;
}

/**
 * Incremental parser for one direction of a connection. Feed it chunks as they
 * arrive; it returns whole packets. A CONNECT sets the protocol version for
 * this parser; set `protocolVersion` on the other direction's parser yourself.
 */
export class MqttParser {
  private buf = Buffer.alloc(0);

  constructor(public protocolVersion = 4) {}

  /** Bytes of a packet received only in part. */
  get pending(): number {
    return this.buf.length;
  }

  parse(chunk: Uint8Array): Packet[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out: Packet[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let len = 0;
      let i = 1;
      for (let mul = 1; ; mul *= 128, i++) {
        if (i > 4) throw new MqttError('invalid remaining length');
        if (i >= this.buf.length) return out;
        const b = this.buf[i]!;
        len += (b & 0x7f) * mul;
        if (!(b & 0x80)) break;
      }
      const start = i + 1;
      if (this.buf.length < start + len) break;
      const cmd = TYPES[this.buf[0]! >> 4];
      if (!cmd) throw new MqttError('reserved packet type 0');
      const packet = decodeBody(cmd, this.buf[0]! & 0x0f, this.buf.subarray(start, start + len), this.protocolVersion);
      if (cmd === 'connect') this.protocolVersion = (packet as ConnectPacket).protocolVersion!;
      this.buf = this.buf.subarray(start + len);
      out.push(packet);
    }
    return out;
  }
}

class Writer {
  private parts: Buffer[] = [];

  byte(n: number): this {
    this.parts.push(Buffer.of(n));
    return this;
  }

  u16(n: number): this {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n);
    this.parts.push(b);
    return this;
  }

  u32(n: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    this.parts.push(b);
    return this;
  }

  raw(b: Uint8Array): this {
    this.parts.push(Buffer.from(b));
    return this;
  }

  bytes(b: Uint8Array | string): this {
    const buf = typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b);
    if (buf.length > 0xffff) throw new MqttError('string or binary field over 65535 bytes');
    return this.u16(buf.length).raw(buf);
  }

  properties(props: Properties | undefined): this {
    const w = new Writer();
    for (const [name, value] of Object.entries(props ?? {})) {
      if (value === undefined) continue;
      const prop = PROP_BY_NAME.get(name);
      if (!prop) throw new MqttError(`unknown property ${name}`);
      if (prop.type === 'pair') {
        for (const [k, v] of Object.entries(value as UserProperties)) for (const one of Array.isArray(v) ? v : [v]) w.byte(prop.id).bytes(k).bytes(String(one));
        continue;
      }
      for (const one of Array.isArray(value) ? value : [value]) {
        w.byte(prop.id);
        switch (prop.type) {
          case 'byte':
            w.byte(one ? 1 : 0);
            break;
          case 'int8':
            w.byte(one as number);
            break;
          case 'int16':
            w.u16(one as number);
            break;
          case 'int32':
            w.u32(one as number);
            break;
          case 'var':
            w.raw(varint(one as number));
            break;
          case 'string':
          case 'binary':
            w.bytes(one as string | Buffer);
            break;
        }
      }
    }
    const body = w.done();
    return this.raw(varint(body.length)).raw(body);
  }

  done(): Buffer {
    return Buffer.concat(this.parts);
  }
}

function varint(n: number): Buffer {
  if (n < 0 || n > 268_435_455) throw new MqttError('variable byte integer out of range');
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

/** Encode a packet for the given protocol version (4 = MQTT 3.1.1). */
export function encodePacket(p: Packet, version = 4): Buffer {
  const v5 = version === 5;
  const w = new Writer();
  let flags = REQUIRED_FLAGS[p.cmd] ?? 0;
  const reasonAndProps = (always = false) => {
    if (!v5) return;
    // A zero reason code with no properties may be left out entirely (MQTT 5, 3.4.2.1).
    const hasProps = !!p.properties && Object.keys(p.properties).length > 0;
    if (always || hasProps || (p.reasonCode ?? 0) !== 0) w.byte(p.reasonCode ?? 0).properties(p.properties);
  };
  switch (p.cmd) {
    case 'connect': {
      const c = p as ConnectPacket;
      const pv = c.protocolVersion ?? 4;
      w.bytes(c.protocolId ?? (pv === 3 ? 'MQIsdp' : 'MQTT')).byte(pv + (c.bridgeMode ? 128 : 0));
      let f = 0;
      if (c.username !== undefined) f |= 0x80;
      if (c.password !== undefined) f |= 0x40;
      if (c.will) f |= 0x04 | ((c.will.qos ?? 0) << 3) | (c.will.retain ? 0x20 : 0);
      if (c.clean ?? true) f |= 0x02;
      w.byte(f).u16(c.keepalive ?? 0);
      if (pv === 5) w.properties(c.properties);
      w.bytes(c.clientId ?? '');
      if (c.will) {
        if (pv === 5) w.properties(c.will.properties);
        w.bytes(c.will.topic).bytes(c.will.payload);
      }
      if (c.username !== undefined) w.bytes(c.username);
      if (c.password !== undefined) w.bytes(c.password);
      break;
    }
    case 'connack': {
      const c = p as ConnackPacket;
      w.byte(c.sessionPresent ? 1 : 0);
      if (v5) {
        w.byte(c.reasonCode ?? 0);
        w.properties(c.properties);
      } else w.byte(c.returnCode ?? c.reasonCode ?? 0);
      break;
    }
    case 'publish': {
      const pub = p as PublishPacket;
      flags = (pub.dup ? 8 : 0) | ((pub.qos ?? 0) << 1) | (pub.retain ? 1 : 0);
      w.bytes(pub.topic);
      if (pub.qos) w.u16(pub.messageId ?? 0);
      if (v5) w.properties(pub.properties);
      w.raw(typeof pub.payload === 'string' ? Buffer.from(pub.payload) : (pub.payload ?? Buffer.alloc(0)));
      break;
    }
    case 'puback':
    case 'pubrec':
    case 'pubrel':
    case 'pubcomp':
      w.u16(p.messageId ?? 0);
      reasonAndProps();
      break;
    case 'subscribe': {
      w.u16(p.messageId ?? 0);
      if (v5) w.properties(p.properties);
      for (const s of p.subscriptions as Subscription[]) {
        let o = s.qos ?? 0;
        if (v5) o |= (s.nl ? 0x04 : 0) | (s.rap ? 0x08 : 0) | ((s.rh ?? 0) << 4);
        w.bytes(s.topic).byte(o);
      }
      break;
    }
    case 'suback':
    case 'unsuback':
      w.u16(p.messageId ?? 0);
      if (v5) w.properties(p.properties);
      if (p.cmd === 'suback' || v5) for (const g of (p.granted as number[] | undefined) ?? []) w.byte(g);
      break;
    case 'unsubscribe':
      w.u16(p.messageId ?? 0);
      if (v5) w.properties(p.properties);
      for (const t of p.unsubscriptions as string[]) w.bytes(t);
      break;
    case 'disconnect':
    case 'auth':
      reasonAndProps(true);
      break;
    case 'pingreq':
    case 'pingresp':
      break;
  }
  const body = w.done();
  return Buffer.concat([Buffer.of((CODES[p.cmd] << 4) | flags), varint(body.length), body]);
}
