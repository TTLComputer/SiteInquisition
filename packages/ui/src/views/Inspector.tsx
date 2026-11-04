import { useCallback, useEffect, useState } from 'react';
import type { ExchangeDetail, HeaderList, WireStreamMessage } from '../api';
import { base64ToBytes } from '../api';
import { useApp } from '../state';
import { Icon } from '../components/icons';
import { asText, fmtMs, fmtSize, fmtTime, hexDump, prettyBody, statusClass, statusText, toRawRequest } from '../format';
import { breakOn, mockFromExchange } from '../actions';
import { TechPanel } from './Tech';

type Tab = 'exchange' | 'messages' | 'tech' | 'timings' | 'notes';
type BodyMode = 'pretty' | 'raw' | 'hex';

function Headers({ headers }: { headers: HeaderList }) {
  return (
    <>
      {headers.map(([k, v], i) => (
        <div key={i}>
          <span className="hk">{k}</span>: {v}
        </div>
      ))}
    </>
  );
}

function BodyView({ bytes, headers, mode, truncated }: { bytes: Uint8Array | null; headers: HeaderList | null; mode: BodyMode; truncated: boolean }) {
  if (!bytes) return <span className="faint">loading body...</span>;
  if (bytes.length === 0) return <span className="faint">(no body)</span>;
  const text = asText(bytes);
  let out: string;
  if (mode === 'hex' || text === null) out = hexDump(bytes);
  else if (mode === 'pretty') out = prettyBody(text, headers);
  else out = text;
  return (
    <>
      {text === null && mode !== 'hex' && <div className="faint">Binary body ({fmtSize(bytes.length)}), shown as hex.</div>}
      {out}
      {truncated && <div className="faint">Body was truncated at the capture size limit.</div>}
    </>
  );
}

function Side({ title, first, headers, bytes, truncated, extra, onDecode, onTrace }: { title: string; first: string; headers: HeaderList | null; bytes: Uint8Array | null; truncated: boolean; extra?: React.ReactNode; onDecode?(text: string): void; onTrace?(text: string): void }) {
  const [mode, setMode] = useState<BodyMode>('pretty');
  return (
    <section>
      <div className="sec-head">
        <b style={{ color: 'var(--text)' }}>{title}</b>
        {extra}
        <span style={{ flex: 1 }} />
        {onDecode && bytes && bytes.length > 0 && (
          <button
            className="btn small"
            title="Decode the selected text, or the whole body, in Codecs (Ctrl D)"
            onClick={() => {
              const sel = window.getSelection()?.toString();
              onDecode(sel && sel.length > 0 ? sel : (asText(bytes) ?? hexDump(bytes)));
            }}
          >
            Decode
          </button>
        )}
        {onTrace && (
          <button
            className="btn small"
            title="Select a value (an id, a token) and find the earlier response that handed it out"
            onClick={() => {
              const sel = window.getSelection()?.toString().trim();
              onTrace(sel ?? '');
            }}
          >
            Where from?
          </button>
        )}
        <div className="segmented" role="group" aria-label={`${title} body view`}>
          {(['pretty', 'raw', 'hex'] as const).map((m) => (
            <button key={m} className="seg" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === 'pretty' ? 'Pretty' : m === 'raw' ? 'Raw' : 'Hex'}
            </button>
          ))}
        </div>
      </div>
      <pre className="raw">
        <div>{first}</div>
        {headers ? <Headers headers={headers} /> : null}
        {'\n'}
        <BodyView bytes={bytes} headers={headers} mode={mode} truncated={truncated} />
      </pre>
    </section>
  );
}

export function Messages({ exchangeId, protocol }: { exchangeId: string; protocol: string }) {
  const { client, sendToCodecs, openStream } = useApp();
  const [msgs, setMsgs] = useState<WireStreamMessage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(() => client.streamMessages(exchangeId).then(setMsgs, () => undefined), [client, exchangeId]);
  useEffect(() => {
    void load();
    let t: number | undefined;
    const off = client.onChange((c) => {
      if (c.entity === 'stream' && t === undefined) t = window.setTimeout(() => ((t = undefined), void load()), 400);
    });
    return () => {
      off();
      window.clearTimeout(t);
    };
  }, [client, load]);
  const isMqtt = protocol.startsWith('mqtt');
  const sel = msgs.find((m) => m.id === selected);
  const selBytes = sel ? base64ToBytes(sel.base64) : null;
  return (
    <div className="two-col">
      <section style={{ flex: '2 1 480px', overflow: 'auto' }}>
        {msgs.length === 0 ? (
          <div className="empty">No messages recorded on this connection yet.</div>
        ) : (
          <table className="msg-table">
            <thead>
              <tr>
                <th>Dir</th>
                <th>Time</th>
                <th>{isMqtt ? 'Packet' : 'Opcode'}</th>
                {isMqtt && <th>Topic</th>}
                <th>Size</th>
                <th>Preview</th>
              </tr>
            </thead>
            <tbody>
              {msgs.map((m) => {
                const bytes = base64ToBytes(m.base64);
                const meta = m.meta ?? {};
                return (
                  <tr key={m.id} aria-selected={m.id === selected} onClick={() => setSelected(m.id)} style={{ cursor: 'pointer', background: m.id === selected ? 'var(--bg-selected)' : undefined }}>
                    <td className={m.direction === 'client' ? 'dir-client' : 'dir-server'}>{m.direction === 'client' ? '↑ client' : '↓ server'}</td>
                    <td className="faint">{fmtTime(m.at)}</td>
                    <td>
                      {m.opcode}
                      {typeof meta.fragments === 'number' && <span className="faint"> ×{meta.fragments} frames</span>}
                      {typeof meta.code === 'number' && <span className="faint"> {meta.code}</span>}
                      {meta.injected === true && <span className="src-replay" style={{ marginLeft: 6 }}>sent</span>}
                      {Array.isArray(meta.violations) && meta.violations.length > 0 && (
                        <span className="badge warn" style={{ marginLeft: 6 }} title={(meta.violations as string[]).join('\n')}>
                          {(meta.violations as string[]).length === 1 ? (meta.violations as string[])[0] : `${(meta.violations as string[]).length} protocol issues`}
                        </span>
                      )}
                    </td>
                    {isMqtt && (
                      <td>
                        {typeof meta.topic === 'string' ? meta.topic : ''}
                        {typeof meta.qos === 'number' ? <span className="faint"> q{meta.qos}</span> : null}
                        {meta.retain === true ? <span className="faint"> retain</span> : null}
                      </td>
                    )}
                    <td className="muted">{fmtSize(m.size)}</td>
                    <td className="preview">{asText(bytes) ?? `<${bytes.length} bytes binary>`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      <section>
        <div className="sec-head">
          Payload
          <span style={{ flex: 1 }} />
          {selBytes && (
            <>
              <button className="btn small" onClick={() => sendToCodecs(asText(selBytes) ?? hexDump(selBytes), `${isMqtt ? 'MQTT' : 'WebSocket'} message`)}>
                Decode
              </button>
              <button className="btn small" onClick={() => openStream(exchangeId, { text: asText(selBytes) ?? '', topic: typeof sel?.meta?.topic === 'string' ? sel.meta.topic : undefined })} title="Edit and send this message from the Streams composer">
                Send a copy
              </button>
            </>
          )}
        </div>
        <pre className="raw">{selBytes ? (asText(selBytes) !== null ? prettyBody(asText(selBytes)!, null) : hexDump(selBytes)) : <span className="faint">Select a message.</span>}</pre>
        {sel?.meta && Object.keys(sel.meta).length > 0 && (
          <dl className="kv">
            {Object.entries(sel.meta).map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </div>
  );
}

function Timings({ ex }: { ex: ExchangeDetail }) {
  const total = ex.timings.total ?? ex.durationMs ?? 0;
  const rows: Array<[string, number | undefined]> = [
    ['Request body received', ex.timings.requestBody],
    ['Response headers sent', ex.timings.responseHeaders],
    ['Response complete', ex.timings.total ?? ex.durationMs ?? undefined],
  ];
  return (
    <div style={{ padding: '8px 0' }}>
      {rows.map(([label, v]) => (
        <div className="timing-row" key={label}>
          <span className="muted">{label}</span>
          <div className="timing-bar">{v !== undefined && total > 0 && <span style={{ left: 0, width: `${Math.max(1, (v / total) * 100)}%` }} />}</div>
          <span className="mono">{v === undefined ? '' : fmtMs(v)}</span>
        </div>
      ))}
      <dl className="kv">
        <dt>Started</dt>
        <dd>{new Date(ex.startedAt).toISOString()}</dd>
        <dt>Client</dt>
        <dd>{ex.clientAddr ?? ''}</dd>
        <dt>HTTP version</dt>
        <dd>{ex.httpVersion}</dd>
        <dt>Recorded by</dt>
        <dd>{ex.createdBy}</dd>
        {ex.error && (
          <>
            <dt>Error</dt>
            <dd className="error-text">{ex.error}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function Notes({ ex }: { ex: ExchangeDetail }) {
  const { client, notify } = useApp();
  const [notes, setNotes] = useState(ex.notes ?? '');
  const [tags, setTags] = useState(ex.tags.join(', '));
  useEffect(() => {
    setNotes(ex.notes ?? '');
    setTags(ex.tags.join(', '));
  }, [ex.id, ex.notes, ex.tags]);
  const save = async () => {
    const list = tags.split(',').map((t) => t.trim()).filter(Boolean);
    await client.tag(ex.id, list);
    await client.notes(ex.id, notes);
    notify('Notes and tags saved');
  };
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
      <label className="label" htmlFor="tags-input">
        Tags (comma separated)
      </label>
      <input id="tags-input" className="input mono" value={tags} onChange={(e) => setTags(e.target.value)} />
      <label className="label" htmlFor="notes-input">
        Notes
      </label>
      <textarea id="notes-input" className="input" style={{ height: 120, padding: 8 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div>
        <button className="btn primary" onClick={() => save().catch((e: Error) => notify(e.message))}>
          Save
        </button>
      </div>
    </div>
  );
}

export function Inspector({ id, height, onClose }: { id: string; height: number | null; onClose(): void }) {
  const { client, openReplay, resendNow, notify, sendToCodecs, sendToRace, openStream, traceValue } = useApp();
  const [sig, setSig] = useState<{ accessKeyId: string; region: string; service: string; date: string; signedHeaders: string[] } | null>(null);
  const [ex, setEx] = useState<ExchangeDetail | null>(null);
  const [reqBody, setReqBody] = useState<Uint8Array | null>(null);
  const [resBody, setResBody] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('exchange');

  const load = useCallback(async () => {
    try {
      const detail = await client.get(id);
      setEx(detail);
      setError(null);
      const [rq, rs] = await Promise.all([client.body(id, 'request'), detail.state === 'pending' ? Promise.resolve(new Uint8Array()) : client.body(id, 'response')]);
      setReqBody(rq);
      setResBody(rs);
      const auth = detail.requestHeaders.find(([k]) => k.toLowerCase() === 'authorization')?.[1];
      setSig(auth?.startsWith('AWS4-HMAC-SHA256') ? ((await client.parseSigV4(id)) as never) : null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client, id]);

  useEffect(() => {
    setEx(null);
    setReqBody(null);
    setResBody(null);
    void load();
    const off = client.onChange((c) => {
      if (c.entity === 'exchange' && c.entityId === id) void load();
    });
    return () => {
      off();
    };
  }, [client, id, load]);

  useEffect(() => {
    if (tab === 'messages' && ex && !ex.stream) setTab('exchange');
  }, [ex, tab]);

  const style = height ? { height } : undefined;
  if (error) {
    return (
      <div className="inspector" style={style}>
        <div className="empty error-text">Could not load this exchange: {error}</div>
      </div>
    );
  }
  if (!ex) return <div className="inspector" style={style} aria-busy="true" />;

  const tabs: Array<[Tab, string]> = [['exchange', 'Request and response']];
  if (ex.stream) tabs.push(['messages', ex.stream.protocol.startsWith('mqtt') ? 'MQTT packets' : 'WebSocket messages']);
  tabs.push(['tech', 'Tech and CSRF'], ['timings', 'Timings'], ['notes', 'Notes and tags']);

  const responseLine =
    ex.status !== null ? `HTTP/${ex.httpVersion} ${ex.status} ${ex.statusMessage ?? ''}` : ex.state === 'pending' ? '(waiting for response)' : ex.error ? `(${ex.state}: ${ex.error})` : `(${ex.state})`;

  return (
    <div className="inspector" style={style} aria-label="Inspector">
      <div className="insp-head">
        <span className={`mono m-${ex.method}`}>{ex.isWebSocket ? 'WS' : ex.method}</span>
        <span className="mono insp-url" title={ex.url}>
          {ex.url}
        </span>
        <span className={`mono ${statusClass(ex)}`}>{statusText(ex)}</span>
        <button className="btn small primary" onClick={() => openReplay(ex)}>
          <Icon name="replay" size={12} /> Send to replay
        </button>
        {ex.stream ? (
          <button className="btn small" onClick={() => openStream(ex.id)} title="Open this connection in the Streams composer to send messages">
            Open in Streams
          </button>
        ) : (
          <>
            <button className="btn small" onClick={() => resendNow(ex.id).catch((e: Error) => notify(e.message))} title="Ctrl Shift Enter">
              Resend now
            </button>
            <button
              className="btn small"
              title="Line this request up in the Race view"
              onClick={() => sendToRace([{ label: ex.path.split('?')[0]!.split('/').pop() || '/', raw: toRawRequest(ex.method, ex.url, ex.requestHeaders, (reqBody && asText(reqBody)) ?? ''), replayOf: ex.id }])}
            >
              Race
            </button>
            <button
              className="btn small"
              title="Serve this response as a mock from now on"
              onClick={() => mockFromExchange(client, ex).then((n) => notify(`Mock "${n}" added. Edit it in Rules, Mocks.`), (e: Error) => notify(e.message))}
            >
              Mock
            </button>
            <button
              className="btn small"
              title="Pause the next request to this endpoint"
              onClick={() => breakOn(client, ex).then(() => notify('Breakpoint added for this endpoint.'), (e: Error) => notify(e.message))}
            >
              Break
            </button>
          </>
        )}
        <button className="icon-btn" aria-label="Close inspector" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="tabs" role="tablist" style={{ background: 'none' }}>
        {tabs.map(([t, label]) => (
          <button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      <div className="insp-body">
        {tab === 'exchange' && (
          <div className="two-col">
            <Side
              title="Request"
              first={`${ex.method} ${ex.path} HTTP/${ex.httpVersion}`}
              headers={ex.requestHeaders}
              bytes={reqBody}
              truncated={ex.requestBodyTruncated}
              extra={
                <>
                  {ex.replayOf ? <span className="src-replay">replay</span> : null}
                  {sig && (
                    <span className="badge" title={`Signed headers: ${sig.signedHeaders.join(', ')}`}>
                      SigV4 {sig.service} · {sig.region} · {sig.accessKeyId.slice(0, 8)}… · {sig.date}
                    </span>
                  )}
                </>
              }
              onDecode={(t) => sendToCodecs(t, `${ex.method} ${ex.path.split('?')[0]} request`)}
              onTrace={(t) => (t ? traceValue(t, ex.id) : notify('Select a value in the request first, such as an id in the path or body.'))}
            />
            <Side
              title="Response"
              first={responseLine}
              headers={ex.responseHeaders}
              bytes={resBody}
              truncated={ex.responseBodyTruncated}
              onDecode={(t) => sendToCodecs(t, `${ex.method} ${ex.path.split('?')[0]} response`)}
            />
          </div>
        )}
        {tab === 'messages' && ex.stream && <Messages exchangeId={ex.id} protocol={ex.stream.protocol} />}
        {tab === 'tech' && <TechPanel ex={ex} />}
        {tab === 'timings' && <Timings ex={ex} />}
        {tab === 'notes' && <Notes ex={ex} />}
      </div>
    </div>
  );
}

