import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ExchangeSummary, WireStreamMessage } from '../api';
import { useApp } from '../state';
import { Icon } from '../components/icons';
import { fmtMs, fmtTime, statusText } from '../format';
import { withFilter } from './History';
import { ReplayButton } from '../components/ReplayButton';

type GroupBy = 'host' | 'flow' | 'connection';
const ZOOMS: Array<{ label: string; ms: number | null }> = [
  { label: '1 min', ms: 60_000 },
  { label: '5 min', ms: 300_000 },
  { label: '15 min', ms: 900_000 },
  { label: '1 h', ms: 3_600_000 },
  { label: 'All', ms: null },
];
const LANE = 26;
const LABEL_W = 220;
const MAX_ROWS = 3000;
const MAX_STREAMS = 20;

/** Bar colour by outcome; the status text is shown beside it on hover and in the detail strip. */
const barColor = (e: ExchangeSummary) => {
  if (e.state === 'error' || e.state === 'aborted') return 'var(--error)';
  if (e.status === null) return e.state === 'pending' ? 'var(--text-faint)' : 'var(--ok)';
  const c = Math.floor(e.status / 100);
  return c === 2 ? 'var(--ok)' : c === 3 ? 'var(--stream)' : c === 4 ? 'var(--warn)' : c === 5 ? 'var(--error)' : 'var(--accent)';
};

function niceStep(spanMs: number, px: number): number {
  const target = (spanMs / Math.max(px, 1)) * 110;
  const steps = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 86_400_000];
  return steps.find((s) => s >= target) ?? 86_400_000;
}

const groupKey = (e: ExchangeSummary, by: GroupBy) => (by === 'host' ? `${e.host}:${e.port}` : by === 'flow' ? e.flowId : (e.clientAddr ?? 'unknown client'));

export function Timeline() {
  const { client, query, setQuery, setView, select, selectedId, openReplay } = useApp();
  const [rows, setRows] = useState<ExchangeSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('host');
  const [zoom, setZoom] = useState<number | null>(null);
  const [live, setLive] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [frames, setFrames] = useState<Record<string, WireStreamMessage[]>>({});
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  const load = useCallback(async () => {
    const t = Date.now();
    const q = zoom ? `${query} since:${t - zoom}` : query;
    try {
      const page = await client.search(q.trim(), { limit: MAX_ROWS });
      setRows(page);
      setNow(t);
      setError(null);
      const streams = page.filter((e) => e.isWebSocket || e.scheme.startsWith('mqtt')).slice(0, MAX_STREAMS);
      const loaded = await Promise.all(streams.map(async (e) => [e.id, await client.streamMessages(e.id).catch(() => [])] as const));
      setFrames(Object.fromEntries(loaded));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client, query, zoom]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!live) return;
    let timer: number | undefined;
    const off = client.onChange((c) => {
      if ((c.entity === 'exchange' || c.entity === 'stream') && timer === undefined) timer = window.setTimeout(() => ((timer = undefined), void load()), 700);
    });
    // Keep the right edge at "now" while live, even when nothing new arrives.
    const tick = window.setInterval(() => setNow(Date.now()), zoom && zoom <= 300_000 ? 1000 : 5000);
    return () => {
      off();
      window.clearTimeout(timer);
      window.clearInterval(tick);
    };
  }, [client, live, load, zoom]);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth - LABEL_W)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { start, end } = useMemo(() => {
    if (zoom) return { start: now - zoom, end: now };
    if (rows.length === 0) return { start: now - 60_000, end: now };
    const first = Math.min(...rows.map((r) => r.startedAt));
    const last = Math.max(...rows.map((r) => r.startedAt + (r.durationMs ?? 0)));
    const pad = Math.max(1000, (last - first) * 0.03);
    return { start: first - pad, end: Math.max(last + pad, first + 1000) };
  }, [zoom, now, rows]);
  const span = end - start;
  const x = useCallback((t: number) => ((t - start) / span) * width, [start, span, width]);

  const lanes = useMemo(() => {
    const map = new Map<string, ExchangeSummary[]>();
    for (const r of [...rows].sort((a, b) => a.startedAt - b.startedAt)) {
      const k = groupKey(r, groupBy);
      const lane = map.get(k);
      if (lane) lane.push(r);
      else map.set(k, [r]);
    }
    return [...map.entries()].map(([key, items]) => ({ key, items, label: groupBy === 'flow' ? `${items[0]!.method} ${items[0]!.host}${items[0]!.path}` : key }));
  }, [rows, groupBy]);

  const ticks = useMemo(() => {
    const step = niceStep(span, width);
    const out: number[] = [];
    for (let t = Math.ceil(start / step) * step; t <= end; t += step) out.push(t);
    return out;
  }, [start, end, span, width]);

  const timeAt = (clientX: number) => {
    const rect = areaRef.current!.getBoundingClientRect();
    return start + ((clientX - rect.left - LABEL_W) / width) * span;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.tl-bar')) return;
    const rect = areaRef.current!.getBoundingClientRect();
    if (e.clientX - rect.left < LABEL_W) return;
    const from = timeAt(e.clientX);
    setDrag({ from, to: from });
    const onMove = (ev: PointerEvent) => setDrag({ from, to: timeAt(ev.clientX) });
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const to = timeAt(ev.clientX);
      setDrag(null);
      if (Math.abs(x(to) - x(from)) < 6) return;
      const [a, b] = from < to ? [from, to] : [to, from];
      // The range becomes a History filter, so the table, inspector and replay all act on it.
      setQuery(withFilter(withFilter(query, 'since', String(Math.floor(a))), 'until', String(Math.ceil(b))));
      setView('history');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const selected = rows.find((r) => r.id === selectedId);

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="filterbar">
        <span className="label">Group by</span>
        <div className="segmented" role="group" aria-label="Group by">
          {(['host', 'flow', 'connection'] as const).map((g) => (
            <button key={g} className="seg" aria-pressed={groupBy === g} onClick={() => setGroupBy(g)}>
              {g === 'host' ? 'Host' : g === 'flow' ? 'Flow' : 'Connection'}
            </button>
          ))}
        </div>
        <span className="label">Zoom</span>
        <div className="segmented" role="group" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <button key={z.label} className="seg" aria-pressed={zoom === z.ms} onClick={() => setZoom(z.ms)}>
              {z.label}
            </button>
          ))}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }} className="muted">
          <button className="switch" role="switch" aria-checked={live} aria-label="Live" onClick={() => setLive((l) => !l)} />
          Live
        </label>
        <span style={{ flex: 1 }} />
        {query && (
          <span className="muted" style={{ fontSize: 12 }}>
            Traffic filter: <span className="mono">{query}</span>{' '}
            <button className="btn small" onClick={() => setQuery('')}>
              Clear
            </button>
          </span>
        )}
        <span className="faint" style={{ fontSize: 12 }}>
          {rows.length === MAX_ROWS ? `newest ${MAX_ROWS} shown` : `${rows.length} exchanges`} · drag across the lanes to filter Traffic
        </span>
      </div>
      {error && <div className="banner" style={{ margin: 8 }}>{error}</div>}
      <div className="tl" ref={areaRef} onPointerDown={onPointerDown} aria-label="Timeline">
        <div className="tl-axis" style={{ paddingLeft: LABEL_W }}>
          {ticks.map((t) => (
            <span key={t} className="tl-tick" style={{ left: LABEL_W + x(t) }}>
              {fmtTime(t)}
              {span < 20_000 ? `.${String(t % 1000).padStart(3, '0')}` : ''}
            </span>
          ))}
        </div>
        <div className="tl-lanes">
          {lanes.length === 0 && <div className="empty">No traffic in this window.</div>}
          {lanes.map((lane) => (
            <div className="tl-lane" key={lane.key} style={{ height: LANE }} data-testid="tl-lane">
              <span className="tl-label mono" title={lane.label} style={{ width: LABEL_W }}>
                {lane.label}
                <span className="faint" style={{ marginLeft: 6 }}>{lane.items.length}</span>
              </span>
              <div className="tl-track" style={{ width }}>
                {ticks.map((t) => (
                  <span key={t} className="tl-grid" style={{ left: x(t) }} />
                ))}
                {lane.items.map((e, i) => {
                  const left = x(e.startedAt);
                  const endAt = e.durationMs !== null ? e.startedAt + e.durationMs : e.state === 'pending' || e.isWebSocket ? now : e.startedAt;
                  const w = Math.max(3, x(endAt) - left);
                  if (left + w < 0 || left > width) return null;
                  const prev = lane.items[i - 1];
                  return (
                    <span key={e.id} style={{ display: 'contents' }}>
                      {groupBy === 'flow' && prev && <span className="tl-link" style={{ left: x(prev.startedAt), width: Math.max(0, left - x(prev.startedAt)) }} />}
                      <button
                        className={`tl-bar${e.source === 'replay' ? ' dashed' : ''}${e.id === selectedId ? ' sel' : ''}`}
                        style={{ left, width: w, borderColor: barColor(e), background: e.source === 'replay' ? 'transparent' : `color-mix(in srgb, ${barColor(e)} 55%, transparent)` }}
                        title={`${e.method} ${e.host}${e.path}\n${statusText(e) || e.state} · ${fmtMs(e.durationMs)} · ${fmtTime(e.startedAt)} · ${e.source}`}
                        aria-label={`${e.method} ${e.path} ${statusText(e)}`}
                        onClick={() => select(e.id)}
                        onDoubleClick={() => openReplay(e)}
                      />
                      {(frames[e.id] ?? []).map((m) => {
                        const fx = x(m.at);
                        return fx >= 0 && fx <= width ? <span key={m.id} className={`tl-frame ${m.direction === 'client' ? 'dir-client' : 'dir-server'}`} style={{ left: fx }} title={`${m.direction} ${m.opcode} ${m.size} B`} /> : null;
                      })}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {drag && (
          <div
            className="tl-range"
            style={{ left: LABEL_W + Math.min(x(drag.from), x(drag.to)), width: Math.abs(x(drag.to) - x(drag.from)) }}
          />
        )}
      </div>
      {selected && (
        <div className="tl-detail">
          <span className={`mono m-${selected.method}`}>{selected.method}</span>
          <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected.url}
          </span>
          <span className="mono">{statusText(selected)}</span>
          <span className="mono muted">{fmtMs(selected.durationMs)}</span>
          <button className="btn small" onClick={() => setView('history')}>
            Open in Traffic
          </button>
          <ReplayButton exchange={selected} primary />
        </div>
      )}
    </div>
  );
}
