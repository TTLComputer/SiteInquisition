import type { SigningKey } from './jwt.js';

/**
 * Named signing keys for re-signing JWTs and session cookies. Keys live in
 * memory for the session by default; a key the user marks "save" is persisted
 * to the project, encrypted with the master key from the OS keyring (the same
 * protection as saved identities), so it survives restarts and travels with
 * the project. Saving is offered only when that encryption is available.
 */
export interface KeyResolver {
  /** Names the user can choose from. */
  names(): string[];
  /** Resolve a name to a signing key, or undefined when it is unknown. */
  resolve(name: string): SigningKey | undefined;
}

export interface KeyInfo {
  name: string;
  kind: 'hmac' | 'pem';
  /** Whether a private key or secret is held (so the UI can show it is usable for signing). */
  canSign: boolean;
  /** Whether the key is persisted to the project (encrypted), not just this session. */
  saved: boolean;
}

/** A persisted key, as stored in the project meta (inside the sealed blob when encrypted). */
export interface PersistedKey {
  name: string;
  kind: 'hmac' | 'pem';
  secret?: string;
  pem?: string;
  passphrase?: string;
}

/**
 * Where saved keys are kept. Implemented by the core over the project store and
 * its SecretBox, so the key store itself stays unaware of encryption details.
 */
export interface KeyVault {
  /** Whether a master key is available to encrypt saved secrets. */
  readonly canEncrypt: boolean;
  /** Human name of where the master key lives, for messages (e.g. the keyring). */
  readonly where: string | null;
  /** Load persisted keys; `error` is set (and keys empty) when they can't be read here. */
  load(): { keys: PersistedKey[]; error?: string };
  /** Replace the persisted set. */
  save(keys: PersistedKey[]): void;
}

const toSigningKey = (k: PersistedKey): SigningKey =>
  k.kind === 'hmac' ? { kind: 'hmac', secret: k.secret ?? '' } : { kind: 'pem', pem: k.pem ?? '', ...(k.passphrase ? { passphrase: k.passphrase } : {}) };

const toPersisted = (name: string, key: SigningKey): PersistedKey =>
  key.kind === 'hmac'
    ? { name, kind: 'hmac', secret: typeof key.secret === 'string' ? key.secret : key.secret.toString('utf8') }
    : key.kind === 'pem'
      ? { name, kind: 'pem', pem: key.pem, ...(key.passphrase ? { passphrase: key.passphrase } : {}) }
      : { name, kind: 'pem', pem: '' };

/**
 * The signing-key store. Holds every key in memory for the session; persists
 * the ones marked saved through the vault. Without a vault (or without
 * encryption) it behaves exactly like the old session-only store.
 */
export class KeyStore implements KeyResolver {
  private keys = new Map<string, { key: SigningKey; saved: boolean }>();
  /** Set when saved keys exist but can't be read here (no keyring, or sealed elsewhere). */
  readonly loadError?: string;

  constructor(private readonly vault?: KeyVault) {
    if (vault) {
      const { keys, error } = vault.load();
      if (error) this.loadError = error;
      for (const k of keys) this.keys.set(k.name, { key: toSigningKey(k), saved: true });
    }
  }

  /** Whether a key can be saved (a master key is available). */
  get canSave(): boolean {
    return !!this.vault?.canEncrypt;
  }

  /** Where saved keys are encrypted, for the UI to explain. */
  get savedWhere(): string | null {
    return this.vault?.where ?? null;
  }

  names(): string[] {
    return [...this.keys.keys()];
  }

  list(): KeyInfo[] {
    return [...this.keys.entries()].map(([name, k]) => ({ name, kind: k.key.kind === 'hmac' ? 'hmac' : 'pem', canSign: true, saved: k.saved }));
  }

  resolve(name: string): SigningKey | undefined {
    return this.keys.get(name)?.key;
  }

  private requireSavable(save: boolean): void {
    if (save && !this.canSave) throw new Error('Saving a key needs the OS keyring, which is not available. Keys are held for this session only. Set up a keyring (Settings › Storage), or add the key without saving.');
  }

  private persist(): void {
    if (!this.vault) return;
    const saved: PersistedKey[] = [];
    for (const [name, k] of this.keys) if (k.saved) saved.push(toPersisted(name, k.key));
    this.vault.save(saved);
  }

  setSecret(name: string, secret: string, save = false): void {
    if (!name.trim()) throw new Error('a key needs a name');
    this.requireSavable(save);
    this.keys.set(name, { key: { kind: 'hmac', secret }, saved: save });
    this.persist();
  }

  setPem(name: string, pem: string, passphrase?: string, save = false): void {
    if (!name.trim()) throw new Error('a key needs a name');
    if (!/-----BEGIN [\w ]*PRIVATE KEY-----/.test(pem)) throw new Error('expected a PEM private key');
    this.requireSavable(save);
    this.keys.set(name, { key: { kind: 'pem', pem, ...(passphrase ? { passphrase } : {}) }, saved: save });
    this.persist();
  }

  /** Turn saving on or off for a key already held, without re-entering it. */
  setSaved(name: string, save: boolean): void {
    const k = this.keys.get(name);
    if (!k) throw new Error(`no key "${name}"`);
    this.requireSavable(save);
    k.saved = save;
    this.persist();
  }

  delete(name: string): void {
    const had = this.keys.get(name);
    this.keys.delete(name);
    if (had?.saved) this.persist();
  }
}

/** A session-only key store (no persistence); kept for callers and tests that want in-memory keys. */
export class SessionKeyStore extends KeyStore {
  constructor() {
    super();
  }
}
