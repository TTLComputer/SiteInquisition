import { parseRoute, routeKey, type Route } from './navigation';
import type { DraftState, WorkspaceDoc, WorkspaceSnapshotV1 } from './types';
import { isReplayDoc } from './types';

/** A short tab label from a URL path: its last segment. */
export const replayLabel = (path: string) => {
  const clean = path.split('?')[0] ?? path;
  const last = clean.split('/').filter(Boolean).pop();
  try {
    return last ? decodeURIComponent(last).slice(0, 32) : clean || '/';
  } catch {
    return last ? last.slice(0, 32) : clean || '/';
  }
};

export const newDocId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The workspace as it is saved: documents with their current drafts folded in. */
export function buildSnapshot(route: Route, activeDoc: string | null, docs: WorkspaceDoc[], drafts: ReadonlyMap<string, DraftState>): WorkspaceSnapshotV1 {
  return {
    version: 1,
    route,
    activeDoc,
    docs: docs.map((d) => {
      if (!isReplayDoc(d)) return d;
      const draft = drafts.get(d.id) ?? d.recovered;
      return draft ? { ...d, recovered: draft } : d;
    }),
  };
}

const str = (v: unknown): v is string => typeof v === 'string';

function validDoc(d: unknown): d is WorkspaceDoc {
  if (!d || typeof d !== 'object') return false;
  const x = d as Record<string, unknown>;
  if (!str(x.id) || !str(x.label)) return false;
  if (x.kind === 'compare') return str(x.a) && str(x.b);
  if (x.kind === 'flow') return str(x.flow);
  if (x.kind !== undefined && x.kind !== 'http' && x.kind !== 'ws') return false;
  if (!str(x.exchangeId) || !str(x.method)) return false;
  // A draft-only document needs its draft; one from an exchange needs the exchange id.
  return !!x.exchangeId || (!!x.draft && typeof x.draft === 'object') || !!x.recovered;
}

/**
 * Read a saved workspace. Unknown versions and damaged documents are dropped
 * rather than half-restored. Restoring never sends anything: documents come
 * back as drafts, and WebSocket editors come back disconnected.
 */
export function restoreSnapshot(raw: unknown): { route: Route | null; activeDoc: string | null; docs: WorkspaceDoc[]; dropped: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<WorkspaceSnapshotV1> & { version?: unknown };
  if (s.version !== 1) return null;
  const list = Array.isArray(s.docs) ? s.docs : [];
  const docs = list.filter(validDoc);
  const seen = new Set<string>();
  const unique = docs.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
  const route = s.route && typeof s.route === 'object' && str((s.route as Route).area) ? parseRoute(routeKey(s.route as Route)) : null;
  const activeDoc = str(s.activeDoc) && unique.some((d) => d.id === s.activeDoc) ? s.activeDoc : (unique[unique.length - 1]?.id ?? null);
  return { route, activeDoc, docs: unique, dropped: list.length - unique.length };
}

/** Back and forward through places visited, like a browser. */
export class RouteHistory {
  private back: Route[] = [];
  private fwd: Route[] = [];
  constructor(private readonly limit = 50) {}
  push(from: Route): void {
    this.back.push(from);
    if (this.back.length > this.limit) this.back.shift();
    this.fwd = [];
  }
  goBack(current: Route): Route | null {
    const r = this.back.pop();
    if (!r) return null;
    this.fwd.push(current);
    return r;
  }
  goForward(current: Route): Route | null {
    const r = this.fwd.pop();
    if (!r) return null;
    this.back.push(current);
    return r;
  }
  /** Undo a move that was refused (e.g. the user kept their unsaved edits). */
  dropLast(): void {
    this.back.pop();
  }
  get canBack(): boolean {
    return this.back.length > 0;
  }
  get canForward(): boolean {
    return this.fwd.length > 0;
  }
}
