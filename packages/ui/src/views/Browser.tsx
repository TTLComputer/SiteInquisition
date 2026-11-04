import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserTabState, ExchangeSummary, ScopeDecision } from '../api';
import { useApp } from '../state';
import { Icon } from '../components/icons';
import { fmtTime, statusClass, statusText } from '../format';

const START_URL = 'about:blank';

/** Accepts "example.com/path", "localhost:3000" and full URLs. */
export function normalizeAddress(input: string): string {
  const t = input.trim();
  if (!t) return START_URL;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[\w.-]+:\d+/.test(t)) return t;
  const local = /^(localhost|127\.|\[::1\]|[\w-]+\.local)(:|\/|$)/i.test(t) || /^\d+\.\d+\.\d+\.\d+/.test(t);
  return `${local ? 'http' : 'https'}://${t}`;
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol.startsWith('http') ? u.hostname : null;
  } catch {
    return null;
  }
}

function Feed({ host }: { host: string | null }) {
  const { client, select, setView, openReplay, setQuery } = useApp();
  const [rows, setRows] = useState<ExchangeSummary[]>([]);
  const q = host ? `source:browser host:${host}` : 'source:browser';
  const load = useCallback(() => client.search(q, { limit: 200 }).then(setRows, () => undefined), [client, q]);
  useEffect(() => {
    void load();
    let t: number | undefined;
    const off = client.onChange((c) => {
      if (c.entity === 'exchange' && t === undefined) t = window.setTimeout(() => ((t = undefined), void load()), 300);
    });
    return () => {
      off();
      window.clearTimeout(t);
    };
  }, [client, load]);
  return (
    <aside className="browser-feed" aria-label="Browser traffic">
      <div className="sec-head">
        <b style={{ color: 'var(--text)' }}>Traffic</b>
        <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{host ?? 'all tabs'}</span>
        <span style={{ flex: 1 }} />
        <button
          className="btn small"
          onClick={() => {
            setQuery(q);
            setView('history');
          }}
        >
          In History
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {rows.length === 0 && <div className="empty" style={{ padding: 20, fontSize: 12 }}>Recorded requests from this site appear here.</div>}
        {rows.map((r) => (
          <div
            key={r.id}
            className="feed-row"
            data-testid="feed-row"
            onClick={() => {
              select(r.id);
              setView('history');
            }}
            title={r.url}
          >
            <span className="faint">{fmtTime(r.startedAt).slice(3)}</span>
            <span className={`m-${r.method}`}>{r.method}</span>
            <span>{r.path}</span>
            <span style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
              <span className={statusClass(r)}>{statusText(r)}</span>
              <button
                className="icon-btn"
                style={{ width: 20, height: 20 }}
                aria-label={`Replay ${r.method} ${r.path}`}
                title="Send to replay"
                onClick={(e) => {
                  e.stopPropagation();
                  openReplay(r);
                }}
              >
                <Icon name="replay" size={11} />
              </button>
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function Browser() {
  const { client, scope, notify, setView, info } = useApp();
  const bridge = window.siq?.browser;
  const [tabs, setTabs] = useState<BrowserTabState[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [address, setAddress] = useState('');
  const [decision, setDecision] = useState<ScopeDecision | null>(null);
  const [showFeed, setShowFeed] = useState(true);
  const pageRef = useRef<HTMLDivElement>(null);
  const current = tabs.find((t) => t.id === active);
  const host = current ? hostOf(current.url) : null;

  // Tabs live in the main process; mirror their state here.
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.list().then(async (list) => {
      if (!alive) return;
      if (list.length === 0) {
        const id = await bridge.create(START_URL);
        setActive(id);
        return;
      }
      setTabs(list);
      setActive((a) => a ?? list[0]!.id);
    });
    const off = bridge.onTab((t) => {
      if ('closed' in t) {
        setTabs((ts) => ts.filter((x) => x.id !== t.id));
        setActive((a) => (a === t.id ? null : a));
      } else setTabs((ts) => (ts.some((x) => x.id === t.id) ? ts.map((x) => (x.id === t.id ? t : x)) : [...ts, t]));
    });
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  useEffect(() => {
    if (active === null && tabs.length) setActive(tabs[tabs.length - 1]!.id);
    if (active !== null) void bridge?.activate(active);
  }, [active, tabs, bridge]);

  useEffect(() => {
    if (current) setAddress(current.url === START_URL ? '' : current.url);
  }, [current?.id, current?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!current || !hostOf(current.url)) return setDecision(null);
    client.evaluate(current.url).then(setDecision, () => setDecision(null));
  }, [client, current?.url, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the native page view glued to the placeholder; hide it when this view is not shown.
  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!bridge || !el) return;
    const push = () => {
      const r = el.getBoundingClientRect();
      void bridge.setBounds({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
    };
    const ro = new ResizeObserver(push);
    ro.observe(el);
    window.addEventListener('resize', push);
    push();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', push);
      void bridge.setBounds(null);
    };
  }, [bridge, showFeed]);

  if (!bridge) {
    return (
      <div className="page">
        <div className="empty">
          <div className="panel-title">Built-in browser</div>
          <div style={{ maxWidth: 560 }}>
            The built-in browser runs in the desktop app. In a normal browser, point its proxy settings at{' '}
            <span className="mono">127.0.0.1:{info?.proxyPort ?? '...'}</span> and trust the CA shown in Settings.
          </div>
        </div>
      </div>
    );
  }

  const go = () => {
    if (active === null) return;
    void bridge.navigate(active, normalizeAddress(address));
  };

  const addToScope = async () => {
    if (!host || !scope) return;
    await client.setScope({ ...scope, rules: [...scope.rules, { id: undefined as unknown as string, action: 'include', host }] });
    notify(`${host} added to scope. Reloading.`);
    if (active !== null) void bridge.reload(active);
  };

  return (
    <div className="browser">
      <div className="tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((t) => (
          <div key={t.id} role="tab" className="tab" tabIndex={0} aria-selected={t.id === active} onClick={() => setActive(t.id)} onKeyDown={(e) => e.key === 'Enter' && setActive(t.id)} style={{ maxWidth: 240 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.loading ? '… ' : ''}{t.title || hostOf(t.url) || 'New tab'}</span>
            <button
              className="close"
              aria-label={`Close tab ${t.title}`}
              onClick={(e) => {
                e.stopPropagation();
                void bridge.close(t.id);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        <button className="tab" aria-label="New tab" onClick={() => void bridge.create(START_URL).then(setActive)}>
          <Icon name="plus" size={13} />
        </button>
      </div>
      <div className="browser-bar">
        <button className="icon-btn" aria-label="Back" disabled={!current?.canGoBack} onClick={() => active !== null && void bridge.back(active)}>
          ‹
        </button>
        <button className="icon-btn" aria-label="Forward" disabled={!current?.canGoForward} onClick={() => active !== null && void bridge.forward(active)}>
          ›
        </button>
        <button className="icon-btn" aria-label="Reload" onClick={() => active !== null && void bridge.reload(active)}>
          <Icon name="replay" size={13} />
        </button>
        <input
          className="input address"
          aria-label="Address"
          placeholder="Type a URL, e.g. localhost:3000 or shop.example.com"
          value={address}
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        {decision && (
          <span className={`badge ${decision.record ? 'ok' : 'warn'}`} data-testid="scope-badge" title="What SiteInquisition does with this host">
            {decision.record ? (decision.decrypt ? 'in scope · decrypting · recording' : 'in scope · recording') : 'not in scope'}
          </span>
        )}
        <button className="btn small" onClick={() => active !== null && void bridge.devtools(active)}>
          DevTools
        </button>
        <button className="btn small" aria-pressed={showFeed} onClick={() => setShowFeed((s) => !s)}>
          {showFeed ? 'Hide traffic' : 'Show traffic'}
        </button>
      </div>
      {decision && !decision.record && host && (
        <div className="banner" style={{ margin: 6 }}>
          <span>
            <b>{host}</b> is not in scope, so its traffic is passed through without being recorded.
          </span>
          <button className="btn small" onClick={() => addToScope().catch((e: Error) => notify(e.message))}>
            Add {host} to scope
          </button>
          <button className="btn small" onClick={() => setView('rules')}>
            Edit scope
          </button>
        </div>
      )}
      {current?.error && <div className="banner" style={{ margin: 6 }}>{current.error}</div>}
      <div className="browser-split">
        <div className="browser-page" ref={pageRef} aria-label="Page" />
        {showFeed && <Feed host={host} />}
      </div>
    </div>
  );
}
