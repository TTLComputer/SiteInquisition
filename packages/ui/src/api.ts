import type { Change, Exchange, ExchangeSummary, HeaderList, ScopeConfig, SeenHost, StreamMessage } from '@siteinquisition/core';

export type { Change, Exchange, ExchangeSummary, HeaderList, ScopeConfig, SeenHost, StreamMessage };
export type { ScopeRule } from '@siteinquisition/core';

export interface CoreInfo {
  version: string;
  projectDir: string;
  actor: string;
  proxyPort: number | null;
  apiPort: number | null;
  allowLan: boolean;
  ca: { certPath: string; fingerprint: string; expiresAt: string };
  decryptHosts: string[];
  stats: { exchanges: number; databaseBytes: number };
  mqtt: Array<{ port: number | null; broker: string; listenTls: boolean }>;
}

export type ExchangeDetail = Exchange & { stream: { id: string; protocol: string; openedAt: number; closedAt: number | null; closeCode: number | null } | null };
export type WireStreamMessage = Omit<StreamMessage, 'payload'> & { base64: string };
export interface SiteMapHost {
  host: string;
  count: number;
  paths: Array<{ segment: string; count: number }>;
}

/** Where to reach the core: from the Electron preload, or from the page URL when run in a plain browser. */
export interface Connection {
  url: string;
  token: string;
}

declare global {
  interface Window {
    siq?: {
      getConnection(): Promise<Connection>;
      setTheme(theme: 'system' | 'light' | 'dark'): Promise<void>;
      platform: string;
    };
  }
}

export async function resolveConnection(): Promise<Connection | null> {
  if (window.siq) return window.siq.getConnection();
  const params = new URLSearchParams(location.search);
  const url = params.get('api');
  const token = params.get('token');
  return url && token ? { url, token } : null;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Status = 'connecting' | 'open' | 'closed';

/**
 * JSON-RPC client for the core API. Reconnects with backoff and re-subscribes
 * to change events, so views can simply redraw from what the core says.
 */
export class CoreClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private changeListeners = new Set<(c: Change) => void>();
  private statusListeners = new Set<(s: Status) => void>();
  private retry = 0;
  private closedByUser = false;
  status: Status = 'connecting';

  constructor(private readonly conn: Connection) {
    this.open();
  }

  private setStatus(s: Status) {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private open() {
    const ws = new WebSocket(`${this.conn.url}/?token=${encodeURIComponent(this.conn.token)}`);
    this.ws = ws;
    this.setStatus('connecting');
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
      void this.call('events.subscribe');
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
      if (msg.method === 'change') {
        for (const l of this.changeListeners) l(msg.params as Change);
        return;
      }
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('connection to core lost'));
      this.pending.clear();
      this.setStatus('closed');
      if (this.closedByUser) return;
      const delay = Math.min(5000, 250 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }

  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Wait for the socket rather than failing calls made during start-up or a reconnect.
      return new Promise<T>((resolve, reject) => {
        const off = this.onStatus((s) => {
          if (s === 'open') {
            off();
            this.call<T>(method, params).then(resolve, reject);
          }
        });
      });
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  onChange(fn: (c: Change) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onStatus(fn: (s: Status) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  // Typed helpers
  info = () => this.call<CoreInfo>('core.info');
  search = (query: string, opts: { limit?: number; before?: string } = {}) => this.call<ExchangeSummary[]>('traffic.search', { query, ...opts });
  get = (id: string) => this.call<ExchangeDetail>('traffic.get', { id });
  body = (id: string, side: 'request' | 'response', decoded = true) =>
    this.call<{ size: number; base64: string }>('traffic.body', { id, side, decoded }).then((b) => base64ToBytes(b.base64));
  streamMessages = (exchangeId: string, after?: string) => this.call<WireStreamMessage[]>('traffic.streamMessages', { exchangeId, after, limit: 1000 });
  siteMap = () => this.call<SiteMapHost[]>('traffic.siteMap', { limit: 200 });
  tag = (id: string, tags: string[]) => this.call<boolean>('traffic.tag', { id, tags });
  notes = (id: string, notes: string) => this.call<boolean>('traffic.notes', { id, notes });
  scope = () => this.call<ScopeConfig>('scope.get');
  setScope = (config: ScopeConfig) => this.call<ScopeConfig>('scope.set', { config });
  seen = () => this.call<SeenHost[]>('scope.seen');
  tlsFailures = () => this.call<Array<{ host: string | null; cause: string; count: number; lastAt: number }>>('tls.failures');
  replay = (req: { method: string; url: string; headers: HeaderList; body?: Uint8Array; replayOf?: string; ignoreTlsErrors?: boolean }) =>
    this.call<ExchangeSummary>('replay.send', {
      method: req.method,
      url: req.url,
      headers: req.headers,
      bodyBase64: req.body ? bytesToBase64(req.body) : undefined,
      replayOf: req.replayOf,
      ignoreTlsErrors: req.ignoreTlsErrors,
    });
  replayHistory = (of: string) => this.call<ExchangeSummary[]>('replay.history', { of });
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
