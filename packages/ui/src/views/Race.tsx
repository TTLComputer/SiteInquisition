import { useState } from 'react';
import type { RaceResult } from '../api';
import { useApp, type RaceItem } from '../state';
import { Icon } from '../components/icons';
import { fmtMs, parseRawRequest, toRawRequest } from '../format';
import { bodyText } from '../actions';
import { ReplayButton } from '../components/ReplayButton';
import { RegionEditor } from '../components/Decoded';

type Sync = 'last-byte' | 'single-packet' | 'h3-single-datagram' | 'none';
const SYNC: Array<{ id: Sync; label: string; hint: string }> = [
  { id: 'last-byte', label: 'Last byte', hint: 'HTTP/1.1: send everything but the last byte on separate connections, then release all last bytes together.' },
  { id: 'single-packet', label: 'Single packet', hint: 'HTTP/2: all requests on one connection, every stream held at its last byte, then all final frames in one TCP write. The server decides HTTP/2 (ALPN for https, prior knowledge for http); one that does not take it fails the race rather than falling back. One origin only. The Protocol lab has more controls.' },
  { id: 'h3-single-datagram', label: 'Single datagram', hint: 'HTTP/3: all requests on one QUIC connection, every stream held at its last byte, then all last bytes in one UDP datagram. One origin only. The Protocol lab has more controls.' },
  { id: 'none', label: 'Plain timers', hint: 'Start each request at its offset with no synchronisation. Good for spacing sends out.' },
];

/**
 * Race-timed replay: line up requests with offsets (0 means "together"),
 * pick how to synchronise them, and see what came back for each run.
 */
export function Race() {
  const { client, raceItems, setRaceItems, selectedId, notify, select, setView, setQuery, openReplayById } = useApp();
  const [sync, setSync] = useState<Sync>('last-byte');
  const [repeat, setRepeat] = useState(1);
  const [jitter, setJitter] = useState(0);
  const [ignoreTls, setIgnoreTls] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RaceResult | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const patch = (key: string, p: Partial<RaceItem>) => setRaceItems(raceItems.map((i) => (i.key === key ? { ...i, ...p } : i)));

  const addSelected = async () => {
    if (!selectedId) return notify('Select a request in History first.');
    const ex = await client.get(selectedId);
    const body = ex.reqBodySize ? await bodyText(client, ex.id, 'request').catch(() => '') : '';
    setRaceItems([...raceItems, { key: `${Date.now()}`, label: ex.path.split('?')[0]!.split('/').pop() || '/', raw: toRawRequest(ex.method, ex.url, ex.requestHeaders, body), offsetMs: 0, replayOf: ex.id }]);
  };

  const copies = (item: RaceItem, n: number) => {
    const extra = Array.from({ length: n }, (_, i) => ({ ...item, key: `${item.key}-c${Date.now()}-${i}` }));
    setRaceItems([...raceItems, ...extra]);
  };

  const run = async () => {
    setRunning(true);
    try {
      const requests = (await Promise.all(raceItems.map(async (i) => ({ ...i, raw: i.regions?.length ? (await client.encodeRegions(i.raw, i.regions)).text : i.raw })))).map((i) => {
        const p = parseRawRequest(i.raw);
        return { method: p.method, url: p.url, headers: p.headers, body: p.body ? new TextEncoder().encode(p.body) : undefined, offsetMs: i.offsetMs, replayOf: i.replayOf ?? null };
      });
      setResult(await client.race(requests, { sync, repeat, jitterMs: jitter, ignoreTlsErrors: ignoreTls }));
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const maxActual = Math.max(1, ...(result?.runs.flatMap((r) => r.sends.map((s) => (Number.isFinite(s.actualMs) ? s.actualMs : 0))) ?? []));

  return (
    <div className="page race">
      <div className="replay-bar">
        <span className="panel-title">Race</span>
        <div className="segmented" role="group" aria-label="Synchronisation">
          {SYNC.map((s) => (
            <button key={s.id} className="seg" aria-pressed={sync === s.id} title={s.hint} onClick={() => setSync(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <label className="check">
          Runs
          <input className="input mono" type="number" min={1} max={50} value={repeat} onChange={(e) => setRepeat(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} style={{ width: 64 }} aria-label="Runs" />
        </label>
        <label className="check" title="Add a random 0 to N ms to each offset">
          Jitter ms
          <input className="input mono" type="number" min={0} value={jitter} onChange={(e) => setJitter(Math.max(0, Number(e.target.value) || 0))} style={{ width: 64 }} aria-label="Jitter" />
        </label>
        <label className="check">
          <input type="checkbox" checked={ignoreTls} onChange={(e) => setIgnoreTls(e.target.checked)} /> Ignore TLS errors
        </label>
        <span style={{ flex: 1 }} />
        <button className="btn small" onClick={() => void addSelected()} disabled={!selectedId} title="Add the request selected in History">
          Add selected request
        </button>
        <button className="btn primary" onClick={() => void run()} disabled={running || raceItems.length === 0}>
          <Icon name="race" size={13} /> {running ? 'Racing...' : `Race ${raceItems.length}`}
        </button>
      </div>
      <div className="faint" style={{ padding: '6px 12px', fontSize: 12 }}>
        {SYNC.find((s) => s.id === sync)!.hint}
      </div>
      {raceItems.length === 0 ? (
        <div className="empty">
          <div className="panel-title">Nothing lined up</div>
          <div style={{ maxWidth: 520 }}>Send requests here with Race in the inspector, Send to Race in a Replay tab or the History right-click menu, or select a request in History and press Add selected request.</div>
        </div>
      ) : (
        <div className="race-items">
          {raceItems.map((it, i) => {
            let line = '';
            try {
              const p = parseRawRequest(it.raw);
              line = `${p.method} ${p.url}`;
            } catch (e) {
              line = (e as Error).message;
            }
            return (
              <div key={it.key} className="card race-item">
                <div className="race-item-head">
                  <span className="mono faint">#{i + 1}</span>
                  <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={line}>
                    {line}
                  </span>
                  <label className="check">
                    Offset ms
                    <input className="input mono" type="number" min={0} value={it.offsetMs} onChange={(e) => patch(it.key, { offsetMs: Math.max(0, Number(e.target.value) || 0) })} style={{ width: 72 }} aria-label={`Offset for request ${i + 1}`} />
                  </label>
                  <button className="btn small" onClick={() => setOpen(open === it.key ? null : it.key)} aria-expanded={open === it.key}>
                    Edit
                  </button>
                  <button className="btn small" onClick={() => copies(it, 1)}>
                    Duplicate
                  </button>
                  <button className="btn small" onClick={() => copies(it, 9)} title="Add 9 more copies (10 in all)">
                    ×10
                  </button>
                  <button className="icon-btn" aria-label={`Remove request ${i + 1}`} onClick={() => setRaceItems(raceItems.filter((x) => x.key !== it.key))}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
                {open === it.key && (
                  <RegionEditor
                    className="editor"
                    style={{ height: 180 }}
                    spellCheck={false}
                    value={it.raw}
                    regions={it.regions ?? []}
                    onChange={(d) => patch(it.key, { raw: d.text, regions: d.regions })}
                    aria-label={`Raw request ${i + 1}`}
                    title="Ctrl D shows a selected value decoded in place; it is encoded again when raced."
                  />
                )}
              </div>
            );
          })}
          <div>
            <button className="btn small" onClick={() => setRaceItems([])}>
              Clear all
            </button>
          </div>
        </div>
      )}
      {result && (
        <div className="race-results" aria-label="Race results">
          <div className="replay-bar">
            <span className="panel-title">Results</span>
            <span className="muted" style={{ fontSize: 12 }}>
              {result.runs.length} {result.runs.length === 1 ? 'run' : 'runs'} · {result.sync}
            </span>
            <span style={{ flex: 1 }} />
            <button
              className="btn small"
              onClick={() => {
                setQuery(`tag:race:${result.id}`);
                setView('history');
              }}
            >
              All sends in History
            </button>
          </div>
          {result.runs.map((r) => {
            const mixed = new Set(r.statuses).size > 1;
            return (
              <div key={r.run} className="card" style={{ margin: '8px 12px' }}>
                <div className="sec-head">
                  <b style={{ color: 'var(--text)' }}>Run {r.run + 1}</b>
                  <span>spread {fmtMs(r.spreadMs)}</span>
                  <span className={mixed ? 's-4' : ''}>{mixed ? `different outcomes: ${r.statuses.join(', ')}` : `all ${r.statuses[0] ?? 'failed'}`}</span>
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Planned</th>
                      <th>Fired</th>
                      <th style={{ width: '30%' }} />
                      <th>Status</th>
                      <th>Took</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {[...r.sends]
                      .sort((a, b) => a.index - b.index)
                      .map((s) => (
                        <tr key={s.exchangeId}>
                          <td className="mono">{s.index + 1}</td>
                          <td className="mono">{fmtMs(s.plannedMs)}</td>
                          <td className="mono">{Number.isFinite(s.actualMs) ? fmtMs(s.actualMs) : ''}</td>
                          <td>
                            <div className="timing-bar">{Number.isFinite(s.actualMs) && <span style={{ left: `${(s.actualMs / maxActual) * 95}%`, width: 4 }} />}</div>
                          </td>
                          <td className={`mono ${s.status === null ? 's-err' : s.status >= 400 ? 's-4' : 's-2'}`}>{s.status ?? s.error ?? 'failed'}</td>
                          <td className="mono">{fmtMs(s.durationMs)}</td>
                          <td>
                            <button
                              className="btn small"
                              onClick={() => {
                                select(s.exchangeId);
                                setView('history');
                              }}
                            >
                              Inspect
                            </button>{' '}
                            <ReplayButton id={s.exchangeId} compact />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
