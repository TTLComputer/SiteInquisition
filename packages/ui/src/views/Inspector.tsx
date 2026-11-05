import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ContractResult, ExchangeDetail, HeaderList, SearchColumn, SearchTerm, WireStreamMessage } from '../api';
import { base64ToBytes } from '../api';
import { useApp } from '../state';
import { Icon } from '../components/icons';
import { asText, fmtMs, fmtSize, fmtTime, hexDump, prettyBody, statusClass, statusText, toRawRequest } from '../format';
import { breakOn, breakOnMessages, mockFromExchange } from '../actions';
import { ErrorBanner, TechPanel } from './Tech';
import { CertHelp } from './TlsSettings';
import { decodeSignalR, decodeSocketIO, detectProtocol, summarizeFrame } from '@siteinquisition/codecs/protocols';
import { ReplayButton } from '../components/ReplayButton';
import { Highlight, termPattern, useHitNavigator } from '../components/Highlight';
import { DecodableText, type Decoded, type SaveContext } from '../components/Decoded';
import { regionLabel } from '@siteinquisition/codecs/regionedit';

/** What the History search looks for, per part of the exchange. */
type Hl = { line: RegExp | null; headers: RegExp | null; body: RegExp | null };

type Tab = 'exchange' | 'messages' | 'tech' | 'timings' | 'notes';
type BodyMode = 'pretty' | 'raw' | 'hex';
/** A body with its saved field codecs decoded in place, as regions. */
type FieldView = Decoded | null;

/** Request or status line and headers, with header names coloured and search terms marked. */
function headPlain(full: string, hl?: Hl) {
  return (t: string, offset: number): ReactNode => {
    const parts: ReactNode[] = [];
    let at = offset;
    for (const piece of t.split(/(?<=\n)/)) {
      const lineStart = at === 0 || full[at - 1] === '\n';
      const pat = at === 0 || full.lastIndexOf('\n', at - 1) === -1 ? (hl?.line ?? null) : (hl?.headers ?? null);
      const colon = piece.indexOf(': ');
      if (pat && ((pat.lastIndex = 0), pat.test(piece))) parts.push(<Highlight key={at} text={piece} pattern={pat} />);
      else if (lineStart && at > 0 && colon > 0)
        parts.push(
          <Fragment key={at}>
            <span className="hk">{piece.slice(0, colon)}</span>
            {piece.slice(colon)}
          </Fragment>,
        );
      else parts.push(<Fragment key={at}>{piece}</Fragment>);
      at += piece.length;
    }
    return parts;
  };
}

function BodyView({ bytes, headers, mode, truncated, fields, hl, viewKey, save, label }: { bytes: Uint8Array | null; headers: HeaderList | null; mode: BodyMode; truncated: boolean; fields?: FieldView; hl?: RegExp | null; viewKey: string; save: SaveContext; label: string }) {
  if (!bytes) return <span className="faint">loading body...</span>;
  if (bytes.length === 0) return <span className="faint">(no body)</span>;
  const text = asText(bytes);
  if (mode === 'hex' || text === null) {
    return (
      <>
        {text === null && mode !== 'hex' && <div className="faint">Binary body ({fmtSize(bytes.length)}), shown as hex.</div>}
        {hexDump(bytes)}
        {truncated && <div className="faint">Body was truncated at the capture size limit.</div>}
      </>
    );
  }
  const out = mode === 'pretty' ? prettyBody(text, headers) : text;
  return (
    <>
      <DecodableText text={out} viewKey={`${viewKey}:${mode}`} initial={mode === 'pretty' ? fields : null} hl={hl ?? null} save={save} label={`${label} body`} />
      {truncated && <div className="faint">Body was truncated at the capture size limit.</div>}
    </>
  );
}

function Side({ title, first, headers, bytes, truncated, extra, onDecode, onTrace, fields, hl, viewKey, url }: { title: string; first: string; headers: HeaderList | null; bytes: Uint8Array | null; truncated: boolean; extra?: React.ReactNode; onDecode?(text: string): void; onTrace?(text: string): void; fields?: FieldView; hl?: Hl; viewKey: string; url: string }) {
  const [mode, setMode] = useState<BodyMode>('pretty');
  const side = title === 'Request' ? 'request' : 'response';
  const head = useMemo(() => [first, ...(headers ?? []).map(([k, v]) => `${k}: ${v}`)].join('\n'), [first, headers]);
  const plain = useMemo(() => headPlain(head, hl), [head, hl]);
  return (
    <section>
      <div className="sec-head">
        <b style={{ color: 'var(--text)' }}>{title}</b>
        {extra}
        {fields && fields.regions.length > 0 && (
          <span className="badge" title={`Decoded with saved field codecs: ${[...new Set(fields.regions.map((r) => regionLabel(r)))].join('; ')}`}>
            {fields.regions.length} decoded {fields.regions.length === 1 ? 'field' : 'fields'}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {onDecode && bytes && bytes.length > 0 && (
          <button
            className="btn small"
            title="Open the selected text, or the whole body, in Codecs (Ctrl Shift D). To decode in place, select a value and press Ctrl D."
            onClick={() => {
              const sel = window.getSelection()?.toString();
              onDecode(sel && sel.length > 0 ? sel : (asText(bytes) ?? hexDump(bytes)));
            }}
          >
            Codecs
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
        <DecodableText text={head} viewKey={`${viewKey}:head`} plain={plain} label={`${title} headers`} />
        {'\n\n'}
        <BodyView bytes={bytes} headers={headers} mode={mode} truncated={truncated} fields={fields} hl={hl?.body} viewKey={viewKey} save={{ url, side, bodyStart: 0 }} label={title} />
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
  const selText = !isMqtt && selBytes ? asText(selBytes) : null;
  const selProto = selText ? detectProtocol(selText) : null;
  const selDecoded = (() => {
    if (!selText || !selProto) return null;
    try {
      return selProto === 'socketio' ? decodeSocketIO(selText) : decodeSignalR(selText);
    } catch {
      return null;
    }
  })();
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
                {!isMqtt && <th>Decoded</th>}
                <th>Size</th>
                <th>Preview</th>
              </tr>
            </thead>
            <tbody>
              {msgs.map((m) => {
                const bytes = base64ToBytes(m.base64);
                const meta = m.meta ?? {};
                const frameText = isMqtt ? null : asText(bytes);
                const summary = frameText ? summarizeFrame(frameText) : null;
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
                    {!isMqtt && <td>{summary ? <span className="badge" title="Decoded realtime frame">{summary}</span> : <span className="faint" />}</td>}
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
        {selDecoded && (
          <details open className="decoded-frame">
            <summary>
              Decoded <span className="badge">{selProto === 'socketio' ? 'Socket.IO' : 'SignalR'}</span>
            </summary>
            <pre className="raw">
              <DecodableText text={JSON.stringify(selDecoded, null, 2)} viewKey={`frame:${sel!.id}`} label="Decoded frame" />
            </pre>
          </details>
        )}
        <pre className="raw">
          {selBytes ? asText(selBytes) !== null ? <DecodableText text={prettyBody(asText(selBytes)!, null)} viewKey={`msg:${sel!.id}`} label="Message payload" /> : hexDump(selBytes) : <span className="faint">Select a message.</span>}
        </pre>
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
      <EndpointNotes ex={ex} />
    </div>
  );
}

/** What the API description says about this exchange, and the team's notes on its endpoint. */
function ApiStrip({ ex, onNotes }: { ex: ExchangeDetail; onNotes(): void }) {
  const { client } = useApp();
  const [contract, setContract] = useState<ContractResult | null>(null);
  const [note, setNote] = useState<{ key: string; notes: string; tags: string[] } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    setContract(null);
    setNote(null);
    if (ex.stream || ex.state === 'pending') return;
    client.contractCheck(ex.id).then((c) => live && setContract(c), () => undefined);
    client.noteFor(ex.id).then((n) => live && setNote(n), () => undefined);
    return () => {
      live = false;
    };
  }, [client, ex.id, ex.state, ex.stream]);
  const errors = contract?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = contract?.issues.filter((i) => i.severity === 'warning') ?? [];
  if (!contract && !note?.notes && !note?.tags.length) return null;
  return (
    <div className="api-strip" aria-label="API description">
      {contract && (
        <div className="api-strip-row">
          <span className={`chip ${errors.length ? 'chip-bad' : warnings.length ? 'chip-warn' : 'chip-good'}`}>
            {errors.length ? `${errors.length} contract ${errors.length === 1 ? 'issue' : 'issues'}` : warnings.length ? `${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}` : 'Matches the spec'}
          </span>
          <span className="mono faint">
            {contract.endpoint} in {contract.specName}
          </span>
          {contract.issues.length > 0 && (
            <button className="btn small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? 'Hide' : 'Show'}
            </button>
          )}
        </div>
      )}
      {open &&
        contract?.issues.map((i, n) => (
          <div key={n} className={`api-issue ${i.severity}`}>
            <span className="faint">{i.side}</span> <span className="mono">{i.path}</span> {i.message}
          </div>
        ))}
      {note && (note.notes || note.tags.length > 0) && (
        <div className="api-strip-row">
          <span className="chip">Endpoint note</span>
          {note.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
          <span className="api-note-text">{note.notes}</span>
          <button className="btn small" onClick={onNotes}>
            Edit
          </button>
        </div>
      )}
    </div>
  );
}

function EndpointNotes({ ex }: { ex: ExchangeDetail }) {
  const { client, notify } = useApp();
  const [key, setKey] = useState('');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');
  useEffect(() => {
    client.noteFor(ex.id).then((n) => {
      setKey(n?.key ?? '');
      setNotes(n?.notes ?? '');
      setTags(n?.tags.join(', ') ?? '');
    }, () => undefined);
  }, [client, ex.id]);
  if (!key) return null;
  return (
    <>
      <div className="sec-head" style={{ marginTop: 12 }}>
        <b style={{ color: 'var(--text)' }}>Endpoint notes</b>
        <span className="mono faint">{key}</span>
      </div>
      <div className="faint" style={{ fontSize: 12 }}>
        Shared with everyone and shown on every call to this endpoint, in Coverage and in the API view.
      </div>
      <input className="input mono" placeholder="tags: needs auth, slow, admin only" value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Endpoint tags" />
      <textarea className="input" style={{ height: 90, padding: 8 }} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Endpoint notes" placeholder="What this endpoint does, quirks, who owns it" />
      <div>
        <button
          className="btn"
          onClick={() =>
            client
              .setEndpointNote(key, notes, tags.split(',').map((t) => t.trim()).filter(Boolean))
              .then(() => notify('Endpoint notes saved'), (e: Error) => notify(e.message))
          }
        >
          Save endpoint notes
        </button>
      </div>
    </>
  );
}

export function Inspector({ id, height, onClose }: { id: string; height: number | null; onClose(): void }) {
  const { client, openReplay, resendNow, notify, sendToCodecs, sendToRace, openStream, traceValue, query } = useApp();
  const [sig, setSig] = useState<{ accessKeyId: string; region: string; service: string; date: string; signedHeaders: string[] } | null>(null);
  const [ex, setEx] = useState<ExchangeDetail | null>(null);
  const [reqBody, setReqBody] = useState<Uint8Array | null>(null);
  const [resBody, setResBody] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('exchange');
  const [reqFields, setReqFields] = useState<FieldView>(null);
  const [resFields, setResFields] = useState<FieldView>(null);

  const load = useCallback(async () => {
    try {
      const detail = await client.get(id);
      setEx(detail);
      setError(null);
      const [rq, rs] = await Promise.all([client.body(id, 'request'), detail.state === 'pending' ? Promise.resolve(new Uint8Array()) : client.body(id, 'response')]);
      setReqBody(rq);
      setResBody(rs);
      // Saved field codecs: those fields read decoded in place in the Pretty view.
      const regions = (b: Uint8Array, side: 'request' | 'response') => {
        const t = b.length ? asText(b) : null;
        return t ? client.fieldRegions(t, detail.url, side).then((r) => (r ? { text: r.text, regions: r.regions } : null), () => null) : Promise.resolve(null);
      };
      const [fq, fs] = await Promise.all([regions(rq, 'request'), regions(rs, 'response')]);
      setReqFields(fq);
      setResFields(fs);
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

  // Highlight what the History search looked for, and jump to the first place it appears.
  const [terms, setTerms] = useState<SearchTerm[]>([]);
  useEffect(() => {
    let live = true;
    if (!query.trim()) setTerms([]);
    else client.searchTerms(query).then((t) => live && setTerms(t.filter((x) => !x.negate)), () => live && setTerms([]));
    return () => {
      live = false;
    };
  }, [client, query]);
  const hl = useMemo(() => {
    const pat = (...cols: SearchColumn[]) => termPattern(terms.filter((t) => t.in.some((c) => cols.includes(c))).map((t) => t.value));
    return {
      req: { line: pat('url'), headers: pat('req_headers'), body: pat('req_body') },
      res: { line: null, headers: pat('res_headers'), body: pat('res_body') },
    };
  }, [terms]);
  const exchangeRef = useRef<HTMLDivElement>(null);
  const hits = useHitNavigator(exchangeRef, `${id}|${terms.map((t) => t.value).join('\u0000')}|${reqBody?.length}|${resBody?.length}|${reqFields?.text.length}|${resFields?.text.length}|${tab}`);

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
        <ReplayButton exchange={ex} primary />
        {ex.stream ? (
          <>
            <button className="btn small" onClick={() => openStream(ex.id)} title="Open this connection in the Streams composer to send messages">
              Open in Streams
            </button>
            {ex.isWebSocket && (
              <button
                className="btn small"
                title="Pause messages on connections to this URL, to edit or drop them before they go on"
                onClick={() => breakOnMessages(client, ex).then(() => notify('Messages on this URL will pause in Rules, Breakpoints.'), (e: Error) => notify(e.message))}
              >
                Break
              </button>
            )}
          </>
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
              title="Copy this request as a curl command"
              onClick={() => client.curl(ex.id).then((c) => navigator.clipboard.writeText(c)).then(() => notify('Copied as curl'), (e: Error) => notify(e.message))}
            >
              curl
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
        {tab === 'exchange' && <ErrorBanner ex={ex} />}
        {tab === 'exchange' && ex.error && <CertHelp url={ex.url} error={ex.error} />}
        {tab === 'exchange' && <ApiStrip ex={ex} onNotes={() => setTab('notes')} />}
        {tab === 'exchange' && terms.length > 0 && (
          <div className="hit-bar" data-testid="hit-bar" role="status">
            <Icon name="search" size={12} color="var(--text-faint)" />
            <span>{hits.count ? `Match ${hits.at + 1} of ${hits.count}${hits.count >= 2000 ? '+' : ''} for the search` : 'No match shown here: it may be past the indexed part of a large body, or in a hex view'}</span>
            <span style={{ flex: 1 }} />
            <button className="btn small" disabled={hits.count < 2} onClick={hits.prev} aria-label="Previous match">
              ‹ Previous
            </button>
            <button className="btn small" disabled={hits.count < 2} onClick={hits.next} aria-label="Next match">
              Next ›
            </button>
          </div>
        )}
        {tab === 'exchange' && (
          <div className="two-col" ref={exchangeRef}>
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
              fields={reqFields}
              hl={hl.req}
              viewKey={`${ex.id}:request`}
              url={ex.url}
              onDecode={(t) => sendToCodecs(t, `${ex.method} ${ex.path.split('?')[0]} request`)}
              onTrace={(t) => (t ? traceValue(t, ex.id) : notify('Select a value in the request first, such as an id in the path or body.'))}
            />
            <Side
              title="Response"
              first={responseLine}
              headers={ex.responseHeaders}
              bytes={resBody}
              truncated={ex.responseBodyTruncated}
              fields={resFields}
              hl={hl.res}
              viewKey={`${ex.id}:response`}
              url={ex.url}
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

