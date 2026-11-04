import type { Server } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateCACertificate } from 'mockttp';
import { Core, type ExchangeSummary } from '@siteinquisition/core';
import { TestClient, createBroker, createBrokerHandler } from './mqtt-fixtures.js';

let tmp: string;
let core: Core;
let plainBroker: Server;
let tlsBroker: Server;
let plainPort: number;
let tlsPort: number;
let v5Broker: Server;
let v5Port: number;

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

async function waitFor(query: string, pred: (e: ExchangeSummary) => boolean = (e) => e.state !== 'pending'): Promise<ExchangeSummary> {
  for (let i = 0; i < 100; i++) {
    const hit = core.store.search(query).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for "${query}"`);
}

const messages = (exchangeId: string) => core.store.getStreamMessages(core.store.getStreamForExchange(exchangeId)!.id);

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-mqtt-'));
  plainBroker = createBroker();
  plainPort = await listen(plainBroker);
  const cert = await generateCACertificate({ subject: { commonName: 'localhost' } });
  tlsBroker = createTlsServer({ key: cert.key, cert: cert.cert }, createBrokerHandler()) as unknown as Server;
  tlsPort = await listen(tlsBroker);
  v5Broker = createBroker();
  v5Port = await listen(v5Broker);

  core = await Core.open({
    projectDir: join(tmp, 'p'),
    dataDir: join(tmp, 'd'),
    api: false,
    proxy: { port: 0 },
    mqtt: [
      { port: 0, upstreamHost: '127.0.0.1', upstreamPort: plainPort },
      { port: 0, upstreamHost: 'localhost', upstreamPort: tlsPort, upstreamTls: true, ignoreUpstreamTlsErrors: true, listenTls: true },
      { port: 0, upstreamHost: '127.0.0.1', upstreamPort: v5Port },
    ],
  });
  await core.setScope({ defaultAction: 'ignore', rules: [{ action: 'include', host: '127.0.0.1' }, { action: 'include', host: 'localhost' }] });
  await core.start();
});

afterAll(async () => {
  await core?.close();
  await new Promise((r) => plainBroker?.close(r));
  await new Promise((r) => tlsBroker?.close(r));
  await new Promise((r) => v5Broker?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe('MQTT relay', () => {
  it('relays a session and records every packet with topic, QoS and payload', async () => {
    const client = await TestClient.connect(core.mqtt[0]!.port, { clientId: 'sensor-1', username: 'dev', password: 'pw' });
    await client.subscribe('sensors/#', 1);
    const got = new Promise<[string, string]>((r) => client.once('message', (t, p) => r([t, p.toString()])));
    await client.publish('sensors/temp', JSON.stringify({ c: 21.5 }), { qos: 1, retain: true });
    expect(await got).toEqual(['sensors/temp', '{"c":21.5}']);
    await client.end();

    const ex = await waitFor(`method:CONNECT url:127.0.0.1:${plainPort}`);
    const full = core.store.getExchange(ex.id)!;
    expect(full).toMatchObject({ url: `mqtt://127.0.0.1:${plainPort}/`, state: 'complete', httpVersion: 'MQTT/3.1.1', port: plainPort });
    expect(full.requestHeaders).toEqual(expect.arrayContaining([['client-id', 'sensor-1'], ['username', 'dev']]));

    let msgs = messages(ex.id);
    for (let i = 0; i < 50 && !msgs.some((m) => m.opcode === 'disconnect'); i++) {
      await new Promise((r) => setTimeout(r, 20));
      msgs = messages(ex.id);
    }
    const seq = msgs.map((m) => `${m.direction}:${m.opcode}`);
    expect(seq.slice(0, 4)).toEqual(['client:connect', 'server:connack', 'client:subscribe', 'server:suback']);
    expect(seq).toEqual(expect.arrayContaining(['client:publish', 'server:puback', 'server:publish', 'client:puback', 'client:disconnect']));
    const pub = msgs.find((m) => m.direction === 'client' && m.opcode === 'publish')!;
    expect(pub.meta).toMatchObject({ topic: 'sensors/temp', qos: 1, retain: true });
    expect(Buffer.from(pub.payload).toString()).toBe('{"c":21.5}');
    expect(msgs[2]!.meta).toMatchObject({ subscriptions: [{ topic: 'sensors/#', qos: 1 }] });
    expect(core.store.getStreamForExchange(ex.id)!.closedAt).not.toBeNull();
  });

  it('terminates TLS from devices with the project CA and speaks TLS to the broker', async () => {
    const client = await TestClient.connect(core.mqtt[1]!.port, { ca: core.ca.cert, servername: 'localhost', clientId: 'tls-dev' });
    await client.publish('a/b', 'hi', { qos: 1 });
    await client.end();
    const ex = await waitFor('scheme:mqtts');
    expect(ex).toMatchObject({ host: 'localhost', state: 'complete', port: tlsPort });
    let msgs = messages(ex.id);
    for (let i = 0; i < 50 && !msgs.some((m) => m.opcode === 'puback'); i++) {
      await new Promise((r) => setTimeout(r, 20));
      msgs = messages(ex.id);
    }
    expect(msgs.find((m) => m.opcode === 'publish')!.meta).toMatchObject({ topic: 'a/b', qos: 1 });
  });

  it('parses MQTT 5 sessions, including properties', async () => {
    const client = await TestClient.connect(core.mqtt[2]!.port, { protocolVersion: 5, clientId: 'v5' });
    await client.publish('v5/topic', 'hello', { qos: 0, properties: { contentType: 'text/plain', userProperties: { trace: 'abc' } } });
    await client.end();
    const ex = await waitFor(`method:CONNECT url:127.0.0.1:${v5Port}`);
    expect(core.store.getExchange(ex.id)!.httpVersion).toBe('MQTT/5.0');
    let msgs = messages(ex.id);
    for (let i = 0; i < 50 && !msgs.some((m) => m.opcode === 'publish'); i++) {
      await new Promise((r) => setTimeout(r, 20));
      msgs = messages(ex.id);
    }
    expect(msgs.find((m) => m.opcode === 'publish')!.meta).toMatchObject({
      topic: 'v5/topic',
      properties: { contentType: 'text/plain', userProperties: { trace: 'abc' } },
    });
  });

  it('marks refused sessions as errors', async () => {
    await expect(TestClient.connect(core.mqtt[0]!.port, { username: 'blocked' })).rejects.toThrow();
    const ex = await waitFor('method:CONNECT state:error');
    expect(core.store.getExchange(ex.id)!.error).toMatch(/CONNACK refused with code 4/);
  });

  it('relays but does not record brokers outside scope', async () => {
    await core.setScope({ defaultAction: 'ignore', rules: [{ action: 'include', host: 'localhost' }] });
    const before = core.store.search('scheme:mqtt').length;
    expect(before).toBeGreaterThan(0);
    const client = await TestClient.connect(core.mqtt[0]!.port);
    await client.publish('x', 'y');
    await client.end();
    await new Promise((r) => setTimeout(r, 100));
    expect(core.store.search('scheme:mqtt').length).toBe(before);
  });

  it('publishes into a live session in either direction', async () => {
    await core.setScope({ defaultAction: 'ignore', rules: [{ action: 'include', host: '127.0.0.1' }] });
    const client = await TestClient.connect(core.mqtt[0]!.port, { clientId: 'inject-me' });
    await client.subscribe('cmd/#', 0);
    let id: string | undefined;
    for (let i = 0; i < 100 && !id; i++) {
      id = core.tools.liveStreams().mqtt.find((x) => core.store.getExchange(x)?.requestHeaders.some(([k, v]) => k === 'client-id' && v === 'inject-me'));
      if (!id) await new Promise((r) => setTimeout(r, 20));
    }
    expect(id).toBeTruthy();
    const got = new Promise<[string, string]>((r) => client.once('message', (t, p) => r([t, p.toString()])));
    expect(core.tools.mqttPublish(id!, { to: 'device', topic: 'cmd/reboot', payload: Buffer.from('now') })).toBe(true);
    expect(await got).toEqual(['cmd/reboot', 'now']);
    // To the broker as the device: the broker routes it back to this subscriber.
    const echoed = new Promise<[string, string]>((r) => client.once('message', (t, p) => r([t, p.toString()])));
    expect(core.tools.mqttPublish(id!, { to: 'broker', topic: 'cmd/echo', payload: Buffer.from('as-device') })).toBe(true);
    expect(await echoed).toEqual(['cmd/echo', 'as-device']);
    const injected = messages(id!).filter((m) => (m.meta as { injected?: boolean } | null)?.injected);
    expect(injected.map((m) => [m.direction, (m.meta as { topic: string }).topic])).toEqual([
      ['server', 'cmd/reboot'],
      ['client', 'cmd/echo'],
    ]);
    await client.end();
  });
});
