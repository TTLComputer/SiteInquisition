import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { bytesToString, decodeContentEncoding, looksLikeText } from '@siteinquisition/codecs';
import { newId } from './ids.js';
import { compileQuery } from './search.js';

export type HeaderList = Array<[string, string]>;
export type ExchangeSource = 'browser' | 'proxy' | 'replay' | 'script' | 'mcp';
export type ExchangeState = 'pending' | 'complete' | 'aborted' | 'error';

export interface Timings {
  /** Milliseconds from request start until the request body was fully received. */
  requestBody?: number;
  /** Milliseconds from request start until response headers were sent to the client. */
  responseHeaders?: number;
  /** Milliseconds from request start until the response finished. */
  total?: number;
}

export interface ExchangeSummary {
  id: string;
  flowId: string;
  parentId: string | null;
  source: ExchangeSource;
  clientAddr: string | null;
  startedAt: number;
  method: string;
  url: string;
  scheme: string;
  host: string;
  port: number;
  path: string;
  status: number | null;
  state: ExchangeState;
  isWebSocket: boolean;
  reqBodySize: number;
  resBodySize: number | null;
  durationMs: number | null;
  tags: string[];
}

export interface Exchange extends ExchangeSummary {
  httpVersion: string;
  requestHeaders: HeaderList;
  responseHeaders: HeaderList | null;
  statusMessage: string | null;
  timings: Timings;
  error: string | null;
  notes: string | null;
  createdBy: string;
  requestBodyTruncated: boolean;
  responseBodyTruncated: boolean;
}

export interface NewRequest {
  id?: string;
  flowId?: string;
  parentId?: string | null;
  source: ExchangeSource;
  clientAddr?: string | null;
  startedAt: number;
  method: string;
  url: string;
  httpVersion: string;
  headers: HeaderList;
  body?: Uint8Array;
  isWebSocket?: boolean;
  tags?: string[];
}

export interface NewResponse {
  status: number;
  statusMessage?: string;
  headers: HeaderList;
  body?: Uint8Array;
  timings?: Timings;
}

export interface StreamMessage {
  id: string;
  streamId: string;
  direction: 'client' | 'server';
  /** WebSocket: "text" or "binary". MQTT: the packet type, e.g. "publish", "subscribe", "connack". */
  opcode: string;
  at: number;
  size: number;
  payload: Uint8Array;
  /** Protocol details that are not the payload, e.g. MQTT topic, QoS and retain flag. */
  meta?: Record<string, unknown> | null;
}

export interface Change {
  id: string;
  actor: string;
  at: number;
  kind: string;
  entity: string;
  entityId: string;
  data: unknown;
}

export interface SearchOptions {
  limit?: number;
  /** Return exchanges older than this id (for paging backwards in time). */
  before?: string;
  order?: 'newest' | 'oldest';
}

export interface StoreOptions {
  /** Who is making changes. Recorded on every row and change-log entry. */
  actor?: string;
  /** Bodies larger than this are stored truncated. Default 10 MB. */
  maxBodyBytes?: number;
  /** Decoded text indexed for full-text search, per body. Default 1 MB. */
  maxIndexBytes?: number;
}

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flow (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS exchange (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL REFERENCES flow(id),
  parent_id TEXT REFERENCES exchange(id),
  source TEXT NOT NULL,
  client_addr TEXT,
  started_at INTEGER NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  scheme TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  path TEXT NOT NULL,
  http_version TEXT NOT NULL,
  req_headers TEXT NOT NULL,
  req_body TEXT REFERENCES blob(sha256),
  req_body_size INTEGER NOT NULL DEFAULT 0,
  req_truncated INTEGER NOT NULL DEFAULT 0,
  status INTEGER,
  status_message TEXT,
  res_headers TEXT,
  res_body TEXT REFERENCES blob(sha256),
  res_body_size INTEGER,
  res_truncated INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  error TEXT,
  timings TEXT NOT NULL DEFAULT '{}',
  is_websocket INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS exchange_started ON exchange(started_at);
CREATE INDEX IF NOT EXISTS exchange_host ON exchange(host);
CREATE INDEX IF NOT EXISTS exchange_flow ON exchange(flow_id);
CREATE INDEX IF NOT EXISTS exchange_status ON exchange(status);
CREATE TABLE IF NOT EXISTS blob (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  compression TEXT NOT NULL,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS stream (
  id TEXT PRIMARY KEY,
  exchange_id TEXT REFERENCES exchange(id),
  protocol TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_code INTEGER,
  close_reason TEXT,
  created_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stream_message (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES stream(id),
  direction TEXT NOT NULL,
  opcode TEXT NOT NULL,
  at INTEGER NOT NULL,
  size INTEGER NOT NULL,
  payload BLOB NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS stream_message_stream ON stream_message(stream_id, id);
CREATE TABLE IF NOT EXISTS tls_failure (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  host TEXT,
  client_addr TEXT,
  cause TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS change (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS exchange_fts USING fts5(
  exchange_id UNINDEXED, url, headers, body, tokenize = 'unicode61'
);
`;

interface ExchangeRow {
  id: string;
  flow_id: string;
  parent_id: string | null;
  source: ExchangeSource;
  client_addr: string | null;
  started_at: number;
  method: string;
  url: string;
  scheme: string;
  host: string;
  port: number;
  path: string;
  http_version: string;
  req_headers: string;
  req_body: string | null;
  req_body_size: number;
  req_truncated: number;
  status: number | null;
  status_message: string | null;
  res_headers: string | null;
  res_body: string | null;
  res_body_size: number | null;
  res_truncated: number;
  state: ExchangeState;
  error: string | null;
  timings: string;
  is_websocket: number;
  tags: string;
  notes: string | null;
  created_by: string;
}

const header = (headers: HeaderList, name: string): string | undefined => {
  const lower = name.toLowerCase();
  return headers.find(([k]) => k.toLowerCase() === lower)?.[1];
};

export const defaultPort = (scheme: string): number =>
  ({ https: 443, wss: 443, mqtt: 1883, mqtts: 8883 })[scheme] ?? 80;

const headersText = (headers: HeaderList) => headers.map(([k, v]) => `${k}: ${v}`).join('\n');

const toSummary = (r: ExchangeRow): ExchangeSummary => ({
  id: r.id,
  flowId: r.flow_id,
  parentId: r.parent_id,
  source: r.source,
  clientAddr: r.client_addr,
  startedAt: r.started_at,
  method: r.method,
  url: r.url,
  scheme: r.scheme,
  host: r.host,
  port: r.port,
  path: r.path,
  status: r.status,
  state: r.state,
  isWebSocket: !!r.is_websocket,
  reqBodySize: r.req_body_size,
  resBodySize: r.res_body_size,
  durationMs: (JSON.parse(r.timings) as Timings).total ?? null,
  tags: JSON.parse(r.tags) as string[],
});

/**
 * The capture database for one project. All writes go through this class so
 * every mutation lands in the change log and is announced on the `change`
 * event, which is what the UI, the core API and (later) replication follow.
 */
export class CaptureStore extends EventEmitter<{ change: [Change] }> {
  readonly db: Database.Database;
  readonly actor: string;
  private readonly maxBodyBytes: number;
  private readonly maxIndexBytes: number;

  constructor(file: string, opts: StoreOptions = {}) {
    super();
    this.actor = opts.actor ?? 'local';
    this.maxBodyBytes = opts.maxBodyBytes ?? 10 * 1024 * 1024;
    this.maxIndexBytes = opts.maxIndexBytes ?? 1024 * 1024;
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    try {
      this.migrate();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  /** Open (or create) the database inside a project folder. */
  static openProject(dir: string, opts?: StoreOptions): CaptureStore {
    mkdirSync(dir, { recursive: true });
    return new CaptureStore(join(dir, 'project.sqlite'), opts);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(SCHEMA);
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    const version = row ? Number(row.value) : SCHEMA_VERSION;
    if (version > SCHEMA_VERSION) throw new Error(`project was created by a newer SiteInquisition (schema ${row!.value})`);
    if (version < 2) {
      const cols = this.db.prepare('PRAGMA table_info(stream_message)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'meta')) this.db.exec('ALTER TABLE stream_message ADD COLUMN meta TEXT');
    }
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION));
  }

  // ---------- meta ----------

  getMeta<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setMeta(key: string, value: unknown): void {
    this.tx(() => {
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
      this.recordChange('meta.set', 'meta', key, value);
    });
  }

  // ---------- change log ----------

  private pending: Change[] = [];
  private depth = 0;

  /** Run fn in a transaction; change events fire only after it commits. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth = 1;
    let out: T;
    try {
      out = this.db.transaction(fn)();
    } catch (err) {
      this.pending = [];
      throw err;
    } finally {
      this.depth = 0;
    }
    const changes = this.pending;
    this.pending = [];
    for (const c of changes) this.emit('change', c);
    return out;
  }

  private recordChange(kind: string, entity: string, entityId: string, data: unknown): void {
    const change: Change = { id: newId(), actor: this.actor, at: Date.now(), kind, entity, entityId, data };
    this.db
      .prepare('INSERT INTO change (id, actor, at, kind, entity, entity_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(change.id, change.actor, change.at, kind, entity, entityId, JSON.stringify(data));
    this.pending.push(change);
  }

  changesSince(afterId: string | null, limit = 500): Change[] {
    const rows = this.db
      .prepare('SELECT * FROM change WHERE id > ? ORDER BY id LIMIT ?')
      .all(afterId ?? '', limit) as Array<{ id: string; actor: string; at: number; kind: string; entity: string; entity_id: string; data: string }>;
    return rows.map((r) => ({ id: r.id, actor: r.actor, at: r.at, kind: r.kind, entity: r.entity, entityId: r.entity_id, data: JSON.parse(r.data) }));
  }

  // ---------- blobs ----------

  private putBlob(data: Uint8Array): { sha: string; size: number; truncated: boolean } {
    const truncated = data.byteLength > this.maxBodyBytes;
    const body = truncated ? data.subarray(0, this.maxBodyBytes) : data;
    const sha = createHash('sha256').update(body).digest('hex');
    const exists = this.db.prepare('SELECT 1 FROM blob WHERE sha256 = ?').get(sha);
    if (!exists) {
      let compression = 'none';
      let stored: Uint8Array = body;
      if (body.byteLength > 512) {
        const z = deflateRawSync(body, { level: 1 });
        if (z.byteLength < body.byteLength * 0.9) {
          stored = z;
          compression = 'deflate-raw';
        }
      }
      this.db.prepare('INSERT INTO blob (sha256, size, compression, data) VALUES (?, ?, ?, ?)').run(sha, body.byteLength, compression, stored);
    }
    return { sha, size: data.byteLength, truncated };
  }

  getBlob(sha: string): Uint8Array | undefined {
    const row = this.db.prepare('SELECT compression, data FROM blob WHERE sha256 = ?').get(sha) as { compression: string; data: Buffer } | undefined;
    if (!row) return undefined;
    return new Uint8Array(row.compression === 'deflate-raw' ? inflateRawSync(row.data) : row.data);
  }

  // ---------- exchanges ----------

  addRequest(req: NewRequest): ExchangeSummary {
    const url = new URL(req.url);
    const id = req.id ?? newId();
    return this.tx(() => {
      let flowId = req.flowId;
      if (!flowId) {
        flowId = newId();
        this.db.prepare('INSERT INTO flow (id, kind, created_at) VALUES (?, ?, ?)').run(flowId, 'single', req.startedAt);
      }
      const body = req.body && req.body.byteLength ? this.putBlob(req.body) : undefined;
      const scheme = url.protocol.replace(/:$/, '');
      const port = url.port ? Number(url.port) : defaultPort(scheme);
      this.db
        .prepare(
          `INSERT INTO exchange (id, flow_id, parent_id, source, client_addr, started_at, method, url, scheme, host, port, path,
             http_version, req_headers, req_body, req_body_size, req_truncated, state, is_websocket, tags, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          id,
          flowId,
          req.parentId ?? null,
          req.source,
          req.clientAddr ?? null,
          req.startedAt,
          req.method.toUpperCase(),
          url.href,
          scheme,
          url.hostname.toLowerCase(),
          port,
          url.pathname + url.search,
          req.httpVersion,
          JSON.stringify(req.headers),
          body?.sha ?? null,
          body?.size ?? 0,
          body?.truncated ? 1 : 0,
          req.isWebSocket ? 1 : 0,
          JSON.stringify(req.tags ?? []),
          this.actor,
        );
      if (req.parentId) {
        this.db.prepare("UPDATE flow SET kind = 'redirect' WHERE id = ? AND kind = 'single'").run(flowId);
      }
      this.db
        .prepare('INSERT INTO exchange_fts (exchange_id, url, headers, body) VALUES (?, ?, ?, ?)')
        .run(id, url.href, headersText(req.headers), this.indexText(req.body, req.headers));
      const summary = this.getSummary(id)!;
      this.recordChange('exchange.request', 'exchange', id, summary);
      return summary;
    });
  }

  completeResponse(id: string, res: NewResponse): ExchangeSummary {
    return this.tx(() => {
      const body = res.body && res.body.byteLength ? this.putBlob(res.body) : undefined;
      const info = this.db
        .prepare(
          `UPDATE exchange SET status = ?, status_message = ?, res_headers = ?, res_body = ?, res_body_size = ?, res_truncated = ?,
             timings = ?, state = 'complete' WHERE id = ?`,
        )
        .run(res.status, res.statusMessage ?? null, JSON.stringify(res.headers), body?.sha ?? null, body?.size ?? 0, body?.truncated ? 1 : 0, JSON.stringify(res.timings ?? {}), id);
      if (info.changes === 0) throw new Error(`no exchange ${id}`);
      const resText = this.indexText(res.body, res.headers);
      const ftsRow = this.db.prepare('SELECT rowid, headers, body FROM exchange_fts WHERE exchange_id = ?').get(id) as { rowid: number; headers: string; body: string } | undefined;
      if (ftsRow) {
        this.db
          .prepare('UPDATE exchange_fts SET headers = ?, body = ? WHERE rowid = ?')
          .run(`${ftsRow.headers}\n${headersText(res.headers)}`, [ftsRow.body, resText].filter(Boolean).join('\n'), ftsRow.rowid);
      }
      const summary = this.getSummary(id)!;
      this.recordChange('exchange.response', 'exchange', id, summary);
      return summary;
    });
  }

  /** Mark a connection-style exchange (e.g. an MQTT session) as established, without an HTTP response. */
  markEstablished(id: string, timings?: Timings): ExchangeSummary {
    return this.tx(() => {
      this.db.prepare("UPDATE exchange SET state = 'complete', timings = COALESCE(?, timings) WHERE id = ?").run(timings ? JSON.stringify(timings) : null, id);
      const summary = this.getSummary(id)!;
      this.recordChange('exchange.established', 'exchange', id, summary);
      return summary;
    });
  }

  failExchange(id: string, state: 'aborted' | 'error', error: string, timings?: Timings): void {
    this.tx(() => {
      this.db.prepare('UPDATE exchange SET state = ?, error = ?, timings = COALESCE(?, timings) WHERE id = ?').run(state, error, timings ? JSON.stringify(timings) : null, id);
      this.recordChange(`exchange.${state}`, 'exchange', id, { error });
    });
  }

  tagExchange(id: string, tags: string[]): void {
    this.tx(() => {
      this.db.prepare('UPDATE exchange SET tags = ? WHERE id = ?').run(JSON.stringify([...new Set(tags)]), id);
      this.recordChange('exchange.tags', 'exchange', id, { tags });
    });
  }

  setNotes(id: string, notes: string | null): void {
    this.tx(() => {
      this.db.prepare('UPDATE exchange SET notes = ? WHERE id = ?').run(notes, id);
      this.recordChange('exchange.notes', 'exchange', id, { notes });
    });
  }

  private indexText(body: Uint8Array | undefined, headers: HeaderList): string {
    if (!body || !body.byteLength) return '';
    const decoded = decodeContentEncoding(body, header(headers, 'content-encoding'));
    if (!decoded || !looksLikeText(decoded)) return '';
    return bytesToString(decoded.subarray(0, this.maxIndexBytes));
  }

  private getRow(id: string): ExchangeRow | undefined {
    return this.db.prepare('SELECT * FROM exchange WHERE id = ?').get(id) as ExchangeRow | undefined;
  }

  getSummary(id: string): ExchangeSummary | undefined {
    const r = this.getRow(id);
    return r && toSummary(r);
  }

  getExchange(id: string): Exchange | undefined {
    const r = this.getRow(id);
    if (!r) return undefined;
    return {
      ...toSummary(r),
      httpVersion: r.http_version,
      requestHeaders: JSON.parse(r.req_headers) as HeaderList,
      responseHeaders: r.res_headers ? (JSON.parse(r.res_headers) as HeaderList) : null,
      statusMessage: r.status_message,
      timings: JSON.parse(r.timings) as Timings,
      error: r.error,
      notes: r.notes,
      createdBy: r.created_by,
      requestBodyTruncated: !!r.req_truncated,
      responseBodyTruncated: !!r.res_truncated,
    };
  }

  /** Raw body bytes as sent on the wire, or with Content-Encoding undone when decoded is true. */
  getBody(id: string, side: 'request' | 'response', decoded = false): Uint8Array | undefined {
    const r = this.getRow(id);
    if (!r) return undefined;
    const sha = side === 'request' ? r.req_body : r.res_body;
    if (!sha) return new Uint8Array();
    const raw = this.getBlob(sha);
    if (!raw || !decoded) return raw;
    const headers = JSON.parse(side === 'request' ? r.req_headers : (r.res_headers ?? '[]')) as HeaderList;
    return decodeContentEncoding(raw, header(headers, 'content-encoding')) ?? raw;
  }

  search(query = '', opts: SearchOptions = {}): ExchangeSummary[] {
    const q = compileQuery(query);
    const where = [...q.where];
    const params = [...q.params];
    if (q.match) {
      where.push('e.id IN (SELECT exchange_id FROM exchange_fts WHERE exchange_fts MATCH ?)');
      params.push(q.match);
    }
    const newest = (opts.order ?? 'newest') === 'newest';
    if (opts.before) {
      where.push(newest ? 'e.id < ?' : 'e.id > ?');
      params.push(opts.before);
    }
    const sql = `SELECT * FROM exchange e ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.id ${newest ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(Math.min(Math.max(opts.limit ?? 100, 1), 10_000));
    return (this.db.prepare(sql).all(...params) as ExchangeRow[]).map(toSummary);
  }

  /** Every exchange in a flow (a redirect chain or a replay batch), in order. */
  getFlow(flowId: string): ExchangeSummary[] {
    return (this.db.prepare('SELECT * FROM exchange WHERE flow_id = ? ORDER BY id').all(flowId) as ExchangeRow[]).map(toSummary);
  }

  // ---------- streams (WebSocket, later MQTT) ----------

  openStream(protocol: 'websocket' | 'mqtt', exchangeId: string | null, openedAt = Date.now(), id = newId()): string {
    this.tx(() => {
      this.db.prepare('INSERT INTO stream (id, exchange_id, protocol, opened_at, created_by) VALUES (?, ?, ?, ?, ?)').run(id, exchangeId, protocol, openedAt, this.actor);
      this.recordChange('stream.open', 'stream', id, { protocol, exchangeId });
    });
    return id;
  }

  addStreamMessage(msg: Omit<StreamMessage, 'id' | 'size'>): StreamMessage {
    const full: StreamMessage = { ...msg, id: newId(), size: msg.payload.byteLength };
    this.tx(() => {
      this.db
        .prepare('INSERT INTO stream_message (id, stream_id, direction, opcode, at, size, payload, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(full.id, full.streamId, full.direction, full.opcode, full.at, full.size, full.payload, full.meta ? JSON.stringify(full.meta) : null);
      const { payload: _payload, ...rest } = full;
      this.recordChange('stream.message', 'stream', full.streamId, rest);
    });
    return full;
  }

  closeStream(id: string, code?: number, reason?: string, closedAt = Date.now()): void {
    this.tx(() => {
      this.db.prepare('UPDATE stream SET closed_at = ?, close_code = ?, close_reason = ? WHERE id = ?').run(closedAt, code ?? null, reason ?? null, id);
      this.recordChange('stream.close', 'stream', id, { code, reason });
    });
  }

  getStreamForExchange(exchangeId: string): { id: string; protocol: string; openedAt: number; closedAt: number | null; closeCode: number | null } | undefined {
    const r = this.db.prepare('SELECT * FROM stream WHERE exchange_id = ?').get(exchangeId) as
      | { id: string; protocol: string; opened_at: number; closed_at: number | null; close_code: number | null }
      | undefined;
    return r && { id: r.id, protocol: r.protocol, openedAt: r.opened_at, closedAt: r.closed_at, closeCode: r.close_code };
  }

  getStreamMessages(streamId: string, opts: { after?: string; limit?: number } = {}): StreamMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM stream_message WHERE stream_id = ? AND id > ? ORDER BY id LIMIT ?')
      .all(streamId, opts.after ?? '', opts.limit ?? 1000) as Array<{ id: string; stream_id: string; direction: 'client' | 'server'; opcode: string; at: number; size: number; payload: Buffer; meta: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      streamId: r.stream_id,
      direction: r.direction,
      opcode: r.opcode,
      at: r.at,
      size: r.size,
      payload: new Uint8Array(r.payload),
      meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
    }));
  }

  // ---------- TLS failures ----------

  addTlsFailure(f: { host?: string; clientAddr?: string; cause: string; at?: number }): void {
    const id = newId();
    this.tx(() => {
      this.db.prepare('INSERT INTO tls_failure (id, at, host, client_addr, cause) VALUES (?, ?, ?, ?, ?)').run(id, f.at ?? Date.now(), f.host ?? null, f.clientAddr ?? null, f.cause);
      this.recordChange('tls.failure', 'tls_failure', id, f);
    });
  }

  /** Hosts whose clients keep rejecting our certificate: likely certificate pinning. */
  tlsFailureSummary(): Array<{ host: string | null; cause: string; count: number; lastAt: number }> {
    return this.db
      .prepare('SELECT host, cause, COUNT(*) AS count, MAX(at) AS lastAt FROM tls_failure GROUP BY host, cause ORDER BY count DESC')
      .all() as Array<{ host: string | null; cause: string; count: number; lastAt: number }>;
  }
}
