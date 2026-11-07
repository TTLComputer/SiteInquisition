import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { CaptureStore, classifyWsMessage, coverage, endpointKind, referenceKind, wsApiMap } from '@siteinquisition/core';

const dir = mkdtempSync(join(tmpdir(), 'siq-explore-'));
const store = CaptureStore.openProject(dir);
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (method: string, url: string, contentType: string, ws = false, respHeaders: Array<[string, string]> = []) => {
  const e = store.addRequest({ source: 'proxy', startedAt: Date.now(), method, url, httpVersion: '1.1', headers: [], isWebSocket: ws });
  store.completeResponse(e.id, { status: ws ? 101 : 200, headers: [...(contentType ? ([['Content-Type', contentType]] as Array<[string, string]>) : []), ...respHeaders] });
  return e.id;
};

describe('endpoint kinds', () => {
  it('tells API endpoints from pages, files and WebSockets', () => {
    expect(endpointKind('GET', '/api/users', ['application/json'])).toBe('api');
    expect(endpointKind('POST', '/upload.png', ['image/png'])).toBe('api');
    expect(endpointKind('GET', '/static/app.js', ['application/javascript'])).toBe('file');
    expect(endpointKind('GET', '/api/v1/bundle.js', ['text/javascript'])).toBe('file');
    expect(endpointKind('GET', '/logo', ['image/svg+xml'])).toBe('file');
    expect(endpointKind('GET', '/fonts/a.woff2', [])).toBe('file');
    expect(endpointKind('GET', '/data/report.json', ['text/plain'])).toBe('api');
    expect(endpointKind('GET', '/about', ['text/html; charset=utf-8'])).toBe('page');
    expect(endpointKind('GET', '/feed', ['application/xml'])).toBe('api');
    expect(endpointKind('GET', '/chat', [], true)).toBe('websocket');
    expect(referenceKind('/img/hero.webp')).toBe('file');
    expect(referenceKind('/api/orders')).toBe('endpoint');
  });

  it('labels each endpoint in the coverage report', () => {
    add('GET', 'http://k.test/api/items', 'application/json');
    add('GET', 'http://k.test/main.css', 'text/css');
    add('GET', 'http://k.test/', 'text/html');
    add('GET', 'http://k.test/socket', '', true);
    const kinds = Object.fromEntries(coverage(store, 'k.test').endpoints.map((e) => [e.template, e.kind]));
    expect(kinds).toMatchObject({ '/api/items': 'api', '/main.css': 'file', '/': 'page', '/socket': 'websocket' });
  });
});

describe('site tree', () => {
  it('nests every path segment, with counts and WebSocket marks', () => {
    add('GET', 'http://t.test/api/v1/users?page=1', 'application/json');
    add('GET', 'http://t.test/api/v1/users?page=2', 'application/json');
    add('GET', 'http://t.test/api/v1/users/7', 'application/json');
    add('GET', 'http://t.test/api/v2/ping', 'application/json');
    add('GET', 'http://t.test/live/ws', '', true);
    const root = store.siteTree('t.test');
    expect(root.count).toBe(5);
    const api = root.children.find((c) => c.name === 'api')!;
    expect(api.count).toBe(4);
    const v1 = api.children.find((c) => c.name === 'v1')!;
    const users = v1.children.find((c) => c.name === 'users')!;
    expect(users).toMatchObject({ path: '/api/v1/users', count: 3, here: 2 });
    expect(users.children.map((c) => c.name)).toEqual(['7']);
    const live = root.children.find((c) => c.name === 'live')!;
    expect(live.children[0]).toMatchObject({ path: '/live/ws', websocket: true });
  });
});

describe('WebSocket API map', () => {
  it('names messages by protocol', () => {
    expect(classifyWsMessage('42["chat:message",{"text":"hi","room":1}]', 'text')).toEqual({ protocol: 'socketio', name: 'chat:message', fields: ['text', 'room'] });
    expect(classifyWsMessage('2', 'text')).toBeNull(); // Engine.IO ping
    expect(classifyWsMessage('{"type":1,"target":"SendMessage","arguments":[{"user":"a"}]}\x1e', 'text')).toMatchObject({ protocol: 'signalr', name: 'Invocation SendMessage', fields: ['user'] });
    expect(classifyWsMessage('{"id":"1","type":"subscribe","payload":{"query":"subscription OnOrder { order { id } }","variables":{"shop":2}}}', 'text', ['graphql-transport-ws'])).toEqual({
      protocol: 'graphql-ws',
      name: 'subscribe OnOrder',
      fields: ['shop'],
    });
    expect(classifyWsMessage('{"type":"ka"}', 'text', ['graphql-ws'])).toBeNull();
    expect(classifyWsMessage('{"jsonrpc":"2.0","id":3,"method":"eth_subscribe","params":{"x":1}}', 'text')).toMatchObject({ protocol: 'json-rpc', name: 'eth_subscribe' });
    expect(classifyWsMessage('SUBSCRIBE\ndestination:/topic/prices\nid:1\n\n\0', 'text')).toMatchObject({ protocol: 'stomp', name: 'SUBSCRIBE /topic/prices' });
    expect(classifyWsMessage('{"action":"join","room":"lobby"}', 'text')).toEqual({ protocol: 'json', name: 'action=join', fields: ['action', 'room'] });
    expect(classifyWsMessage('hello there', 'text')).toMatchObject({ protocol: 'text', name: 'hello' });
    expect(classifyWsMessage(null, 'binary')).toMatchObject({ protocol: 'binary' });
  });

  it('maps each endpoint with its message kinds in both directions', () => {
    for (const room of ['1', '2']) {
      const id = add('GET', `http://w.test/rooms/${room}/socket`, '', true, [['Sec-WebSocket-Protocol', 'chat.v1']]);
      const s = store.openStream('websocket', id);
      const msg = (direction: 'client' | 'server', text: string) => store.addStreamMessage({ streamId: s, direction, opcode: 'text', at: Date.now(), payload: Buffer.from(text) });
      msg('client', '{"type":"subscribe","channel":"prices"}');
      msg('server', '{"type":"tick","price":3}');
      msg('server', '{"type":"tick","price":4}');
      store.addStreamMessage({ streamId: s, direction: 'server', opcode: 'ping', at: Date.now(), payload: Buffer.alloc(0) });
    }
    const [ep] = wsApiMap(store, { host: 'w.test' });
    expect(ep).toMatchObject({ host: 'w.test', template: '/rooms/{n}/socket', protocol: 'json', connections: 2, messages: 6, subprotocols: ['chat.v1'] });
    expect(ep!.kinds.map((k) => `${k.direction} ${k.name} ${k.count}`)).toEqual(['client type=subscribe 2', 'server type=tick 4']);
    expect(ep!.kinds[1]!.fields).toEqual(['type', 'price']);
  });
});
