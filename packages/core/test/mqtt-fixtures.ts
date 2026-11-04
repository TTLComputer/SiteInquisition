// A tiny MQTT broker and client for the relay tests, built on the core's own
// codec. Wire-format correctness of that codec is checked separately against
// recorded vectors (mqttcodec.test.ts), so these only need to behave like a
// broker and a device.
import { EventEmitter } from 'node:events';
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { MqttParser, encodePacket, type ConnectPacket, type Packet, type PublishPacket, type QoS, type Subscription } from '../src/mqttcodec.js';

/** MQTT topic filter match, with + and # wildcards. */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

interface Session {
  sock: Socket;
  version: number;
  subs: Subscription[];
  nextId: number;
}

/** Accepts every client except username "blocked" (refused with code 4, "bad user name or password"). */
export function createBrokerHandler(): (sock: Socket) => void {
  const sessions = new Set<Session>();
  const retained = new Map<string, PublishPacket>();
  const deliver = (s: Session, pub: PublishPacket, qos: QoS, retain = false) => {
    const out: PublishPacket = { cmd: 'publish', topic: pub.topic, payload: pub.payload, qos, retain, dup: false, ...(pub.properties ? { properties: pub.properties } : {}) };
    if (qos) out.messageId = s.nextId = (s.nextId % 65_000) + 1;
    s.sock.write(encodePacket(out, s.version));
  };
  return (sock: Socket) => {
    const parser = new MqttParser();
    const s: Session = { sock, version: 4, subs: [], nextId: 0 };
    const send = (p: Packet) => sock.write(encodePacket(p, s.version));
    sock.on('error', () => undefined);
    sock.on('close', () => sessions.delete(s));
    sock.on('data', (chunk) => {
      let packets: Packet[];
      try {
        packets = parser.parse(chunk);
      } catch {
        return void sock.destroy();
      }
      for (const p of packets) {
        switch (p.cmd) {
          case 'connect': {
            const c = p as ConnectPacket;
            s.version = c.protocolVersion ?? 4;
            if (c.username === 'blocked') {
              send(s.version === 5 ? { cmd: 'connack', sessionPresent: false, reasonCode: 0x86 } : { cmd: 'connack', sessionPresent: false, returnCode: 4 });
              sock.end();
              return;
            }
            sessions.add(s);
            send({ cmd: 'connack', sessionPresent: false, returnCode: 0, reasonCode: 0 });
            break;
          }
          case 'subscribe': {
            const subs = p.subscriptions as Subscription[];
            s.subs.push(...subs);
            send({ cmd: 'suback', messageId: p.messageId, granted: subs.map((x) => Math.min(x.qos, 1)) });
            for (const sub of subs) for (const r of retained.values()) if (topicMatches(sub.topic, r.topic)) deliver(s, r, Math.min(sub.qos, r.qos, 1) as QoS, true);
            break;
          }
          case 'unsubscribe':
            s.subs = s.subs.filter((x) => !(p.unsubscriptions as string[]).includes(x.topic));
            send({ cmd: 'unsuback', messageId: p.messageId });
            break;
          case 'publish': {
            const pub = p as PublishPacket;
            if (pub.qos === 1) send({ cmd: 'puback', messageId: pub.messageId });
            if (pub.retain) retained.set(pub.topic, pub);
            for (const other of sessions) {
              const sub = other.subs.find((x) => topicMatches(x.topic, pub.topic));
              if (sub) deliver(other, pub, Math.min(sub.qos, pub.qos, 1) as QoS);
            }
            break;
          }
          case 'pingreq':
            send({ cmd: 'pingresp' });
            break;
          case 'disconnect':
            sock.end();
            break;
        }
      }
    });
  };
}

export const createBroker = (): Server => createServer(createBrokerHandler());

export interface ClientOptions {
  clientId?: string;
  username?: string;
  password?: string;
  protocolVersion?: 4 | 5;
  /** Connect with TLS, trusting this CA. */
  ca?: string;
  servername?: string;
}

/** A minimal MQTT client: connect, subscribe, publish (QoS 0 or 1) and receive. */
export class TestClient extends EventEmitter<{ message: [string, Buffer]; packet: [Packet] }> {
  private parser = new MqttParser();
  private nextId = 0;
  private waiting = new Map<string, (p: Packet) => void>();

  private constructor(
    private readonly sock: Socket,
    private readonly version: number,
  ) {
    super();
    sock.on('error', () => undefined);
    sock.on('data', (chunk) => {
      for (const p of this.parser.parse(chunk)) {
        this.emit('packet', p);
        if (p.cmd === 'publish') {
          const pub = p as PublishPacket;
          if (pub.qos === 1) this.send({ cmd: 'puback', messageId: pub.messageId });
          this.emit('message', pub.topic, pub.payload);
        }
        const key = p.messageId === undefined ? p.cmd : `${p.cmd}:${p.messageId}`;
        this.waiting.get(key)?.(p);
        this.waiting.delete(key);
      }
    });
  }

  static async connect(port: number, opts: ClientOptions = {}): Promise<TestClient> {
    const version = opts.protocolVersion ?? 4;
    const sock = opts.ca ? tlsConnect({ host: '127.0.0.1', port, ca: opts.ca, servername: opts.servername ?? 'localhost' }) : netConnect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      sock.once(opts.ca ? 'secureConnect' : 'connect', () => resolve());
      sock.once('error', reject);
    });
    const client = new TestClient(sock, version);
    client.parser.protocolVersion = version;
    const ack = client.expect('connack');
    client.send({
      cmd: 'connect',
      protocolId: 'MQTT',
      protocolVersion: version,
      clean: true,
      keepalive: 60,
      clientId: opts.clientId ?? `test-${Math.random().toString(16).slice(2, 8)}`,
      ...(opts.username !== undefined ? { username: opts.username } : {}),
      ...(opts.password !== undefined ? { password: Buffer.from(opts.password) } : {}),
    } as ConnectPacket);
    const connack = await Promise.race([
      ack,
      new Promise<never>((_, reject) => sock.once('close', () => reject(new Error('connection closed before CONNACK')))),
    ]);
    const code = (connack.reasonCode as number | undefined) ?? (connack.returnCode as number | undefined) ?? 0;
    if (code !== 0) {
      sock.destroy();
      throw new Error(`connection refused: code ${code}`);
    }
    return client;
  }

  private send(p: Packet): void {
    this.sock.write(encodePacket(p, this.version));
  }

  private expect(cmd: string, messageId?: number): Promise<Packet> {
    return new Promise((resolve) => this.waiting.set(messageId === undefined ? cmd : `${cmd}:${messageId}`, resolve));
  }

  private id(): number {
    return (this.nextId = (this.nextId % 60_000) + 1);
  }

  async subscribe(topic: string, qos: QoS = 0): Promise<void> {
    const messageId = this.id();
    const ack = this.expect('suback', messageId);
    this.send({ cmd: 'subscribe', messageId, subscriptions: [{ topic, qos }] });
    await ack;
  }

  async publish(topic: string, payload: string | Buffer, opts: { qos?: 0 | 1; retain?: boolean; properties?: PublishPacket['properties'] } = {}): Promise<void> {
    const qos = opts.qos ?? 0;
    const p: PublishPacket = { cmd: 'publish', topic, payload: Buffer.from(payload), qos, retain: !!opts.retain, dup: false, ...(opts.properties ? { properties: opts.properties } : {}) };
    if (qos) p.messageId = this.id();
    const ack = qos ? this.expect('puback', p.messageId) : undefined;
    this.send(p);
    await ack;
  }

  async end(): Promise<void> {
    this.send({ cmd: 'disconnect' });
    this.sock.end();
    if (!this.sock.closed) await new Promise((r) => this.sock.once('close', r));
  }
}
