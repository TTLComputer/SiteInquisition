import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { MemoryKeyring, SecretBox, WorkspaceStore, WORKSPACE_MAX_BYTES } from '@siteinquisition/core';

// The per-user workspace: drafts survive a restart, sealed like other secrets at rest.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'siq-workspace-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('workspace store', () => {
  const snap = { version: 1, savedAt: 0, docs: [{ id: 'replay-x', raw: 'GET /api/cart\nCookie: session=secret-cookie' }] };

  it('starts empty, then round-trips a snapshot sealed with the keyring', () => {
    const box = SecretBox.open(new MemoryKeyring())!;
    const ws = new WorkspaceStore(join(dir, 'a'), '/projects/shop', 'local', box);
    expect(ws.get()).toBeNull();
    const r = ws.set(snap);
    expect(r.sealed).toBe(true);
    expect(readFileSync(ws.path, 'utf8')).not.toContain('secret-cookie');
    const back = ws.get()!;
    expect(back.docs).toEqual(snap.docs);
    expect(back.savedAt).toBe(r.savedAt);
    if (process.platform !== 'win32') expect(statSync(ws.path).mode & 0o777).toBe(0o600);
    // Another keyring cannot read it, and says nothing rather than throwing.
    expect(new WorkspaceStore(join(dir, 'a'), '/projects/shop', 'local', SecretBox.open(new MemoryKeyring())!).get()).toBeNull();
  });

  it('keeps one workspace per project and per user', () => {
    const a = new WorkspaceStore(join(dir, 'b'), '/projects/shop', 'local', undefined);
    const b = new WorkspaceStore(join(dir, 'b'), '/projects/other', 'local', undefined);
    const c = new WorkspaceStore(join(dir, 'b'), '/projects/shop', 'sam', undefined);
    a.set(snap);
    expect(b.get()).toBeNull();
    expect(c.get()).toBeNull();
    expect(a.get()!.docs).toEqual(snap.docs);
  });

  it('refuses a snapshot without a version, or one too big to be drafts', () => {
    const ws = new WorkspaceStore(join(dir, 'c'), '/p', 'local', undefined);
    expect(() => ws.set({} as never)).toThrow(/version/);
    expect(() => ws.set({ version: 1, savedAt: 0, big: 'x'.repeat(WORKSPACE_MAX_BYTES) })).toThrow(/limit/);
    expect(ws.get()).toBeNull();
  });
});
