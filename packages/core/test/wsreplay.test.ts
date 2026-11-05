import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { Core } from '@siteinquisition/core';
import { connectWebSocket, serveWebSockets, type WsConnection } from '../src/websocket.js';
import { extractFromMessage, mapJsonPart, scriptFromMessages, waitMatches, type WsScript } from '../src/wsscript.js';
import { tunnel } from './proxy-client.js';

describe('replay script helpers', () => {
  it('finds the JSON inside Socket.IO and SignalR framing', () => {
    const up = (j: string) => j.toUpperCase();
    expect(mapJsonPart('42["chat",{"t":"hi"}]', up)).toBe('42["CHAT",{"T":"HI"}]');
    expect(mapJsonPart('42/admin,7["x"]', up)).toBe('42/admin,7["X"]');
    expect(mapJsonPart('0{"sid":"a"}', up)).toBe('0{"SID":"A"}');
    expect(mapJsonPart('{"type":1}\x1e{"type":6}\x1e', up)).toBe('{"TYPE":1}\x1e{"TYPE":6}\x1e');
    expect(mapJsonPart('{"a":1}', up)).toBe('{"A":1}');
    expect(mapJsonPart('hello', up)).toBeNull();
    expect(mapJsonPart('2', up)).toBeNull();
  });

  it('extracts values by JSONPath (through framing) or regex, and matches waits', () => {
    expect(extractFromMessage('$.token', '{"token":"abc"}')).toBe('abc');
    expect(extractFromMessage('$[1].sid', '42["welcome",{"sid":"s-9"}]')).toBe('s-9');
    expect(extractFromMessage('$.n', '{"n":{"a":1}}')).toBe('{"a":1}');
    expect(extractFromMessage('/id=(\\d+)/', 'user id=42 ok')).toBe('42');
    expect(extractFromMessage('$.nope', '{"a":1}')).toBeUndefined();
    expect(waitMatches('', 'x')).toBe(true);
    expect(waitMatches('Welcome', 'welcome!')).toBe(true);
    expect(waitMatches('/^ok \\d+$/', 'ok 12')).toBe(true);
    expect(waitMatches('/^ok \\d+$/', 'not ok')).toBe(false);
  });

  it('writes a recorded conversation out as sends and waits, without heartbeats', () => {
    const m = (direction: 'client' | 'server', text: string, at: number, opcode = 'text') => ({ id: String(at), direction, opcode, payload: Buffer.from(text), at, meta: null });
    const script = scriptFromMessages(
      'ws://x/socket.io/?EIO=4',
      [['Origin', 'https://x']],
      [m('server', '0{"sid":"a"}', 0), m('client', '40', 10), m('server', '40{"sid":"b"}', 20), m('server', '2', 30), m('client', '3', 31), m('client', '42["hi"]', 500), m('client', 'bye', 600, 'close')],
      { waits: true, timing: true },
    );
    expect(script.steps).toEqual([
      { kind: 'wait', count: 1, timeoutMs: 10_000, note: 'last was 0{"sid":"a"}' },
      { kind: 'send', opcode: 'text', payload: '40' },
      { kind: 'wait', count: 1, timeoutMs: 10_000, note: 'last was 40{"sid":"b"}' },
      { kind: 'send', opcode: 'text', payload: '42["hi"]', delayMs: 490 },
      { kind: 'close', code: Buffer.from('bye').readUInt16BE(0) },
    ]);
  });
});

let tmp: string;
let core: Core;
let target: Server;
let port: number;
let proxyPort: number;
/** What the server received, in order. */
const seen: Array<{ data: string; fragments: number }> = [];
let wsClients: Set<WsConnection>;

async function until<T>(fn: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'siq-wsr-'));
  target = createServer();
  ({ clients: wsClients } = serveWebSockets(target, (ws, req) => {
    ws.send(`hello ${req.headers.cookie ?? 'no-cookie'}`);
    ws.on('message', (d, _bin, info) => {
      const text = d.toString();
      seen.push({ data: text, fragments: info.fragments });
      if (text === 'login') setTimeout(() => ws.send(JSON.stringify({ token: `tok-${seen.length}` })), 30);
      else if (text === 'ping-me') ws.send('2');
      else if (text !== '3') ws.send(`echo:${text}`);
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
const texts = (exchangeId: string, dir: 'client' | 'server') =>
  messagesOf(exchangeId)
    .filter((m) => m.direction === dir && m.opcode === 'text')
    .map((m) => Buffer.from(m.payload).toString());
const finished = async (exchangeId: string) => until(() => (core.tools.ws.runState(exchangeId)?.running === false ? core.tools.ws.runState(exchangeId) : undefined), 'the script to finish');

describe('WebSocket replay scripts', () => {
  it('fills tokens, waits for the server, saves a value and uses it in a later message', async () => {
    core.tools.vars.set('room', 'lobby');
    seen.length = 0;
    const script: WsScript = {
      url: `ws://127.0.0.1:${port}/chat`,
      headers: [['Cookie', 'sid={{var:room}}']],
      steps: [
        { kind: 'wait', match: 'hello' },
        { kind: 'send', opcode: 'text', payload: 'login' },
        { kind: 'wait', match: 'token', extract: { var: 'wsToken', from: '$.token' } },
        { kind: 'send', opcode: 'text', payload: 'join {{var:room}} as {{var:wsToken}}' },
        { kind: 'send', opcode: 'text', payload: 'n{{counter:1..3}}' },
        { kind: 'send', opcode: 'text', payload: 'skipped', enabled: false },
        { kind: 'close', code: 4000, reason: 'done' },
      ],
    };
    const { exchangeId } = await core.tools.ws.run(script, {});
    const state = (await finished(exchangeId))!;
    expect(state.error).toBeUndefined();
    expect(state.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'skipped', 'done']);
    expect(state.steps[4]!.sent).toBe(3);
    expect(state.vars.wsToken).toBe('tok-1');
    expect(core.tools.vars.values().wsToken).toBe('tok-1');
    // The script is done once its frames are written; the server may still be reading the last ones.
    await until(() => (seen.length >= 5 ? true : undefined), 'the server to read every message');
    expect(seen.map((s) => s.data)).toEqual(['login', 'join lobby as tok-1', 'n1', 'n2', 'n3']);
    // The handshake had its token filled in too, and is recorded as a replay.
    expect(texts(exchangeId, 'server')[0]).toBe('hello sid=lobby');
    expect(core.store.getSummary(exchangeId)!.source).toBe('replay');
    await until(() => !core.tools.ws.isOpen(exchangeId) || undefined, 'the close');
  });

  it('stops at a wait that times out when told to, and reports it', async () => {
    const { exchangeId } = await core.tools.ws.run(
      { url: `ws://127.0.0.1:${port}/t`, headers: [], steps: [{ kind: 'wait', match: 'never', timeoutMs: 100, onTimeout: 'stop' }, { kind: 'send', opcode: 'text', payload: 'x' }] },
      { closeAtEnd: true },
    );
    const state = (await finished(exchangeId))!;
    expect(state.steps.map((s) => s.status)).toEqual(['timeout', 'skipped']);
    expect(state.error).toBe('step 1 timed out');
  });

  it('encodes JSON fields inside Socket.IO framing, then the encode chain', async () => {
    seen.length = 0;
    const { exchangeId } = await core.tools.ws.run(
      { url: `ws://127.0.0.1:${port}/f`, headers: [], steps: [{ kind: 'send', opcode: 'text', payload: '42["save",{"blob":{"a":1}}]' }] },
      { fields: [{ path: '$[1].blob', chain: ['base64', 'json'] }], closeAtEnd: true },
    );
    await finished(exchangeId);
    await until(() => seen[0], 'the message');
    expect(seen[0]!.data).toBe(`42["save",{"blob":"${Buffer.from('{"a":1}').toString('base64')}"}]`);
  });

  it('answers Engine.IO pings on its own and keeps them out of waits', async () => {
    seen.length = 0;
    const { exchangeId } = await core.tools.ws.run(
      { url: `ws://127.0.0.1:${port}/socket.io/?EIO=4`, headers: [], steps: [{ kind: 'wait' }, { kind: 'send', opcode: 'text', payload: 'ping-me' }, { kind: 'send', opcode: 'text', payload: 'after' }, { kind: 'wait', match: 'echo:after' }] },
      { closeAtEnd: true },
    );
    const state = (await finished(exchangeId))!;
    expect(state.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(seen.map((s) => s.data)).toContain('3');
    const auto = messagesOf(exchangeId).find((m) => (m.meta as { auto?: string } | null)?.auto);
    expect(auto?.meta).toMatchObject({ auto: 'Engine.IO pong' });
  });

  it('writes a captured connection out as a script and sends it again with edits', async () => {
    const { exchangeId: first } = await core.tools.ws.connect({ url: `ws://127.0.0.1:${port}/orig`, headers: [['X-Test', 'yes']] });
    core.tools.ws.send(first, Buffer.from('alpha'), 'text');
    await until(() => texts(first, 'server').includes('echo:alpha') || undefined, 'echo');
    core.tools.ws.send(first, Buffer.from('beta'), 'text');
    await until(() => texts(first, 'server').includes('echo:beta') || undefined, 'echo');
    core.tools.ws.close(first);
    await until(() => !core.tools.ws.isOpen(first) || undefined, 'close');

    const script = core.tools.ws.scriptFor(first, { waits: true });
    expect(script.headers).toEqual([['X-Test', 'yes']]);
    expect(script.steps.map((s) => s.kind)).toEqual(['wait', 'send', 'wait', 'send', 'close']);
    const send = script.steps[3] as Extract<WsScript['steps'][number], { kind: 'send' }>;
    send.payload = 'BETA';
    send.preset = 'fragment';
    send.presetOptions = { parts: 2 };
    seen.length = 0;
    const { exchangeId } = await core.tools.ws.run(script, { replayOf: first });
    await finished(exchangeId);
    expect(seen.map((s) => [s.data, s.fragments])).toEqual([
      ['alpha', 1],
      ['BETA', 2],
    ]);
    expect(core.store.getSummary(exchangeId)!.replayOf).toBe(first);
  });

  it('runs more steps on an open replay connection', async () => {
    const { exchangeId } = await core.tools.ws.run({ url: `ws://127.0.0.1:${port}/more`, headers: [], steps: [] }, {});
    await finished(exchangeId);
    core.tools.vars.set('who', 'nick');
    const state = await core.tools.ws.runMore(exchangeId, [
      { kind: 'send', opcode: 'text', payload: 'hi {{var:who}}' },
      { kind: 'wait', match: 'echo:hi' },
    ]);
    expect(state.steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(texts(exchangeId, 'server')).toContain('echo:hi nick');
    core.tools.ws.close(exchangeId);
  });
});

describe('WebSocket message breakpoints', () => {
  it('pauses messages through the proxy for forwarding, editing or dropping, and stops when the breakpoint goes', async () => {
    core.tools.setBreakpoints([{ phase: 'messages', host: '127.0.0.1', pathPrefix: '/held', direction: 'client', match: 'secret' }]);
    const got: string[] = [];
    const { ws: client } = await connectWebSocket(`ws://127.0.0.1:${port}/held`, { createConnection: () => tunnel(`http://127.0.0.1:${proxyPort}`, '127.0.0.1', port) });
    client.on('message', (d) => got.push(d.toString()));
    await until(() => got[0], 'hello');
    seen.length = 0;

    // Not matching: straight through, still fragmented as sent.
    client.sendFrame({ opcode: 'text', payload: Buffer.from('pla'), fin: false });
    client.sendFrame({ opcode: 'continuation', payload: Buffer.from('in') });
    await until(() => seen.find((s) => s.data === 'plain'), 'the plain message');
    expect(seen[0]!.fragments).toBe(2);

    // Matching: held until resolved, and later messages wait behind it.
    client.send('my secret one');
    client.send('next');
    const p1 = await until(() => core.tools.intercept.list()[0], 'the pause');
    expect(p1).toMatchObject({ phase: 'message', ws: { direction: 'client', opcode: 'text' } });
    expect(Buffer.from(p1.message.bodyBase64, 'base64').toString()).toBe('my secret one');
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.map((s) => s.data)).toEqual(['plain']);
    core.tools.intercept.resolve(p1.id, { action: 'forward', edits: { bodyBase64: Buffer.from('my edited one').toString('base64') } });
    await until(() => seen.find((s) => s.data === 'next'), 'the message behind it');
    expect(seen.map((s) => s.data)).toEqual(['plain', 'my edited one', 'next']);

    client.send('secret two');
    const p2 = await until(() => core.tools.intercept.list()[0], 'the second pause');
    core.tools.intercept.resolve(p2.id, { action: 'drop' });
    client.send('after drop');
    await until(() => seen.find((s) => s.data === 'after drop'), 'the next message');
    expect(seen.map((s) => s.data)).not.toContain('secret two');

    const ex = core.store.search('ws:true path:/held')[0]!;
    const rec = messagesOf(ex.id).filter((m) => m.direction === 'client');
    const edited = rec.find((m) => (m.meta as { edited?: boolean } | null)?.edited);
    expect(Buffer.from(edited!.payload).toString()).toBe('my edited one');
    expect(Buffer.from((edited!.meta as { originalBase64: string }).originalBase64, 'base64').toString()).toBe('my secret one');
    expect(rec.find((m) => (m.meta as { dropped?: boolean } | null)?.dropped)).toBeDefined();

    // Without the breakpoint, messages flow again with no pause.
    core.tools.setBreakpoints([]);
    client.send('secret three');
    await until(() => seen.find((s) => s.data === 'secret three'), 'the unpaused message');
    expect(core.tools.intercept.list()).toHaveLength(0);
    client.close(1000);
  });
});
