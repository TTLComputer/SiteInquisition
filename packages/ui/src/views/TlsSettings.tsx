import { useCallback, useEffect, useState } from 'react';
import type { PeerCertInfo, UpstreamTlsConfig } from '../api';
import { useApp } from '../state';

/** Error text Node and the in-house stacks give for a certificate they refuse. */
export const CERT_ERROR = /self[- ]signed|certificate|CERT_|unable to verify|unable to get (local )?issuer|altname|ERR_TLS|bad_certificate|unknown_ca/i;

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString();
const PROBLEM_TEXT: Record<string, string> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed',
  SELF_SIGNED_CERT_IN_CHAIN: 'signed by a CA this computer does not trust (self-signed root)',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'issuer not trusted or missing from the chain',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'issuer not trusted',
  CERT_HAS_EXPIRED: 'expired',
  CERT_NOT_YET_VALID: 'not valid yet',
  ERR_TLS_CERT_ALTNAME_INVALID: 'made for a different name',
};

function splitHostPort(input: string): { host: string; port: number } {
  const v = input.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(v) ?? /^([^:]+)(?::(\d+))?$/.exec(v);
  return { host: m?.[1] ?? v, port: Number(m?.[2]) || 443 };
}

/** A server's certificate, fetched on request, with the two ways to accept it. */
function PeerCert({ info, onDone }: { info: PeerCertInfo; onDone(c: UpstreamTlsConfig): void }) {
  const { client, notify } = useApp();
  const act = (p: Promise<UpstreamTlsConfig>, msg: string) => p.then((c) => (onDone(c), notify(msg)), (e: Error) => notify(e.message));
  const root = info.chain[info.chain.length - 1];
  return (
    <div className="card cert-card" data-testid="peer-cert">
      <div>
        <b>{info.cert.subject}</b>
      </div>
      <div className="muted">
        Issued by {info.selfSigned ? 'itself (self-signed)' : info.cert.issuer} · expires {fmtDate(info.cert.validTo)}
        {info.cert.altNames ? ` · for ${info.cert.altNames}` : ''}
      </div>
      <div className="mono faint" style={{ fontSize: 11 }}>
        SHA-256 {info.cert.fingerprint256}
      </div>
      <div className={info.problem ? 'warn-text' : 'muted'}>{info.problem ? `Refused today: ${PROBLEM_TEXT[info.problem] ?? info.problem}` : 'This certificate already passes the normal checks.'}</div>
      <div className="cert-actions">
        <button className="btn small primary" onClick={() => act(client.tlsTrust(info.cert.pem, `${info.host}:${info.port}`), `Trusted the certificate of ${info.host}`)} title="Check this server against this exact certificate. Safer than skipping checks: a different certificate is still refused.">
          Trust this certificate
        </button>
        {root && root.subject === root.issuer && root.fingerprint256 !== info.cert.fingerprint256 && (
          <button className="btn small" onClick={() => act(client.tlsTrust(root.pem, root.name), `Trusted ${root.name} as a CA`)} title="Trust every certificate this private CA issues">
            Trust its CA ({root.name})
          </button>
        )}
        <button className="btn small" onClick={() => act(client.tlsSkipHost(info.host), `Certificate checks skipped for ${info.host}`)} title="Accept any certificate from this host">
          Skip checks for {info.host}
        </button>
      </div>
    </div>
  );
}

/** Shown where a request failed on a certificate: look at it and accept it in one or two clicks. */
export function CertHelp({ url, error }: { url: string; error: string }) {
  const { client, notify, openAt } = useApp();
  const [info, setInfo] = useState<PeerCertInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  if (!CERT_ERROR.test(error)) return null;
  let host = '';
  let port = 443;
  try {
    const u = new URL(url.replace(/^wss:/, 'https:').replace(/^mqtts:/, 'https:'));
    host = u.hostname.replace(/^\[|\]$/g, '');
    port = Number(u.port) || 443;
  } catch {
    return null;
  }
  const look = async () => {
    setBusy(true);
    try {
      setInfo(await client.tlsPeerCert(host, port));
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="banner cert-help" role="status" data-testid="cert-help">
      {done ? (
        <span>Saved. Send the request again; it now connects.</span>
      ) : (
        <>
          <div>
            <b>{host}</b> has a certificate SiteInquisition does not trust ({error}). Dev servers often use self-signed certificates.
          </div>
          {!info && (
            <div className="cert-actions">
              <button className="btn small primary" disabled={busy} onClick={() => void look()} title="Connect once to read the certificate. No request is sent.">
                {busy ? 'Connecting…' : 'Look at its certificate'}
              </button>
              <button className="btn small" onClick={() => openAt('settings', 'servers')}>
                Server certificate settings
              </button>
            </div>
          )}
          {info && <PeerCert info={info} onDone={() => setDone(true)} />}
        </>
      )}
    </div>
  );
}

/** Settings › Server certificates: how upstream certificates are checked. */
export function TlsSettings() {
  const { client, notify } = useApp();
  const [cfg, setCfg] = useState<UpstreamTlsConfig | null>(null);
  const [hosts, setHosts] = useState('');
  const [target, setTarget] = useState('');
  const [peer, setPeer] = useState<PeerCertInfo | null>(null);
  const [pem, setPem] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = useCallback((c: UpstreamTlsConfig) => {
    setCfg(c);
    setHosts(c.hosts.join('\n'));
  }, []);
  useEffect(() => {
    client.tlsGet().then(apply, (e: Error) => notify(e.message));
    const off = client.onChange((c) => {
      if (c.kind === 'meta.set' && c.entityId === 'upstreamTls') void client.tlsGet().then(apply, () => undefined);
    });
    return () => {
      off();
    };
  }, [client, apply, notify]);

  const save = (p: Promise<UpstreamTlsConfig>, msg: string) => p.then((c) => (apply(c), notify(msg)), (e: Error) => notify(e.message));
  const fetchPeer = async () => {
    const { host, port } = splitHostPort(target);
    if (!host) return;
    setBusy(true);
    setPeer(null);
    try {
      setPeer(await client.tlsPeerCert(host, port));
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) return <div className="empty" aria-busy="true" />;
  const hostList = hosts
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean);
  return (
    <div aria-label="Server certificates">
      <div className="panel-title" style={{ padding: '12px 14px' }}>
        Server certificates
      </div>
      <div className="muted" style={{ padding: '0 14px 10px', fontSize: 12 }}>
        How SiteInquisition checks the certificates of the servers it connects to, for the browser and proxy, Replay, Race, the HTTP/3 lab, WebSockets and MQTT. Dev servers with
        self-signed certificates work once you trust their certificate (best) or skip checks for them. Each send in Replay can also ignore TLS errors on its own.
      </div>
      <div className="settings-row">
        <span className="muted">Check certificates</span>
        <div className="segmented" role="radiogroup" aria-label="Certificate checks">
          {(
            [
              ['verify', 'Always'],
              ['hosts', 'Except listed hosts'],
              ['all', 'Never'],
            ] as const
          ).map(([m, label]) => (
            <button key={m} className="seg" role="radio" aria-checked={cfg.mode === m} aria-pressed={cfg.mode === m} onClick={() => void save(client.tlsSet({ mode: m }), m === 'all' ? 'Certificate checks are off for every server' : 'Saved')}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {cfg.mode === 'all' && (
        <div className="banner" style={{ margin: '0 14px 8px' }}>
          Any certificate is accepted from every server, so a machine in the middle would go unnoticed. Prefer trusting the dev servers' certificates.
        </div>
      )}
      {cfg.mode === 'hosts' && (
        <div className="settings-row">
          <span className="muted">Skip checks for</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <textarea className="input mono" rows={3} value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder={'dev.example.com\n*.staging.local\n10.0.0.*'} aria-label="Hosts that skip certificate checks" />
            <div>
              <button className="btn small primary" disabled={hostList.join('\n') === cfg.hosts.join('\n')} onClick={() => void save(client.tlsSet({ hosts: hostList }), `Checks skipped for ${hostList.length} ${hostList.length === 1 ? 'host' : 'hosts'}`)}>
                Save hosts
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="settings-row" style={{ alignItems: 'start' }}>
        <span className="muted">Trusted certificates</span>
        <div>
          {cfg.trusted.length === 0 && <div className="faint">None yet. Fetch one from a server below, or paste a PEM.</div>}
          <ul className="tech-list">
            {cfg.trusted.map((t) => (
              <li key={t.id} style={{ padding: '6px 0' }} data-testid="trusted-cert">
                <div className="tech-line">
                  <b>{t.name}</b>
                  <span className="faint">expires {fmtDate(t.validTo)}</span>
                  <span style={{ flex: 1 }} />
                  <button className="btn small" onClick={() => void save(client.tlsUntrust(t.id), `No longer trusting ${t.name}`)}>
                    Remove
                  </button>
                </div>
                <div className="tech-evidence">
                  {t.subject}
                  {t.subject !== t.issuer ? ` · issued by ${t.issuer}` : ' · self-signed'}
                  {t.altNames ? ` · ${t.altNames}` : ''}
                </div>
                <div className="tech-evidence mono">SHA-256 {t.fingerprint256}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="settings-row" style={{ alignItems: 'start' }}>
        <span className="muted">Add from a server</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="input mono" value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void fetchPeer()} placeholder="dev.example.com:8443" aria-label="Server to fetch the certificate from" style={{ flex: 1 }} />
            <button className="btn small" disabled={busy || !target.trim()} onClick={() => void fetchPeer()} title="Connect once to read the certificate. No request is sent.">
              {busy ? 'Connecting…' : 'Fetch certificate'}
            </button>
          </div>
          {peer && <PeerCert info={peer} onDone={(c) => (apply(c), setPeer(null))} />}
        </div>
      </div>
      <div className="settings-row" style={{ alignItems: 'start' }}>
        <span className="muted">Paste a certificate</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea className="input mono" rows={4} value={pem} onChange={(e) => setPem(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" aria-label="Certificate PEM" />
          <div>
            <button className="btn small primary" disabled={!pem.includes('BEGIN CERTIFICATE')} onClick={() => void save(client.tlsTrust(pem), 'Certificate trusted').then(() => setPem(''))}>
              Trust it
            </button>
            <span className="faint" style={{ marginLeft: 8, fontSize: 12 }}>
              A server's own certificate, or a private CA that signs your dev servers.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
