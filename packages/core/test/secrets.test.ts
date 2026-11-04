import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { CA_VALID_DAYS, Core, MemoryKeyring, SecretBox, bitlockerState, diskEncryption, loadOrCreateCA, removeCA, rotateCA } from '@siteinquisition/core';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'siq-secrets-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('secret box', () => {
  it('round-trips, and refuses another master key or changed text', () => {
    const ring = new MemoryKeyring();
    const box = SecretBox.open(ring)!;
    const sealed = box.seal('token=abc');
    expect(SecretBox.isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain('abc');
    expect(SecretBox.open(ring)!.open(sealed).toString()).toBe('token=abc');
    expect(() => SecretBox.open(new MemoryKeyring())!.open(sealed)).toThrow();
    const flipped = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => box.open(flipped)).toThrow();
    expect(SecretBox.open(null)).toBeUndefined();
  });
});

describe('CA key at rest', () => {
  it('stores the key encrypted when there is a keyring, and converts an existing plain key', async () => {
    const data = join(dir, 'ca1');
    const plain = await loadOrCreateCA(data, { keyring: null });
    expect(plain.keyProtection).toBe('file');
    const keyFile = join(data, 'ca', 'siteinquisition-ca.key');
    if (process.platform !== 'win32') {
      // POSIX modes; on Windows the per-user profile folder's ACL does this job.
      expect(statSync(keyFile).mode & 0o077).toBe(0);
      expect(statSync(join(data, 'ca')).mode & 0o777).toBe(0o700);
    }
    expect((plain.expiresAt.getTime() - Date.now()) / 86_400_000).toBeLessThan(CA_VALID_DAYS + 1);

    const ring = new MemoryKeyring();
    const sealed = await loadOrCreateCA(data, { keyring: ring });
    expect(sealed.keyProtection).toBe('keyring');
    expect(sealed.fingerprint).toBe(plain.fingerprint);
    expect(sealed.key).toBe(plain.key);
    expect(existsSync(keyFile)).toBe(false);
    expect(readFileSync(`${keyFile}.sealed`, 'utf8')).not.toContain('PRIVATE KEY');

    await expect(loadOrCreateCA(data, { keyring: null })).rejects.toThrow(/keyring, which is not available/);
    await expect(loadOrCreateCA(data, { keyring: new MemoryKeyring() })).rejects.toThrow(/cannot be decrypted/);
    expect((await loadOrCreateCA(data, { keyring: ring })).key).toBe(plain.key);
  });

  it('rotates to a new CA and removes it', async () => {
    const data = join(dir, 'ca2');
    const ring = new MemoryKeyring();
    const first = await loadOrCreateCA(data, { keyring: ring });
    const next = await rotateCA(data, { keyring: ring });
    expect(next.fingerprint).not.toBe(first.fingerprint);
    expect(removeCA(data)).toBe(true);
    expect(existsSync(next.certPath)).toBe(false);
    expect(removeCA(data)).toBe(false);
  });
});

describe('saved identities', () => {
  it('are encrypted in the project database when there is a keyring', async () => {
    const ring = new MemoryKeyring();
    // Each keyring stands for a computer, with its own data folder.
    const open = (keyring: MemoryKeyring, data: string) => Core.open({ projectDir: join(dir, 'p'), dataDir: join(dir, data), api: false, keyring });
    let core = await open(ring, 'data');
    const ids = [{ name: 'alice', headers: [['Authorization', 'Bearer alice-secret']] as Array<[string, string]> }];
    try {
      core.tools.setIdentities(ids);
      expect(JSON.stringify(core.store.getMeta('identities'))).not.toContain('alice-secret');
      expect(core.tools.identities()).toEqual(ids);
      expect(core.protection()).toMatchObject({ caKey: 'keyring', secrets: 'keyring', keyring: 'memory' });
      const rows = core.store.db.prepare("SELECT data FROM change WHERE entity_id = 'identities'").all() as Array<{ data: string }>;
      expect(rows.some((r) => r.data.includes('alice-secret'))).toBe(false);
    } finally {
      await core.close();
    }
    core = await open(new MemoryKeyring(), 'data-elsewhere');
    try {
      expect(() => core.tools.identities()).toThrow(/cannot be read here/);
    } finally {
      await core.close();
    }
  });
});

describe('disk encryption check', () => {
  /** A fake /proc and /sys: / on a LUKS volume under LVM, /data on a plain partition. */
  it.skipIf(process.platform === 'win32')('finds dm-crypt below LVM, and reports a plain partition', () => {
    const root = join(dir, 'fake');
    mkdirSync(join(root, 'proc/self'), { recursive: true });
    writeFileSync(
      join(root, 'proc/self/mountinfo'),
      ['22 1 253:1 / / rw,relatime - ext4 /dev/mapper/vg-root rw', '30 22 259:3 / /data rw,relatime - ext4 /dev/nvme0n1p3 rw', '31 22 0:40 / /home/me/.Private rw - ecryptfs /home/me/.Private rw'].join('\n'),
    );
    const blk = (name: string, dev: string, uuid?: string, slaves: string[] = []) => {
      const d = join(root, 'sys/devices/virtual/block', name);
      mkdirSync(join(d, 'slaves'), { recursive: true });
      if (uuid) {
        mkdirSync(join(d, 'dm'), { recursive: true });
        writeFileSync(join(d, 'dm/uuid'), `${uuid}\n`);
      }
      mkdirSync(join(root, 'sys/class/block'), { recursive: true });
      mkdirSync(join(root, 'sys/dev/block'), { recursive: true });
      symlinkSync(d, join(root, 'sys/class/block', name));
      symlinkSync(d, join(root, 'sys/dev/block', dev));
      for (const s of slaves) symlinkSync(join(root, 'sys/class/block', s), join(d, 'slaves', s));
    };
    blk('nvme0n1p2', '259:2');
    blk('nvme0n1p3', '259:3');
    blk('dm-0', '253:0', 'CRYPT-LUKS2-abc-luks', ['nvme0n1p2']);
    blk('dm-1', '253:1', 'LVM-xyz', ['dm-0']);
    expect(diskEncryption('/no-such-dir/project', root)).toEqual({ state: 'encrypted', detail: 'dm-crypt (LUKS2) under /' });
    expect(diskEncryption('/data/no-such-project', root)).toEqual({ state: 'not-encrypted', detail: 'ext4 on /dev/nvme0n1p3' });
    expect(diskEncryption('/home/me/.Private/no-such', root)).toEqual({ state: 'encrypted', detail: 'eCryptfs on /home/me/.Private' });
  });
});

describe('BitLocker check', () => {
  it('reads the protection values Explorer reports', () => {
    expect(bitlockerState(1, 'C:')).toEqual({ state: 'encrypted', detail: 'BitLocker on C:' });
    expect(bitlockerState(6, 'D:').state).toBe('encrypted');
    expect(bitlockerState(2, 'C:')).toEqual({ state: 'not-encrypted', detail: 'BitLocker off on C:' });
    expect(bitlockerState(5, 'C:')).toEqual({ state: 'not-encrypted', detail: 'BitLocker suspended on C:' });
    expect(bitlockerState(null, 'E:').state).toBe('unknown');
  });

  it.skipIf(process.platform !== 'win32')('asks Windows about the project drive', () => {
    expect(['encrypted', 'not-encrypted', 'unknown']).toContain(diskEncryption(dir).state);
    expect(diskEncryption('\\\\server\\share\\p').state).toBe('unknown');
  });
});

