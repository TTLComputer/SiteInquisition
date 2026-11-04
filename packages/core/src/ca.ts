import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { generateCACertificate } from 'mockttp';

export interface CertificateAuthority {
  cert: string;
  key: string;
  certPath: string;
  /** SHA-256 fingerprint, shown to users so they can check what they installed. */
  fingerprint: string;
  expiresAt: Date;
}

/**
 * Load the per-install root CA, creating it on first use. The private key is
 * written owner-read-only. (Encrypting it with the OS keychain comes with the
 * Electron app, which has access to safeStorage.)
 */
export async function loadOrCreateCA(dataDir: string): Promise<CertificateAuthority> {
  const dir = join(dataDir, 'ca');
  const certPath = join(dir, 'siteinquisition-ca.pem');
  const keyPath = join(dir, 'siteinquisition-ca.key');
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    mkdirSync(dir, { recursive: true });
    const created = new Date().toISOString().slice(0, 10);
    const { cert, key } = await generateCACertificate({
      subject: {
        commonName: `SiteInquisition CA (${hostname()}, ${created})`,
        organizationName: 'SiteInquisition',
      },
      bits: 2048,
    });
    writeFileSync(keyPath, key, { mode: 0o600 });
    writeFileSync(certPath, cert);
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // Windows ignores POSIX modes; the per-user profile directory protects it there.
    }
  }
  const cert = readFileSync(certPath, 'utf8');
  const key = readFileSync(keyPath, 'utf8');
  const x509 = new X509Certificate(cert);
  return { cert, key, certPath, fingerprint: x509.fingerprint256, expiresAt: new Date(x509.validTo) };
}
