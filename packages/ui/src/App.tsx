import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from './state';
import { Icon } from './components/icons';
import { fmtCount, fmtSize } from './format';
import { DRAG_TYPE, History } from './views/History';
import { Replay } from './views/Replay';
import { NewRequestButton } from './views/NewRequest';
import { WsReplay } from './views/WsReplay';
import { ScopeEditor } from './views/Rules';
import { Breakpoints, Mocks, ReplaceRules } from './views/RulesTools';
import { ActiveOverrides, OverridesChip } from './views/Overrides';
import { EndpointDocument } from './views/Endpoint';
import { SHORTCUTS, SettingsSection, type SettingsSectionId } from './views/Settings';
import { Placeholder } from './views/Placeholder';
import { Browser } from './views/Browser';
import { Timeline } from './views/Timeline';
import { Cookies } from './views/Cookies';
import { Codecs } from './views/Codecs';
import { Race } from './views/Race';
import { H3Lab } from './views/H3Lab';
import { Streams } from './views/Streams';
import { Scripts } from './views/Scripts';
import { FlowDocument, Flows, Specs, Values } from './views/Api';
import { Dialog } from './components/Dialog';
import { CommandSearch } from './components/CommandSearch';
import type { WorkspaceDoc } from './workspace/types';
import { AuthAndNegative, Compare, Glossary, GraphQL, Resources } from './views/ApiExtras';
import { Coverage } from './views/Coverage';
import { AREAS, areaDef, defaultRoute, type AreaDef, type AreaId, type Route } from './workspace/navigation';
import { TechOverview } from './views/TechOverview';
import { Aws, Macros, Variables } from './views/CookiesTools';
import { ApprovalChip } from './views/Mcp';
import { LanChip } from './views/Lan';
import { bodyText } from './actions';
import { toRawRequest } from './format';

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function TitleBar() {
  const { info, connected, scope, navigate, paused } = useApp();
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
        <span className="mono">{info?.proxyPort ? `${info.allowLan ? '0.0.0.0' : '127.0.0.1'}:${info.proxyPort}` : 'not listening'}</span>
        <span className="muted">{connected ? 'Recording in scope' : 'Disconnected'}</span>
      </span>
      <button className="chip-btn" onClick={() => navigate('project/scope')} title="Edit the capture scope (Project settings)">
        Scope: {included === 0 ? (scope?.defaultAction === 'record' ? 'everything' : 'nothing yet') : `${included} ${included === 1 ? 'rule' : 'rules'}`}
      </button>
      {paused.length > 0 && (
        <button className="chip-btn attention" onClick={() => navigate('overrides/breakpoints')} data-testid="paused-chip">
          <span className="dot" style={{ background: 'var(--warn)' }} />
          {paused.length} paused at a breakpoint
        </button>
      )}
      <OverridesChip />
      <ApprovalChip />
      <LanChip />
      <button
        className="chip-btn search"
        onClick={() => {
          navigate('traffic/requests');
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
  const { route, navigate, info, replayTabs, savedViews, setQuery, paused, raceItems, openReplayById, notify } = useApp();
  const badge: Partial<Record<AreaId, string>> = {
    traffic: info ? fmtCount(info.stats.exchanges) : undefined,
    replay: replayTabs.length ? String(replayTabs.length) : undefined,
    overrides: paused.length ? `${paused.length} paused` : undefined,
    advanced: raceItems.length ? `${raceItems.length} in race` : undefined,
  };
  const item = (a: AreaDef) => (
    <button
      key={a.id}
      className="nav-item"
      aria-current={route.area === a.id ? 'page' : undefined}
      title={a.hint}
      onClick={() => navigate(route.area === a.id ? defaultRoute(a.id) : lastPage.current[a.id] ?? defaultRoute(a.id))}
      // Drop a History row on Replay to open it there.
      onDragOver={
        a.id === 'replay'
          ? (e) => {
              if (e.dataTransfer.types.includes(DRAG_TYPE)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }
            }
          : undefined
      }
      onDrop={
        a.id === 'replay'
          ? (e) => {
              const id = e.dataTransfer.getData(DRAG_TYPE);
              if (id) {
                e.preventDefault();
                openReplayById(id).catch((err: Error) => notify(err.message));
              }
            }
          : undefined
      }
    >
      <Icon name={a.icon} />
      {a.label}
      {badge[a.id] && <span className="nav-badge">{badge[a.id]}</span>}
    </button>
  );
  // Coming back to an area returns to the page last used there.
  const lastPage = useRef<Partial<Record<AreaId, Route>>>({});
  lastPage.current[route.area] = route;
  return (
    <nav className="nav" aria-label="Work areas">
      {AREAS.filter((a) => !a.footer).map(item)}
      {savedViews.length > 0 && <div className="nav-heading">Saved views</div>}
      {savedViews.map((v) => (
        <button
          key={v.name}
          className="saved-view"
          onClick={() => {
            setQuery(v.query);
            navigate('traffic/requests');
          }}
        >
          <span>{v.name}</span>
          <span className="mono faint" style={{ fontSize: 11 }}>
            {v.query}
          </span>
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <div className="nav-footer">{AREAS.filter((a) => a.footer).map(item)}</div>
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

/** The pages of the current work area, as tabs. */
function AreaTabs() {
  const { route, navigate, paused, flowPicks, replayTabs, goBack, goForward, canBack, canForward } = useApp();
  const area = areaDef(route.area);
  const extra: Record<string, string> = {
    'overrides/breakpoints': paused.length ? ` (${paused.length} paused)` : '',
    'replay/flows': flowPicks.length ? ` (${flowPicks.length} picked)` : '',
    'replay/editors': replayTabs.length ? ` (${replayTabs.length})` : '',
  };
  return (
    <div className="area-bar">
      <div className="history-btns">
        <button className="icon-btn" onClick={goBack} disabled={!canBack} aria-label="Back" title="Back (Alt Left)">
          <Icon name="back" size={14} />
        </button>
        <button className="icon-btn" onClick={goForward} disabled={!canForward} aria-label="Forward" title="Forward (Alt Right)">
          <Icon name="forward" size={14} />
        </button>
      </div>
    <div className="tabs area-tabs" role="tablist" aria-label={area.label}>
      {area.pages.map((p) => (
        <button key={p.id} role="tab" className="tab" aria-selected={route.page === p.id} title={p.hint} onClick={() => navigate({ area: area.id, page: p.id })}>
          {p.label}
          {extra[`${area.id}/${p.id}`]}
        </button>
      ))}
    </div>
    </div>
  );
}

/** The open replay editors: one tab per request or conversation. */
function EditorTabs() {
  const { activeTab, setActiveTab, replayTabs, closeReplay, openReplayById, notify, dirtyDocs, workspaceStatus } = useApp();
  return (
    <div
      className="tabs"
      role="tablist"
      aria-label="Open editors"
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
      {replayTabs.map((t) => (
        <div key={t.id} role="tab" className="tab" aria-selected={activeTab === t.id} tabIndex={0}
          onClick={() => setActiveTab(t.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setActiveTab(t.id);
          }}
        >
          <span className="muted">{DOC_KIND[t.kind ?? 'http']}:</span> <span className={`mono m-${t.method}`}>{t.method}</span> {t.label}
          {dirtyDocs.has(t.id) && (
            <span className="dirty-dot" title="Edited since it was opened. The draft is kept across restarts; nothing is sent until you send it.">
              <span className="sr-only">edited</span>
            </span>
          )}
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
      <NewRequestButton />
      <span style={{ flex: 1 }} />
      <WorkspaceStatus status={workspaceStatus} />
    </div>
  );
}

const DOC_KIND: Record<string, string> = { http: 'Replay', ws: 'Conversation', compare: 'Compare', flow: 'Flow', endpoint: 'Endpoint' };

/** Whether open editors and drafts are saved for the next start. */
function WorkspaceStatus({ status }: { status: ReturnType<typeof useApp>['workspaceStatus'] }) {
  if (status.state === 'error')
    return (
      <span className="chip chip-bad" role="status" title={status.message} data-testid="workspace-status">
        Drafts not saved
      </span>
    );
  if (status.state !== 'saved') return null;
  return (
    <span className="faint" style={{ fontSize: 12, alignSelf: 'center', whiteSpace: 'nowrap' }} role="status" data-testid="workspace-status" title="Open editors and their drafts come back when you restart. Restoring never sends anything.">
      {status.restored ? `${status.restored} restored from last session · ` : ''}Drafts saved
    </span>
  );
}

/** One open document. */
function DocumentView({ doc }: { doc: WorkspaceDoc }) {
  if (doc.kind === 'compare') return <Compare a={doc.a} b={doc.b} />;
  if (doc.kind === 'flow') return <FlowDocument name={doc.flow} />;
  if (doc.kind === 'endpoint') return <EndpointDocument endpointKey={doc.key} />;
  return doc.kind === 'ws' ? <WsReplay tab={doc} /> : <Replay tab={doc} />;
}

/** The page a route shows. Each capability has one owning component; routes are only ways to reach it. */
function Page({ route }: { route: Route }) {
  const { query, navigate } = useApp();
  switch (`${route.area}/${route.page}`) {
    case 'traffic/requests':
      return <History />;
    case 'traffic/browser':
      return <Browser />;
    case 'traffic/timeline':
      return <Timeline />;
    case 'traffic/connections':
      return <Streams />;
    case 'explore/endpoints':
      return (
        <div className="page">
          <Coverage initialHost={/(?:^|\s)host:(\S+)/.exec(query)?.[1]?.replace(/^\*\./, '') ?? null} />
        </div>
      );
    case 'explore/resources':
      return <Resources />;
    case 'explore/values':
      return <Values />;
    case 'explore/fields':
      return <Glossary />;
    case 'explore/specs':
      return <Specs />;
    case 'explore/graphql':
      return <GraphQL />;
    case 'explore/tech':
      return <TechOverview />;
    case 'replay/flows':
      return <Flows />;
    case 'replay/compare':
      return <Compare />;
    case 'replay/probes':
      return <AuthAndNegative />;
    case 'overrides/active':
      return <ActiveOverrides />;
    case 'overrides/mocks':
      return <Mocks />;
    case 'overrides/replace':
      return <ReplaceRules />;
    case 'overrides/breakpoints':
      return <Breakpoints />;
    case 'overrides/hooks':
      return <Scripts only="hook" />;
    case 'project/scope':
      return <ScopeEditor />;
    case 'project/session':
      return <Cookies macros={<Macros />} vars={<Variables />} aws={<Aws />} tab={route.tab} onTab={(t) => navigate({ ...route, tab: t })} />;
    case 'advanced/codecs':
      return <Codecs />;
    case 'advanced/race':
      return <Race />;
    case 'advanced/h3':
      return <H3Lab />;
    case 'advanced/scripts':
      return <Scripts />;
  }
  if (route.area === 'project')
    return (
      <div className="page">
        <SettingsSection section={route.page as SettingsSectionId} />
      </div>
    );
  return null;
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

const typing = (el: Element | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement | null)?.isContentEditable === true;

/** Press ? anywhere outside a text field for the list of keyboard shortcuts. */
function ShortcutOverlay() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      else if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(document.activeElement)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!open) return null;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onMouseDown={() => setOpen(false)} data-testid="shortcuts">
      <div className="card overlay-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="panel-title" style={{ padding: '12px 14px' }}>
          Keyboard shortcuts
        </div>
        <table className="shortcut-table">
          <tbody>
            {[...SHORTCUTS, ['?', 'Show or hide this list'] as [string, string]].map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted" style={{ padding: '8px 14px 12px', fontSize: 12 }}>
          Also in Project settings, Keyboard. Esc closes this.
        </div>
      </div>
    </div>
  );
}

function useShortcuts(openCommands: () => void) {
  const { client, selectedId, openReplayById, resendNow, notify, navigate, sendToCodecs, sendToRace, goBack, goForward } = useApp();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing(document.activeElement)) {
        e.preventDefault();
        if (e.key === 'ArrowLeft') goBack();
        else goForward();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'p' && e.shiftKey) {
        e.preventDefault();
        openCommands();
      } else if (key === 'k') {
        e.preventDefault();
        navigate('traffic/requests');
        window.setTimeout(() => document.getElementById('filter-input')?.focus(), 0);
      } else if (key === 'd') {
        e.preventDefault();
        // Ctrl D on a selection in a view that decodes in place does that; Ctrl Shift D always opens Codecs.
        const anchor = window.getSelection()?.anchorNode;
        const zone = !e.shiftKey && anchor ? (anchor instanceof Element ? anchor : anchor.parentElement)?.closest('[data-region-zone]') : null;
        if (zone && !window.getSelection()?.isCollapsed) {
          zone.dispatchEvent(new CustomEvent('siq-decode'));
          return;
        }
        const sel = selectedText();
        if (sel) sendToCodecs(sel, 'selection');
        else if (selectedId)
          bodyText(client, selectedId, 'response').then(
            (t) => sendToCodecs(t, 'selected response'),
            (err: Error) => notify(err.message),
          );
        else notify('Select some text, or an exchange in Traffic, then press Ctrl D to decode it.');
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
  }, [client, selectedId, openReplayById, resendNow, notify, navigate, sendToCodecs, sendToRace, goBack, goForward, openCommands]);
}

export function App() {
  const { route, connected, toast, activeTab, replayTabs, dialog } = useApp();
  const [commandsOpen, setCommandsOpen] = useState(false);
  const openCommands = useCallback(() => setCommandsOpen(true), []);
  useShortcuts(openCommands);
  const onEditors = route.area === 'replay' && route.page === 'editors';
  const activeReplay = replayTabs.find((t) => t.id === activeTab) ?? replayTabs[replayTabs.length - 1];
  return (
    <div className="app">
      <TitleBar />
      {!connected && <div className="connection-lost" role="status">Lost the connection to the core. Reconnecting...</div>}
      <div className="body">
        <NavRail />
        <main className="main" aria-label={areaDef(route.area).label}>
          <AreaTabs />
          {onEditors && <EditorTabs />}
          {/* Replay editors stay mounted while hidden so unsent edits survive moving around. */}
          {replayTabs.map((t) => (
            <div key={t.id} className="tab-host" style={{ display: onEditors && t.id === activeReplay?.id ? 'flex' : 'none' }}>
              <DocumentView doc={t} />
            </div>
          ))}
          {onEditors && !activeReplay && (
            <Placeholder title="No open editors" text="Send a request here with Send to Replay: the Replay pill on any Traffic row, Ctrl R, the right-click menu, or the button in the Inspector, Timeline and Explore API screens. Drop a row on Replay in the navigation. Or press + on the tab bar for a blank request, or one from a curl command." />
          )}
          {!onEditors && <Page route={route} />}
        </main>
      </div>
      <ShortcutOverlay />
      {dialog && <Dialog req={dialog} onAnswer={dialog.resolve} />}
      {commandsOpen && <CommandSearch onClose={() => setCommandsOpen(false)} />}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
