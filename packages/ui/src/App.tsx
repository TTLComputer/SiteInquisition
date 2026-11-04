import { useEffect } from 'react';
import { useApp, type ViewId } from './state';
import { Icon } from './components/icons';
import { fmtCount, fmtSize } from './format';
import { DRAG_TYPE, History } from './views/History';
import { Replay } from './views/Replay';
import { Rules } from './views/Rules';
import { Settings } from './views/Settings';
import { Placeholder } from './views/Placeholder';
import { Browser } from './views/Browser';
import { Timeline } from './views/Timeline';
import { Cookies } from './views/Cookies';
import { Codecs } from './views/Codecs';
import { Race } from './views/Race';
import { H3Lab } from './views/H3Lab';
import { Streams } from './views/Streams';
import { Scripts } from './views/Scripts';
import { Aws, Macros, Variables } from './views/CookiesTools';
import { ApprovalChip } from './views/Mcp';
import { bodyText } from './actions';
import { toRawRequest } from './format';

const NAV: Array<{ id: ViewId; label: string }> = [
  { id: 'browser', label: 'Browser' },
  { id: 'history', label: 'History' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'replay', label: 'Replay' },
  { id: 'race', label: 'Race' },
  { id: 'h3', label: 'HTTP/3' },
  { id: 'rules', label: 'Rules' },
  { id: 'codecs', label: 'Codecs' },
  { id: 'cookies', label: 'Cookies' },
  { id: 'streams', label: 'Streams' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'settings', label: 'Settings' },
];

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function TitleBar() {
  const { info, connected, scope, setView, paused, openAt } = useApp();
  const included = scope?.rules.filter((r) => r.action === 'include' && r.enabled !== false).length ?? 0;
  return (
    <header className="titlebar">
      <div className="brand">
        <Icon name="logo" size={20} color="var(--accent)" stroke={2} />
        SiteInquisition
      </div>
      {info && (
        <span className="chip-btn plain" title={info.projectDir}>
          {basename(info.projectDir)}
        </span>
      )}
      <span className="chip-btn" title={connected ? 'Proxy listening' : 'Core not connected'} data-testid="listener">
        <span className="dot" style={{ background: connected && info?.proxyPort ? 'var(--ok)' : 'var(--error)' }} />
        <span className="mono">{info?.proxyPort ? `127.0.0.1:${info.proxyPort}` : 'not listening'}</span>
        <span className="muted">{connected ? 'Recording in scope' : 'Disconnected'}</span>
      </span>
      <button className="chip-btn" onClick={() => setView('rules')} title="Edit scope">
        Scope: {included === 0 ? (scope?.defaultAction === 'record' ? 'everything' : 'nothing yet') : `${included} ${included === 1 ? 'rule' : 'rules'}`}
      </button>
      {paused.length > 0 && (
        <button className="chip-btn attention" onClick={() => openAt('rules', 'breakpoints')} data-testid="paused-chip">
          <span className="dot" style={{ background: 'var(--warn)' }} />
          {paused.length} paused at a breakpoint
        </button>
      )}
      <ApprovalChip />
      <button
        className="chip-btn search"
        onClick={() => {
          setView('history');
          window.setTimeout(() => document.getElementById('filter-input')?.focus(), 0);
        }}
      >
        <Icon name="search" size={14} />
        <span style={{ flex: 1 }}>Filter traffic</span>
        <kbd>Ctrl K</kbd>
      </button>
    </header>
  );
}

function NavRail() {
  const { view, setView, info, replayTabs, savedViews, setQuery, scope, raceItems, paused } = useApp();
  const badge: Partial<Record<ViewId, string>> = {
    history: info ? fmtCount(info.stats.exchanges) : undefined,
    replay: replayTabs.length ? String(replayTabs.length) : undefined,
    race: raceItems.length ? String(raceItems.length) : undefined,
    rules: paused.length ? `${paused.length} paused` : scope ? String(scope.rules.length) : undefined,
    streams: info?.mqtt.length ? `${info.mqtt.length} mqtt` : undefined,
  };
  return (
    <nav className="nav" aria-label="Views">
      {NAV.map((n) => (
        <button key={n.id} className="nav-item" aria-current={view === n.id ? 'page' : undefined} onClick={() => setView(n.id)}>
          <Icon name={n.id} />
          {n.label}
          {badge[n.id] && <span className="nav-badge">{badge[n.id]}</span>}
        </button>
      ))}
      {savedViews.length > 0 && <div className="nav-heading">Saved views</div>}
      {savedViews.map((v) => (
        <button
          key={v.name}
          className="saved-view"
          onClick={() => {
            setQuery(v.query);
            setView('history');
          }}
        >
          <span>{v.name}</span>
          <span className="mono faint" style={{ fontSize: 11 }}>
            {v.query}
          </span>
        </button>
      ))}
      <div style={{ flex: 1 }} />
      {info && (
        <div className="nav-summary" aria-label="Capture summary">
          <div>
            Exchanges <b>{fmtCount(info.stats.exchanges)}</b>
          </div>
          <div>
            Database <b>{fmtSize(info.stats.databaseBytes)}</b>
          </div>
          <div>
            Decrypting <b>{info.decryptHosts.length ? info.decryptHosts.length : 'none'}</b>
          </div>
        </div>
      )}
    </nav>
  );
}

function WorkspaceTabs() {
  const { activeTab, setActiveTab, setView, replayTabs, closeReplay, openReplayById, notify } = useApp();
  return (
    <div
      className="tabs"
      role="tablist"
      aria-label="Workspace"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (id) {
          e.preventDefault();
          openReplayById(id).catch((err: Error) => notify(err.message));
        }
      }}
    >
      <button
        role="tab"
        className="tab"
        aria-selected={activeTab === 'history'}
        onClick={() => {
          setActiveTab('history');
          setView('history');
        }}
      >
        History
      </button>
      {replayTabs.map((t) => (
        <div key={t.id} role="tab" className="tab" aria-selected={activeTab === t.id} tabIndex={0}
          onClick={() => {
            setActiveTab(t.id);
            setView('replay');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              setActiveTab(t.id);
              setView('replay');
            }
          }}
        >
          <span className="muted">Replay:</span> <span className={`mono m-${t.method}`}>{t.method}</span> {t.label}
          <button
            className="close"
            aria-label={`Close replay ${t.label}`}
            onClick={(e) => {
              e.stopPropagation();
              closeReplay(t.id);
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The text selected anywhere on the page, including inside a text field. */
function selectedText(): string {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text')) {
    const t = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
    if (t) return t;
  }
  return window.getSelection()?.toString() ?? '';
}

function useShortcuts() {
  const { client, selectedId, openReplayById, resendNow, notify, setView, sendToCodecs, sendToRace } = useApp();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        setView('history');
        window.setTimeout(() => document.getElementById('filter-input')?.focus(), 0);
      } else if (key === 'd' && !e.shiftKey) {
        e.preventDefault();
        const sel = selectedText();
        if (sel) sendToCodecs(sel, 'selection');
        else if (selectedId)
          bodyText(client, selectedId, 'response').then(
            (t) => sendToCodecs(t, 'selected response'),
            (err: Error) => notify(err.message),
          );
        else notify('Select some text, or an exchange in History, then press Ctrl D to decode it.');
      } else if (key === 'r' && e.shiftKey && selectedId) {
        e.preventDefault();
        (async () => {
          const ex = await client.get(selectedId);
          const body = ex.reqBodySize ? await bodyText(client, ex.id, 'request').catch(() => '') : '';
          sendToRace([{ label: ex.path.split('?')[0]!.split('/').pop() || '/', raw: toRawRequest(ex.method, ex.url, ex.requestHeaders, body), replayOf: ex.id }]);
        })().catch((err: Error) => notify(err.message));
      } else if (key === 'r' && !e.shiftKey && selectedId) {
        e.preventDefault();
        openReplayById(selectedId).catch((err: Error) => notify(err.message));
      } else if (key === 'enter' && e.shiftKey && selectedId) {
        e.preventDefault();
        resendNow(selectedId).catch((err: Error) => notify(err.message));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [client, selectedId, openReplayById, resendNow, notify, setView, sendToCodecs, sendToRace]);
}

export function App() {
  const { view, connected, toast, activeTab, replayTabs } = useApp();
  useShortcuts();
  const activeReplay = replayTabs.find((t) => t.id === activeTab);
  return (
    <div className="app">
      <TitleBar />
      {!connected && <div className="connection-lost" role="status">Lost the connection to the core. Reconnecting...</div>}
      <div className="body">
        <NavRail />
        <main className="main">
          {(view === 'history' || view === 'replay') && <WorkspaceTabs />}
          {view === 'history' && <History />}
          {/* Replay tabs stay mounted while hidden so unsent edits survive switching views. */}
          {replayTabs.map((t) => (
            <div key={t.id} className="tab-host" style={{ display: view === 'replay' && t.id === activeTab ? 'flex' : 'none' }}>
              <Replay tab={t} />
            </div>
          ))}
          {view === 'replay' && !activeReplay && (
            <Placeholder title="Replay" text="Send a request here from History: the Replay pill on any row, Ctrl R, or the right-click menu." />
          )}
          {view === 'browser' && <Browser />}
          {view === 'timeline' && <Timeline />}
          {view === 'cookies' && <Cookies macros={<Macros />} vars={<Variables />} aws={<Aws />} />}
          {view === 'codecs' && <Codecs />}
          {view === 'race' && <Race />}
          {view === 'h3' && <H3Lab />}
          {view === 'streams' && <Streams />}
          {view === 'scripts' && <Scripts />}
          {view === 'rules' && <Rules />}
          {view === 'settings' && <Settings />}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
