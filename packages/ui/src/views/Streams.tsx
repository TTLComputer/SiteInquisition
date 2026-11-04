import { useCallback, useEffect, useState } from 'react';
import type { ExchangeSummary } from '../api';
import { base64ToBytes, bytesToBase64 } from '../api';
import { useApp } from '../state';
import { fmtTime } from '../format';
import { Messages } from './Inspector';
import { FramePlanner } from './FramePlanner';

const enc = new TextEncoder();

function parsePayload(text: string, format: 'text' | 'hex' | 'base64'): Uint8Array {
  if (format === 'text') return enc.encode(text);
  if (format === 'base64') return base64ToBytes(text.replace(/\s+/g, ''));
  const hex = text.replace(/[^0-9a-f]/gi, '');
  if (hex.length % 2) throw new Error('hex needs an even number of digits');
  return new Uint8Array(hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
}

const headerText = (h: Array<[string, string]>) => h.filter(([k]) => !k.startsWith(':')).map(([k, v]) => `${k}: ${v}`).join('\n');
const parseHeaders = (t: string): Array<[string, string]> =>
  t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(':');
      if (i <= 0) throw new Error(`header line needs "Name: value": ${l}`);
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string];
    });

/**
 * WebSocket and MQTT connections, with a composer. Messages and exact frame
 * plans go into live WebSockets the proxy is relaying (to either side) and
 * into replay connections, which reopen a captured connection with the same
 * or edited handshake. MQTT messages go straight into a live session, in
 * either direction.
 */
export function Streams() {
  const { client, streamId, streamPrefill, notify, select, setView } = useApp();
  const [conns, setConns] = useState<ExchangeSummary[]>([]);
  const [live, setLive] = useState<{ mqtt: string[]; ws: string[]; wsProxied: string[] }>({ mqtt: [], ws: [], wsProxied: [] });
  const [mode, setMode] = useState<'message' | 'frames'>('message');
  const [wsTo, setWsTo] = useState<'server' | 'client'>('server');
  const [handshake, setHandshake] = useState<string | null>(null);
  const [timing, setTiming] = useState<'none' | 'original'>('none');
  const [current, setCurrent] = useState<string | null>(streamId);
  const [payload, setPayload] = useState('');
  const [format, setFormat] = useState<'text' | 'hex' | 'base64'>('text');
  const [topic, setTopic] = useState('');
  const [qos, setQos] = useState<0 | 1>(0);
  const [retain, setRetain] = useState(false);
  const [to, setTo] = useState<'broker' | 'device'>('broker');
  const [ignoreTls, setIgnoreTls] = useState(false);

  const load = useCallback(async () => {
    const [ws, mqtt, l] = await Promise.all([client.search('ws:true', { limit: 200 }), client.search('scheme:mqtt', { limit: 200 }), client.liveStreams()]);
    const mqtts = await client.search('scheme:mqtts', { limit: 200 });
    setConns([...new Map([...ws, ...mqtt, ...mqtts].map((e) => [e.id, e])).values()].sort((a, b) => (a.id < b.id ? 1 : -1)));
    setLive(l);
  }, [client]);

  useEffect(() => {
    void load();
    let t: number | undefined;
    const off = client.onChange((c) => {
      if ((c.entity === 'exchange' || c.entity === 'stream') && t === undefined) t = window.setTimeout(() => ((t = undefined), void load()), 700);
    });
    return () => {
      off();
      window.clearTimeout(t);
    };
  }, [client, load]);

  useEffect(() => {
    if (streamId) setCurrent(streamId);
  }, [streamId]);
  useEffect(() => {
    if (!streamPrefill) return;
    setPayload(streamPrefill.text);
    if (streamPrefill.topic) setTopic(streamPrefill.topic);
  }, [streamPrefill]);

  const sel = conns.find((c) => c.id === current);
  const isMqtt = !!sel?.scheme.startsWith('mqtt');
  const isLive = sel ? (isMqtt ? live.mqtt.includes(sel.id) : live.ws.includes(sel.id)) : false;
  const isProxied = !!sel && live.wsProxied.includes(sel.id);
  useEffect(() => setHandshake(null), [current]);

  const send = async () => {
    if (!sel) return;
    try {
      const bytes = parsePayload(payload, format);
      if (isMqtt) {
        await client.mqttPublish({ exchangeId: sel.id, to, topic, payload: bytes, qos, retain });
        notify(`Published to ${topic} (${to === 'broker' ? 'as the device' : 'to the device'})`);
      } else if (isProxied) {
        await client.sendFramePlan(sel.id, [{ kind: 'frame', opcode: format === 'text' ? 'text' : 'binary', payload: bytesToBase64(bytes) }], wsTo);
      } else {
        await client.streamSend(sel.id, bytes, format === 'text' ? 'text' : 'binary');
      }
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const openReplayConnection = async () => {
    if (!sel) return;
    try {
      const r = await client.streamConnect(sel.id, ignoreTls, handshake === null ? undefined : parseHeaders(handshake));
      await load();
      setCurrent(r.exchangeId);
      notify('Replay connection open. Messages you send appear marked as injected.');
    } catch (e) {
      notify(`Could not connect: ${(e as Error).message}`);
    }
  };

  const editHandshake = async () => {
    if (!sel) return;
    if (handshake !== null) return setHandshake(null);
    try {
      setHandshake(headerText((await client.get(sel.id)).requestHeaders));
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const replaySession = async () => {
    if (!sel) return;
    try {
      const r = await client.replayStreamSession(sel.id, { ignoreTlsErrors: ignoreTls, timing });
      await load();
      setCurrent(r.exchangeId);
      notify(`Replaying ${r.sent} client ${r.sent === 1 ? 'message' : 'messages'} on a new connection`);
    } catch (e) {
      notify(`Could not replay: ${(e as Error).message}`);
    }
  };

  return (
    <div className="two-pane streams">
      <aside className="side-list" aria-label="Connections">
        <div className="label" style={{ margin: '4px 4px 8px' }}>
          Connections
        </div>
        {conns.length === 0 && <div className="faint" style={{ fontSize: 12, padding: 4 }}>No WebSocket or MQTT connections recorded yet.</div>}
        {conns.map((c) => {
          const mq = c.scheme.startsWith('mqtt');
          const on = mq ? live.mqtt.includes(c.id) : live.ws.includes(c.id);
          return (
            <button key={c.id} className="saved-view" aria-pressed={c.id === current} onClick={() => setCurrent(c.id)} style={{ background: c.id === current ? 'var(--bg-selected)' : undefined }}>
              <span>
                <span className="dot" style={{ display: 'inline-block', background: on ? 'var(--ok)' : 'var(--text-faint)', marginRight: 6 }} />
                <span className="mono">{mq ? 'MQTT' : 'WS'}</span> {c.host}
                {c.source === 'replay' && <span className="src-replay" style={{ marginLeft: 6 }}>replay</span>}
              </span>
              <span className="mono faint" style={{ fontSize: 11 }}>
                {c.path} · {fmtTime(c.startedAt)}
              </span>
            </button>
          );
        })}
      </aside>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {!sel ? (
          <div className="empty">Pick a connection on the left, or use Open in Streams on a WebSocket or MQTT row in History.</div>
        ) : (
          <>
            <div className="replay-bar">
              <span className="panel-title mono">{sel.url}</span>
              <span className="badge">{isLive ? 'live' : isMqtt ? 'ended' : sel.source === 'replay' ? 'closed' : 'captured'}</span>
              <span style={{ flex: 1 }} />
              <button
                className="btn small"
                onClick={() => {
                  select(sel.id);
                  setView('history');
                }}
              >
                Show in History
              </button>
              {!isMqtt && (
                <>
                  <select className="input" aria-label="Replay timing" value={timing} onChange={(e) => setTiming(e.target.value as 'none' | 'original')}>
                    <option value="none">As fast as possible</option>
                    <option value="original">With the original timing</option>
                  </select>
                  <button className="btn small" onClick={() => void replaySession()} title="Open a new connection like this one and send its client messages again">
                    Replay session
                  </button>
                </>
              )}
              {!isMqtt && isLive && !isProxied && (
                <button className="btn small" onClick={() => client.streamClose(sel.id).then(load, (e: Error) => notify(e.message))}>
                  Close connection
                </button>
              )}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <Messages exchangeId={sel.id} protocol={isMqtt ? 'mqtt' : 'websocket'} />
            </div>
            <div className="composer" aria-label="Composer">
              {!isMqtt && !isLive ? (
                <div className="composer-note">
                  <span>
                    {sel.source === 'replay'
                      ? 'This replay connection has closed. Open another with the same URL, cookies and headers to keep sending.'
                      : 'This connection has ended. Open a replay connection with the same URL, cookies and headers, or edit the handshake first (for example another Origin), to send your own messages and frames.'}
                  </span>
                  <label className="check">
                    <input type="checkbox" checked={ignoreTls} onChange={(e) => setIgnoreTls(e.target.checked)} /> Ignore TLS errors
                  </label>
                  <button className="btn small" aria-pressed={handshake !== null} onClick={() => void editHandshake()}>
                    Edit handshake
                  </button>
                  <button className="btn primary small" onClick={() => void openReplayConnection()}>
                    Open replay connection
                  </button>
                  {handshake !== null && (
                    <textarea
                      className="editor composer-text"
                      aria-label="Handshake headers"
                      spellCheck={false}
                      value={handshake}
                      onChange={(e) => setHandshake(e.target.value)}
                      title="One header per line. Key, version and extensions are set by the client."
                    />
                  )}
                </div>
              ) : isMqtt && !isLive ? (
                <div className="composer-note">This MQTT session has ended. Messages can only be injected while the device is connected through the relay.</div>
              ) : (
                <>
                  {!isMqtt && (
                    <div className="composer-row" style={{ paddingBottom: 0 }}>
                      <div className="segmented" role="group" aria-label="Composer mode">
                        <button className="seg" aria-pressed={mode === 'message'} onClick={() => setMode('message')}>
                          Message
                        </button>
                        <button className="seg" aria-pressed={mode === 'frames'} onClick={() => setMode('frames')}>
                          Frames
                        </button>
                      </div>
                      <span className="faint" style={{ fontSize: 12 }}>
                        {isProxied ? 'Live through the proxy: frames can go to either side.' : 'Replay connection to the server.'}
                      </span>
                    </div>
                  )}
                  {!isMqtt && mode === 'frames' && <FramePlanner exchangeId={sel.id} payload={() => parsePayload(payload, format)} opcode={format === 'text' ? 'text' : 'binary'} proxied={isProxied} />}
                  <div className="composer-row">
                    {!isMqtt && isProxied && mode === 'message' && (
                      <select className="input" aria-label="Send to" value={wsTo} onChange={(e) => setWsTo(e.target.value as 'server' | 'client')}>
                        <option value="server">To the server, as the client</option>
                        <option value="client">To the client, as the server</option>
                      </select>
                    )}
                    {isMqtt && (
                      <>
                        <select className="input" value={to} onChange={(e) => setTo(e.target.value as 'broker' | 'device')} aria-label="Direction">
                          <option value="broker">To the broker, as the device</option>
                          <option value="device">To the device, as the broker</option>
                        </select>
                        <input className="input mono" placeholder="topic" value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Topic" style={{ flex: '1 1 200px' }} />
                        <select className="input" value={qos} onChange={(e) => setQos(Number(e.target.value) as 0 | 1)} aria-label="QoS">
                          <option value={0}>QoS 0</option>
                          <option value={1}>QoS 1</option>
                        </select>
                        <label className="check">
                          <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} /> Retain
                        </label>
                      </>
                    )}
                    <div className="segmented" role="group" aria-label="Payload format">
                      {(['text', 'hex', 'base64'] as const).map((f) => (
                        <button key={f} className="seg" aria-pressed={format === f} onClick={() => setFormat(f)}>
                          {f === 'text' ? 'Text' : f === 'hex' ? 'Hex' : 'Base64'}
                        </button>
                      ))}
                    </div>
                    <span style={{ flex: 1 }} />
                    {(isMqtt || mode === 'message') && (
                      <button className="btn primary small" onClick={() => void send()} disabled={isMqtt && !topic} title="Ctrl Enter">
                        {isMqtt ? 'Publish' : 'Send frame'}
                      </button>
                    )}
                  </div>
                  <textarea
                    className="editor composer-text"
                    aria-label="Message payload"
                    spellCheck={false}
                    value={payload}
                    onChange={(e) => setPayload(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && (isMqtt || mode === 'message')) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={isMqtt ? '{"cmd":"reboot"}' : mode === 'frames' ? 'Message the preset turns into frames' : 'Message to send'}
                  />
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
