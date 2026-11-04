import { describe, expect, it } from '@siteinquisition/devkit/test';
import { decodeChain, decodeSignalR, decodeSocketIO, decodeViewState, detectProtocol, encodeSignalR, encodeSocketIO, getCodec, listCodecs, summarizeFrame } from '@siteinquisition/codecs';

describe('Socket.IO frames', () => {
  it('decodes an event with a namespace and ack, and round-trips', () => {
    const frame = '42/chat,7["message",{"text":"hi"}]';
    const p = decodeSocketIO(frame);
    expect(p).toMatchObject({ transport: 'message', type: 'EVENT', namespace: '/chat', ack: 7, event: 'message', data: [{ text: 'hi' }] });
    expect(encodeSocketIO(p)).toBe(frame);
  });
  it('reads ping/pong and plain messages', () => {
    expect(decodeSocketIO('2').transport).toBe('ping');
    expect(decodeSocketIO('40/admin,').type).toBe('CONNECT');
    const bin = decodeSocketIO('451-["img",{"_placeholder":true,"num":0}]');
    expect(bin).toMatchObject({ type: 'BINARY_EVENT', attachments: 1, event: 'img' });
  });
  it('is available as a codec', () => {
    expect(listCodecs().some((c) => c.id === 'socketio')).toBe(true);
    expect((decodeChain(['socketio'], '42["hello",1]') as { event: string }).event).toBe('hello');
  });
});

describe('SignalR messages', () => {
  const RS = '\x1e';
  it('decodes hub invocations and the handshake', () => {
    const msg = decodeSignalR(`{"type":1,"target":"Send","arguments":["nick","hi"],"invocationId":"0"}${RS}`);
    expect(Array.isArray(msg)).toBe(true);
    expect((msg as any[])[0]).toMatchObject({ typeName: 'Invocation', target: 'Send', arguments: ['nick', 'hi'] });
    expect(decodeSignalR(`{"protocol":"json","version":1}${RS}`)).toEqual({ handshake: { protocol: 'json', version: 1 } });
  });
  it('round-trips through its codec', () => {
    const text = `{"type":1,"target":"Send","arguments":[1]}${RS}{"type":6}${RS}`;
    const decoded = decodeSignalR(text);
    expect(encodeSignalR(decoded)).toBe(text);
    expect(getCodec('signalr').decode(new TextEncoder().encode(text))).toEqual(decoded);
  });
});

describe('ASP.NET ViewState', () => {
  it('parses a binary ObjectStateFormatter stream and flags MAC protection', () => {
    // 0xFF 0x01, Pair( Pair( null, ArrayList[ Int32(42), "hello" ] ), null )
    const bytes = Uint8Array.from([
      0xff, 0x01,
      0x0f, // Pair
      0x0f, // Pair
      0x64, // null
      0x15, 0x02, // ArrayList of 2
      0x6a, 42, 0, 0, 0, // Int32 42
      0x05, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f, // string "hello"
      0x64, // null
    ]);
    const vs = decodeViewState(bytes);
    expect(vs.format).toBe('binary');
    expect(vs.macProtected).toBe(false);
    expect(JSON.stringify(vs.value)).toContain('hello');
    expect(JSON.stringify(vs.value)).toContain('42');
    // The same bytes plus a 20-byte MAC read as protected.
    const withMac = new Uint8Array([...bytes, ...new Array(20).fill(0)]);
    expect(decodeViewState(withMac).macProtected).toBe(true);
  });
  it('re-encoding is refused rather than producing a wrong value', () => {
    expect(() => getCodec('viewstate').encode({})).toThrow(/decode-only/);
  });
});

describe('Frame detection and summaries', () => {
  const RS = '\x1e';
  it('detects the protocol of a raw frame', () => {
    expect(detectProtocol('42["message",{"text":"hi"}]')).toBe('socketio');
    expect(detectProtocol('2')).toBe('socketio');
    expect(detectProtocol(`{"type":1,"target":"Send","arguments":[]}${RS}`)).toBe('signalr');
    expect(detectProtocol('just some text')).toBeNull();
    expect(detectProtocol('')).toBeNull();
  });
  it('summarizes Socket.IO events and SignalR invocations for a list', () => {
    expect(summarizeFrame('42/chat,7["message",{"text":"hi"}]')).toBe('/chat message ack#7');
    expect(summarizeFrame('42["hello",1]')).toBe('hello');
    expect(summarizeFrame('2')).toBe('ping');
    expect(summarizeFrame(`{"type":1,"target":"Send","arguments":[]}${RS}`)).toBe('Invocation Send');
    expect(summarizeFrame(`{"protocol":"json","version":1}${RS}`)).toBe('handshake');
    expect(summarizeFrame('plain websocket text')).toBeNull();
  });
});
