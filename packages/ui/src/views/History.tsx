import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ExchangeSummary, SiteMapHost } from '../api';
import { useApp } from '../state';
import { Icon } from '../components/icons';
import { fmtMs, fmtSize, fmtTime, statusClass, statusText, toRawRequest } from '../format';
import { bodyText, breakOn, mockFromExchange } from '../actions';
import { Coverage } from './Coverage';
import { Inspector } from './Inspector';

const replayName = (path: string) => {
  const last = (path.split('?')[0] ?? path).split('/').filter(Boolean).pop();
  return last ? decodeURIComponent(last).slice(0, 32) : '/';
};

export const ROW_HEIGHT = 28;
const PAGE = 300;
export const DRAG_TYPE = 'application/x-siq-exchange';

const CHIPS: Array<{ label: string; query: string }> = [
  { label: 'All', query: '' },
  { label: 'HTML', query: 'header:"text/html"' },
  { label: 'XHR', query: 'header:"application/json"' },
  { label: 'WebSocket', query: 'ws:true' },
  { label: 'Errors', query: 'status:>=400' },
  { label: 'Replays', query: 'source:replay' },
];

/** Replace any existing `key:` filters in a query with one new value (or remove them when value is null). */
export function withFilter(query: string, key: string, value: string | null): string {
  const re = new RegExp(`(^|\\s)-?${key}:("[^"]*"|\\S+)`, 'g');
  const rest = query.replace(re, ' ').replace(/\s+/g, ' ').trim();
  if (value === null) return rest;
  const v = /\s/.test(value) ? JSON.stringify(value) : value;
  return `${rest} ${key}:${v}`.trim();
}

function SiteMap({ query, setQuery, version }: { query: string; setQuery(q: string): void; version: number }) {
  const { client } = useApp();
  const [hosts, setHosts] = useState<SiteMapHost[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    client.siteMap().then(setHosts, () => undefined);
  }, [client, version]);
  const activeHost = /(?:^|\s)host:(\S+)/.exec(query)?.[1];
  const activePath = /(?:^|\s)path:(\S+)/.exec(query)?.[1];
  return (
    <aside className="sitemap" aria-label="Site map">
      <div className="label" style={{ padding: '4px 6px 8px' }}>
        Site map
      </div>
      {hosts.length === 0 && <div className="faint" style={{ padding: 6, fontSize: 12 }}>Hosts appear here once traffic is recorded.</div>}
      {hosts.map((h) => (
        <div key={h.host}>
          <button
            aria-pressed={activeHost === h.host && !activePath}
            aria-expanded={!!open[h.host]}
            onClick={() => {
              setOpen((o) => ({ ...o, [h.host]: !o[h.host] }));
              setQuery(withFilter(withFilter(query, 'path', null), 'host', activeHost === h.host && !activePath ? null : h.host));
            }}
          >
            <span style={{ display: 'inline-flex', transform: open[h.host] ? undefined : 'rotate(-90deg)' }}>
              <Icon name="chevron" size={12} />
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.host}</span>
            <span className="count">{h.count}</span>
          </button>
          {open[h.host] &&
            h.paths.map((p) => (
              <button
                key={p.segment}
                className="seg-row"
                aria-pressed={activeHost === h.host && activePath === p.segment}
                onClick={() => setQuery(withFilter(withFilter(query, 'host', h.host), 'path', activeHost === h.host && activePath === p.segment ? null : p.segment))}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.segment}</span>
                <span className="count">{p.count}</span>
              </button>
            ))}
        </div>
      ))}
    </aside>
  );
}

interface MenuState {
  x: number;
  y: number;
  row: ExchangeSummary;
}

function RowMenu({ menu, close, setQuery, query }: { menu: MenuState; close(): void; setQuery(q: string): void; query: string }) {
  const { client, openReplay, resendNow, notify, sendToCodecs, sendToRace, openStream, setView, select, flowPicks, setFlowPicks, openAt } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const [tagging, setTagging] = useState(false);
  const [tagName, setTagName] = useState('');
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [close]);
  const run = (fn: () => unknown) => () => {
    close();
    Promise.resolve(fn()).catch((e: Error) => notify(e.message));
  };
  const { row } = menu;
  const x = Math.min(menu.x, window.innerWidth - 280);
  const y = Math.max(8, Math.min(menu.y, window.innerHeight - 480));
  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left: x, top: y }}>
      <button role="menuitem" onClick={run(() => openReplay(row))}>
        Send to replay <kbd>Ctrl R</kbd>
      </button>
      <button role="menuitem" onClick={run(() => openReplay(row, { refreshCookies: true }))}>
        Send to replay, cookies from jar
      </button>
      <button role="menuitem" onClick={run(() => resendNow(row.id))}>
        {row.isWebSocket || row.scheme.startsWith('mqtt') ? 'Open in Streams' : 'Resend now'} <kbd>Ctrl Shift Enter</kbd>
      </button>
      {!row.isWebSocket && !row.scheme.startsWith('mqtt') && (
        <button
          role="menuitem"
          onClick={run(async () => {
            const ex = await client.get(row.id);
            const body = ex.reqBodySize ? await bodyText(client, row.id, 'request').catch(() => '') : '';
            sendToRace([{ label: replayName(row.path), raw: toRawRequest(ex.method, ex.url, ex.requestHeaders, body), replayOf: row.id }]);
          })}
        >
          Send to Race
        </button>
      )}
      {(row.isWebSocket || row.scheme.startsWith('mqtt')) && (
        <button role="menuitem" onClick={run(() => openStream(row.id))}>
          Open in Streams composer
        </button>
      )}
      <button role="menuitem" onClick={run(async () => sendToCodecs(await bodyText(client, row.id, 'response'), `${row.method} ${replayName(row.path)} response`))}>
        Decode response body <kbd>Ctrl D</kbd>
      </button>
      <button role="menuitem" onClick={run(async () => sendToCodecs(await bodyText(client, row.id, 'request'), `${row.method} ${replayName(row.path)} request`))}>
        Decode request body
      </button>
      <button
        role="menuitem"
        onClick={run(async () => {
          const name = await mockFromExchange(client, await client.get(row.id));
          notify(`Mock "${name}" added. Edit it in Rules, Mocks.`);
        })}
      >
        Mock this response
      </button>
      <button
        role="menuitem"
        onClick={run(async () => {
          await breakOn(client, row);
          notify('Breakpoint added: the next matching request will pause.');
        })}
      >
        Break on this endpoint
      </button>
      <button
        role="menuitem"
        onClick={run(() => {
          select(row.id);
          setView('timeline');
        })}
      >
        Show in Timeline
      </button>
      <button
        role="menuitem"
        onClick={run(() => {
          if (flowPicks.includes(row.id)) return notify('Already picked for the flow');
          setFlowPicks([...flowPicks, row.id]);
          notify(`${flowPicks.length + 1} picked. Make the flow in API, Flows.`);
        })}
      >
        Add to flow {flowPicks.length > 0 && <span className="faint">({flowPicks.length} picked)</span>}
      </button>
      {flowPicks.length > 0 && (
        <button role="menuitem" onClick={run(() => openAt('api', 'flows'))}>
          Make a flow from the {flowPicks.length} picked
        </button>
      )}
      {tagging ? (
        <form
          className="menu-form"
          onSubmit={(e) => {
            e.preventDefault();
            const t = tagName.trim();
            if (!t) return;
            run(async () => {
              const moved = await client.moveTag(t, row.id);
              notify(`Tag "${t}" is now on this request${moved.length ? `, moved from ${moved.length} other` : ''}. Use {{$${t}.field}} in requests.`);
            })();
          }}
        >
          <input className="input mono" autoFocus placeholder="tag name" value={tagName} onChange={(e) => setTagName(e.target.value)} aria-label="Reference tag" onKeyDown={(e) => e.stopPropagation()} />
          <button className="btn small primary" type="submit">
            Move here
          </button>
        </form>
      ) : (
        <button role="menuitem" onClick={() => setTagging(true)} title="Put a tag on this request only; {{$tag.field}} tokens then read from it">
          Move a reference tag here...
        </button>
      )}
      <button role="menuitem" onClick={run(() => navigator.clipboard.writeText(row.url).then(() => notify('URL copied')))}>
        Copy URL
      </button>
      <button role="menuitem" onClick={run(() => setQuery(withFilter(query, 'host', row.host)))}>
        Only this host
      </button>
      <button role="menuitem" onClick={run(() => setQuery(`flow:${row.flowId}`))}>
        Show its redirect flow
      </button>
      {row.replayOf === null && (
        <button role="menuitem" onClick={run(() => setQuery(`replayof:${row.id}`))}>
          Show replays of this request
        </button>
      )}
    </div>
  );
}

function Row({ row, selected, top, onSelect, onMenu }: { row: ExchangeSummary; selected: boolean; top: number; onSelect(): void; onMenu(e: React.MouseEvent): void }) {
  const { openReplay } = useApp();
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, row.id);
    e.dataTransfer.setData('text/plain', row.url);
    e.dataTransfer.effectAllowed = 'copy';
  };
  return (
    <div
      className="grid-row row"
      role="row"
      aria-selected={selected}
      data-id={row.id}
      draggable
      onDragStart={onDragStart}
      style={{ position: 'absolute', top, left: 0, right: 0 }}
      onClick={onSelect}
      onContextMenu={onMenu}
      onDoubleClick={() => openReplay(row)}
    >
      <span className="faint">{fmtTime(row.startedAt)}</span>
      <span className={`src-${row.source}`}>{row.source}</span>
      <span className={`m-${row.method}`}>{row.isWebSocket ? 'WS' : row.method}</span>
      <span title={`${row.scheme}://${row.host}:${row.port}`}>{row.host}</span>
      <span title={row.path}>
        {row.parentId && (
          <span className="hop" title="Redirect hop">
            ↳{' '}
          </span>
        )}
        {row.path}
      </span>
      <span className={statusClass(row)}>{statusText(row)}</span>
      <span className="muted">{fmtSize(row.resBodySize)}</span>
      <span className="muted">{fmtMs(row.durationMs)}</span>
      <span>
        {row.replayOf && <span className="tag">replay</span>}
        {row.tags.map((t) => (
          <span key={t} className="tag">
            {t}
          </span>
        ))}
      </span>
      <button
        className="pill"
        title="Send to replay (Ctrl R)"
        onClick={(e) => {
          e.stopPropagation();
          openReplay(row);
        }}
      >
        <Icon name="replay" size={11} /> Replay
      </button>
    </div>
  );
}

export function History() {
  const { client, query, setQuery, selectedId, select, saveView, notify, info } = useApp();
  const [draft, setDraft] = useState(query);
  const [rows, setRows] = useState<ExchangeSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [follow, setFollow] = useState(true);
  const [pendingNew, setPendingNew] = useState(0);
  const [showMap, setShowMap] = useState(true);
  const [mapVersion, setMapVersion] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [inspectorHeight, setInspectorHeight] = useState<number | null>(null);
  const [mode, setMode] = useState<'requests' | 'coverage'>('requests');
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => setDraft(query), [query]);
  // A new filter (from Coverage's "Calls" or anywhere else) means: show the matching requests.
  useEffect(() => setMode('requests'), [query]);

  // Apply typed filters after a short pause, so the table follows typing without a query per key.
  useEffect(() => {
    if (draft === query) return;
    const t = window.setTimeout(() => setQuery(draft), 250);
    return () => window.clearTimeout(t);
  }, [draft, query, setQuery]);

  const load = useCallback(
    async (mode: 'reset' | 'refresh' | 'more') => {
      const q = queryRef.current;
      const current = rowsRef.current;
      setLoading(true);
      try {
        const limit = mode === 'refresh' ? Math.min(Math.max(PAGE, current.length), 2000) : PAGE;
        const before = mode === 'more' ? current[current.length - 1]?.id : undefined;
        const page = await client.search(q, { limit, before });
        if (q !== queryRef.current) return; // a newer query took over
        setError(null);
        if (mode === 'more') {
          setRows([...current, ...page]);
          setExhausted(page.length < PAGE);
        } else {
          setRows(page);
          setExhausted(page.length < limit);
          setPendingNew(0);
        }
      } catch (e) {
        setError((e as Error).message);
        if (mode !== 'more') setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void load('reset');
    listRef.current?.scrollTo({ top: 0 });
  }, [query, load]);

  // Live follow: redraw from the core's change stream, debounced.
  const followRef = useRef(follow);
  followRef.current = follow;
  useEffect(() => {
    let timer: number | undefined;
    let mapTimer: number | undefined;
    const off = client.onChange((c) => {
      if (c.entity !== 'exchange') return;
      if (!mapTimer) mapTimer = window.setTimeout(() => ((mapTimer = undefined), setMapVersion((v) => v + 1)), 3000);
      const known = rowsRef.current.some((r) => r.id === c.entityId);
      if (!followRef.current && !known) {
        if (c.kind === 'exchange.request') setPendingNew((n) => n + 1);
        return;
      }
      if (known && !followRef.current && !(c.data && typeof c.data === 'object' && 'id' in c.data)) return;
      if (known && c.data && typeof c.data === 'object' && 'id' in c.data) {
        // Updates to rows on screen carry the new summary; patch in place.
        const summary = c.data as ExchangeSummary;
        setRows((rs) => rs.map((r) => (r.id === summary.id ? summary : r)));
        return;
      }
      if (timer === undefined) timer = window.setTimeout(() => ((timer = undefined), void load('refresh')), 300);
    });
    return () => {
      off();
      window.clearTimeout(timer);
      window.clearTimeout(mapTimer);
    };
  }, [client, load]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = listRef.current!;
    setScrollTop(el.scrollTop);
    if (!loading && !exhausted && el.scrollTop + el.clientHeight > el.scrollHeight - ROW_HEIGHT * 20) void load('more');
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 10);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + 10);
  const visible = useMemo(() => rows.slice(first, last), [rows, first, last]);

  const moveSelection = (delta: number) => {
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.id === selectedId);
    const next = Math.max(0, Math.min(rows.length - 1, i === -1 ? 0 : i + delta));
    select(rows[next]!.id);
    const el = listRef.current!;
    const top = next * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  };

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const r = rows.find((x) => x.id === selectedId);
      const el = listRef.current?.querySelector(`[data-id="${selectedId}"]`)?.getBoundingClientRect();
      if (r && el) {
        e.preventDefault();
        setMenu({ x: el.left + 200, y: el.bottom, row: r });
      }
    }
  };

  const activeChip = CHIPS.find((c) => c.query === query.trim());
  const firstRun = !query && rows.length === 0 && !loading && !error && info?.stats.exchanges === 0;

  const startResize = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const host = (e.currentTarget as HTMLElement).parentElement!;
    const startH = host.querySelector<HTMLElement>('.inspector')!.offsetHeight;
    const onMove = (ev: PointerEvent) => setInspectorHeight(Math.max(140, Math.min(host.clientHeight - 120, startH - (ev.clientY - startY))));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="history">
      <div className="filterbar">
        <div className="segmented" role="group" aria-label="History mode">
          <button className="seg" aria-pressed={mode === 'requests'} onClick={() => setMode('requests')}>
            Requests
          </button>
          <button className="seg" aria-pressed={mode === 'coverage'} onClick={() => setMode('coverage')} title="Endpoints seen per host, and paths referenced but never requested">
            Coverage
          </button>
        </div>
        <button className="icon-btn" aria-pressed={showMap} title={showMap ? 'Hide site map' : 'Show site map'} onClick={() => setShowMap((s) => !s)}>
          <Icon name="filter" size={14} />
        </button>
        <label className="filter-input">
          <span className="sr-only">Filter</span>
          <Icon name="search" size={14} color="var(--text-faint)" />
          <input
            id="filter-input"
            value={draft}
            spellCheck={false}
            placeholder='host:*.example.com method:POST status:>=400 "free text" -path:/static'
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setQuery(draft);
              if (e.key === 'Escape') setDraft(query);
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                listRef.current?.focus();
                moveSelection(selectedId ? 0 : 1);
              }
            }}
          />
          {draft && (
            <button className="icon-btn" aria-label="Clear filter" onClick={() => setQuery('')}>
              <Icon name="close" size={12} />
            </button>
          )}
        </label>
        <div className="segmented" role="group" aria-label="Quick filters">
          {CHIPS.map((c) => (
            <button key={c.label} className="seg" aria-pressed={activeChip === c} onClick={() => setQuery(c.query)} title={c.query || 'Everything recorded'}>
              {c.label}
            </button>
          ))}
        </div>
        <button
          className="btn small"
          disabled={!query.trim()}
          onClick={() => {
            const name = window.prompt('Name this view', query.slice(0, 40));
            if (name) saveView({ name, query }).then(() => notify(`Saved view "${name}"`), (e: Error) => notify(e.message));
          }}
        >
          Save view
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }} className="muted">
          <button className="switch" role="switch" aria-checked={follow} aria-label="Live follow" onClick={() => setFollow((f) => !f)} />
          Live
        </label>
        {pendingNew > 0 && (
          <button className="btn small primary" onClick={() => void load('reset')}>
            Show {pendingNew} new
          </button>
        )}
      </div>
      <div className="split">
        {showMap && <SiteMap query={query} setQuery={setQuery} version={mapVersion} />}
        <div className="table-wrap" style={{ display: 'flex', flexDirection: 'column' }}>
          {mode === 'coverage' && (
            <Coverage initialHost={rows.find((r) => r.id === selectedId)?.host ?? /(?:^|\s)host:(\S+)/.exec(query)?.[1]?.replace(/^\*\./, '') ?? null} />
          )}
          <div className="grid-row grid-head" role="row" style={mode === 'coverage' ? { display: 'none' } : undefined}>
            <span>Time</span>
            <span>Source</span>
            <span>Method</span>
            <span>Host</span>
            <span>Path</span>
            <span>Status</span>
            <span>Size</span>
            <span>Duration</span>
            <span>Tags</span>
            <span className="sr-only">Replay</span>
          </div>
          <div
            className="vlist"
            style={mode === 'coverage' ? { display: 'none' } : undefined}
            ref={listRef}
            role="grid"
            aria-label="Recorded exchanges"
            aria-rowcount={rows.length}
            tabIndex={0}
            onScroll={onScroll}
            onKeyDown={onListKey}
          >
            {error && <div className="empty error-text">Search failed: {error}</div>}
            {firstRun && <FirstRun />}
            {!error && !firstRun && info && rows.length === 0 && !loading && <div className="empty">Nothing matches this filter.</div>}
            <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
              {visible.map((r, i) => (
                <Row
                  key={r.id}
                  row={r}
                  top={(first + i) * ROW_HEIGHT}
                  selected={r.id === selectedId}
                  onSelect={() => select(r.id)}
                  onMenu={(e) => {
                    e.preventDefault();
                    select(r.id);
                    setMenu({ x: e.clientX, y: e.clientY, row: r });
                  }}
                />
              ))}
            </div>
          </div>
          {selectedId && (
            <>
              <button className="resizer" aria-label="Resize inspector" onPointerDown={startResize} />
              <Inspector id={selectedId} height={inspectorHeight} onClose={() => select(null)} />
            </>
          )}
        </div>
      </div>
      {menu && <RowMenu menu={menu} close={() => setMenu(null)} setQuery={setQuery} query={query} />}
    </div>
  );
}

function FirstRun() {
  const { client, setView, info } = useApp();
  const [seen, setSeen] = useState<Array<{ host: string; count: number }>>([]);
  useEffect(() => {
    client.seen().then(setSeen, () => undefined);
  }, [client]);
  return (
    <div className="empty" data-testid="first-run">
      <div className="panel-title">Nothing recorded yet</div>
      <div style={{ maxWidth: 520 }}>
        A new project records nothing until you say which hosts you are testing. Point a browser or device at{' '}
        <span className="mono">127.0.0.1:{info?.proxyPort ?? '...'}</span>, then add hosts to the scope.
      </div>
      <button className="btn primary" onClick={() => setView('rules')}>
        Open Rules › Scope
      </button>
      {seen.length > 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          Seen but not in scope: {seen.slice(0, 6).map((s) => s.host).join(', ')}
        </div>
      )}
    </div>
  );
}
