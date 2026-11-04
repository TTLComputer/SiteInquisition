import { useCallback, useEffect, useState } from 'react';
import type { ExchangeSummary } from '../api';
import { base64ToBytes } from '../api';
import { useApp } from '../state';
import { fmtTime } from '../format';
import { Messages } from './Inspector';

const enc = new TextEncoder();

function parsePayload(text: string, format: 'text' | 'hex' | 'base64'): Uint8Array {
  if (format === 'text') return enc.encode(text);
  if (format === 'base64') return base64ToBytes(text.replace(/\s+/g, ''));
  const hex = text.replace(/[^0-9a-f]/gi, '');
  if (hex.length % 2) throw new Error('hex needs an even number of digits');
  return new Uint8Array(hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
}

/**
 * WebSocket and MQTT connections, with a composer. A WebSocket the proxy is
 * passing through cannot take new frames, so the composer opens a replay
 * connection (same URL, cookies and headers) and sends on that. MQTT
 * messages go straight into a live session, in either direction.
 */
export function Streams() {
  const { client, streamId, streamPrefill, notify, select, setView } = useApp();
  const [conns, setConns] = useState<ExchangeSummary[]>([]);
  const [live, setLive] = useState<{ mqtt: string[]; ws: string[] }>({ mqtt: [], ws: [] });
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

  const send = async () => {
    if (!sel) return;
    try {
      const bytes = parsePayload(payload, format);
      if (isMqtt) {
        await client.mqttPublish({ exchangeId: sel.id, to, topic, payload: bytes, qos, retain });
        notify(`Published to ${topic} (${to === 'broker' ? 'as the device' : 'to the device'})`);
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
      const r = await client.streamConnect(sel.id, ignoreTls);
      await load();
      setCurrent(r.exchangeId);
      notify('Replay connection open. Messages you send appear marked as injected.');
    } catch (e) {
      notify(`Could not connect: ${(e as Error).message}`);
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
              {!isMqtt && isLive && (
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
                      : 'The proxy only passes captured connections through and cannot add frames to them. Open a replay connection with the same URL, cookies and headers to send your own messages.'}
                  </span>
                  <label className="check">
                    <input type="checkbox" checked={ignoreTls} onChange={(e) => setIgnoreTls(e.target.checked)} /> Ignore TLS errors
                  </label>
                  <button className="btn primary small" onClick={() => void openReplayConnection()}>
                    Open replay connection
                  </button>
                </div>
              ) : isMqtt && !isLive ? (
                <div className="composer-note">This MQTT session has ended. Messages can only be injected while the device is connected through the relay.</div>
              ) : (
                <>
                  <div className="composer-row">
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
                    <button className="btn primary small" onClick={() => void send()} disabled={isMqtt && !topic} title="Ctrl Enter">
                      {isMqtt ? 'Publish' : 'Send frame'}
                    </button>
                  </div>
                  <textarea
                    className="editor composer-text"
                    aria-label="Message payload"
                    spellCheck={false}
                    value={payload}
                    onChange={(e) => setPayload(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={isMqtt ? '{"cmd":"reboot"}' : 'Message to send'}
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
