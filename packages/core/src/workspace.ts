import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretBox } from './secrets.js';

/**
 * The per-user workspace: open editors with their unsaved drafts, and where
 * the user was. It belongs to one person on one computer, so it lives in the
 * per-user data folder rather than the shared project, and is never part of
 * the change log other clients see.
 *
 * Drafts can hold captured traffic (cookies, tokens), so the file is sealed
 * with the keyring's master key when there is one, and otherwise readable only
 * by the user, the same as other secrets at rest.
 *
 * The core stores the snapshot as given and does not interpret it; the
 * renderer owns its shape and its `version`.
 */

/** Refuse snapshots past this size: a workspace is drafts, not a traffic dump. */
export const WORKSPACE_MAX_BYTES = 8 * 1024 * 1024;

export interface WorkspaceSnapshot {
  version: number;
  savedAt: number;
  [k: string]: unknown;
}

export class WorkspaceStore {
  readonly path: string;

  constructor(
    dataDir: string,
    projectDir: string,
    actor: string,
    private readonly secrets: SecretBox | undefined,
  ) {
    const key = createHash('sha256').update(`${projectDir}\0${actor}`).digest('hex').slice(0, 32);
    this.path = join(dataDir, 'workspaces', `${key}.json`);
  }

  /** The last saved snapshot, or null when there is none or it cannot be read (another keyring, a damaged file). */
  get(): WorkspaceSnapshot | null {
    if (!existsSync(this.path)) return null;
    try {
      const file = JSON.parse(readFileSync(this.path, 'utf8')) as { sealed?: string; plain?: WorkspaceSnapshot };
      if (file.sealed) {
        if (!this.secrets) return null;
        return JSON.parse(this.secrets.open(file.sealed).toString('utf8')) as WorkspaceSnapshot;
      }
      return file.plain ?? null;
    } catch {
      return null;
    }
  }

  /** Replace the snapshot. Written to a temporary file first so a crash cannot leave half a workspace. */
  set(snapshot: WorkspaceSnapshot): { savedAt: number; sealed: boolean } {
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.version !== 'number') throw new Error('a workspace snapshot needs a numeric version');
    const savedAt = Date.now();
    const json = JSON.stringify({ ...snapshot, savedAt });
    if (json.length > WORKSPACE_MAX_BYTES) throw new Error(`the workspace is ${Math.round(json.length / 1024)} KB, over the ${WORKSPACE_MAX_BYTES / 1024 / 1024} MB limit; close some editors`);
    mkdirSync(join(this.path, '..'), { recursive: true });
    const body = this.secrets ? JSON.stringify({ sealed: this.secrets.seal(json) }) : JSON.stringify({ plain: JSON.parse(json) });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Windows: the data folder is already per-user
    }
    return { savedAt, sealed: !!this.secrets };
  }
}
