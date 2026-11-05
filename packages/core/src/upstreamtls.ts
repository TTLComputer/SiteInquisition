import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import tls, { type PeerCertificate } from 'node:tls';
import { newId } from './ids.js';
import { globToRegExp } from './scope.js';
import type { CaptureStore } from './store.js';

/**
 * How SiteInquisition checks the certificates of servers it connects to: the
 * proxy's upstream side, Replay, Race, the HTTP/3 lab, WebSocket and MQTT.
 *
 * Dev and staging servers often run on self-signed certificates. There are
 * two ways to reach them, best first:
 *
 *  - Trust a certificate: the server's self-signed certificate (or a private
 *    CA) is checked like a public one. A trusted certificate that is the
 *    server's own also passes when the name does not match, which covers a
 *    cert made for "localhost" served on 10.0.0.5.
 *  - Skip checks: for listed hosts (globs), or every host. Any certificate is
 *    accepted, so a machine in the middle would go unnoticed.
 *
 * A per-send "Ignore TLS errors" still skips checks for that send only.
 */
export interface TrustedCert {
  id: string;
  /** Who it is for, shown in lists. */
  name: string;
  pem: string;
  fingerprint256: string;
  subject: string;
  issuer: string;
  validTo: string;
  /** Names and addresses it was issued for. */
  altNames?: string;
}

export interface UpstreamTlsConfig {
  /** verify: check every certificate (trusted ones count). hosts: skip checks for the listed hosts. all: skip checks everywhere. */
  mode: 'verify' | 'hosts' | 'all';
  /** Host globs for mode "hosts", e.g. *.dev.local or 10.0.0.*. */
  hosts: string[];
  trusted: TrustedCert[];
}

/** Error codes and text for a certificate the checks refuse. */
export const CERT_REFUSED = /SELF_SIGNED|CERT_|UNABLE_TO_(VERIFY|GET_ISSUER)|ERR_TLS_CERT|self[- ]signed|certificate/i;

export const DEFAULT_UPSTREAM_TLS: UpstreamTlsConfig = { mode: 'verify', hosts: [], trusted: [] };

/** TLS options for one upstream connection. */
export interface UpstreamTlsOptions {
  rejectUnauthorized: boolean;
  ca?: string[];
  checkServerIdentity?: (host: string, cert: PeerCertificate) => Error | undefined;
}

interface Policy {
  config: UpstreamTlsConfig;
  /** From the command line: true for every host, or a host list. */
  startup: boolean | string[];
  hostRes: RegExp[];
  startupRes: RegExp[];
  ca?: string[];
  pins: Set<string>;
}

const compile = (config: UpstreamTlsConfig, startup: boolean | string[]): Policy => ({
  config,
  startup,
  hostRes: config.hosts.map((h) => globToRegExp(h.toLowerCase())),
  startupRes: Array.isArray(startup) ? startup.map((h) => globToRegExp(h.toLowerCase())) : [],
  // Passing ca replaces Node's roots, so keep them alongside the trusted ones.
  ca: config.trusted.length ? [...tls.rootCertificates, ...config.trusted.map((t) => t.pem)] : undefined,
  pins: new Set(config.trusted.map((t) => t.fingerprint256.toUpperCase())),
});

// One project is open per process; the core sets this when it opens and whenever the setting changes.
let policy: Policy = compile(DEFAULT_UPSTREAM_TLS, false);

export function setUpstreamTlsPolicy(config: UpstreamTlsConfig, startup: boolean | string[] = policy.startup): void {
  policy = compile(config, startup);
}

export const upstreamTlsPolicy = (): UpstreamTlsConfig => policy.config;

/** True when certificate checks are skipped for this host by the setting (or the command line). */
export function skipsTlsChecks(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (policy.startup === true || policy.startupRes.some((re) => re.test(h))) return true;
  if (policy.config.mode === 'all') return true;
  return policy.config.mode === 'hosts' && policy.hostRes.some((re) => re.test(h));
}

/** The options to connect to a host with. `ignore` is a per-send "Ignore TLS errors". */
export function upstreamTls(host: string, ignore = false): UpstreamTlsOptions {
  if (ignore || skipsTlsChecks(host)) return { rejectUnauthorized: false };
  if (!policy.ca) return { rejectUnauthorized: true };
  const pins = policy.pins;
  return {
    rejectUnauthorized: true,
    ca: policy.ca,
    // A trusted certificate that is the server's own passes whatever name it was made for.
    checkServerIdentity: (h, cert) => (cert.fingerprint256 && pins.has(cert.fingerprint256.toUpperCase()) ? undefined : tls.checkServerIdentity(h, cert)),
  };
}

/** Trusted certificates (PEM) for the in-house QUIC stack, which takes extra anchors only. */
export const trustedPems = (): string[] => policy.config.trusted.map((t) => t.pem);

export function describeCert(pem: string, name?: string): TrustedCert {
  const x = new X509Certificate(pem);
  const cn = /CN=([^\n,]+)/.exec(x.subject)?.[1];
  return {
    id: newId(),
    name: name?.trim() || cn || x.subject.split('\n')[0] || 'certificate',
    pem: x.toString(),
    fingerprint256: x.fingerprint256,
    subject: x.subject.replace(/\n/g, ', '),
    issuer: x.issuer.replace(/\n/g, ', '),
    validTo: new Date(x.validTo).toISOString(),
    ...(x.subjectAltName ? { altNames: x.subjectAltName } : {}),
  };
}

export interface PeerCertInfo {
  host: string;
  port: number;
  /** The server's own certificate. */
  cert: TrustedCert;
  /** The rest of the chain it sent, leaf's issuer first. */
  chain: TrustedCert[];
  selfSigned: boolean;
  /** Why the normal check refuses it (DEPTH_ZERO_SELF_SIGNED_CERT, ERR_TLS_CERT_ALTNAME_INVALID...), or null when it passes. */
  problem: string | null;
}

/**
 * Connect to a server only to read the certificate it presents, so the user
 * can look at it and choose to trust it. Sends no HTTP request.
 */
export function fetchPeerCertificate(host: string, port = 443, timeoutMs = 8000): Promise<PeerCertInfo> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: timeoutMs });
    const fail = (e: Error) => {
      socket.destroy();
      reject(e);
    };
    socket.once('timeout', () => fail(new Error(`no TLS handshake from ${host}:${port} after ${timeoutMs} ms`)));
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      try {
        const peer = socket.getPeerCertificate(true);
        if (!peer?.raw) throw new Error(`${host}:${port} sent no certificate`);
        const toPem = (raw: Buffer) => `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
        const chain: TrustedCert[] = [];
        let cur = peer as tls.DetailedPeerCertificate;
        const seen = new Set([cur.fingerprint256]);
        while (cur.issuerCertificate && !seen.has(cur.issuerCertificate.fingerprint256)) {
          cur = cur.issuerCertificate;
          seen.add(cur.fingerprint256);
          chain.push(describeCert(toPem(cur.raw)));
        }
        let problem: string | null = socket.authorized ? null : String(socket.authorizationError ?? 'not trusted');
        if (!problem) {
          const err = tls.checkServerIdentity(host, peer);
          if (err) problem = (err as NodeJS.ErrnoException).code ?? err.message;
        }
        const cert = describeCert(toPem(peer.raw), host);
        resolve({ host, port, cert, chain, selfSigned: cert.subject === cert.issuer, problem });
      } catch (e) {
        reject(e as Error);
      } finally {
        socket.end();
      }
    });
  });
}

/** The saved setting, kept in the project and applied to the process. */
export class UpstreamTlsSettings {
  constructor(
    private readonly store: CaptureStore,
    startup: boolean | string[] = false,
  ) {
    setUpstreamTlsPolicy(this.get(), startup);
    store.on('change', (c) => {
      if (c.kind === 'meta.set' && c.entityId === 'upstreamTls') setUpstreamTlsPolicy(this.get());
    });
  }

  get(): UpstreamTlsConfig {
    return { ...DEFAULT_UPSTREAM_TLS, ...(this.store.getMeta<Partial<UpstreamTlsConfig>>('upstreamTls') ?? {}) };
  }

  set(input: Partial<UpstreamTlsConfig>): UpstreamTlsConfig {
    const cur = this.get();
    const mode = input.mode ?? cur.mode;
    if (!['verify', 'hosts', 'all'].includes(mode)) throw new Error('mode must be verify, hosts or all');
    const hosts = (input.hosts ?? cur.hosts).map((h) => String(h).trim().toLowerCase()).filter(Boolean);
    const trusted = (input.trusted ?? cur.trusted).map((t) => {
      if (!t?.pem) throw new Error('a trusted certificate needs its PEM');
      const d = describeCert(t.pem, t.name);
      return { ...d, id: t.id ?? d.id };
    });
    const out: UpstreamTlsConfig = { mode, hosts: [...new Set(hosts)], trusted };
    this.store.setMeta('upstreamTls', out);
    setUpstreamTlsPolicy(out);
    return out;
  }

  /** Add certificates from PEM text (one or several). */
  trust(pem: string, name?: string): UpstreamTlsConfig {
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!blocks?.length) throw new Error('no PEM certificate found (expected -----BEGIN CERTIFICATE-----)');
    const cur = this.get();
    const have = new Set(cur.trusted.map((t) => t.fingerprint256));
    const add = blocks.map((b, i) => describeCert(b, blocks.length > 1 && name ? `${name} ${i + 1}` : name)).filter((t) => !have.has(t.fingerprint256));
    return this.set({ trusted: [...cur.trusted, ...add] });
  }

  untrust(id: string): UpstreamTlsConfig {
    return this.set({ trusted: this.get().trusted.filter((t) => t.id !== id) });
  }

  /** Read a server's certificate so the user can decide to trust it (connects once, sends no request). */
  fetchPeer(host: string, port = 443): Promise<PeerCertInfo> {
    return fetchPeerCertificate(host, port);
  }

  /** Skip checks for one more host (switching mode "verify" to "hosts"). */
  skipHost(host: string): UpstreamTlsConfig {
    const cur = this.get();
    return this.set({ mode: cur.mode === 'all' ? 'all' : 'hosts', hosts: [...cur.hosts, host] });
  }
}
