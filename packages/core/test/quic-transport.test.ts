import * as dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connection } from '../src/quic/connection.js';
import { QuicClient, QuicServer } from '../src/quic/endpoint.js';
import type { SessionTicket } from '../src/quic/tls.js';
import { generateCA, LeafIssuer } from '../src/x509.js';

const ca = generateCA({ commonName: 'QUIC test CA' });
const issuer = new LeafIssuer(ca);

/** Echo server: each bidi stream gets its data back, upper-cased, when the client finishes. */
function echoServer(extra: Partial<ConstructorParameters<typeof QuicServer>[0]> = {}) {
  const server = new QuicServer({
    tls: {
      cert: (sni) => {
        const l = issuer.issue(sni || 'localhost');
        return { cert: l.cert, key: l.key };
      },
      alpn: ['echo'],
      ticketKey: randomBytes(32),
      acceptEarlyData: true,
    },
    ...extra,
  });
  const conns: Connection[] = [];
  server.on('connection', (conn: Connection) => {
    conns.push(conn);
    const bufs = new Map<number, Buffer[]>();
    conn.ev.data = (id, data, fin) => {
      const list = bufs.get(id) ?? [];
      list.push(data);
      bufs.set(id, list);
      if (fin) conn.write(id, Buffer.from(Buffer.concat(list).toString().toUpperCase()), true);
    };
    conn.ev.datagram = (d) => conn.sendDatagram(Buffer.concat([Buffer.from('echo:'), d]));
  });
  return { server, conns };
}

async function request(c: QuicClient, body: Buffer | string): Promise<string> {
  const id = c.conn.openStream(true)!;
  expect(id).not.toBeNull();
  const out: Buffer[] = [];
  const done = new Promise<string>((resolve) => {
    const prev = c.conn.ev.data;
    c.conn.ev.data = (sid, data, fin) => {
      if (sid !== id) return prev?.(sid, data, fin);
      out.push(data);
      if (fin) resolve(Buffer.concat(out).toString());
    };
  });
  c.conn.write(id, Buffer.from(body), true);
  return done;
}

/** A UDP relay between client and server that drops a share of datagrams. */
async function lossyRelay(target: number, dropEvery: number) {
  const sock = dgram.createSocket('udp4');
  let client: { address: string; port: number } | undefined;
  let n = 0;
  sock.on('message', (msg, r) => {
    const fromServer = r.port === target;
    if (!fromServer) client = { address: r.address, port: r.port };
    if (++n % dropEvery === 0) return;
    if (fromServer && client) sock.send(msg, client.port, client.address);
    else if (!fromServer) sock.send(msg, target, '127.0.0.1');
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  return { port: sock.address().port, close: () => sock.close() };
}

describe('QUIC transport over loopback', () => {
  const { server, conns } = echoServer();
  let port = 0;
  beforeAll(async () => {
    port = (await server.listen(0)).port;
  });
  afterAll(() => server.close());

  const connect = async (o: Partial<Parameters<typeof QuicClient.connect>[0]> = {}) => {
    const c = await QuicClient.connect({ host: '127.0.0.1', port, serverName: 'localhost', alpn: ['echo'], tls: { ca: [ca.cert] }, ...o });
    if (!o.earlyData) await c.ready;
    return c;
  };

  it('handshakes and echoes on several streams at once', async () => {
    const c = await connect();
    expect(c.conn.tls.alpn).toBe('echo');
    const replies = await Promise.all(['one', 'two', 'three'].map((s) => request(c, s)));
    expect(replies).toEqual(['ONE', 'TWO', 'THREE']);
    c.close();
  });

  it('moves a large body through flow control windows', async () => {
    const c = await connect({ params: { initialMaxStreamDataBidiLocal: 16_384, initialMaxData: 32_768 } });
    const big = 'x'.repeat(300_000);
    expect(await request(c, big)).toBe(big.toUpperCase());
    c.close();
  });

  it('survives packet loss', async () => {
    const relay = await lossyRelay(port, 5);
    try {
      const c = await QuicClient.connect({ host: '127.0.0.1', port: relay.port, serverName: 'localhost', alpn: ['echo'], tls: { ca: [ca.cert] } });
      await c.ready;
      const big = 'y'.repeat(100_000);
      expect(await request(c, big)).toBe(big.toUpperCase());
      c.close();
    } finally {
      relay.close();
    }
  });

  it('migrates to a new local port mid-connection', async () => {
    const c = await connect();
    expect(await request(c, 'before')).toBe('BEFORE');
    const validated = new Promise<void>((r) => (c.conn.ev.pathValidated = () => r()));
    const { from, to } = await c.rebind(true);
    expect(to).not.toBe(from);
    await validated;
    expect(await request(c, 'after')).toBe('AFTER');
    const sc = conns.find((x) => x.path.port === to);
    expect(sc).toBeDefined();
    c.close();
  });

  it('sends datagrams', async () => {
    const c = await connect();
    const got = new Promise<string>((r) => (c.conn.ev.datagram = (d) => r(d.toString())));
    expect(c.conn.sendDatagram(Buffer.from('hi'))).toBe(true);
    expect(await got).toBe('echo:hi');
    c.close();
  });

  it('resumes and sends 0-RTT', async () => {
    const tickets: SessionTicket[] = [];
    const c = await connect({ ...{}, earlyData: false });
    c.conn.ev.ticket = (t) => tickets.push(t);
    await request(c, 'warm');
    await new Promise((r) => setTimeout(r, 50));
    c.close();
    expect(tickets.length).toBeGreaterThan(0);

    const c2 = await QuicClient.connect({ host: '127.0.0.1', port, serverName: 'localhost', alpn: ['echo'], tls: { ca: [ca.cert] }, session: tickets[0], earlyData: true });
    expect(c2.conn.earlyDataAvailable).toBe(true);
    const reply = request(c2, 'early');
    await c2.ready;
    expect(await reply).toBe('EARLY');
    expect(c2.conn.tls.earlyDataAccepted).toBe(true);
    expect(c2.conn.log.some((e) => e.dir === 'out' && e.type === '0rtt')).toBe(true);
    c2.close();
  });

  it('resets a stream and reports it to the peer', async () => {
    const c = await connect();
    const id = c.conn.openStream(true)!;
    const sc = await new Promise<Connection>((r) => setTimeout(() => r(conns.at(-1)!), 20));
    const got = new Promise<[number, number]>((r) => (sc.ev.reset = (sid, code) => r([sid, code])));
    c.conn.write(id, Buffer.from('partial'));
    await new Promise((r) => setTimeout(r, 20));
    c.conn.resetStream(id, 0x10c);
    expect(await got).toEqual([id, 0x10c]);
    c.close();
  });
});

describe('QUIC Retry', () => {
  it('validates the address with a Retry first', async () => {
    const { server } = echoServer({ retry: true });
    const { port } = await server.listen(0);
    try {
      const c = await QuicClient.connect({ host: '127.0.0.1', port, serverName: 'localhost', alpn: ['echo'], tls: { ca: [ca.cert] } });
      await c.ready;
      expect(await request(c, 'retried')).toBe('RETRIED');
      c.close();
    } finally {
      await server.close();
    }
  });
});
