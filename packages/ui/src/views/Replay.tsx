import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExchangeDetail, ExchangeSummary } from '../api';
import { useApp, type ReplayTab } from '../state';
import { Icon } from '../components/icons';
import { asText, fmtMs, fmtSize, hexDump, parseRawRequest, prettyBody, statusClass, statusText, toRawRequest } from '../format';
import { diffLines } from '../diff';

const binaryMarker = (n: number) => `<binary body: ${n} bytes, sent as captured>`;

interface Shown {
  ex: ExchangeDetail;
  body: Uint8Array;
}

function ResponsePane({ shown, original, compare }: { shown: Shown | null; original: Shown | null; compare: boolean }) {
  if (!shown) return <div className="empty">Press Send (Ctrl Enter) to see the response here.</div>;
  const { ex, body } = shown;
  const text = asText(body);
  const bodyText = text === null ? hexDump(body) : prettyBody(text, ex.responseHeaders);
  const head = [
    ex.status !== null ? `HTTP/${ex.httpVersion} ${ex.status} ${ex.statusMessage ?? ''}` : `(${ex.state}${ex.error ? `: ${ex.error}` : ''})`,
    ...(ex.responseHeaders ?? []).map(([k, v]) => `${k}: ${v}`),
  ].join('\n');
  if (compare && original && original.ex.id !== ex.id) {
    const ot = asText(original.body);
    const before = `${original.ex.status ?? ''}\n\n${ot === null ? hexDump(original.body) : prettyBody(ot, original.ex.responseHeaders)}`;
    const after = `${ex.status ?? ''}\n\n${bodyText}`;
    const lines = diffLines(before, after);
    return (
      <pre className="raw" aria-label="Diff with original response">
        {lines.map((l, i) => (
          <div key={i} className={l.op === '+' ? 'diff-add' : l.op === '-' ? 'diff-del' : undefined}>
            {l.op === '=' ? '  ' : `${l.op} `}
            {l.text}
          </div>
        ))}
      </pre>
    );
  }
  return (
    <pre className="raw">
      {head}
      {'\n\n'}
      {body.length === 0 ? <span className="faint">(no body)</span> : bodyText}
    </pre>
  );
}

export function Replay({ tab }: { tab: ReplayTab }) {
  const { client, notify, select, setView, setQuery } = useApp();
  const [original, setOriginal] = useState<Shown | null>(null);
  const [originalReqBody, setOriginalReqBody] = useState<Uint8Array | null>(null);
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [ignoreTls, setIgnoreTls] = useState(false);
  const [sends, setSends] = useState<ExchangeSummary[]>([]);
  const [shownId, setShownId] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [compare, setCompare] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const reset = useCallback(async () => {
    const ex = await client.get(tab.exchangeId);
    const reqBody = ex.reqBodySize ? await client.body(ex.id, 'request', false) : new Uint8Array();
    const resBody = ex.state === 'pending' ? new Uint8Array() : await client.body(ex.id, 'response');
    setOriginal({ ex, body: resBody });
    setOriginalReqBody(reqBody);
    const text = asText(reqBody);
    setRaw(toRawRequest(ex.method, ex.url, ex.requestHeaders, text === null ? binaryMarker(reqBody.length) : text));
  }, [client, tab.exchangeId]);

  useEffect(() => {
    reset().catch((e: Error) => setError(`Could not load the original request: ${e.message}`));
  }, [reset]);

  const loadSends = useCallback(() => client.replayHistory(tab.exchangeId).then(setSends, () => undefined), [client, tab.exchangeId]);
  useEffect(() => {
    void loadSends();
  }, [loadSends]);

  useEffect(() => {
    if (!shownId) return setShown(null);
    let live = true;
    (async () => {
      const ex = await client.get(shownId);
      const body = ex.state === 'pending' ? new Uint8Array() : await client.body(shownId, 'response');
      if (live) setShown({ ex, body });
    })().catch((e: Error) => notify(e.message));
    return () => {
      live = false;
    };
  }, [client, shownId, notify]);

  const send = useCallback(async () => {
    let parsed;
    try {
      parsed = parseRawRequest(raw);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setError(null);
    setSending(true);
    try {
      const marker = originalReqBody && parsed.body === binaryMarker(originalReqBody.length);
      const body = marker ? originalReqBody! : parsed.body ? new TextEncoder().encode(parsed.body) : undefined;
      const res = await client.replay({ method: parsed.method, url: parsed.url, headers: parsed.headers, body, replayOf: tab.exchangeId, ignoreTlsErrors: ignoreTls });
      setShownId(res.id);
      await loadSends();
      if (res.state !== 'complete') setError(`The request failed (${res.state}). Details are in the response pane.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }, [raw, originalReqBody, client, tab.exchangeId, ignoreTls, loadSends]);

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      void send();
    }
  };

  const ordered = useMemo(() => [...sends].sort((a, b) => (a.id < b.id ? -1 : 1)), [sends]);
  const index = ordered.findIndex((s) => s.id === shownId);
  const showOriginal = !shownId;

  return (
    <div className="replay" onKeyDown={onKey}>
      <div className="replay-bar">
        <span className="panel-title">
          <span className={`mono m-${tab.method}`}>{tab.method}</span> {tab.label}
        </span>
        <button className="btn primary" onClick={() => void send()} disabled={sending || !raw} title="Ctrl Enter">
          <Icon name="replay" size={13} /> {sending ? 'Sending...' : 'Send'}
        </button>
        <div className="segmented" role="group" aria-label="Sends">
          <button className="seg" aria-pressed={showOriginal} onClick={() => setShownId(null)}>
            Original
          </button>
          <button className="seg" disabled={ordered.length === 0 || index <= 0} aria-label="Previous send" onClick={() => setShownId(ordered[index - 1]?.id ?? null)}>
            ‹
          </button>
          <span className="mono muted" style={{ alignSelf: 'center', fontSize: 12 }} aria-live="polite">
            {ordered.length === 0 ? 'no sends yet' : index === -1 ? `${ordered.length} sends` : `send ${index + 1} of ${ordered.length}`}
          </span>
          <button
            className="seg"
            disabled={ordered.length === 0 || index === ordered.length - 1}
            aria-label="Next send"
            onClick={() => setShownId(ordered[index + 1]?.id ?? ordered[0]?.id ?? null)}
          >
            ›
          </button>
        </div>
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={ignoreTls} onChange={(e) => setIgnoreTls(e.target.checked)} /> Ignore TLS errors
        </label>
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} disabled={showOriginal} /> Diff with original
        </label>
        <span style={{ flex: 1 }} />
        <button className="btn small" onClick={() => reset().catch((e: Error) => notify(e.message))}>
          Reset to original
        </button>
        <button
          className="btn small"
          onClick={() => {
            setQuery(`replayof:${tab.exchangeId}`);
            setView('history');
          }}
        >
          All sends in History
        </button>
      </div>
      {error && (
        <div className="banner" role="alert" style={{ margin: 8 }}>
          {error}
        </div>
      )}
      <div className="replay-split">
        <section>
          <div className="sec-head">
            <b style={{ color: 'var(--text)' }}>Request</b>
            <span>Raw. Edit anything; Content-Length is recalculated on send.</span>
          </div>
          <textarea ref={editorRef} className="editor" aria-label="Raw request" spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} />
        </section>
        <section>
          <div className="sec-head">
            <b style={{ color: 'var(--text)' }}>Response</b>
            {(shown ?? original) && (
              <>
                <span className={`mono ${statusClass((shown ?? original)!.ex)}`}>{statusText((shown ?? original)!.ex)}</span>
                <span className="mono">{fmtSize((shown ?? original)!.ex.resBodySize)}</span>
                <span className="mono">{fmtMs((shown ?? original)!.ex.durationMs)}</span>
                <span>{showOriginal ? 'as originally captured' : 'from this send'}</span>
                <span style={{ flex: 1 }} />
                <button
                  className="btn small"
                  onClick={() => {
                    select((shown ?? original)!.ex.id);
                    setView('history');
                  }}
                >
                  Show in History
                </button>
              </>
            )}
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <ResponsePane shown={shown ?? original} original={original} compare={compare} />
          </div>
        </section>
      </div>
    </div>
  );
}
