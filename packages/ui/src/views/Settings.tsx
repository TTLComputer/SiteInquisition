import { useState } from 'react';
import { useApp } from '../state';
import { applyTheme, storedTheme, type ThemeChoice } from '../theme';

type Section = 'proxy' | 'mcp' | 'appearance' | 'keys' | 'together';

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl K', 'Filter traffic (focus the History filter)'],
  ['Ctrl R', 'Send the selected exchange to replay'],
  ['Ctrl Enter', 'Send the request in the current replay tab'],
  ['Ctrl Shift Enter', 'Resend the selected exchange without opening the editor'],
  ['Up / Down', 'Move the selection in History'],
  ['Shift F10', 'Open the row menu for the selected exchange'],
  ['Double click', 'Open a row in replay'],
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <span className="muted">{label}</span>
      <span style={{ minWidth: 0, wordBreak: 'break-all' }}>{children}</span>
    </div>
  );
}

export function Settings() {
  const { info } = useApp();
  const [section, setSection] = useState<Section>('proxy');
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme());
  const labels: Record<Section, string> = { proxy: 'Proxy and TLS', mcp: 'MCP and agents', appearance: 'Appearance', keys: 'Keyboard', together: 'Work together' };
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
          {section === 'proxy' && (
            <>
              <div className="panel-title" style={{ padding: '12px 14px' }}>
                Proxy and TLS
              </div>
              {!info && <Row label="Status">Waiting for the core...</Row>}
              {info && (
                <>
                  <Row label="Proxy listener">
                    <span className="mono">{info.proxyPort ? `127.0.0.1:${info.proxyPort}` : 'not running'}</span>
                    <span className="muted"> · HTTP, HTTPS (CONNECT) and SOCKS on one port</span>
                  </Row>
                  <Row label="Other devices on the LAN">{info.allowLan ? 'Allowed' : 'Refused (start with --lan to accept IoT devices)'}</Row>
                  <Row label="CA certificate">
                    <span className="mono">{info.ca.certPath}</span>
                  </Row>
                  <Row label="CA fingerprint (SHA-256)">
                    <span className="mono" style={{ fontSize: 11 }}>
                      {info.ca.fingerprint}
                    </span>
                  </Row>
                  <Row label="CA expires">{new Date(info.ca.expiresAt).toLocaleDateString()}</Row>
                  <Row label="Decrypting">{info.decryptHosts.length ? <span className="mono">{info.decryptHosts.join(', ')}</span> : 'No hosts (add include rules in Rules › Scope)'}</Row>
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
          {section === 'mcp' && (
            <>
              <div className="panel-title" style={{ padding: '12px 14px' }}>
                MCP and agents
              </div>
              <Row label="Write actions">Ask each time (default). The approval chip, the approval card and the agent activity log arrive with the MCP server in the power tools milestone.</Row>
            </>
          )}
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
