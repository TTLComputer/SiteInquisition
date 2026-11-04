import { useEffect, useState } from 'react';
import { useApp } from '../state';
import { applyTheme, storedTheme, type ThemeChoice } from '../theme';
import { McpSection } from './Mcp';
import { LanSettings } from './Lan';
import { StorageSettings } from './Storage';
import { KeySettings, TechSettings } from './Tech';

type Section = 'proxy' | 'storage' | 'tech' | 'signing' | 'mcp' | 'appearance' | 'keys' | 'together';

export const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl K', 'Filter traffic (focus the History filter)'],
  ['Ctrl R', 'Send the selected exchange to replay'],
  ['Ctrl Enter', 'Send the request in the current replay tab'],
  ['Ctrl Shift Enter', 'Resend the selected exchange without opening the editor'],
  ['Up / Down', 'Move the selection in History'],
  ['Shift F10', 'Open the row menu for the selected exchange'],
  ['Delete', 'Delete the selected exchange (asks first)'],
  ['Double click', 'Open a row in replay'],
  ['Ctrl D', 'Decode the selected text (or the selected exchange\'s response body) in Codecs'],
  ['Ctrl Shift R', 'Send the selected exchange to Race'],
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <span className="muted">{label}</span>
      <span style={{ minWidth: 0, wordBreak: 'break-all' }}>{children}</span>
    </div>
  );
}

/** Hosts the built-in browser reaches over QUIC. Chromium reads them at launch, so saving asks for a restart. */
function BrowserHttp3() {
  const { client, notify } = useApp();
  const [hosts, setHosts] = useState('');
  const [port, setPort] = useState<number | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    void client
      .browserHttp3()
      .then((r) => {
        setHosts(r.hosts.join(', '));
        setSaved(r.hosts.join(', '));
        setPort(r.port);
      })
      .catch(() => undefined);
  }, [client]);
  const save = async () => {
    try {
      const r = await client.setBrowserHttp3Hosts(hosts.split(/[\s,]+/).filter(Boolean));
      setHosts(r.hosts.join(', '));
      setSaved(r.hosts.join(', '));
      notify('Saved. Restart SiteInquisition for the built-in browser to pick up the change.');
    } catch (err) {
      notify((err as Error).message);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="input mono"
          style={{ flex: 1 }}
          value={hosts}
          placeholder="shop.example.com, api.example.com"
          onChange={(e) => setHosts(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
          aria-label="Browser HTTP/3 hosts"
        />
        <button className="btn small" onClick={() => void save()} disabled={hosts === saved}>
          Save
        </button>
      </div>
      <span className="muted">
        The browser talks QUIC to these hosts through {port ? <span className="mono">UDP 127.0.0.1:{port}</span> : 'the browser listener'}, and each request is recorded as HTTP/3 and sent on over HTTP/3 (or HTTPS when the site has no QUIC). Exact host names only. Takes effect after a restart.
      </span>
    </div>
  );
}

export function Settings() {
  const { info, subTab } = useApp();
  const [section, setSection] = useState<Section>((subTab.settings as Section) ?? 'proxy');
  useEffect(() => {
    if (subTab.settings) setSection(subTab.settings as Section);
  }, [subTab]);
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme());
  const labels: Record<Section, string> = { proxy: 'Proxy and TLS', storage: 'Storage', tech: 'Technologies', signing: 'Signing keys', mcp: 'MCP and agents', appearance: 'Appearance', keys: 'Keyboard', together: 'Work together' };
  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="tabs" role="tablist" aria-label="Settings">
        {(Object.keys(labels) as Section[]).map((s) => (
          <button key={s} role="tab" className="tab" aria-selected={section === s} onClick={() => setSection(s)}>
            {labels[s]}
          </button>
        ))}
      </div>
      <div className="page-inner">
        <div className="card" style={{ flex: '1 1 640px', maxWidth: 900 }}>
          {section === 'tech' && <TechSettings />}
          {section === 'signing' && <KeySettings />}
          {section === 'proxy' && (
            <>
              <div className="panel-title" style={{ padding: '12px 14px' }}>
                Proxy and TLS
              </div>
              {!info && <Row label="Status">Waiting for the core...</Row>}
              {info && (
                <>
                  <Row label="Proxy listener">
                    <span className="mono">{info.proxyPort ? `${info.allowLan ? '0.0.0.0' : '127.0.0.1'}:${info.proxyPort}` : 'not running'}</span>
                    <span className="muted"> · HTTP, HTTPS (CONNECT) and SOCKS on one port</span>
                  </Row>
                  <Row label="Other devices on the LAN">
                    <LanSettings />
                  </Row>
                  <Row label="CA certificate">
                    <span className="mono">{info.ca.certPath}</span>
                  </Row>
                  <Row label="CA fingerprint (SHA-256)">
                    <span className="mono" style={{ fontSize: 11 }}>
                      {info.ca.fingerprint}
                    </span>
                  </Row>
                  <Row label="CA expires">{new Date(info.ca.expiresAt).toLocaleDateString()}</Row>
                  <Row label="CA private key">
                    {info.protection?.caKey === 'keyring' ? (
                      `Encrypted with a key kept in ${info.protection.keyring}`
                    ) : (
                      <span className="warn-text">A plain file readable only by your account (no OS keyring found). Anyone who copies it can intercept the traffic of devices that trust this CA.</span>
                    )}
                    <div className="muted" style={{ fontSize: 12 }}>
                      Replace it with <code>siq ca rotate</code>, or delete it with <code>siq ca remove</code>; see docs/ca-trust.md for removing it from devices.
                    </div>
                  </Row>
                  <Row label="Decrypting">{info.decryptHosts.length ? <span className="mono">{info.decryptHosts.join(', ')}</span> : 'No hosts (add include rules in Rules › Scope)'}</Row>
                  <Row label="Browser over HTTP/3">
                    <BrowserHttp3 />
                  </Row>
                  <Row label="MQTT relays">
                    {info.mqtt.length === 0
                      ? 'None (start with --mqtt PORT=BROKER)'
                      : info.mqtt.map((m) => (
                          <div key={m.broker} className="mono">
                            {m.port ? `127.0.0.1:${m.port}` : 'stopped'} → {m.broker}
                            {m.listenTls ? ' (TLS listener)' : ''}
                          </div>
                        ))}
                  </Row>
                  <Row label="Core API">
                    <span className="mono">{info.apiPort ? `ws://127.0.0.1:${info.apiPort}` : 'not running'}</span>
                    <span className="muted"> · token protected, local only</span>
                  </Row>
                  <Row label="Project">
                    <span className="mono">{info.projectDir}</span>
                  </Row>
                  <Row label="Version">{info.version}</Row>
                </>
              )}
            </>
          )}
          {section === 'storage' && <StorageSettings Row={Row} />}
          {section === 'mcp' && <McpSection Row={Row} />}
          {section === 'appearance' && (
            <>
              <div className="panel-title" style={{ padding: '12px 14px' }}>
                Appearance
              </div>
              <Row label="Theme">
                <div className="segmented" role="radiogroup" aria-label="Theme">
                  {(['system', 'light', 'dark'] as const).map((t) => (
                    <button
                      key={t}
                      className="seg"
                      role="radio"
                      aria-checked={theme === t}
                      aria-pressed={theme === t}
                      onClick={() => {
                        setTheme(t);
                        applyTheme(t);
                      }}
                    >
                      {t === 'system' ? 'Follow system' : t === 'light' ? 'Light' : 'Dark'}
                    </button>
                  ))}
                </div>
              </Row>
            </>
          )}
          {section === 'keys' && (
            <>
              <div className="panel-title" style={{ padding: '12px 14px' }}>
                Keyboard
              </div>
              {SHORTCUTS.map(([k, v]) => (
                <Row key={k} label={k}>
                  {v}
                </Row>
              ))}
            </>
          )}
          {section === 'together' && (
            <>
              <div className="panel-title" style={{ padding: '12px 14px' }}>
                Work together
              </div>
              <Row label="Sharing">After v1: two or three people on one capture, with live updates. Every view already redraws from the core's change stream, so a second client will need no UI changes.</Row>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
