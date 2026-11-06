import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AwsProfile, ExchangeDetail, ExchangeSummary, SendOptions } from '../api';
import { useApp, type ReplayTab } from '../state';
import { Icon } from '../components/icons';
import { asText, fmtMs, fmtSize, hexDump, parseRawRequest, prettyBody, statusClass, statusText, toRawRequest } from '../format';
import { diffLines } from '../diff';
import { TokenPicker } from './TokenPicker';
import { CertHelp } from './TlsSettings';
import { mockFromExchange } from '../actions';
import { DecodableText, RegionEditor, decodeInto, encodeAll } from '../components/Decoded';
import { adjustForEdit, shiftRegions, type TextRegion } from '@siteinquisition/codecs/regionedit';

interface Options {
  refreshCookies: boolean;
  applyRules: boolean;
  loginMacro: boolean;
  followRedirects: boolean;
  csrf: boolean;
  sigv4: string;
  ignoreTls: boolean;
  protocol: 'h1' | 'h2' | 'h3';
  /** HTTP/2 only: how to get it from the server; '' lets the URL decide (ALPN for https, prior knowledge for http). */
  h2Method: '' | 'alpn' | 'upgrade' | 'prior-knowledge';
  /** Run this flow before each send; its variables fill {{var:...}}. */
  flow: string;
  /** Codec chain the body is encoded with after tokens are filled in, e.g. "base64,json". */
  encode: string;
  /** JSON fields written decoded and encoded on send: "$.payload = base64>json; $.sig = hex". */
  fields: string;
}
const DEFAULT_OPTIONS: Options = { refreshCookies: false, applyRules: false, loginMacro: false, followRedirects: false, csrf: false, sigv4: '', ignoreTls: false, protocol: 'h1', h2Method: '', flow: '', encode: '', fields: '' };

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
      <DecodableText text={head} viewKey={`replay:${ex.id}:head`} label="Response headers" />
      {'\n\n'}
      {body.length === 0 ? <span className="faint">(no body)</span> : text === null ? bodyText : <DecodableText text={bodyText} viewKey={`replay:${ex.id}:body`} save={{ url: ex.url, side: 'response', bodyStart: 0 }} label="Response body" />}
    </pre>
  );
}

export function Replay({ tab }: { tab: ReplayTab }) {
  const { client, notify, select, setView, setQuery, sendToCodecs, sendToRace } = useApp();
  const [original, setOriginal] = useState<Shown | null>(null);
  const [originalReqBody, setOriginalReqBody] = useState<Uint8Array | null>(null);
  const [raw, setRaw] = useState('');
  // Parts of the editor shown decoded in place; encoded again on send.
  const [regions, setRegions] = useState<TextRegion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [opts, setOpts] = useState<Options>({ ...DEFAULT_OPTIONS, ...tab.options });
  const [profiles, setProfiles] = useState<AwsProfile[]>([]);
  const [flowNames, setFlowNames] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ sends: number; url: string | null; error: string | null } | null>(null);
  const [draftSends, setDraftSends] = useState<ExchangeSummary[]>([]);
  const [sends, setSends] = useState<ExchangeSummary[]>([]);
  const [shownId, setShownId] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [compare, setCompare] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // Send options are remembered per host, so the next replay to the same API starts the same way.
  const host = useMemo(() => {
    const m = /^[A-Z]+\s+(\S+)/.exec(raw);
    try {
      return m ? new URL(m[1]!).host : null;
    } catch {
      return null;
    }
  }, [raw]);
  const editorUrl = useMemo(() => /^[A-Z]+\s+(\S+)/.exec(raw)?.[1] ?? null, [raw]);
  const loadedHost = useRef<string | null>(null);
  /** The protocol the source request was captured on, when it was HTTP/2 or HTTP/3: Replay sends it the same way by default. */
  const capturedProtocol = useRef<'h2' | 'h3' | undefined>(undefined);
  useEffect(() => {
    if (!host || loadedHost.current === host) return;
    loadedHost.current = host;
    if (tab.options) return; // opened with explicit options, e.g. "cookies from jar"
    try {
      const saved = JSON.parse(localStorage.getItem(`siq.replayOptions.${host}`) ?? 'null') as Partial<Options> | null;
      if (saved) setOpts((o) => ({ ...o, ...saved, fields: o.fields, protocol: capturedProtocol.current ?? saved.protocol ?? o.protocol }));
    } catch {
      // storage unavailable or a bad entry; keep the defaults
    }
  }, [host, tab.options]);
  const changeOpts = (next: Options) => {
    setOpts(next);
    if (!host) return;
    try {
      localStorage.setItem(`siq.replayOptions.${host}`, JSON.stringify(next));
    } catch {
      // not remembered; fine
    }
  };

  const reset = useCallback(async () => {
    if (tab.draft) {
      setOriginal(null);
      setOriginalReqBody(null);
      setRaw(toRawRequest(tab.draft.method, tab.draft.url, tab.draft.headers, tab.draft.body ?? ''));
      setRegions([]);
      return;
    }
    const ex = await client.get(tab.exchangeId);
    const reqBody = ex.reqBodySize ? await client.body(ex.id, 'request', false) : new Uint8Array();
    const resBody = ex.state === 'pending' ? new Uint8Array() : await client.body(ex.id, 'response');
    setOriginal({ ex, body: resBody });
    setOriginalReqBody(reqBody);
    const text = asText(reqBody);
    // Saved field codecs for this URL: open the body with those fields decoded in place; they are encoded again on send.
    let body = text;
    let found: TextRegion[] = [];
    if (text) {
      try {
        const r = await client.fieldRegions(text, ex.url, 'request');
        if (r) {
          body = r.text;
          found = r.regions;
        }
      } catch {
        // leave the body as captured
      }
    }
    const v = ex.httpVersion ?? '';
    capturedProtocol.current = v.startsWith('2') ? 'h2' : v.startsWith('3') ? 'h3' : undefined;
    setOpts((o) => ({ ...o, fields: '', ...(capturedProtocol.current && !tab.options ? { protocol: capturedProtocol.current } : {}) }));
    const next = toRawRequest(ex.method, ex.url, ex.requestHeaders, body === null ? binaryMarker(reqBody.length) : body);
    setRaw(next);
    setRegions(body === null ? [] : shiftRegions(found, next.length - body.length));
  }, [client, tab.exchangeId, tab.draft, tab.options]);

  /** Decode (or encode back) the body's fields with the spec in the Fields box. */
  const convertFields = async (dir: 'decode' | 'encode') => {
    try {
      const parsed = parseRawRequest(raw);
      if (!parsed.body) return notify('There is no body to change.');
      const specs = await client.parseFieldSpecs(opts.fields);
      if (!specs.length) return notify('Write the fields first, e.g. $.payload = base64>json');
      const out = dir === 'decode' ? await client.decodeFields(parsed.body, specs) : await client.encodeFields(parsed.body, specs);
      if (!out) return notify('None of those fields are in the body, or the body is not JSON.');
      if (out.errors.length) notify(out.errors[0]!);
      setRaw(toRawRequest(parsed.method, parsed.url, parsed.headers, out.text));
      setRegions([]);
      if (dir === 'encode') setOpts((o) => ({ ...o, fields: '' }));
    } catch (e) {
      notify((e as Error).message);
    }
  };

  useEffect(() => {
    client.aws().then((a) => setProfiles(a.profiles), () => undefined);
    client.flows().then((f) => setFlowNames(f.map((x) => x.name)), () => undefined);
  }, [client]);

  // Token preview: how many sends, and the first one's URL, or the error a token gives.
  useEffect(() => {
    if (!/\{\{/.test(raw)) return setPreview(null);
    const t = window.setTimeout(() => {
      let parsed;
      try {
        parsed = parseRawRequest(raw);
      } catch {
        return;
      }
      client
        .previewTokens([parsed.url, ...parsed.headers.map(([, v]) => v), parsed.body ?? ''], parsed.url)
        .then((r) => setPreview({ sends: r.sends, url: r.resolved[0]?.text ?? null, error: r.resolved.find((x) => !x.ok)?.error ?? null }), () => setPreview(null));
    }, 250);
    return () => window.clearTimeout(t);
  }, [client, raw]);

  useEffect(() => {
    reset().catch((e: Error) => setError(`Could not load the original request: ${e.message}`));
  }, [reset]);

  const loadSends = useCallback(
    () => (tab.exchangeId ? client.replayHistory(tab.exchangeId).then(setSends, () => undefined) : Promise.resolve()),
    [client, tab.exchangeId],
  );
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
      // Decoded regions go back to their encoded form; ones holding tokens are encoded after the tokens are filled in.
      parsed = parseRawRequest(await encodeAll(client, { text: raw, regions }));
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setError(null);
    setSending(true);
    try {
      const marker = originalReqBody && parsed.body === binaryMarker(originalReqBody.length);
      const body = marker ? originalReqBody! : parsed.body ? new TextEncoder().encode(parsed.body) : undefined;
      const req = { method: parsed.method, url: parsed.url, headers: parsed.headers, body, replayOf: tab.exchangeId || null };
      const options: SendOptions = {
        tokens: true,
        refreshCookies: opts.refreshCookies,
        applyRules: opts.applyRules,
        loginMacro: opts.loginMacro,
        csrf: opts.csrf,
        followRedirects: opts.followRedirects ? 10 : 0,
        sigv4: opts.sigv4 || undefined,
        ignoreTlsErrors: opts.ignoreTls,
        protocol: opts.protocol === 'h1' ? undefined : opts.protocol,
        h2Method: opts.protocol === 'h2' && opts.h2Method ? opts.h2Method : undefined,
        flow: opts.flow || undefined,
        bodyChain: opts.encode ? opts.encode.split(/[,>\s]+/).filter(Boolean) : undefined,
        fieldCodecs: opts.fields.trim() ? await client.parseFieldSpecs(opts.fields) : undefined,
      };
      if (preview && preview.sends > 1) {
        const out = await client.replayBatch(req, { ...options, concurrency: 4 });
        notify(`Sent ${out.sends.length} of ${preview.sends}${out.errors.length ? `, ${out.errors.length} failed: ${out.errors[0]}` : ''}`);
        if (!tab.exchangeId) setDraftSends((d) => [...d, ...out.sends]);
        setShownId(out.sends[out.sends.length - 1]?.id ?? null);
        await loadSends();
        return;
      }
      const res = await client.replayWith(req, options);
      if (!tab.exchangeId) setDraftSends((d) => [...d, res]);
      setShownId(res.id);
      await loadSends();
      if (res.state !== 'complete') setError(`The request failed (${res.state}). Details are in the response pane.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }, [raw, regions, originalReqBody, client, tab.exchangeId, opts, preview, loadSends, notify]);

  const decodeSelection = () => {
    const el = editorRef.current;
    if (!el) return;
    let s = el.selectionStart;
    let e = el.selectionEnd;
    if (s === e) {
      // No selection: take the body.
      const at = raw.search(/\r?\n\r?\n/);
      if (at === -1) return notify('Select some text to decode, or add a body.');
      s = raw.indexOf('\n', raw.indexOf('\n', at) + 1) + 1;
      e = raw.length;
    }
    // Codecs writes back as it edits, so track where the value ends now.
    let end = e;
    sendToCodecs(raw.slice(s, e), `Replay ${tab.label}`, (text, live) => {
      const was = end;
      end = s + text.length;
      setRaw((cur) => cur.slice(0, s) + text + cur.slice(was));
      setRegions((r) => adjustForEdit(r, s, was, text.length));
      if (!live) setView('replay');
    });
  };

  /** Show the selection (or the value under the caret) decoded in place. */
  const decodeInline = async () => {
    const el = editorRef.current;
    try {
      const out = await decodeInto(client, { text: raw, regions }, el?.selectionStart ?? 0, el?.selectionEnd ?? 0);
      setRaw(out.text);
      setRegions(out.regions);
      window.setTimeout(() => {
        el?.focus();
        el?.setSelectionRange(out.plan.start, out.plan.start);
      }, 0);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const insertToken = (token: string) => {
    const el = editorRef.current;
    const s = el?.selectionStart ?? raw.length;
    const e = el?.selectionEnd ?? raw.length;
    setRaw(raw.slice(0, s) + token + raw.slice(e));
    setRegions((r) => adjustForEdit(r, s, e, token.length, raw));
    window.setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(s + token.length, s + token.length);
    }, 0);
  };

  const opt = (k: keyof Options, label: string, title: string) => (
    <label className="check" title={title}>
      <input type="checkbox" checked={opts[k] as boolean} onChange={(e) => changeOpts({ ...opts, [k]: e.target.checked })} /> {label}
    </label>
  );

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && e.target === editorRef.current) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) decodeSelection();
      else void decodeInline();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      void send();
    }
  };

  const ordered = useMemo(() => [...(tab.exchangeId ? sends : draftSends)].sort((a, b) => (a.id < b.id ? -1 : 1)), [sends, draftSends, tab.exchangeId]);
  const index = ordered.findIndex((s) => s.id === shownId);
  const showOriginal = !shownId;

  return (
    <div className="replay" onKeyDown={onKey}>
      <div className="replay-bar">
        <span className="panel-title">
          <span className={`mono m-${tab.method}`}>{tab.method}</span> {tab.label}
        </span>
        <button className="btn primary" onClick={() => void send()} disabled={sending || !raw} title="Ctrl Enter">
          <Icon name="replay" size={13} /> {sending ? 'Sending...' : preview && preview.sends > 1 ? `Send ${preview.sends}` : 'Send'}
        </button>
        <div className="segmented" role="group" aria-label="Sends">
          <button className="seg" aria-pressed={showOriginal} onClick={() => setShownId(null)} disabled={!tab.exchangeId}>
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
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} disabled={showOriginal} /> Diff with original
        </label>
        <span style={{ flex: 1 }} />
        <button className="btn small" onClick={() => void decodeInline()} title="Show the selection, or the value under the caret, decoded in place. It is encoded again on send. Ctrl D">
          Decode
        </button>
        <button className="btn small" onClick={decodeSelection} title="Open the selection (or the body) in Codecs, then put the result back. Ctrl Shift D">
          Open in Codecs
        </button>
        <button
          className="btn small"
          onClick={() => void encodeAll(client, { text: raw, regions }).then((r) => sendToRace([{ label: tab.label, raw: r, replayOf: tab.exchangeId || undefined }]), (e: Error) => notify(e.message))}
          title="Add this request, as edited, to the Race view"
        >
          <Icon name="race" size={12} /> Send to Race
        </button>
        <button className="btn small" onClick={() => reset().catch((e: Error) => notify(e.message))}>
          {tab.draft ? 'Reset draft' : 'Reset to original'}
        </button>
        {(shownId || tab.exchangeId) && (
          <button
            className="btn small"
            title="Make a mock rule that answers this request with the response shown below"
            onClick={() =>
              client
                .get(shownId ?? tab.exchangeId)
                .then((ex) => mockFromExchange(client, ex))
                .then((n) => notify(`Mock "${n}" added. Edit it in Rules, Mocks.`), (e: Error) => notify(e.message))
            }
          >
            Mock this response
          </button>
        )}
        {tab.exchangeId && (
          <button
            className="btn small"
            onClick={() => {
              setQuery(`replayof:${tab.exchangeId}`);
              setView('history');
            }}
          >
            All sends in History
          </button>
        )}
      </div>
      <div className="replay-options" aria-label="Send options">
        <label className="check" title="HTTP/2 and HTTP/3 send with the built-in stacks, so the server's own answer shows: a server without HTTP/2 fails the send rather than falling back. HTTP/3 needs an https URL.">
          Protocol
          <select className="input" value={opts.protocol} onChange={(e) => changeOpts({ ...opts, protocol: e.target.value as Options['protocol'] })} aria-label="Protocol">
            <option value="h1">HTTP/1.1</option>
            <option value="h2">HTTP/2</option>
            <option value="h3">HTTP/3</option>
          </select>
        </label>
        {opts.protocol === 'h2' && (
          <label className="check" title="How to ask the server for HTTP/2. Automatic: ALPN over TLS for https, prior knowledge for http.">
            via
            <select className="input" value={opts.h2Method} onChange={(e) => changeOpts({ ...opts, h2Method: e.target.value as Options['h2Method'] })} aria-label="HTTP/2 via">
              <option value="">Automatic</option>
              <option value="alpn">ALPN (TLS)</option>
              <option value="upgrade">h2c upgrade</option>
              <option value="prior-knowledge">Prior knowledge</option>
            </select>
          </label>
        )}
        {opt('refreshCookies', 'Fresh cookies', 'Replace the Cookie header with the current cookie jar')}
        {opt('applyRules', 'Apply rules', 'Run enabled request match and replace rules')}
        {opt('loginMacro', 'Log in on 401/403', 'Run the login macro for this host and send again')}
        {opt('csrf', 'Fresh CSRF token', 'Put the latest captured CSRF token in; load a new one and retry if the server rejects it (set up in the Inspector, Tech and CSRF tab)')}
        {opt('followRedirects', 'Follow redirects', 'Follow up to 10 redirects; each hop is recorded')}
        {opt('ignoreTls', 'Ignore TLS errors', 'Accept any upstream certificate')}
        <label className="check" title="Sign with AWS SigV4">
          SigV4
          <select className="input" value={opts.sigv4} onChange={(e) => changeOpts({ ...opts, sigv4: e.target.value })} aria-label="SigV4 profile">
            <option value="">off</option>
            {profiles.length > 0 && <option value="auto">auto (by host or captured signature)</option>}
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="check" title="Run a flow before each send (a batch runs it once per send); its variables fill {{var:name}}">
          Run flow first
          <select className="input" value={opts.flow} onChange={(e) => changeOpts({ ...opts, flow: e.target.value })} aria-label="Run flow first">
            <option value="">none</option>
            {flowNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="check" title="Write the body decoded; after tokens are filled in it is encoded with this codec chain, outermost first (e.g. base64,json)">
          Encode body
          <input className="input mono" value={opts.encode} placeholder="none" onChange={(e) => changeOpts({ ...opts, encode: e.target.value })} aria-label="Encode body with" style={{ width: 110 }} />
        </label>
        <label className="check" title="JSON fields the editor shows decoded; each is encoded with its chain on send. Example: $.payload = base64>json; $.meta.sig = hex. Saved ones (Codecs, Field codecs) fill this in.">
          Fields
          <input className="input mono" value={opts.fields} placeholder="$.field = base64>json" onChange={(e) => setOpts({ ...opts, fields: e.target.value })} aria-label="Encode fields with" style={{ width: 200 }} />
        </label>
        {opts.fields.trim() && (
          <>
            <button className="btn small" onClick={() => void convertFields('decode')} title="Decode these fields in the editor now">
              Decode
            </button>
            <button className="btn small" onClick={() => void convertFields('encode')} title="Put the encoded values back in the editor and stop encoding on send">
              Encode back
            </button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <TokenPicker onPick={insertToken} />
      </div>
      {error && (
        <div className="banner" role="alert" style={{ margin: 8 }}>
          {error}
        </div>
      )}
      {shown?.ex.error && <CertHelp url={shown.ex.url} error={shown.ex.error} />}
      <div className="replay-split">
        <section>
          <div className="sec-head">
            <b style={{ color: 'var(--text)' }}>Request</b>
            <span>Raw. Edit anything; Content-Length is recalculated on send.</span>
          </div>
          {preview && (
            <div className={`token-preview${preview.error ? ' bad' : ''}`} aria-live="polite" data-testid="token-preview">
              {preview.error ? `Token problem: ${preview.error}` : `${preview.sends === 1 ? 'Tokens resolve to' : `${preview.sends} sends, first is`} ${preview.url ?? ''}`}
            </div>
          )}
          <RegionEditor
            decodeKey={false}
            textareaRef={editorRef}
            aria-label="Raw request"
            spellCheck={false}
            value={raw}
            regions={regions}
            save={editorUrl ? { url: editorUrl, side: 'request', bodyStart: raw.indexOf('\n\n') + 2 } : undefined}
            onChange={(d) => {
              setRaw(d.text);
              setRegions(d.regions);
            }}
          />
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
