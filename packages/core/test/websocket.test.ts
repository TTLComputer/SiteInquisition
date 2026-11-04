import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Core, type ExchangeSummary } from '@siteinquisition/core';
import { FrameParser, MessageAssembler, connectWebSocket, encodeFrame, frameViolations, serveWebSockets, type WsConnection } from '../src/websocket.js';
import { PRESETS, buildPlan, type PlanStep } from '../src/wsplan.js';
import { tunnel } from './proxy-client.js';

describe('frame codec', () => {
  it('round-trips frames with every field set, masked or not', () => {
    for (const len of [0, 5, 125, 126, 65_535, 65_536]) {
      for (const mask of [true, false]) {
        const payload = Buffer.alloc(len, 0x61);
        const bytes = encodeFrame({ opcode: 'binary', payload, fin: false, rsv2: true, mask }, false);
        const [f] = new FrameParser().push(bytes);
        expect(f).toMatchObject({ fin: false, rsv1: false, rsv2: true, rsv3: false, opcode: 2, masked: mask });
        expect(f!.payload.equals(payload)).toBe(true);
      }
    }
  });

  it('writes frames a correct implementation would not, and the parser names the problems', () => {
    const p = new FrameParser();
    const frames = p.push(
      Buffer.concat([
        encodeFrame({ opcode: 'text', payload: Buffer.from('hi'), lengthField: 64 }, true),
        encodeFrame({ opcode: 3, payload: Buffer.from('x'), rsv1: true }, false),
        encodeFrame({ opcode: 'ping', payload: Buffer.alloc(126), fin: false }, true),
        encodeFrame({ opcode: 'close', payload: Buffer.of(0x03, 0xed) }, true),
      ]),
    );
    expect(frames.map((f) => frameViolations(f, 'client', false))).toEqual([
      ['non-minimal length'],
      ['unmasked client frame', 'reserved bits set', 'reserved opcode 3'],
      ['control frame over 125 bytes', 'fragmented control frame'],
      ['invalid close code 1005'],
    ]);
  });

  it('can lie about the length and cut frames short', () => {
    const lie = encodeFrame({ opcode: 'text', payload: Buffer.from('abc'), declaredLength: 10, mask: false }, false);
    expect([...lie.subarray(0, 2)]).toEqual([0x81, 10]);
    const p = new FrameParser();
    expect(p.push(lie)).toEqual([]);
    expect(p.pending).toBe(5);
    expect(encodeFrame({ opcode: 'text', payload: Buffer.from('abcdef'), truncateTo: 4 }, true)).toHaveLength(4);
  });

  it('assembles fragments and keeps control frames separate', () => {
    const asm = new MessageAssembler('client');
    const p = new FrameParser();
    const out = p
      .push(Buffer.concat(buildPlan('ping-between', { payload: Buffer.from('hello world'), opcode: 'text' }).map((s) => encodeFrame({ ...(s as never), payload: Buffer.from((s as { payload: string }).payload, 'base64') }, true))))
      .map((f) => asm.push(f))
      .filter(Boolean);
    expect(out.map((m) => [m!.opcode, m!.payload.toString(), m!.fragments])).toEqual([
      ['ping', 'mid-message', 1],
      ['text', 'hello world', 2],
    ]);
  });
});

describe('frame presets', () => {
  it('builds every preset', () => {
    for (const p of PRESETS) expect(buildPlan(p.id, { payload: Buffer.from('héllo, server'), opcode: 'text' }).length, p.id).toBeGreaterThan(0);
  });

  it('splits inside a multi-byte character', () => {
    const [a, b] = buildPlan('split-utf8', { payload: Buffer.from('héllo'), opcode: 'text' }) as Array<Extract<PlanStep, { kind: 'frame' }>>;
    expect([...Buffer.from(a!.payload, 'base64')]).toEqual([0x68, 0xc3]);
    expect(Buffer.from(b!.payload, 'base64').toString('latin1')).toBe('©llo');
    expect([a!.fin, b!.opcode, b!.fin]).toEqual([false, 'continuation', true]);
  });
});

let tmp: string;
let core: Core;
let target: Server;
let port: number;
let proxyPort: number;
/** What the server saw, per connection: messages with their fragment counts and protocol problems. */
const seen: Array<{ data: string; fragments: number; violations: string[] }> = [];
let lastServer: WsConnection | undefined;
let wsClients: Set<WsConnection>;

async function until<T>(fn: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-ws-'));
  target = createServer();
  ({ clients: wsClients } = serveWebSockets(target, (ws, req) => {
    lastServer = ws;
    ws.send(`hello ${req.headers.origin ?? 'no-origin'}`);
    ws.on('frame', (f, v) => {
      if (v.length) seen.push({ data: `frame:${f.opcode}`, fragments: 1, violations: v });
    });
    ws.on('message', (d, _bin, info) => {
      seen.push({ data: d.toString(), fragments: info.fragments, violations: info.violations });
      ws.send(`echo:${d.toString()}`);
    });
  }));
  port = await new Promise<number>((r) => target.listen(0, '127.0.0.1', () => r((target.address() as AddressInfo).port)));
  core = await Core.open({ projectDir: join(tmp, 'p'), dataDir: join(tmp, 'd'), api: false });
  await core.setScope({ defaultAction: 'ignore', rules: [{ action: 'include', host: '127.0.0.1' }] });
  ({ proxyPort } = await core.start());
});

afterAll(async () => {
  await core?.close();
  for (const c of wsClients ?? []) c.terminate();
  target?.closeAllConnections();
  await new Promise((r) => target?.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

const messagesOf = (exchangeId: string) => core.store.getStreamMessages(core.store.getStreamForExchange(exchangeId)!.id);

describe('WebSocket replay with frame plans', () => {
  it('sends fragmented and malformed frames and records what went out and what came back', async () => {
    const { exchangeId } = await core.tools.ws.connect({ url: `ws://127.0.0.1:${port}/plan`, headers: [['Origin', 'https://evil.example']] });
    seen.length = 0;
    await core.tools.ws.sendPlan(exchangeId, buildPlan('fragment', { payload: Buffer.from('abcdefghi'), opcode: 'text' }, { parts: 3 }));
    await until(() => seen.find((s) => s.data === 'abcdefghi'), 'the reassembled message');
    expect(seen.find((s) => s.data === 'abcdefghi')).toMatchObject({ fragments: 3, violations: [] });

    await core.tools.ws.sendPlan(exchangeId, buildPlan('unmasked', { payload: Buffer.from('plain'), opcode: 'text' }));
    await until(() => seen.find((s) => s.violations.includes('unmasked client frame')), 'the unmasked frame');

    const msgs = await until(() => {
      const m = messagesOf(exchangeId);
      return m.filter((x) => x.direction === 'server').length >= 3 ? m : undefined;
    }, 'server replies');
    // The handshake carried the edited Origin, and each sent step is recorded with its frame details.
    expect(Buffer.from(msgs[0]!.payload).toString()).toBe('hello https://evil.example');
    const sent = msgs.filter((m) => m.direction === 'client');
    expect(sent.slice(0, 3).map((m) => [m.opcode, (m.meta as { frame: { fin: boolean } }).frame.fin])).toEqual([
      ['text', false],
      ['continuation', false],
      ['continuation', true],
    ]);
    expect(sent[3]!.meta).toMatchObject({ injected: true, frame: { masked: false } });
    core.tools.ws.close(exchangeId);
  });

  it('replays a captured session on a new connection', async () => {
    const { exchangeId } = await core.tools.ws.connect({ url: `ws://127.0.0.1:${port}/session`, headers: [] });
    core.tools.ws.send(exchangeId, Buffer.from('one'), 'text');
    core.tools.ws.send(exchangeId, Buffer.from('two'), 'text');
    await until(() => messagesOf(exchangeId).filter((m) => m.direction === 'server').length >= 3 || undefined, 'echoes');
    core.tools.ws.close(exchangeId);
    seen.length = 0;
    const r = await core.tools.ws.replaySession(exchangeId, { preset: 'fragment', presetOptions: { parts: 2 } });
    expect(r.sent).toBe(2);
    await until(() => seen.filter((s) => s.data === 'one' || s.data === 'two').length === 2 || undefined, 'both replayed messages');
    expect(seen.map((s) => [s.data, s.fragments])).toEqual([
      ['one', 2],
      ['two', 2],
    ]);
    expect(core.store.getSummary(r.exchangeId)!.replayOf).toBe(exchangeId);
  });
});

describe('WebSockets through the proxy', () => {
  let ex: ExchangeSummary;
  let client: WsConnection;
  const got: string[] = [];

  it('passes fragmented frames through untouched', async () => {
    ({ ws: client } = await connectWebSocket(`ws://127.0.0.1:${port}/live`, { createConnection: () => tunnel(`http://127.0.0.1:${proxyPort}`, '127.0.0.1', port) }));
    client.on('message', (d) => got.push(d.toString()));
    seen.length = 0;
    client.sendFrame({ opcode: 'text', payload: Buffer.from('frag'), fin: false });
    client.sendFrame({ opcode: 'continuation', payload: Buffer.from('mented') });
    await until(() => seen.find((s) => s.data === 'fragmented'), 'the message at the server');
    expect(seen.find((s) => s.data === 'fragmented')!.fragments).toBe(2);
    ex = await until(() => core.store.search('ws:true path:/live').find((e) => e.state !== 'pending'), 'the exchange');
    const msgs = await until(() => {
      const m = messagesOf(ex.id).filter((x) => x.direction === 'client' && x.opcode === 'text');
      return m.length ? m : undefined;
    }, 'the recorded message');
    expect(msgs[0]!.meta).toMatchObject({ fragments: 2 });
  });

  it('injects frames into a live relayed connection in either direction', async () => {
    expect(core.tools.liveStreams().wsProxied).toContain(ex.id);
    seen.length = 0;
    await core.proxy.injectWebSocket(ex.id, 'server', buildPlan('fragment', { payload: Buffer.from('as-the-client'), opcode: 'text' }, { parts: 2 }));
    await until(() => seen.find((s) => s.data === 'as-the-client'), 'injected message at the server');
    await core.proxy.injectWebSocket(ex.id, 'client', [{ kind: 'frame', opcode: 'text', payload: Buffer.from('as-the-server').toString('base64') }]);
    await until(() => got.includes('as-the-server') || undefined, 'injected message at the client');
    const injected = messagesOf(ex.id).filter((m) => (m.meta as { injected?: boolean } | null)?.injected);
    expect(injected.map((m) => [m.direction, m.opcode])).toEqual([
      ['client', 'text'],
      ['client', 'continuation'],
      ['server', 'text'],
    ]);
    client.close(1000);
    await until(() => !core.tools.liveStreams().wsProxied.includes(ex.id) || undefined, 'the relay to close');
    expect(lastServer).toBeDefined();
  });
});
