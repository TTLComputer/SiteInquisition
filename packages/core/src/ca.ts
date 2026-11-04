import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { LeafIssuer, generateCA } from './x509.js';
import { SecretBox, defaultKeyring, type Keyring } from './secrets.js';

export interface CertificateAuthority {
  cert: string;
  key: string;
  certPath: string;
  /** SHA-256 fingerprint, shown to users so they can check what they installed. */
  fingerprint: string;
  expiresAt: Date;
  /** "keyring": the private key on disk is encrypted with a key from the OS keyring. "file": plain, readable only by the user. */
  keyProtection: 'keyring' | 'file';
}

export interface CaOptions {
  /** Defaults to the OS keyring when there is one; null keeps the key in a plain 0600 file. */
  keyring?: Keyring | null;
}

/** New CAs are valid for two years: long enough not to nag, short enough that a forgotten one expires. */
export const CA_VALID_DAYS = 730;

const paths = (dataDir: string) => {
  const dir = join(dataDir, 'ca');
  return { dir, certPath: join(dir, 'siteinquisition-ca.pem'), keyPath: join(dir, 'siteinquisition-ca.key'), sealedPath: join(dir, 'siteinquisition-ca.key.sealed') };
};

function writePrivate(path: string, data: string) {
  writeFileSync(path, data, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; the per-user profile directory protects it there.
  }
}

/** Write the CA's key: sealed with the keyring's master key when there is one, else plain. */
function storeKey(p: ReturnType<typeof paths>, key: string, box: SecretBox | undefined) {
  if (box) {
    writePrivate(p.sealedPath, box.seal(key));
    rmSync(p.keyPath, { force: true });
  } else {
    writePrivate(p.keyPath, key);
    rmSync(p.sealedPath, { force: true });
  }
}

function create(p: ReturnType<typeof paths>, box: SecretBox | undefined) {
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const created = new Date().toISOString().slice(0, 10);
  const { cert, key } = generateCA({ commonName: `SiteInquisition CA (${hostname()}, ${created})`, organizationName: 'SiteInquisition' }, { validDays: CA_VALID_DAYS });
  storeKey(p, key, box);
  writeFileSync(p.certPath, cert);
}

/**
 * Load the per-install root CA, creating it on first use. With an OS keyring
 * the private key is stored encrypted (an existing plain key is converted);
 * without one it is a file only the user can read.
 */
export async function loadOrCreateCA(dataDir: string, opts: CaOptions = {}): Promise<CertificateAuthority> {
  const p = paths(dataDir);
  const box = SecretBox.open(opts.keyring === undefined ? defaultKeyring() : opts.keyring);
  if (!existsSync(p.certPath) || (!existsSync(p.keyPath) && !existsSync(p.sealedPath))) create(p, box);
  const cert = readFileSync(p.certPath, 'utf8');
  let key: string;
  if (existsSync(p.sealedPath)) {
    const sealed = readFileSync(p.sealedPath, 'utf8');
    if (!box) throw new Error(`The CA key in ${p.sealedPath} is encrypted with a key from the OS keyring, which is not available. Unlock the keyring, or run \`siq ca rotate\` to make a new CA.`);
    try {
      key = box.open(sealed).toString('utf8');
    } catch {
      throw new Error(`The CA key in ${p.sealedPath} cannot be decrypted with this keyring's key. Run \`siq ca rotate\` to make a new CA.`);
    }
  } else {
    key = readFileSync(p.keyPath, 'utf8');
    if (box) storeKey(p, key, box);
  }
  const x509 = new X509Certificate(cert);
  return { cert, key, certPath: p.certPath, fingerprint: x509.fingerprint256, expiresAt: new Date(x509.validTo), keyProtection: box ? 'keyring' : 'file' };
}

/** Replace the CA with a new one. Devices must trust the new certificate; running proxies need a restart. */
export async function rotateCA(dataDir: string, opts: CaOptions = {}): Promise<CertificateAuthority> {
  removeCA(dataDir);
  return loadOrCreateCA(dataDir, opts);
}

/** Delete the CA certificate and key. Returns whether there was one. */
export function removeCA(dataDir: string): boolean {
  const p = paths(dataDir);
  const had = existsSync(p.certPath);
  for (const f of [p.certPath, p.keyPath, p.sealedPath]) rmSync(f, { force: true });
  return had;
}

const issuers = new WeakMap<CertificateAuthority, LeafIssuer>();

/** The leaf certificate issuer for a CA, shared by every listener that uses it. */
export function leafIssuer(ca: CertificateAuthority): LeafIssuer {
  let issuer = issuers.get(ca);
  if (!issuer) {
    issuer = new LeafIssuer(ca);
    issuers.set(ca, issuer);
  }
  return issuer;
}
