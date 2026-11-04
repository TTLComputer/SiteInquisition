import type { SigningKey } from './jwt.js';

/**
 * A place to resolve a named signing key. SiteInquisition's key and
 * certificate store (a separate piece of work) will implement this, so the
 * JWT and cookie signers can ask for "the key bound to name X" without
 * knowing where it lives. Until then, keys entered in the UI live in memory
 * for the session only and never touch disk.
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
}

/** A session-only resolver: keys are held in memory and lost when the project closes. */
export class SessionKeyStore implements KeyResolver {
  private keys = new Map<string, SigningKey>();

  names(): string[] {
    return [...this.keys.keys()];
  }

  list(): KeyInfo[] {
    return [...this.keys.entries()].map(([name, k]) => ({ name, kind: k.kind === 'hmac' ? 'hmac' : 'pem', canSign: true }));
  }

  resolve(name: string): SigningKey | undefined {
    return this.keys.get(name);
  }

  setSecret(name: string, secret: string): void {
    if (!name.trim()) throw new Error('a key needs a name');
    this.keys.set(name, { kind: 'hmac', secret });
  }

  setPem(name: string, pem: string, passphrase?: string): void {
    if (!name.trim()) throw new Error('a key needs a name');
    if (!/-----BEGIN [\w ]*PRIVATE KEY-----/.test(pem)) throw new Error('expected a PEM private key');
    this.keys.set(name, { kind: 'pem', pem, ...(passphrase ? { passphrase } : {}) });
  }

  delete(name: string): void {
    this.keys.delete(name);
  }
}
