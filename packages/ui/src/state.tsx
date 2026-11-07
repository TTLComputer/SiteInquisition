import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { confirmLeave } from './unsaved';
import { legacyRoute, parseRoute, routeToLegacy, sameRoute, type LegacyView, type Route } from './workspace/navigation';
import { RouteHistory, buildSnapshot, newDocId, replayLabel, restoreSnapshot } from './workspace/documents';
import type { Draft, DraftState, ReplayTab, WorkspaceDoc } from './workspace/types';
import type { DialogRequest } from './components/Dialog';
import type { Approval, CoreClient, CoreInfo, ExchangeSummary, HeaderList, Paused, ScopeConfig } from './api';

/** An old screen name; resolves to a page in one of the work areas (see workspace/navigation). */
export type ViewId = LegacyView;

export type { Draft, ReplayTab, WorkspaceDoc, ComparisonDoc, FlowDoc, DraftState } from './workspace/types';

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
  /** Go back or forward through the places visited (Alt Left, Alt Right). */
  goBack(): void;
  goForward(): void;
  canBack: boolean;
  canForward: boolean;
  /** The open document on show in Replay, or 'history' when none. */
  activeTab: string;
  setActiveTab(id: string): void;
  /** Open documents: replay editors, conversations, comparisons and flows. */
  docs: WorkspaceDoc[];
  /** Same list as docs; kept for older callers. */
  replayTabs: WorkspaceDoc[];
  /** Documents with edits not yet saved anywhere. Drafts still survive a restart. */
  dirtyDocs: ReadonlySet<string>;
  markDirty(id: string, dirty: boolean): void;
  /** An editor reports what it holds, for recovery after a restart. Cheap: no re-render. */
  reportDraft(id: string, state: DraftState): void;
  /** Open a comparison of two exchanges as a document. */
  openComparison(a: string, b: string): void;
  /** Open a saved flow as a document. */
  openFlow(name: string): void;
  /** Open an endpoint, by its reference "host METHOD /template", as a document. */
  openEndpoint(key: string): void;
  /** How the workspace last saved: shown beside the open editors. */
  workspaceStatus: { state: 'idle' | 'saved' | 'error'; at?: number; message?: string; restored?: number };
  /** Ask a question with buttons; resolves with the chosen button's id (or 'cancel'). */
  ask(req: DialogRequest): Promise<string>;
  dialog: (DialogRequest & { resolve(v: string): void }) | null;
  /** Open (or switch to) the Replay tab for an exchange; a WebSocket opens the WebSocket replay editor. */
  openReplay(e: ReplayTarget, options?: ReplayTab['options']): void;
  /** Close a document; one with unsaved edits asks first. */
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

export function AppProvider({ client, children }: { client: CoreClient; children: ReactNode }) {
  const [info, setInfo] = useState<CoreInfo | null>(null);
  const [connected, setConnected] = useState(client.status === 'open');
  const [route, setRoute] = useState<Route>({ area: 'traffic', page: 'requests' });
  const routeRef = useRef(route);
  routeRef.current = route;
  const [activeTab, setActiveTab] = useState('history');
  const [docs, setDocs] = useState<WorkspaceDoc[]>([]);
  const [dirtyDocs, setDirtyDocs] = useState<ReadonlySet<string>>(new Set());
  const drafts = useRef(new Map<string, DraftState>());
  const [draftTick, setDraftTick] = useState(0);
  const [workspaceStatus, setWorkspaceStatus] = useState<AppState['workspaceStatus']>({ state: 'idle' });
  const [dialog, setDialog] = useState<AppState['dialog']>(null);
  const history = useRef(new RouteHistory());
  const [historyTick, setHistoryTick] = useState(0);
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
    history.current.push(cur);
    setHistoryTick((t) => t + 1);
    routeRef.current = r;
    setRoute(r);
  }, []);
  const step = useCallback((dir: 'back' | 'forward') => {
    const cur = routeRef.current;
    const r = dir === 'back' ? history.current.goBack(cur) : history.current.goForward(cur);
    if (!r) return;
    if ((cur.area !== r.area || cur.page !== r.page) && !confirmLeave()) {
      // Stay put: put the history back the way it was.
      if (dir === 'back') history.current.goForward(r);
      else history.current.goBack(r);
      return;
    }
    setHistoryTick((t) => t + 1);
    routeRef.current = r;
    setRoute(r);
  }, []);
  const goBack = useCallback(() => step('back'), [step]);
  const goForward = useCallback(() => step('forward'), [step]);
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
    setDocs((tabs) => (tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, exchangeId: e.id, kind, label: replayLabel(e.path), method: kind === 'ws' ? 'WS' : e.method, options }]));
    setActiveTab(id);
    setView('replay');
  }, [setView]);

  const openDraft = useCallback((draft: Draft, label?: string) => {
    const id = newDocId('draft');
    let name = label;
    if (!name) {
      try {
        name = replayLabel(new URL(draft.url).pathname);
      } catch {
        name = 'draft';
      }
    }
    setDocs((tabs) => [...tabs, { id, exchangeId: '', label: name!, method: draft.method, draft, ...(draft.options ? { options: draft.options } : {}) } satisfies ReplayTab]);
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

  const ask = useCallback((req: DialogRequest) => new Promise<string>((resolve) => setDialog({ ...req, resolve: (v) => (setDialog(null), resolve(v)) })), []);

  const markDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyDocs((cur) => {
      if (cur.has(id) === dirty) return cur;
      const next = new Set(cur);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const reportDraft = useCallback((id: string, state: DraftState) => {
    drafts.current.set(id, state);
    setDraftTick((t) => t + 1);
  }, []);

  const docsRef = useRef(docs);
  docsRef.current = docs;
  const dirtyRef = useRef(dirtyDocs);
  dirtyRef.current = dirtyDocs;
  const closeReplay = useCallback(
    (id: string) => {
      const doc = docsRef.current.find((d) => d.id === id);
      if (!doc) return;
      const drop = () => {
        drafts.current.delete(id);
        markDirty(id, false);
        setDocs((tabs) => tabs.filter((t) => t.id !== id));
        setActiveTab((cur) => {
          if (cur !== id) return cur;
          const rest = docsRef.current.filter((t) => t.id !== id);
          return rest[rest.length - 1]?.id ?? 'history';
        });
      };
      if (!dirtyRef.current.has(id)) return drop();
      void ask({
        title: `Close ${doc.label}?`,
        text: 'It has edits that are not saved. Closing it discards them; other open editors keep theirs.',
        choices: [
          { id: 'discard', label: 'Discard and close', tone: 'danger' },
          { id: 'cancel', label: 'Keep editing', primary: true },
        ],
      }).then((c) => c === 'discard' && drop());
    },
    [ask, markDirty],
  );

  const openComparison = useCallback(
    (a: string, b: string) => {
      const id = `compare-${a}-${b}`;
      setDocs((tabs) => (tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, kind: 'compare', label: 'Compare', method: 'DIFF', a, b }]));
      setActiveTab(id);
      setView('replay');
    },
    [setView],
  );

  const openFlow = useCallback(
    (name: string) => {
      const id = `flow-${name}`;
      setDocs((tabs) => (tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, kind: 'flow', label: name, method: 'FLOW', flow: name }]));
      setActiveTab(id);
      setView('replay');
    },
    [setView],
  );

  const openEndpoint = useCallback(
    (key: string) => {
      const id = `endpoint-${key}`;
      const [, method = 'GET', template = key] = key.split(' ');
      setDocs((tabs) => (tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, kind: 'endpoint', label: template, method, key }]));
      setActiveTab(id);
      setView('replay');
    },
    [setView],
  );

  // ---------- recovery: the workspace is saved per user, and put back on the next start ----------
  const asked = useRef(false);
  // Saving starts only once the last session has been read, so an empty start never overwrites it.
  const [restoreDone, setRestoreDone] = useState(false);
  useEffect(() => {
    if (!connected || asked.current) return;
    asked.current = true;
    client
      .workspace()
      .then(
        (snap) => {
          const r = restoreSnapshot(snap);
          if (!r || !r.docs.length) return;
          setDocs((cur) => [...r.docs.filter((d) => !cur.some((c) => c.id === d.id)), ...cur]);
          if (r.activeDoc) setActiveTab(r.activeDoc);
          setWorkspaceStatus({ state: 'saved', at: (snap as { savedAt?: number }).savedAt, restored: r.docs.length });
        },
        () => undefined,
      )
      .finally(() => setRestoreDone(true));
  }, [client, connected]);

  useEffect(() => {
    if (!restoreDone) return;
    const t = window.setTimeout(() => {
      const snap = buildSnapshot(routeRef.current, activeTab === 'history' ? null : activeTab, docsRef.current, drafts.current);
      client.saveWorkspace(snap as never).then(
        (r) => setWorkspaceStatus((s) => ({ state: 'saved', at: r.savedAt, ...(s.restored ? { restored: s.restored } : {}) })),
        (e: Error) => setWorkspaceStatus({ state: 'error', message: `Drafts were not saved: ${e.message}` }),
      );
    }, 600);
    return () => window.clearTimeout(t);
  }, [client, restoreDone, docs, activeTab, draftTick, route]);

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
      goBack,
      goForward,
      canBack: history.current.canBack,
      canForward: history.current.canForward,
      activeTab,
      setActiveTab,
      docs,
      replayTabs: docs,
      dirtyDocs,
      markDirty,
      reportDraft,
      openComparison,
      openFlow,
      openEndpoint,
      workspaceStatus,
      ask,
      dialog,
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
    [client, info, connected, route, navigate, view, setView, goBack, goForward, historyTick, activeTab, docs, dirtyDocs, markDirty, reportDraft, openComparison, openFlow, openEndpoint, workspaceStatus, ask, dialog, openReplay, closeReplay, resendNow, selectedId, query, savedViews, saveView, refreshInfo, scope, openReplayById, toast, notify, openDraft, codecInput, sendToCodecs, raceItems, sendToRace, h3Items, sendToH3, streamId, streamPrefill, openStream, paused, approvals, openAt, flowPicks, traceInput, traceValue, compareMark, sendToApi, apiInput],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
