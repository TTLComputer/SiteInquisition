import type { TextRegion } from '@siteinquisition/codecs/regionedit';
import type { HeaderList } from '../api';
import type { Route } from './navigation';

/**
 * Open work, as documents. A document is one request, conversation,
 * comparison or flow being worked on; the work area only says what kind of
 * work is on screen. Recorded exchanges are evidence and are never edited: a
 * document keeps a reference to the exchange it came from and its own draft.
 */

/** A request built somewhere other than Traffic (Decode, an agent, a script, curl) and opened in Replay. */
export interface Draft {
  method: string;
  url: string;
  headers: HeaderList;
  body?: string;
  /** Opened from a curl command: what it could not carry over, and the files it reads. */
  imported?: { warnings: string[]; files: string[] };
  /** Send options to start with. */
  options?: ReplayOptions;
}

export interface ReplayOptions {
  refreshCookies?: boolean;
  flow?: string;
  ignoreTls?: boolean;
  followRedirects?: boolean;
  protocol?: 'h1' | 'h2' | 'h3';
  h2Method?: '' | 'alpn' | 'upgrade' | 'prior-knowledge';
}

/** What an HTTP replay editor had in it, to put back after a restart. */
export interface HttpDraftState {
  kind: 'http';
  raw: string;
  regions: TextRegion[];
  options: Record<string, unknown>;
}

/** What a WebSocket replay editor had in it. Steps are stored as the editor holds them. */
export interface WsDraftState {
  kind: 'ws';
  handshake: string;
  steps: unknown[];
  options: Record<string, unknown>;
}

export type DraftState = HttpDraftState | WsDraftState;

/** An HTTP request or WebSocket conversation in a replay editor. */
export interface ReplayTab {
  id: string;
  /** The exchange this replays; empty for a document opened from a draft. */
  exchangeId: string;
  /** "ws" replays a WebSocket connection: handshake plus an editable message script. */
  kind?: 'http' | 'ws';
  label: string;
  method: string;
  draft?: Draft;
  /** Send options to start with, e.g. fresh cookies from the jar. */
  options?: ReplayOptions;
  /** The editor's contents from the last session. Opening it sends nothing. */
  recovered?: DraftState;
}

/** Two exchanges side by side. */
export interface ComparisonDoc {
  id: string;
  kind: 'compare';
  label: string;
  method: 'DIFF';
  a: string;
  b: string;
}

/** A saved flow open for editing. */
export interface FlowDoc {
  id: string;
  kind: 'flow';
  label: string;
  method: 'FLOW';
  flow: string;
}

export type WorkspaceDoc = ReplayTab | ComparisonDoc | FlowDoc;

export const isReplayDoc = (d: WorkspaceDoc): d is ReplayTab => d.kind === undefined || d.kind === 'http' || d.kind === 'ws';

/** What is written to the per-user workspace. Bump the version when its shape changes, and migrate in documents.ts. */
export interface WorkspaceSnapshotV1 {
  version: 1;
  savedAt?: number;
  route: Route;
  activeDoc: string | null;
  docs: WorkspaceDoc[];
}
