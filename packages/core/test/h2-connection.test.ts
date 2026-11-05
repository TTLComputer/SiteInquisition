// The in-house HTTP/2 engine against node:http2 in both roles, and against itself.
import { connect as h2connect, createServer as createH2Server, type Http2Server } from 'node:http2';
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { H2Connection, collectResponse, type Field } from '../src/h2/connection.js';
import { H2Error, Setting } from '../src/h2/frames.js';

let node: Http2Server;
let nodePort: number;

/** Two connected in-memory duplex streams. */
function pair(): [Duplex, Duplex] {
  let a!: Duplex;
  let b!: Duplex;
  const mk = (other: () => Duplex) =>
    new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        setImmediate(() => other().push(chunk));
        cb();
      },
      final(cb) {
        setImmediate(() => other().push(null));
        cb();
      },
    });
  a = mk(() => b);
  b = mk(() => a);
  return [a, b];
}

const req = (path: string, method = 'GET', extra: Field[] = []): Field[] => [[':method', method], [':scheme', 'http'], [':authority', `localhost:${nodePort}`], [':path', path], ...extra];

function connectNode(opts: Partial<ConstructorParameters<typeof H2Connection>[1]> = {}): Promise<H2Connection> {
  return new Promise((resolve) => {
    const sock = netConnect(nodePort, '127.0.0.1', () => {
      const c = new H2Connection(sock, { role: 'client', ...opts });
      c.once('settings', () => resolve(c));
    });
  });
}

beforeAll(async () => {
  node = createH2Server();
  node.on('stream', (stream, headers) => {
    const path = String(headers[':path']);
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => {
      const body = Buffer.concat(chunks);
      if (path === '/reset') return stream.close(H2Error.REFUSED_STREAM);
      if (path === '/big') {
        stream.respond({ ':status': 200 });
        return stream.end(Buffer.alloc(300_000, 0x61));
      }
      stream.respond({ ':status': 200, 'content-type': 'application/json' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(JSON.stringify({ path, method: headers[':method'], size: body.length, te: headers.te ?? null, custom: headers['x-big'] ? String(headers['x-big']).length : 0 }));
    });
  });
  nodePort = await new Promise<number>((r) => node.listen(0, '127.0.0.1', () => r((node.address() as AddressInfo).port)));
});

afterAll(async () => {
  await new Promise((r) => node.close(r));
});

describe('HTTP/2 engine', () => {
  it('talks to node:http2 as a client: requests, bodies past the window, trailers, resets', async () => {
    const c = await connectNode();
    expect(c.peerSetting(Setting.MAX_FRAME_SIZE)).toBe(16_384);
    const a = collectResponse(c.request(req('/a', 'GET', [['te', 'trailers']]), { endStream: true }));
    const upload = c.request(req('/upload', 'POST'));
    upload.end(Buffer.alloc(200_000, 0x62));
    const b = collectResponse(upload);
    const big = collectResponse(c.request(req('/big'), { endStream: true }));
    const reset = collectResponse(c.request(req('/reset'), { endStream: true }));
    const ra = await a;
    expect(ra.status).toBe(200);
    expect(JSON.parse(ra.body.toString())).toMatchObject({ path: '/a', te: 'trailers' });
    expect(ra.trailers).toEqual([['grpc-status', '0']]);
    expect(JSON.parse((await b).body.toString()).size).toBe(200_000);
    expect((await big).body.length).toBe(300_000);
    expect((await reset).reset).toEqual({ code: H2Error.REFUSED_STREAM, by: 'remote' });
    expect(c.log.some((e) => e.dir === 'out' && e.type === 'WINDOW_UPDATE')).toBe(true);
    c.close();
  });

  it('splits a large header block into CONTINUATION frames that node reassembles', async () => {
    const c = await connectNode({ hpack: { huffman: false, dynamic: false } });
    const r = await collectResponse(c.request(req('/cont', 'GET', [['x-big', 'v'.repeat(5000)]]), { endStream: true, continuationSize: 1000 }));
    expect(JSON.parse(r.body.toString()).custom).toBe(5000);
    expect(c.log.filter((e) => e.dir === 'out' && e.type === 'CONTINUATION').length).toBeGreaterThan(3);
    c.close();
  });

  it('serves node:http2 clients as a server', async () => {
    const srv: Server = createNetServer((sock) => {
      const conn = new H2Connection(sock, { role: 'server' });
      conn.on('stream', (s, fields) => {
        const parts: Buffer[] = [];
        s.on('data', (d: Buffer) => parts.push(d));
        s.once('end', () => {
          s.sendHeaders([[':status', '201'], ['x-path', fields.find(([k]) => k === ':path')![1]]]);
          s.write(Buffer.concat(parts));
          s.sendHeaders([['grpc-status', '0']], { endStream: true });
        });
      });
    });
    const port = await new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as AddressInfo).port)));
    const client = h2connect(`http://127.0.0.1:${port}`);
    const res = await new Promise<{ status: number; path: string; body: string; trailers: Record<string, unknown> }>((resolve, reject) => {
      const r = client.request({ ':method': 'POST', ':path': '/echo' });
      let body = '';
      let status = 0;
      let path = '';
      r.on('response', (h) => ((status = Number(h[':status'])), (path = String(h['x-path']))));
      r.on('trailers', (t) => resolve({ status, path, body, trailers: t }));
      r.on('data', (d: Buffer) => (body += d.toString()));
      r.on('error', reject);
      r.end('x'.repeat(100_000));
    });
    client.close();
    srv.close();
    expect(res).toMatchObject({ status: 201, path: '/echo', trailers: { 'grpc-status': '0' } });
    expect(res.body.length).toBe(100_000);
  });

  it('holds credit on one stream while others finish, and refuses streams over the limit', async () => {
    const [a, b] = pair();
    const server = new H2Connection(b, { role: 'server', settings: { maxConcurrentStreams: 2, initialWindowSize: 1000 } });
    server.on('stream', (s, fields) => {
      const path = fields.find(([k]) => k === ':path')![1];
      if (path === '/held') s.holdCredit(true);
      let n = 0;
      s.on('data', (d: Buffer) => (n += d.length));
      s.once('end', () => {
        s.sendHeaders([[':status', '200']]);
        s.end(Buffer.from(String(n)));
      });
    });
    const client = new H2Connection(a, { role: 'client' });
    await new Promise((r) => client.once('settings', r));
    const held = client.request(req('/held', 'POST'));
    held.end(Buffer.alloc(3000));
    const quick = client.request(req('/quick', 'POST'));
    const third = collectResponse(client.request(req('/third'), { endStream: true }));
    quick.end(Buffer.alloc(500));
    expect((await collectResponse(quick)).body.toString()).toBe('500');
    expect((await third).reset).toEqual({ code: H2Error.REFUSED_STREAM, by: 'remote' });
    // The held stream got exactly its first window and is waiting for credit.
    expect(held.queued).toBe(2000);
    server.stream(1)!.holdCredit(false);
    expect((await collectResponse(held)).body.toString()).toBe('3000');
    client.close();
  });

  it('answers malformed input: stream errors with RST_STREAM, connection errors with GOAWAY', async () => {
    const [a, b] = pair();
    const server = new H2Connection(b, { role: 'server' });
    server.on('stream', () => undefined);
    const client = new H2Connection(a, { role: 'client' });
    await new Promise((r) => client.once('settings', r));
    const bad = collectResponse(client.request([[':method', 'GET'], [':path', '/'], [':scheme', 'http'], ['Upper', 'x']], { endStream: true }));
    expect((await bad).reset).toEqual({ code: H2Error.PROTOCOL_ERROR, by: 'remote' });
    const goaway = new Promise<{ code: number }>((r) => client.once('goaway', r));
    client.writeFrame({ type: 'DATA', stream: 99, data: Buffer.from('x'), endStream: false });
    expect((await goaway).code).toBe(H2Error.PROTOCOL_ERROR);
  });
});
