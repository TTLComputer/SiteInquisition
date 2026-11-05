import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExchangeSummary, FramePreset, WireStreamMessage, WsRunOptions, WsRunState, WsScript, WsScriptStep, WsStepResult } from '../api';
import { base64ToBytes } from '../api';
import { useApp, type ReplayTab } from '../state';
import { Icon } from '../components/icons';
import { asText, hexDump } from '../format';
import { diffLines } from '../diff';
import { breakOnMessages } from '../actions';
import { summarizeFrame } from '@siteinquisition/codecs/protocols';
import { Messages } from './Inspector';
import { TokenPicker } from './TokenPicker';
import { CertHelp } from './TlsSettings';
import { RegionEditor, decodeInto, encodeAll } from '../components/Decoded';
import { adjustForEdit, type TextRegion } from '@siteinquisition/codecs/regionedit';

/** The SignalR record separator, shown as a visible character so it survives editing. */
const RS = '\x1e';
const RS_SHOWN = '␞';
const show = (t: string) => t.split(RS).join(RS_SHOWN);
const unshow = (t: string) => t.split(RS_SHOWN).join(RS);

/** A step being edited; a text message can have parts shown decoded in place (encoded again when it runs). */
type Keyed = WsScriptStep & { key: string; regions?: TextRegion[] };
let seq = 0;
const keyed = (s: WsScriptStep): Keyed => ({ ...s, key: `s${++seq}` });
const strip = ({ key: _k, regions: _r, ...s }: Keyed): WsScriptStep => s as WsScriptStep;

interface Options {
  refreshCookies: boolean;
  ignoreTls: boolean;
  keepAlive: boolean;
  closeAtEnd: boolean;
  /** Steps built from the capture wait for the server like the original did. */
  waits: boolean;
  /** Steps built from the capture keep the original gaps. */
  timing: boolean;
  speed: number;
  encode: string;
  fields: string;
  flow: string;
}
const DEFAULTS: Options = { refreshCookies: false, ignoreTls: false, keepAlive: true, closeAtEnd: false, waits: true, timing: false, speed: 1, encode: '', fields: '', flow: '' };

const handshakeText = (url: string, headers: Array<[string, string]>) => [`GET ${url}`, ...headers.map(([k, v]) => `${k}: ${v}`)].join('\n');
function parseHandshake(text: string): { url: string; headers: Array<[string, string]> } {
  const [first = '', ...lines] = text.split(/\r?\n/);
  const url = first.trim().replace(/^GET\s+/i, '').replace(/\s+HTTP\/[\d.]+$/i, '');
  if (!/^(wss?|https?):\/\//i.test(url)) throw new Error('The first line is the URL: GET wss://host/path');
  const headers = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(':');
      if (i <= 0) throw new Error(`Header line needs "Name: value": ${l}`);
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string];
    });
  return { url, headers };
}

/** Apply fn to the JSON inside a text message (plain, Socket.IO or SignalR framing); null when there is none. */
async function mapJson(text: string, fn: (json: string) => Promise<string>): Promise<string | null> {
  if (text.endsWith(RS)) {
    const recs = text.split(RS).slice(0, -1);
    if (!recs.length || !recs.every((r) => /^\s*[[{]/.test(r))) return null;
    return (await Promise.all(recs.map(fn))).join(RS) + RS;
  }
  const sio = /^(\d(?:\d(?:\d+-)?(?:\/[^,[{]*,)?\d*)?)([[{].*)$/s.exec(text);
  if (sio?.[1]) return sio[1] + (await fn(sio[2]!));
  if (/^\s*[[{]/.test(text)) return fn(text);
  return null;
}

const STATUS_BADGE: Record<WsStepResult['status'], string> = { pending: '', running: 'running', done: 'ok', skipped: '', timeout: 'warn', error: 'warn' };

function stepTitle(s: WsScriptStep): string {
  switch (s.kind) {
    case 'send':
      return 'Send';
    case 'wait':
      return 'Wait for the server';
    case 'frames':
      return 'Frames';
    default:
      return 'Close';
  }
}

/**
 * Replay a WebSocket connection: the handshake and the client's messages as
 * an editable script (send, wait for the server, exact frames, close), run
 * on a new connection. Messages take Replay tokens and codecs like a request
 * body, and every run is kept as a send you can step through and compare.
 */
export function WsReplay({ tab }: { tab: ReplayTab }) {
  const { client, notify, select, setView, setQuery, sendToCodecs, openStream } = useApp();
  const [original, setOriginal] = useState<ExchangeSummary | null>(null);
  const [handshake, setHandshake] = useState('');
  const [steps, setSteps] = useState<Keyed[]>([]);
  const [opts, setOpts] = useState<Options>({ ...DEFAULTS, refreshCookies: !!tab.options?.refreshCookies, flow: tab.options?.flow ?? '' });
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [sends, setSends] = useState<ExchangeSummary[]>([]);
  const [shownId, setShownId] = useState<string | null>(null);
  const [runStates, setRunStates] = useState<Record<string, WsRunState>>({});
  const [presets, setPresets] = useState<FramePreset[]>([]);
  const [flowNames, setFlowNames] = useState<string[]>([]);
  const [live, setLive] = useState<string[]>([]);
  const [compare, setCompare] = useState(false);
  const [quick, setQuick] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; text: string | null; sends: number; error: string | null } | null>(null);
  const editors = useRef(new Map<string, HTMLTextAreaElement>());

  const url = useMemo(() => {
    try {
      return parseHandshake(handshake).url;
    } catch {
      return null;
    }
  }, [handshake]);

  const reset = useCallback(
    async (o: Pick<Options, 'waits' | 'timing' | 'keepAlive'> = opts) => {
      const ex = await client.get(tab.exchangeId);
      setOriginal(ex);
      const script = await client.wsScript(tab.exchangeId, { waits: o.waits, timing: o.timing, keepAlive: o.keepAlive });
      // Saved field codecs for this URL: show those fields decoded, and encode them again on send.
      let fields = '';
      let list = script.steps;
      try {
        const rules = await client.fieldCodecsFor(ex.url.replace(/^ws/, 'http'), 'request');
        if (rules.length) {
          const specs = rules.map((r) => ({ path: r.field, chain: r.chain }));
          const used = new Set<number>();
          list = await Promise.all(
            list.map(async (s) => {
              if (s.kind !== 'send' || (s.encoding ?? 'text') !== 'text') return s;
              const out = await mapJson(s.payload, async (json) => {
                const d = await client.decodeFields(json, specs);
                d?.counts.forEach((c, i) => c && used.add(i));
                return d?.text ?? json;
              });
              return out === null ? s : { ...s, payload: out };
            }),
          );
          fields = rules
            .filter((_, i) => used.has(i))
            .map((r) => `${r.field} = ${r.chain.join('>')}`)
            .join('; ');
        }
      } catch {
        // keep the messages as captured
      }
      setOpts((cur) => ({ ...cur, fields }));
      setHandshake(handshakeText(script.url, script.headers));
      setSteps(list.map((st) => keyed(st.kind === 'send' && (st.encoding ?? 'text') === 'text' ? { ...st, payload: show(st.payload) } : st)));
    },
    [client, tab.exchangeId, opts],
  );

  useEffect(() => {
    reset().catch((e: Error) => setError(`Could not load the connection: ${e.message}`));
    // Load once; the rebuild buttons call reset again with new options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tab.exchangeId]);

  useEffect(() => {
    client.framePresets().then(setPresets, () => undefined);
    client.flows().then((f) => setFlowNames(f.map((x) => x.name)), () => undefined);
  }, [client]);

  const loadSends = useCallback(() => client.replayHistory(tab.exchangeId).then(setSends, () => undefined), [client, tab.exchangeId]);
  const loadLive = useCallback(() => client.liveStreams().then((l) => setLive(l.ws), () => undefined), [client]);
  useEffect(() => {
    void loadSends();
    void loadLive();
    let t: number | undefined;
    const off = client.onChange((c) => {
      if (c.kind === 'wsreplay.progress') {
        const st = c.data as WsRunState;
        setRunStates((cur) => ({ ...cur, [st.exchangeId]: st }));
      }
      if ((c.entity === 'stream' || c.entity === 'exchange') && t === undefined) t = window.setTimeout(() => ((t = undefined), void loadSends(), void loadLive()), 500);
    });
    return () => {
      off();
      window.clearTimeout(t);
    };
  }, [client, loadSends, loadLive]);

  // The run state of the send on show, for step badges (fetched once in case its events came before this tab).
  useEffect(() => {
    if (!shownId || runStates[shownId]) return;
    client.wsRunState(shownId).then((st) => st && setRunStates((cur) => ({ ...cur, [shownId]: st })), () => undefined);
  }, [client, shownId, runStates]);
  const shownState = shownId ? runStates[shownId] : undefined;
  const shownSummary = shownId ? sends.find((s) => s.id === shownId) : original;
  const shownOpen = !!shownId && live.includes(shownId);

  // Token preview for the message being edited.
  const focused = steps.find((s) => s.key === focus);
  const focusedText = focused?.kind === 'send' && (focused.encoding ?? 'text') === 'text' ? focused.payload : null;
  useEffect(() => {
    if (!focused || focusedText === null || !/\{\{/.test(focusedText) || !url) return setPreview(null);
    const t = window.setTimeout(() => {
      client
        .previewTokens([unshow(focusedText)], url.replace(/^ws/, 'http'))
        .then((r) => setPreview({ key: focused.key, sends: r.sends, text: r.resolved[0]?.text ?? null, error: r.resolved.find((x) => !x.ok)?.error ?? null }), () => setPreview(null));
    }, 250);
    return () => window.clearTimeout(t);
  }, [client, focused, focusedText, url]);

  const runOptions = useCallback(async (): Promise<WsRunOptions> => {
    return {
      ignoreTlsErrors: opts.ignoreTls,
      refreshCookies: opts.refreshCookies,
      keepAlive: opts.keepAlive,
      closeAtEnd: opts.closeAtEnd,
      speed: opts.speed > 0 ? opts.speed : 1,
      encode: opts.encode ? opts.encode.split(/[,>\s]+/).filter(Boolean) : undefined,
      fields: opts.fields.trim() ? await client.parseFieldSpecs(opts.fields) : undefined,
      flow: opts.flow || undefined,
    };
  }, [client, opts]);

  const toWire = async (s: Keyed): Promise<WsScriptStep> => {
    const st = strip(s);
    if (st.kind !== 'send' || (st.encoding ?? 'text') !== 'text') return st;
    // Decoded parts go back encoded; ones holding tokens are encoded once the tokens are filled in.
    const payload = s.kind === 'send' && s.regions?.length ? await encodeAll(client, { text: st.payload, regions: s.regions }) : st.payload;
    return { ...st, payload: unshow(payload) };
  };

  const run = useCallback(async () => {
    let hs;
    try {
      hs = parseHandshake(handshake);
    } catch (e) {
      return setError((e as Error).message);
    }
    setError(null);
    setRunning(true);
    try {
      const script: WsScript = { url: hs.url, headers: hs.headers, steps: await Promise.all(steps.map(toWire)) };
      const r = await client.wsRun(script, await runOptions(), tab.exchangeId);
      if (r.state) setRunStates((cur) => ({ ...cur, [r.exchangeId]: r.state! }));
      setShownId(r.exchangeId);
      await Promise.all([loadSends(), loadLive()]);
    } catch (e) {
      setError(`Could not open the connection: ${(e as Error).message}`);
      await loadSends();
    } finally {
      setRunning(false);
    }
  }, [client, handshake, steps, runOptions, tab.exchangeId, loadSends, loadLive]);

  const sendQuick = async () => {
    if (!shownId || !quick) return;
    try {
      const st = await client.wsRunMore(shownId, [{ kind: 'send', opcode: 'text', payload: unshow(quick) }], await runOptions());
      const r = st.steps[0];
      if (r?.status === 'error') notify(r.error ?? 'Could not send');
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const update = (key: string, patch: Partial<WsScriptStep>) => setSteps((cur) => cur.map((s) => (s.key === key ? ({ ...s, ...patch } as Keyed) : s)));
  const move = (i: number, by: number) =>
    setSteps((cur) => {
      const j = i + by;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const add = (s: WsScriptStep, at = steps.length) => {
    const k = keyed(s);
    setSteps((cur) => [...cur.slice(0, at), k, ...cur.slice(at)]);
    setFocus(k.key);
  };

  /** Where Insert token and Decode selection act: the message being edited, or the last one. */
  const target = () => {
    const key = focus && steps.some((s) => s.key === focus && s.kind === 'send') ? focus : [...steps].reverse().find((s) => s.kind === 'send')?.key;
    return key ? { key, el: editors.current.get(key) ?? null, step: steps.find((s) => s.key === key) as Extract<Keyed, { kind: 'send' }> } : null;
  };

  const insertToken = (token: string) => {
    const t = target();
    if (!t) return add({ kind: 'send', opcode: 'text', payload: token });
    const s = t.el?.selectionStart ?? t.step.payload.length;
    const e = t.el?.selectionEnd ?? t.step.payload.length;
    update(t.key, { payload: t.step.payload.slice(0, s) + token + t.step.payload.slice(e) });
    window.setTimeout(() => {
      t.el?.focus();
      t.el?.setSelectionRange(s + token.length, s + token.length);
    }, 0);
  };

  const decodeSelection = () => {
    const t = target();
    if (!t) return notify('Add a message to decode first.');
    let s = t.el?.selectionStart ?? 0;
    let e = t.el?.selectionEnd ?? 0;
    if (s === e) {
      s = 0;
      e = t.step.payload.length;
    }
    let end = e;
    const payload = t.step.payload;
    sendToCodecs(unshow(payload.slice(s, e)), `WS Replay ${tab.label}`, (text, isLive) => {
      const was = end;
      end = s + show(text).length;
      setSteps((cur) => cur.map((x) => (x.key === t.key && x.kind === 'send' ? { ...x, payload: x.payload.slice(0, s) + show(text) + x.payload.slice(was), regions: adjustForEdit(x.regions ?? [], s, was, show(text).length) } : x)));
      if (!isLive) setView('replay');
    });
  };

  /** Show the selection (or the value under the caret) in the message being edited decoded in place. */
  const decodeInline = async () => {
    const t = target();
    if (!t) return notify('Add a message to decode first.');
    try {
      const out = await decodeInto(client, { text: t.step.payload, regions: t.step.regions ?? [] }, t.el?.selectionStart ?? 0, t.el?.selectionEnd ?? 0);
      setSteps((cur) => cur.map((x) => (x.key === t.key ? ({ ...x, payload: out.text, regions: out.regions } as Keyed) : x)));
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && e.target instanceof HTMLTextAreaElement && e.target.dataset.step) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) decodeSelection();
      else void decodeInline();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (e.target instanceof HTMLInputElement && e.target.dataset.quick) void sendQuick();
      else void run();
    }
  };

  const ordered = useMemo(() => [...sends].sort((a, b) => (a.id < b.id ? -1 : 1)), [sends]);
  const index = ordered.findIndex((s) => s.id === shownId);
  const opt = (k: keyof Options, label: string, title: string) => (
    <label className="check" title={title}>
      <input type="checkbox" checked={opts[k] as boolean} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} /> {label}
    </label>
  );
  const rebuild = (patch: Partial<Options>) => {
    const next = { ...opts, ...patch };
    setOpts(next);
    reset(next).catch((e: Error) => notify(e.message));
  };

  return (
    <div className="replay ws-replay" onKeyDown={onKey}>
      <div className="replay-bar">
        <span className="panel-title">
          <span className="mono m-WS">WS</span> {tab.label}
        </span>
        <button className="btn primary" onClick={() => void run()} disabled={running || !handshake} title="Open a new connection and run the steps (Ctrl Enter)">
          <Icon name="replay" size={13} /> {running ? 'Connecting...' : 'Run'}
        </button>
        <div className="segmented" role="group" aria-label="Sends">
          <button className="seg" aria-pressed={!shownId} onClick={() => setShownId(null)}>
            Original
          </button>
          <button className="seg" disabled={ordered.length === 0 || index <= 0} aria-label="Previous send" onClick={() => setShownId(ordered[index - 1]?.id ?? null)}>
            ‹
          </button>
          <span className="mono muted" style={{ alignSelf: 'center', fontSize: 12 }} aria-live="polite">
            {ordered.length === 0 ? 'no runs yet' : index === -1 ? `${ordered.length} ${ordered.length === 1 ? 'run' : 'runs'}` : `run ${index + 1} of ${ordered.length}`}
          </span>
          <button className="seg" disabled={ordered.length === 0 || index === ordered.length - 1} aria-label="Next send" onClick={() => setShownId(ordered[index + 1]?.id ?? ordered[0]?.id ?? null)}>
            ›
          </button>
        </div>
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} disabled={!shownId} /> Diff with original
        </label>
        <span style={{ flex: 1 }} />
        <button className="btn small" onClick={() => void decodeInline()} title="Show the selection, or the value under the caret, decoded in place in the message being edited. It is encoded again when the script runs. Ctrl D">
          Decode
        </button>
        <button className="btn small" onClick={decodeSelection} title="Open the selection (or the message being edited) in Codecs, then put the result back. Ctrl Shift D">
          Open in Codecs
        </button>
        <button
          className="btn small"
          title="Pause messages on connections to this URL so you can edit or drop them (Rules, Breakpoints)"
          onClick={() =>
            original &&
            breakOnMessages(client, original).then(
              () => notify('Messages on this URL will pause in Rules, Breakpoints. Traffic through the proxy waits there for you.'),
              (e: Error) => notify(e.message),
            )
          }
        >
          Break on messages
        </button>
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
          All runs in History
        </button>
      </div>
      <div className="replay-options" aria-label="Run options">
        {opt('refreshCookies', 'Fresh cookies', 'Replace the Cookie header with the current cookie jar')}
        {opt('keepAlive', 'Keep alive', 'Answer Socket.IO (Engine.IO) pings and send its client pings, and leave heartbeats out of waits')}
        {opt('closeAtEnd', 'Close at end', 'Close the connection after the last step; otherwise it stays open so you can keep sending')}
        {opt('ignoreTls', 'Ignore TLS errors', 'Accept any upstream certificate')}
        <label className="check" title="Divide every delay by this, e.g. 2 runs twice as fast">
          Speed
          <select className="input" value={opts.speed} onChange={(e) => setOpts({ ...opts, speed: Number(e.target.value) })} aria-label="Speed">
            {[0.5, 1, 2, 5, 10].map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
        </label>
        <label className="check" title="Run a flow before connecting; its variables fill {{var:name}}">
          Run flow first
          <select className="input" value={opts.flow} onChange={(e) => setOpts({ ...opts, flow: e.target.value })} aria-label="Run flow first">
            <option value="">none</option>
            {flowNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="check" title="Write text messages decoded; after tokens are filled in each is encoded with this codec chain, outermost first (e.g. base64)">
          Encode messages
          <input className="input mono" value={opts.encode} placeholder="none" onChange={(e) => setOpts({ ...opts, encode: e.target.value })} aria-label="Encode messages with" style={{ width: 110 }} />
        </label>
        <label className="check" title="JSON fields shown decoded and encoded on send, inside Socket.IO and SignalR framing too. Example: $[1].payload = base64>json. Saved field codecs fill this in.">
          Fields
          <input className="input mono" value={opts.fields} placeholder="$.field = base64>json" onChange={(e) => setOpts({ ...opts, fields: e.target.value })} aria-label="Encode fields with" style={{ width: 200 }} />
        </label>
        <span style={{ flex: 1 }} />
        <TokenPicker onPick={insertToken} />
      </div>
      {error && (
        <div className="banner" role="alert" style={{ margin: 8 }}>
          {error}
        </div>
      )}
      {error && url && /certificate|self[- ]signed|TLS|SSL/i.test(error) && <CertHelp url={url.replace(/^ws/, 'http')} error={error} />}
      <div className="replay-split">
        <section>
          <div className="sec-head">
            <b style={{ color: 'var(--text)' }}>Handshake</b>
            <span>URL, then headers. Key, version and extensions are set on connect. Tokens work here.</span>
          </div>
          <textarea className="editor ws-handshake" aria-label="Handshake" spellCheck={false} value={handshake} onChange={(e) => setHandshake(e.target.value)} />
          <div className="sec-head">
            <b style={{ color: 'var(--text)' }}>Steps</b>
            <span>{steps.length ? `${steps.length} ${steps.length === 1 ? 'step' : 'steps'} from the capture, as edited` : 'No client messages were captured. Add steps below.'}</span>
            <span style={{ flex: 1 }} />
            <label className="check" title="Rebuild the steps with a wait before each send for the server messages the client had seen">
              <input type="checkbox" checked={opts.waits} onChange={(e) => rebuild({ waits: e.target.checked })} /> Waits
            </label>
            <label className="check" title="Rebuild the steps with the original gaps between messages">
              <input type="checkbox" checked={opts.timing} onChange={(e) => rebuild({ timing: e.target.checked })} /> Original timing
            </label>
          </div>
          <div className="ws-steps" aria-label="Steps">
            {steps.map((s, i) => (
              <StepEditor
                key={s.key}
                step={s}
                index={i}
                count={steps.length}
                result={shownState?.steps[i]}
                presets={presets}
                preview={preview?.key === s.key ? preview : null}
                onChange={(p) => update(s.key, p)}
                onRegions={(payload, regions) => setSteps((cur) => cur.map((x) => (x.key === s.key ? ({ ...x, payload, regions } as Keyed) : x)))}
                onMove={(by) => move(i, by)}
                onDuplicate={() => add({ ...strip(s) }, i + 1)}
                onDelete={() => setSteps((cur) => cur.filter((x) => x.key !== s.key))}
                onFocus={() => setFocus(s.key)}
                editorRef={(el) => (el ? editors.current.set(s.key, el) : editors.current.delete(s.key))}
              />
            ))}
            <div className="ws-add" role="group" aria-label="Add a step">
              <button className="btn small" onClick={() => add({ kind: 'send', opcode: 'text', payload: '' })}>
                <Icon name="plus" size={11} /> Message
              </button>
              <button className="btn small" onClick={() => add({ kind: 'wait', timeoutMs: 10_000 })}>
                <Icon name="plus" size={11} /> Wait
              </button>
              <button className="btn small" onClick={() => add({ kind: 'frames', steps: [{ kind: 'frame', opcode: 'text', payload: '' }] })} title="Exact frames: opcode, FIN, RSV bits, mask, length, as JSON">
                <Icon name="plus" size={11} /> Frames
              </button>
              <button className="btn small" onClick={() => add({ kind: 'close', code: 1000 })}>
                <Icon name="plus" size={11} /> Close
              </button>
            </div>
          </div>
        </section>
        <section>
          <div className="sec-head">
            <b style={{ color: 'var(--text)' }}>Messages</b>
            <span>{shownId ? (shownOpen ? 'this run, live' : 'this run') : 'as originally captured'}</span>
            {shownState && (
              <span className={`badge${shownState.error ? ' warn' : ''}`} data-testid="run-status">
                {shownState.running ? 'running' : shownState.error ?? 'all steps ran'}
              </span>
            )}
            <span style={{ flex: 1 }} />
            {shownId && shownOpen && (
              <button className="btn small" onClick={() => client.streamClose(shownId).then(loadLive, (e: Error) => notify(e.message))}>
                Close connection
              </button>
            )}
            {shownSummary && (
              <>
                <button className="btn small" onClick={() => openStream(shownSummary.id)} title="Open this connection in Streams for exact frames and presets">
                  Open in Streams
                </button>
                <button
                  className="btn small"
                  onClick={() => {
                    select(shownSummary.id);
                    setView('history');
                  }}
                >
                  Show in History
                </button>
              </>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {compare && shownId ? <ServerDiff a={tab.exchangeId} b={shownId} /> : <Messages exchangeId={shownId ?? tab.exchangeId} protocol="websocket" />}
          </div>
          {shownId && shownOpen && (
            <div className="composer-row ws-quick">
              <input
                className="input mono"
                data-quick="1"
                style={{ flex: 1 }}
                value={quick}
                onChange={(e) => setQuick(e.target.value)}
                placeholder="Send another message on this connection (tokens and codecs apply)"
                aria-label="Message to send now"
              />
              <button className="btn primary small" onClick={() => void sendQuick()} disabled={!quick} title="Ctrl Enter">
                Send
              </button>
              <button className="btn small" onClick={() => (quick ? (add({ kind: 'send', opcode: 'text', payload: quick }), setQuick('')) : undefined)} disabled={!quick} title="Add it to the steps instead">
                Add as step
              </button>
            </div>
          )}
        </section>
      </div>
      {steps.length === 0 && !original && <div className="faint" style={{ padding: 12 }}>Loading...</div>}
    </div>
  );
}

function StepEditor(props: {
  step: Keyed;
  index: number;
  count: number;
  result?: WsStepResult;
  presets: FramePreset[];
  preview: { text: string | null; sends: number; error: string | null } | null;
  onChange(p: Partial<WsScriptStep>): void;
  onMove(by: number): void;
  onDuplicate(): void;
  onDelete(): void;
  onFocus(): void;
  onRegions(payload: string, regions: TextRegion[]): void;
  editorRef(el: HTMLTextAreaElement | null): void;
}) {
  const { step: s, result: r } = props;
  const [framesText, setFramesText] = useState(() => (s.kind === 'frames' ? JSON.stringify(s.steps, null, 2) : ''));
  const [framesError, setFramesError] = useState<string | null>(null);
  const summary = s.kind === 'send' && (s.encoding ?? 'text') === 'text' ? summarizeFrame(unshow(s.payload)) : null;
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
  const off = s.enabled === false;
  return (
    <div className={`card ws-step${off ? ' off' : ''}${r?.status === 'done' ? ' passed' : r && ['error', 'timeout'].includes(r.status) ? ' failed' : ''}`} aria-label={`Step ${props.index + 1}`}>
      <div className="ws-step-head">
        <input type="checkbox" checked={!off} onChange={(e) => props.onChange({ enabled: e.target.checked })} aria-label="Run this step" />
        <span className="mono faint">{props.index + 1}</span>
        <b>{stepTitle(s)}</b>
        {s.kind === 'send' && (
          <>
            <select
              className="input"
              aria-label="Message type"
              value={s.opcode === 'text' ? 'text' : (s.encoding ?? 'base64')}
              onChange={(e) => {
                const v = e.target.value as 'text' | 'base64' | 'hex';
                props.onChange(v === 'text' ? { opcode: 'text', encoding: 'text' } : { opcode: 'binary', encoding: v });
              }}
            >
              <option value="text">Text</option>
              <option value="base64">Binary (base64)</option>
              <option value="hex">Binary (hex)</option>
            </select>
            <select className="input" aria-label="Send as" value={s.preset ?? 'single'} onChange={(e) => props.onChange({ preset: e.target.value === 'single' ? undefined : e.target.value })} title={props.presets.find((p) => p.id === (s.preset ?? 'single'))?.expect}>
              {props.presets.length === 0 && <option value="single">One frame</option>}
              {props.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {summary && (
              <span className="badge" title="Decoded realtime frame">
                {summary}
              </span>
            )}
          </>
        )}
        <label className="check" title="Wait this long before the step">
          after
          <input className="input mono" style={{ width: 64 }} value={s.delayMs ?? ''} placeholder="0" onChange={(e) => props.onChange({ delayMs: num(e.target.value) })} aria-label="Delay in ms" /> ms
        </label>
        {r && r.status !== 'pending' && (
          <span className={`badge ${STATUS_BADGE[r.status]}`} title={r.error} data-testid="step-status">
            {r.status === 'done' && s.kind === 'send' && (r.sent ?? 1) > 1 ? `sent ${r.sent}` : r.status === 'done' && s.kind === 'wait' && r.value !== undefined ? `saved ${r.value.slice(0, 24)}` : r.status}
            {r.error && r.status !== 'done' ? `: ${r.error}` : ''}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="icon-btn" aria-label="Move up" disabled={props.index === 0} onClick={() => props.onMove(-1)}>
          <Icon name="up" size={12} />
        </button>
        <button className="icon-btn" aria-label="Move down" disabled={props.index === props.count - 1} onClick={() => props.onMove(1)}>
          <Icon name="down" size={12} />
        </button>
        <button className="icon-btn" aria-label="Duplicate step" onClick={props.onDuplicate}>
          <Icon name="plus" size={12} />
        </button>
        <button className="icon-btn" aria-label="Delete step" onClick={props.onDelete}>
          <Icon name="trash" size={12} />
        </button>
      </div>
      {s.kind === 'send' && (
        <>
          {props.preview && (
            <div className={`token-preview${props.preview.error ? ' bad' : ''}`} data-testid="token-preview">
              {props.preview.error ? `Token problem: ${props.preview.error}` : `${props.preview.sends > 1 ? `${props.preview.sends} messages, first is ` : 'Sends '}${props.preview.text ?? ''}`}
            </div>
          )}
          <RegionEditor
            textareaRef={props.editorRef}
            data-step="1"
            spellCheck={false}
            rows={Math.min(12, Math.max(2, s.payload.split('\n').length))}
            value={s.payload}
            regions={s.regions ?? []}
            onFocus={props.onFocus}
            onChange={(d) => props.onRegions(d.text, d.regions)}
            aria-label={`Message ${props.index + 1}`}
            placeholder={s.opcode === 'text' ? 'Message text. Tokens such as {{var:name}} work here.' : 'Bytes'}
          />
        </>
      )}
      {s.kind === 'wait' && (
        <div className="extract-rows">
          <label className="extract-row">
            for
            <input className="input mono" value={s.count ?? 1} style={{ width: 48 }} onChange={(e) => props.onChange({ count: num(e.target.value) })} aria-label="How many messages" />
            {(s.count ?? 1) === 1 ? 'message' : 'messages'} containing
            <input className="input mono" value={s.match ?? ''} placeholder="anything, or /regex/" onChange={(e) => props.onChange({ match: e.target.value || undefined })} aria-label="Match" style={{ width: 180 }} />
          </label>
          <label className="extract-row">
            up to
            <input className="input mono" value={s.timeoutMs ?? 10_000} style={{ width: 72 }} onChange={(e) => props.onChange({ timeoutMs: num(e.target.value) })} aria-label="Timeout in ms" /> ms, then
            <select className="input" value={s.onTimeout ?? 'continue'} onChange={(e) => props.onChange({ onTimeout: e.target.value as 'continue' | 'stop' })} aria-label="On timeout">
              <option value="continue">carry on</option>
              <option value="stop">stop</option>
            </select>
          </label>
          <label className="extract-row" title="Save a value from the message into a variable; later steps use {{var:name}}">
            save
            <input className="input mono" value={s.extract?.from ?? ''} placeholder="$.token or /id=(\d+)/" style={{ width: 150 }} onChange={(e) => props.onChange({ extract: e.target.value || s.extract?.var ? { var: s.extract?.var ?? '', from: e.target.value } : undefined })} aria-label="Extract from" />
            as
            <input className="input mono" value={s.extract?.var ?? ''} placeholder="variable" style={{ width: 110 }} onChange={(e) => props.onChange({ extract: e.target.value || s.extract?.from ? { from: s.extract?.from ?? '', var: e.target.value } : undefined })} aria-label="Variable name" />
          </label>
          {s.note && <span className="faint">{s.note}</span>}
        </div>
      )}
      {s.kind === 'close' && (
        <div className="extract-rows">
          <label className="extract-row">
            code
            <input className="input mono" value={s.code ?? ''} placeholder="1000" style={{ width: 64 }} onChange={(e) => props.onChange({ code: num(e.target.value) })} aria-label="Close code" />
          </label>
          <label className="extract-row">
            reason
            <input className="input" value={s.reason ?? ''} onChange={(e) => props.onChange({ reason: e.target.value })} aria-label="Close reason" style={{ width: 200 }} />
          </label>
        </div>
      )}
      {s.kind === 'frames' && (
        <>
          {framesError && <div className="token-preview bad">{framesError}</div>}
          <textarea
            className="editor"
            spellCheck={false}
            rows={Math.min(14, Math.max(4, framesText.split('\n').length))}
            value={framesText}
            aria-label={`Frames ${props.index + 1}`}
            title='Frame plan steps: {"kind":"frame","opcode":"text","payload":"<base64>","fin":false,"mask":"none"}, {"kind":"raw","bytes":"<base64>"}, {"kind":"socket","action":"destroy"}'
            onChange={(e) => {
              setFramesText(e.target.value);
              try {
                const v = JSON.parse(e.target.value) as unknown;
                if (!Array.isArray(v)) throw new Error('a list of frame steps');
                setFramesError(null);
                props.onChange({ steps: v as never });
              } catch (err) {
                setFramesError(`Not a frame list yet: ${(err as Error).message}`);
              }
            }}
          />
        </>
      )}
    </div>
  );
}

/** Server messages of the original connection next to a run's, as a line diff. */
function ServerDiff({ a, b }: { a: string; b: string }) {
  const { client } = useApp();
  const [lines, setLines] = useState<ReturnType<typeof diffLines> | null>(null);
  useEffect(() => {
    let live = true;
    const text = (msgs: WireStreamMessage[]) =>
      msgs
        .filter((m) => m.direction === 'server' && (m.opcode === 'text' || m.opcode === 'binary'))
        .map((m) => {
          const bytes = base64ToBytes(m.base64);
          return show(asText(bytes) ?? hexDump(bytes).replace(/\n/g, ' '));
        })
        .join('\n');
    Promise.all([client.streamMessages(a), client.streamMessages(b)]).then(([x, y]) => live && setLines(diffLines(text(x), text(y))), () => undefined);
    return () => {
      live = false;
    };
  }, [client, a, b]);
  if (!lines) return <div className="empty">Loading...</div>;
  return (
    <pre className="raw" aria-label="Diff of server messages with the original">
      {lines.map((l, i) => (
        <div key={i} className={l.op === '+' ? 'diff-add' : l.op === '-' ? 'diff-del' : undefined}>
          {l.op === '=' ? '  ' : `${l.op} `}
          {l.text}
        </div>
      ))}
    </pre>
  );
}
