import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Approval, CoreClient, CoreInfo, ExchangeSummary, HeaderList, Paused, ScopeConfig } from './api';

export type ViewId = 'browser' | 'history' | 'timeline' | 'replay' | 'race' | 'h3' | 'rules' | 'codecs' | 'cookies' | 'streams' | 'scripts' | 'api' | 'settings';

/** A request built somewhere other than History (Codecs, an agent, a script) and opened in Replay. */
export interface Draft {
  method: string;
  url: string;
  headers: HeaderList;
  body?: string;
}

export interface ReplayTab {
  id: string;
  /** The exchange this tab replays; empty for a tab opened from a draft. */
  exchangeId: string;
  label: string;
  method: string;
  draft?: Draft;
  /** Send options to start with, e.g. fresh cookies from the jar. */
  options?: { refreshCookies?: boolean; flow?: string };
}

/** One request lined up in the Race view. */
export interface RaceItem {
  key: string;
  label: string;
  raw: string;
  offsetMs: number;
  replayOf?: string;
}

/** One row of the HTTP/3 lab's stream plan. Numbers left empty mean "not set". */
export interface H3Item {
  key: string;
  raw: string;
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
}

/** Text handed to the Codecs workbench from another screen. */
export interface CodecInput {
  text: string;
  label: string;
  nonce: number;
  /** Where "Put back" sends the result, e.g. the selection in a Replay editor. */
  returnTo?: (text: string) => void;
}

export interface SavedView {
  name: string;
  query: string;
}

interface AppState {
  client: CoreClient;
  info: CoreInfo | null;
  connected: boolean;
  view: ViewId;
  setView(v: ViewId): void;
  /** Workspace tab: 'history' or a replay tab id. */
  activeTab: string;
  setActiveTab(id: string): void;
  replayTabs: ReplayTab[];
  openReplay(e: Pick<ExchangeSummary, 'id' | 'method' | 'path'>, options?: ReplayTab['options']): void;
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
  sendToCodecs(text: string, label: string, returnTo?: (text: string) => void): void;
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
  /** Open a view at one of its tabs (Rules > Breakpoints, Cookies > Variables...). */
  subTab: Partial<Record<ViewId, string>>;
  openAt(view: ViewId, tab: string): void;
  /** Exchanges picked in History to make a flow from, in the order picked. */
  flowPicks: string[];
  setFlowPicks(ids: string[]): void;
  /** Look up where a value came from (opens API > Values with it). */
  traceValue(value: string, beforeId?: string): void;
  traceInput: { value: string; beforeId?: string; nonce: number } | null;
}

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
  const [view, setViewState] = useState<ViewId>('history');
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
  const [subTab, setSubTab] = useState<Partial<Record<ViewId, string>>>({});
  const [flowPicks, setFlowPicks] = useState<string[]>([]);
  const [traceInput, setTraceInput] = useState<AppState['traceInput']>(null);
  const openAt = useCallback((v: ViewId, tab: string) => {
    setSubTab((s) => ({ ...s, [v]: tab }));
    setViewState(v);
  }, []);

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

  const setView = useCallback((v: ViewId) => {
    setViewState(v);
    if (v === 'history') setActiveTab('history');
  }, []);

  const openReplay = useCallback((e: Pick<ExchangeSummary, 'id' | 'method' | 'path'>, options?: ReplayTab['options']) => {
    const id = `replay-${e.id}`;
    setReplayTabs((tabs) => (tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, exchangeId: e.id, label: replayLabel(e.path), method: e.method, options }]));
    setActiveTab(id);
    setViewState('replay');
  }, []);

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
    setReplayTabs((tabs) => [...tabs, { id, exchangeId: '', label: name!, method: draft.method, draft }]);
    setActiveTab(id);
    setViewState('replay');
  }, []);

  const sendToCodecs = useCallback((text: string, label: string, returnTo?: (text: string) => void) => {
    setCodecInput({ text, label, nonce: Date.now(), returnTo });
    setViewState('codecs');
  }, []);

  const sendToH3 = useCallback((items: Array<Omit<H3Item, 'key'>>) => {
    setH3Items((cur) => [...cur, ...items.map((it, i) => ({ ...it, key: `${Date.now().toString(36)}-h${cur.length + i}` }))]);
    setViewState('h3');
  }, []);
  const sendToRace = useCallback((items: Array<Omit<RaceItem, 'key' | 'offsetMs'> & { offsetMs?: number }>) => {
    setRaceItems((cur) => [...cur, ...items.map((it, i) => ({ ...it, offsetMs: it.offsetMs ?? 0, key: `${Date.now().toString(36)}-${cur.length + i}` }))]);
    setViewState('race');
  }, []);

  const openStream = useCallback((exchangeId: string, prefill?: { text: string; topic?: string }) => {
    setStreamId(exchangeId);
    setStreamPrefill(prefill ? { ...prefill, nonce: Date.now() } : null);
    setViewState('streams');
  }, []);

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
        setActiveTab('history');
        setViewState('history');
      }
    },
    [activeTab],
  );

  /** Send a copy of an exchange without opening the editor; the result lands in History. */
  const resendNow = useCallback(
    async (id: string) => {
      const ex = await client.get(id);
      if (ex.isWebSocket || ex.scheme.startsWith('mqtt')) {
        setStreamId(id);
        setViewState('streams');
        return;
      }
      const body = ex.reqBodySize ? await client.body(id, 'request', false) : undefined;
      const res = await client.replay({ method: ex.method, url: ex.url, headers: ex.requestHeaders, body, replayOf: id });
      notify(res.state === 'complete' ? `Resent: ${res.status ?? ''} ${res.method} ${res.path}` : `Resend failed: ${res.method} ${res.path}`);
    },
    [client, notify],
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

  const value = useMemo<AppState>(
    () => ({
      client,
      info,
      connected,
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
      subTab,
      openAt,
      flowPicks,
      setFlowPicks,
      traceInput,
      traceValue,
    }),
    [client, info, connected, view, setView, activeTab, replayTabs, openReplay, closeReplay, resendNow, selectedId, query, savedViews, saveView, refreshInfo, scope, openReplayById, toast, notify, openDraft, codecInput, sendToCodecs, raceItems, sendToRace, h3Items, sendToH3, streamId, streamPrefill, openStream, paused, approvals, subTab, openAt, flowPicks, traceInput, traceValue],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
