import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CoreClient, CoreInfo, ExchangeSummary, ScopeConfig } from './api';

export type ViewId = 'browser' | 'history' | 'timeline' | 'replay' | 'race' | 'rules' | 'codecs' | 'cookies' | 'streams' | 'scripts' | 'settings';

export interface ReplayTab {
  id: string;
  exchangeId: string;
  label: string;
  method: string;
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
  openReplay(e: Pick<ExchangeSummary, 'id' | 'method' | 'path'>): void;
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
    const offStatus = client.onStatus((s) => {
      setConnected(s === 'open');
      if (s === 'open') {
        refreshInfo();
        client.scope().then(setScope, () => undefined);
      }
    });
    // Counts in the title bar and nav summary follow the change stream, throttled.
    let timer: number | undefined;
    const offChange = client.onChange((c) => {
      if (c.kind === 'meta.set' && c.entityId === 'savedViews') setSavedViews(c.data as SavedView[]);
      if (c.kind === 'meta.set' && c.entityId === 'scope') setScope(c.data as ScopeConfig);
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

  const openReplay = useCallback((e: Pick<ExchangeSummary, 'id' | 'method' | 'path'>) => {
    const id = `replay-${e.id}`;
    setReplayTabs((tabs) => (tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, exchangeId: e.id, label: replayLabel(e.path), method: e.method }]));
    setActiveTab(id);
    setViewState('replay');
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
        notify('Resending WebSocket and MQTT sessions comes with the Streams view.');
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
    }),
    [client, info, connected, view, setView, activeTab, replayTabs, openReplay, closeReplay, resendNow, selectedId, query, savedViews, saveView, refreshInfo, scope, openReplayById, toast, notify],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
