import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir } from './paths.js';

/**
 * Secrets at rest. The CA's private key and saved credentials (identities)
 * are encrypted with a master key that lives in the OS keyring (the Secret
 * Service: GNOME Keyring, KWallet; on Windows, DPAPI), so a copy of the data
 * folder or project database alone does not give them away. Where there is no keyring, they
 * stay in files only the user can read, and the app says so.
 */

export interface Keyring {
  /** Shown in Settings, e.g. "Secret Service (secret-tool)". */
  readonly name: string;
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const ATTRS = (key: string) => ['application', 'siteinquisition', 'key', key];

/** The freedesktop Secret Service, through libsecret's `secret-tool`. */
export class SecretToolKeyring implements Keyring {
  readonly name = 'Secret Service (secret-tool)';

  private run(args: string[], input?: string) {
    const r = spawnSync('secret-tool', args, { input, encoding: 'utf8', timeout: 10_000 });
    if (r.error) throw r.error;
    return r;
  }

  /** Whether secret-tool is installed and a keyring answers. */
  static available(): boolean {
    if (process.platform !== 'linux') return false;
    const r = spawnSync('secret-tool', ['lookup', ...ATTRS('probe')], { encoding: 'utf8', timeout: 10_000 });
    // Found or not found both mean the service answered; anything on stderr means it did not.
    return !r.error && (r.status === 0 || (r.status === 1 && !r.stderr.trim()));
  }

  get(key: string): string | undefined {
    const r = this.run(['lookup', ...ATTRS(key)]);
    return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : undefined;
  }

  set(key: string, value: string): void {
    const r = this.run(['store', `--label=SiteInquisition ${key}`, ...ATTRS(key)], value);
    if (r.status !== 0) throw new Error(`could not save to the keyring: ${r.stderr.trim() || `exit ${r.status}`}`);
  }

  delete(key: string): void {
    this.run(['clear', ...ATTRS(key)]);
  }
}

/** PowerShell, for the Windows APIs Node has no binding for. Script text only; inputs go through stdin. */
function powershell(script: string, input = ''): { ok: boolean; out: string; err: string } {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { input, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  return { ok: !r.error && r.status === 0, out: r.stdout ?? '', err: r.error?.message ?? r.stderr ?? '' };
}

/**
 * Windows: each secret is a DPAPI blob (CurrentUser scope) in a file. Only
 * this Windows account on this computer can unprotect it, as with the
 * browser's saved passwords.
 */
export class DpapiKeyring implements Keyring {
  readonly name = 'Windows DPAPI';
  constructor(private readonly dir: string) {}

  private file(key: string) {
    return join(this.dir, `${key.replace(/[^\w.-]/g, '_')}.dpapi`);
  }

  static available(): boolean {
    return process.platform === 'win32' && powershell('Add-Type -AssemblyName System.Security; exit 0').ok;
  }

  get(key: string): string | undefined {
    const f = this.file(key);
    if (!existsSync(f)) return undefined;
    const r = powershell(
      "Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
        "[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')))",
      readFileSync(f, 'utf8'),
    );
    if (!r.ok) throw new Error(`could not read ${key} with DPAPI: ${r.err.trim()}`);
    return Buffer.from(r.out.trim(), 'base64').toString('utf8');
  }

  set(key: string, value: string): void {
    const r = powershell(
      "Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
        "[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')))",
      Buffer.from(value, 'utf8').toString('base64'),
    );
    if (!r.ok || !r.out.trim()) throw new Error(`could not protect ${key} with DPAPI: ${r.err.trim()}`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file(key), r.out.trim(), { mode: 0o600 });
    try {
      chmodSync(this.file(key), 0o600);
    } catch {
      // POSIX modes mean little on Windows; the blob is useless to other accounts anyway
    }
  }

  delete(key: string): void {
    rmSync(this.file(key), { force: true });
  }
}

/** For tests, and for callers that bring their own keyring (e.g. Electron's safeStorage). */
export class MemoryKeyring implements Keyring {
  readonly name = 'memory';
  readonly values = new Map<string, string>();
  get(key: string) {
    return this.values.get(key);
  }
  set(key: string, value: string) {
    this.values.set(key, value);
  }
  delete(key: string) {
    this.values.delete(key);
  }
}

let cached: Keyring | null | undefined;

/** The keyring to use, or null when there is none. SIQ_KEYRING=none turns it off. */
export function defaultKeyring(): Keyring | null {
  if (cached !== undefined) return cached;
  if (process.env.SIQ_KEYRING === 'none') cached = null;
  else if (process.platform === 'win32') cached = DpapiKeyring.available() ? new DpapiKeyring(join(defaultDataDir(), 'keyring')) : null;
  else cached = SecretToolKeyring.available() ? new SecretToolKeyring() : null;
  return cached;
}

const PREFIX = 'siq1:';
const MASTER = 'master-key';

/** AES-256-GCM with the master key from a keyring. */
export class SecretBox {
  private constructor(
    private readonly key: Buffer,
    readonly keyring: Keyring,
  ) {}

  /** Open the master key, creating it on first use. Undefined when there is no keyring or it fails. */
  static open(keyring: Keyring | null = defaultKeyring()): SecretBox | undefined {
    if (!keyring) return undefined;
    try {
      let b64 = keyring.get(MASTER);
      if (!b64) {
        b64 = randomBytes(32).toString('base64');
        keyring.set(MASTER, b64);
        // Read it back: a keyring that drops writes must not lose data later.
        if (keyring.get(MASTER) !== b64) return undefined;
      }
      const key = Buffer.from(b64, 'base64');
      return key.length === 32 ? new SecretBox(key, keyring) : undefined;
    } catch {
      return undefined;
    }
  }

  static isSealed(v: unknown): v is string {
    return typeof v === 'string' && v.startsWith(PREFIX);
  }

  seal(data: string | Buffer): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(data), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  /** Throws when the text was sealed with another master key or changed. */
  open(sealed: string): Buffer {
    if (!SecretBox.isSealed(sealed)) throw new Error('not sealed');
    const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  }
}

export interface DiskEncryption {
  state: 'encrypted' | 'not-encrypted' | 'unknown';
  /** What was found, e.g. "dm-crypt (LUKS) under /home" or "ext4 on /dev/nvme0n1p2". */
  detail: string;
}

/**
 * Whether `path` is on an encrypted file system: dm-crypt/LUKS (also under
 * LVM), eCryptfs, or fscrypt-style per-directory encryption where the kernel
 * reports it. Linux only; elsewhere "unknown".
 */
export function diskEncryption(path: string, root = '/'): DiskEncryption {
  if (process.platform === 'win32') return bitlocker(path);
  if (process.platform !== 'linux') return { state: 'unknown', detail: `not checked on ${process.platform}` };
  try {
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      // not created yet; judge by the path as given
    }
    const lines = readFileSync(join(root, 'proc/self/mountinfo'), 'utf8').split('\n').filter(Boolean);
    let best: { mount: string; dev: string; fstype: string; source: string } | undefined;
    for (const l of lines) {
      const [left, right] = l.split(' - ') as [string, string | undefined];
      const f = left.split(' ');
      const mount = f[4]!.replace(/\\040/g, ' ');
      if (!(real === mount || real.startsWith(mount.endsWith('/') ? mount : `${mount}/`))) continue;
      if (best && best.mount.length > mount.length) continue;
      const [fstype = '', source = ''] = (right ?? '').split(' ');
      best = { mount, dev: f[2]!, fstype, source };
    }
    if (!best) return { state: 'unknown', detail: 'mount not found' };
    if (best.fstype === 'ecryptfs') return { state: 'encrypted', detail: `eCryptfs on ${best.mount}` };
    if (best.fstype === 'tmpfs' || best.fstype === 'ramfs') return { state: 'encrypted', detail: `${best.fstype} (memory only) on ${best.mount}` };
    const sys = join(root, 'sys/dev/block', best.dev);
    if (!existsSync(sys)) return { state: 'unknown', detail: `${best.fstype} on ${best.source || best.mount}` };
    const crypt = cryptBelow(sys, root, 0);
    if (crypt) return { state: 'encrypted', detail: `dm-crypt (${crypt}) under ${best.mount}` };
    return { state: 'not-encrypted', detail: `${best.fstype} on ${best.source || best.mount}` };
  } catch (e) {
    return { state: 'unknown', detail: (e as Error).message };
  }
}

/** Walk a block device and the devices it sits on, looking for a dm-crypt layer. */
function cryptBelow(sysDir: string, root: string, depth: number): string | undefined {
  if (depth > 8) return undefined;
  try {
    const uuid = readFileSync(join(sysDir, 'dm', 'uuid'), 'utf8').trim();
    if (uuid.startsWith('CRYPT-')) return uuid.split('-')[1] ?? 'dm-crypt';
  } catch {
    // not a device-mapper device
  }
  const slaves = join(sysDir, 'slaves');
  if (existsSync(slaves)) {
    for (const s of readdirSync(slaves)) {
      const hit = cryptBelow(join(root, 'sys/class/block', s), root, depth + 1);
      if (hit) return hit;
    }
  }
  // A partition: its parent's holders do not matter, but a partition of a dm device does.
  return undefined;
}

/**
 * BitLocker state of a drive, from the System.Volume.BitLockerProtection
 * value Explorer shows (reading it needs no administrator rights).
 */
export function bitlockerState(value: number | null, drive: string): DiskEncryption {
  if (value === 1 || value === 3 || value === 6) return { state: 'encrypted', detail: `BitLocker on ${drive}` };
  if (value === 0 || value === 2 || value === 5 || value === 8) {
    const why = value === 5 ? 'BitLocker suspended' : value === 8 ? 'BitLocker waiting for activation' : 'BitLocker off';
    return { state: 'not-encrypted', detail: `${why} on ${drive}` };
  }
  return { state: 'unknown', detail: `BitLocker state not reported for ${drive}` };
}

function bitlocker(path: string): DiskEncryption {
  const drive = /^([a-z]):/i.exec(path)?.[1]?.toUpperCase();
  if (!drive) return { state: 'unknown', detail: `${path} is not on a lettered drive (network share?)` };
  const r = powershell(`$v = (New-Object -ComObject Shell.Application).NameSpace('${drive}:').Self.ExtendedProperty('System.Volume.BitLockerProtection'); if ($v -ne $null) { [Console]::Out.Write($v) }`);
  const value = r.ok && /^\d+$/.test(r.out.trim()) ? Number(r.out.trim()) : null;
  return bitlockerState(value, `${drive}:`);
}
