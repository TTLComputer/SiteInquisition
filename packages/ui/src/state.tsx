import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { confirmLeave } from './unsaved';
import { legacyRoute, parseRoute, routeToLegacy, sameRoute, type LegacyView, type Route } from './workspace/navigation';
import type { Approval, CoreClient, CoreInfo, ExchangeSummary, HeaderList, Paused, ScopeConfig } from './api';

/** An old screen name; resolves to a page in one of the work areas (see workspace/navigation). */
export type ViewId = LegacyView;

/** A request built somewhere other than History (Codecs, an agent, a script) and opened in Replay. */
export interface Draft {
  method: string;
  url: string;
  headers: HeaderList;
  body?: string;
  /** Opened from a curl command: what it could not carry over, and the files it reads. */
  imported?: { warnings: string[]; files: string[] };
  /** Send options to start with. */
  options?: ReplayTab['options'];
}

export interface ReplayTab {
  id: string;
  /** The exchange this tab replays; empty for a tab opened from a draft. */
  exchangeId: string;
  /** "ws" replays a WebSocket connection: handshake plus an editable message script. */
  kind?: 'http' | 'ws';
  label: string;
  method: string;
  draft?: Draft;
  /** Send options to start with, e.g. fresh cookies from the jar. */
  options?: { refreshCookies?: boolean; flow?: string; ignoreTls?: boolean; followRedirects?: boolean; protocol?: 'h1' | 'h2' | 'h3'; h2Method?: '' | 'alpn' | 'upgrade' | 'prior-knowledge' };
}

/** One request lined up in the Race view. */
import type { TextRegion } from '@siteinquisition/codecs/regionedit';

export interface RaceItem {
  key: string;
  label: string;
  raw: string;
  offsetMs: number;
  replayOf?: string;
  /** Parts of raw shown decoded in place; encoded again when sent. */
  regions?: TextRegion[];
}

/** One row of the HTTP/3 lab's stream plan. Numbers left empty mean "not set". */
export interface H3Item {
  key: string;
  raw: string;
  /** Parts of raw shown decoded in place; encoded again when sent. */
  regions?: TextRegion[];
  replayOf?: string;
  openAtMs?: number;
  after?: { row: number; event: 'headers' | 'end' };
  hold?: 'last-byte' | 'fin';
  releaseAtMs?: number;
  chunkSize?: number;
  chunkGapMs?: number;
  resetAfterBytes?: number;
  resetAtMs?: number;
  resetCode?: number;
  stopSendingAfterBytes?: number;
  priority?: string;
  priorityUpdateAtMs?: number;
  priorityUpdateValue?: string;
  earlyData?: boolean;
  // HTTP/2 only
  continuationSize?: number;
  padding?: number;
  /** Trailer header block, one "name: value" per line, sent after the body. */
  trailers?: string;
}

/** Text handed to the Codecs workbench from another screen. */
export interface CodecInput {
  text: string;
  label: string;
  nonce: number;
  /** Where "Put back" sends the result, e.g. the selection in a Replay editor. */
  returnTo?: (text: string, live?: boolean) => void;
}

export interface SavedView {
  name: string;
  query: string;
}

interface AppState {
  client: CoreClient;
  info: CoreInfo | null;
  connected: boolean;
  /** Where the user is: a work area, one of its pages, and maybe a tab. */
  route: Route;
  /** Go somewhere. Every way of moving around (nav, links, shortcuts, row menus, agents) comes through here. */
  navigate(to: Route | string): void;
  /** The old screen name for the current route. */
  view: ViewId;
  /** Open an old screen by name; resolves to its page in the work areas. */
  setView(v: ViewId): void;
  /** Workspace tab: 'history' or a replay tab id. */
  activeTab: string;
  setActiveTab(id: string): void;
  replayTabs: ReplayTab[];
  /** Open (or switch to) the Replay tab for an exchange; a WebSocket opens the WebSocket replay editor. */
  openReplay(e: ReplayTarget, options?: ReplayTab['options']): void;
  closeReplay(id: string): void;
  resendNow(id: string): Promise<void>;
  selectedId: string | null;
  select(id: string | null): void;
  query: string;
  setQuery(q: string): void;
  savedViews: SavedView[];
  saveView(view: SavedView): Promise<void>;
  refreshInfo(): void;
  scope: ScopeConfig | null;
  /** Open the replay editor for an exchange known only by id (keyboard and menu paths). */
  openReplayById(id: string): Promise<void>;
  toast: string | null;
  notify(msg: string): void;
  /** Open a Replay tab on a request that was never recorded. */
  openDraft(draft: Draft, label?: string): void;
  codecInput: CodecInput | null;
  /** Send text (a selection, a body, a header value) to the Codecs workbench. */
  sendToCodecs(text: string, label: string, returnTo?: (text: string, live?: boolean) => void): void;
  raceItems: RaceItem[];
  setRaceItems(items: RaceItem[]): void;
  h3Items: H3Item[];
  setH3Items(items: H3Item[]): void;
  /** Add requests to the HTTP/3 lab and open it. */
  sendToH3(items: Array<Omit<H3Item, 'key'>>): void;
  sendToRace(items: Array<Omit<RaceItem, 'key' | 'offsetMs'> & { offsetMs?: number }>): void;
  /** The connection the Streams view should show. */
  streamId: string | null;
  /** A message to start the composer with, e.g. one picked in the inspector. */
  streamPrefill: { text: string; topic?: string; nonce: number } | null;
  openStream(exchangeId: string, prefill?: { text: string; topic?: string }): void;
  paused: Paused[];
  approvals: Approval[];
  /** Open an old screen at one of its tabs (Rules > Breakpoints, Cookies > Variables...); resolves like setView. */
  openAt(view: ViewId, tab: string): void;
  /** Exchanges picked in History to make a flow from, in the order picked. */
  flowPicks: string[];
  setFlowPicks(ids: string[]): void;
  /** Look up where a value came from (opens API > Values with it). */
  traceValue(value: string, beforeId?: string): void;
  traceInput: { value: string; beforeId?: string; nonce: number } | null;
  /** An exchange marked in History to compare another one with. */
  compareMark: string | null;
  setCompareMark(id: string | null): void;
  /** Open API > Compare, Auth matrix or Negative tests with these exchanges. */
  sendToApi(kind: 'compare' | 'auth' | 'negative', ids: string[]): void;
  apiInput: { kind: 'compare' | 'auth' | 'negative'; ids: string[]; nonce: number } | null;
}

/** What opening Replay needs to know about a recorded exchange. */
export type ReplayTarget = Pick<ExchangeSummary, 'id' | 'method' | 'path'> & Partial<Pick<ExchangeSummary, 'isWebSocket'>>;

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

const replayLabel = (path: string) => {
  const clean = path.split('?')[0] ?? path;
  const last = clean.split('/').filter(Boolean).pop();
  return last ? decodeURIComponent(last).slice(0, 32) : clean || '/';
};

export function AppProvider({ client, children }: { client: CoreClient; children: ReactNode }) {
  const [info, setInfo] = useState<CoreInfo | null>(null);
  const [connected, setConnected] = useState(client.status === 'open');
  const [route, setRoute] = useState<Route>({ area: 'traffic', page: 'requests' });
  const routeRef = useRef(route);
  routeRef.current = route;
  const [activeTab, setActiveTab] = useState('history');
  const [replayTabs, setReplayTabs] = useState<ReplayTab[]>([]);
  const [selectedId, select] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [scope, setScope] = useState<ScopeConfig | null>(null);
  const toastTimer = useRef<number>();
  const [codecInput, setCodecInput] = useState<CodecInput | null>(null);
  const [raceItems, setRaceItems] = useState<RaceItem[]>([]);
  const [h3Items, setH3Items] = useState<H3Item[]>([]);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [streamPrefill, setStreamPrefill] = useState<AppState['streamPrefill']>(null);
  const [paused, setPaused] = useState<Paused[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [flowPicks, setFlowPicks] = useState<string[]>([]);
  const [traceInput, setTraceInput] = useState<AppState['traceInput']>(null);
  const [compareMark, setCompareMark] = useState<string | null>(null);
  const [apiInput, setApiInput] = useState<AppState['apiInput']>(null);
  /** The one place navigation happens. Leaving a page with unsaved edits asks first, whatever started the move. */
  const navigate = useCallback((to: Route | string) => {
    const r = typeof to === 'string' ? parseRoute(to) : to;
    if (!r) return;
    const cur = routeRef.current;
    if (sameRoute(cur, r)) return;
    const leavingPage = cur.area !== r.area || cur.page !== r.page;
    if (leavingPage && !confirmLeave()) return;
    routeRef.current = r;
    setRoute(r);
  }, []);
  const setView = useCallback((v: ViewId) => navigate(legacyRoute(v)), [navigate]);
  const openAt = useCallback((v: ViewId, tab: string) => navigate(legacyRoute(v, tab)), [navigate]);
  const view = routeToLegacy(route);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const refreshInfo = useCallback(() => {
    client.info().then(setInfo, () => undefined);
  }, [client]);

  useEffect(() => {
    refreshInfo();
    client.call<SavedView[]>('views.get').then(setSavedViews, () => undefined);
    client.scope().then(setScope, () => undefined);
    const loadLive = () => {
      client.paused().then(setPaused, () => undefined);
      client.approvals().then(setApprovals, () => undefined);
    };
    loadLive();
    const offStatus = client.onStatus((s) => {
      setConnected(s === 'open');
      if (s === 'open') {
        refreshInfo();
        loadLive();
        client.scope().then(setScope, () => undefined);
      }
    });
    // Counts in the title bar and nav summary follow the change stream, throttled.
    let timer: number | undefined;
    const offChange = client.onChange((c) => {
      if (c.kind === 'meta.set' && c.entityId === 'savedViews') setSavedViews(c.data as SavedView[]);
      if (c.kind === 'meta.set' && c.entityId === 'scope') setScope(c.data as ScopeConfig);
      if (c.kind.startsWith('intercept.') || c.kind === 'mcp.approval' || c.kind === 'mcp.decided') loadLive();
      if (c.entity !== 'exchange' && c.entity !== 'meta') return;
      if (timer === undefined) timer = window.setTimeout(() => ((timer = undefined), refreshInfo()), 1000);
    });
    return () => {
      offStatus();
      offChange();
      window.clearTimeout(timer);
    };
  }, [client, refreshInfo]);

  const openReplay = useCallback((e: ReplayTarget, options?: ReplayTab['options']) => {
    const id = `replay-${e.id}`;
    const kind = e.isWebSocket ? 'ws' : 'http';
    setReplayTabs((tabs) => (tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, exchangeId: e.id, kind, label: replayLabel(e.path), method: kind === 'ws' ? 'WS' : e.method, options }]));
    setActiveTab(id);
    setView('replay');
  }, [setView]);

  const openDraft = useCallback((draft: Draft, label?: string) => {
    const id = `draft-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let name = label;
    if (!name) {
      try {
        name = replayLabel(new URL(draft.url).pathname);
      } catch {
        name = 'draft';
      }
    }
    setReplayTabs((tabs) => [...tabs, { id, exchangeId: '', label: name!, method: draft.method, draft, ...(draft.options ? { options: draft.options } : {}) }]);
    setActiveTab(id);
    setView('replay');
  }, [setView]);

  const sendToCodecs = useCallback((text: string, label: string, returnTo?: (text: string, live?: boolean) => void) => {
    setCodecInput({ text, label, nonce: Date.now(), returnTo });
    setView('codecs');
  }, [setView]);

  const sendToH3 = useCallback((items: Array<Omit<H3Item, 'key'>>) => {
    setH3Items((cur) => [...cur, ...items.map((it, i) => ({ ...it, key: `${Date.now().toString(36)}-h${cur.length + i}` }))]);
    setView('h3');
  }, [setView]);
  const sendToRace = useCallback((items: Array<Omit<RaceItem, 'key' | 'offsetMs'> & { offsetMs?: number }>) => {
    setRaceItems((cur) => [...cur, ...items.map((it, i) => ({ ...it, offsetMs: it.offsetMs ?? 0, key: `${Date.now().toString(36)}-${cur.length + i}` }))]);
    setView('race');
  }, [setView]);

  const openStream = useCallback((exchangeId: string, prefill?: { text: string; topic?: string }) => {
    setStreamId(exchangeId);
    setStreamPrefill(prefill ? { ...prefill, nonce: Date.now() } : null);
    setView('streams');
  }, [setView]);

  const openReplayById = useCallback(
    async (id: string) => {
      const ex = await client.get(id);
      openReplay(ex);
    },
    [client, openReplay],
  );

  const closeReplay = useCallback(
    (id: string) => {
      setReplayTabs((tabs) => tabs.filter((t) => t.id !== id));
      if (activeTab === id) {
        const rest = replayTabs.filter((t) => t.id !== id);
        setActiveTab(rest[rest.length - 1]?.id ?? 'history');
      }
    },
    [activeTab, replayTabs],
  );

  /** Send a copy of an exchange without opening the editor; the result lands in History. */
  const resendNow = useCallback(
    async (id: string) => {
      const ex = await client.get(id);
      if (ex.isWebSocket || ex.scheme.startsWith('mqtt')) {
        setStreamId(id);
        setView('streams');
        return;
      }
      const body = ex.reqBodySize ? await client.body(id, 'request', false) : undefined;
      const res = await client.replay({ method: ex.method, url: ex.url, headers: ex.requestHeaders, body, replayOf: id });
      notify(res.state === 'complete' ? `Resent: ${res.status ?? ''} ${res.method} ${res.path}` : `Resend failed: ${res.method} ${res.path}`);
    },
    [client, notify, setView],
  );

  const saveView = useCallback(
    async (v: SavedView) => {
      const next = [...savedViews.filter((s) => s.name !== v.name), v];
      setSavedViews(next);
      await client.call('views.set', { views: next });
    },
    [client, savedViews],
  );

  const traceValue = useCallback(
    (v: string, beforeId?: string) => {
      setTraceInput({ value: v, beforeId, nonce: Date.now() });
      openAt('api', 'values');
    },
    [openAt],
  );

  const sendToApi = useCallback(
    (kind: 'compare' | 'auth' | 'negative', ids: string[]) => {
      setApiInput({ kind, ids, nonce: Date.now() });
      openAt('api', kind === 'compare' ? 'compare' : 'probes');
    },
    [openAt],
  );

  const value = useMemo<AppState>(
    () => ({
      client,
      info,
      connected,
      route,
      navigate,
      view,
      setView,
      activeTab,
      setActiveTab,
      replayTabs,
      openReplay,
      closeReplay,
      resendNow,
      selectedId,
      select,
      query,
      setQuery,
      savedViews,
      saveView,
      refreshInfo,
      scope,
      openReplayById,
      toast,
      notify,
      openDraft,
      codecInput,
      sendToCodecs,
      raceItems,
      setRaceItems,
      sendToRace,
      h3Items,
      setH3Items,
      sendToH3,
      streamId,
      streamPrefill,
      openStream,
      paused,
      approvals,
      openAt,
      flowPicks,
      setFlowPicks,
      traceInput,
      traceValue,
      compareMark,
      setCompareMark,
      sendToApi,
      apiInput,
    }),
    [client, info, connected, route, navigate, view, setView, activeTab, replayTabs, openReplay, closeReplay, resendNow, selectedId, query, savedViews, saveView, refreshInfo, scope, openReplayById, toast, notify, openDraft, codecInput, sendToCodecs, raceItems, sendToRace, h3Items, sendToH3, streamId, streamPrefill, openStream, paused, approvals, openAt, flowPicks, traceInput, traceValue, compareMark, sendToApi, apiInput],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
