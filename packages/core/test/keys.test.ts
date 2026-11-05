import { describe, expect, it } from '@siteinquisition/devkit/test';
import { KeyStore, MemoryKeyring, SecretBox, SessionKeyStore, type KeyVault, type PersistedKey } from '@siteinquisition/core';

/** A vault over an in-memory meta map, sealing with a SecretBox when one is given (as the core does). */
function vault(box?: SecretBox): KeyVault & { meta: Map<string, unknown> } {
  const meta = new Map<string, unknown>();
  return {
    meta,
    get canEncrypt() {
      return !!box;
    },
    get where() {
      return box ? 'memory keyring' : null;
    },
    load() {
      const raw = meta.get('signingKeys');
      if (raw === undefined) return { keys: [] };
      if (!SecretBox.isSealed(raw)) return { keys: raw as PersistedKey[] };
      if (!box) return { keys: [], error: 'no keyring' };
      try {
        return { keys: JSON.parse(box.open(raw).toString('utf8')) as PersistedKey[] };
      } catch {
        return { keys: [], error: 'sealed elsewhere' };
      }
    },
    save(keys) {
      meta.set('signingKeys', box && keys.length ? box.seal(JSON.stringify(keys)) : keys);
    },
  };
}

describe('KeyStore persistence', () => {
  const box = SecretBox.open(new MemoryKeyring())!;

  it('keeps an unsaved key in memory only', () => {
    const v = vault(box);
    const store = new KeyStore(v);
    store.setSecret('app', 'topsecret');
    expect(store.list()).toEqual([{ name: 'app', kind: 'hmac', canSign: true, saved: false }]);
    // Nothing persisted, so a fresh store over the same vault has no keys.
    expect(new KeyStore(v).names()).toEqual([]);
  });

  it('persists a saved key, encrypted, and reloads it in a new session', () => {
    const v = vault(box);
    const store = new KeyStore(v);
    store.setSecret('app', 'topsecret', true);
    store.setPem('rsa', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', undefined, true);
    expect(store.list().every((k) => k.saved)).toBe(true);
    expect(SecretBox.isSealed(v.meta.get('signingKeys'))).toBe(true);

    const reopened = new KeyStore(v);
    expect(reopened.names().sort()).toEqual(['app', 'rsa']);
    expect(reopened.resolve('app')).toEqual({ kind: 'hmac', secret: 'topsecret' });
    expect(reopened.list().find((k) => k.name === 'app')?.saved).toBe(true);
  });

  it('toggles saving on an existing key and drops it from storage when turned off', () => {
    const v = vault(box);
    const store = new KeyStore(v);
    store.setSecret('app', 'topsecret');
    store.setSaved('app', true);
    expect(SecretBox.isSealed(v.meta.get('signingKeys'))).toBe(true);
    store.setSaved('app', false);
    expect(new KeyStore(v).names()).toEqual([]);
  });

  it('removes a saved key from storage on delete', () => {
    const v = vault(box);
    const store = new KeyStore(v);
    store.setSecret('a', '1', true);
    store.setSecret('b', '2', true);
    store.delete('a');
    expect(new KeyStore(v).names()).toEqual(['b']);
  });

  it('refuses to save without encryption, and still keeps the key for the session', () => {
    const v = vault(); // no box
    const store = new KeyStore(v);
    expect(() => store.setSecret('app', 'topsecret', true)).toThrow(/keyring/i);
    expect(() => store.setSaved('app', true)).toThrow(/no key/); // nothing was stored
    store.setSecret('app', 'topsecret');
    expect(store.resolve('app')).toEqual({ kind: 'hmac', secret: 'topsecret' });
    expect(() => store.setSaved('app', true)).toThrow(/keyring/i);
  });

  it('surfaces a load error when saved keys cannot be unsealed here', () => {
    const v = vault(box);
    new KeyStore(v).setSecret('app', 'topsecret', true); // seals into v.meta
    const vNoBox = vault();
    vNoBox.meta.set('signingKeys', v.meta.get('signingKeys')); // same sealed blob, no key to open it
    const store = new KeyStore(vNoBox);
    expect(store.loadError).toMatch(/no keyring/);
    expect(store.names()).toEqual([]);
  });

  it('SessionKeyStore stays in-memory and cannot save', () => {
    const store = new SessionKeyStore();
    store.setSecret('app', 'topsecret');
    expect(store.canSave).toBe(false);
    expect(store.list()[0]).toEqual({ name: 'app', kind: 'hmac', canSign: true, saved: false });
  });
});
