import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { confirmLeave } from '../unsaved';
import type { JarCookie, JarCookieInfo, SessionCookie } from '../api';
import { CookieToggle } from './Tech';
import { useApp } from '../state';
import { fmtTime } from '../format';
import { DecodableText } from '../components/Decoded';

type Tab = 'jar' | 'macros' | 'vars' | 'aws';

/** Decode a framework session cookie (Flask, Django, Rails, Laravel, Express) on demand. */
function SessionDecode({ name, value }: { name: string; value: string }) {
  const { client } = useApp();
  const [info, setInfo] = useState<SessionCookie | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.decodeSessionCookie(name, value).then(
      (i) => live && setInfo(i),
      (e: Error) => live && setErr(e.message),
    );
    return () => {
      live = false;
    };
  }, [client, name, value]);
  if (err) return <div className="faint">Could not decode: {err}</div>;
  if (!info) return <div className="faint">Decoding…</div>;
  if (info.framework === 'unknown') return <div className="faint">Not a recognized framework session cookie.</div>;
  return (
    <div className="session-decode" style={{ padding: '4px 0' }}>
      <div style={{ marginBottom: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="badge">{info.framework}</span>
        <span className="badge">{info.structure}</span>
        {info.compressed && <span className="pill faint">compressed</span>}
        {info.flags.map((f) => (
          <span key={f} className="pill faint">
            {f}
          </span>
        ))}
      </div>
      <dl className="kv">
        {info.parts.map((p) => (
          <div key={p.label} style={{ display: 'contents' }}>
            <dt>{p.label}</dt>
            <dd className="mono wrap">{p.value.length > 160 ? `${p.value.slice(0, 160)}…` : p.value}</dd>
          </div>
        ))}
      </dl>
      {info.payload !== undefined && (
        <pre className="raw" style={{ marginTop: 6 }}>
          <DecodableText text={JSON.stringify(info.payload, null, 2)} viewKey={`session:${name}:${value.slice(0, 64)}`} label="Session payload" />
        </pre>
      )}
    </div>
  );
}

/** A short hint at what a cookie value decodes to, e.g. "url › base64 › json". */
export function decodeHint(value: string): string | null {
  const steps: string[] = [];
  let v = value;
  for (let i = 0; i < 4; i++) {
    if (/%[0-9a-f]{2}/i.test(v)) {
      try {
        v = decodeURIComponent(v);
        steps.push('url');
        continue;
      } catch {
        break;
      }
    }
    const t = v.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && (() => { try { JSON.parse(t); return true; } catch { return false; } })()) {
      steps.push('json');
      break;
    }
    if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(t)) {
      steps.push('jwt');
      break;
    }
    if (t.length >= 8 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(t) && t.length % 4 !== 1) {
      try {
        const bin = atob(t.replace(/-/g, '+').replace(/_/g, '/'));
        if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(bin)) {
          v = bin;
          steps.push('base64');
          continue;
        }
      } catch {
        // not base64
      }
    }
    break;
  }
  return steps.length ? steps.join(' › ') : null;
}

function expiryText(c: JarCookie, now: number): { text: string; cls: string } {
  if (c.expires === null) return { text: 'session', cls: 'muted' };
  if (c.expired) return { text: `expired ${new Date(c.expires).toLocaleString()}`, cls: 'expired' };
  const left = c.expires - now;
  const text = left < 3_600_000 ? `in ${Math.max(1, Math.round(left / 60_000))} min` : new Date(c.expires).toLocaleString();
  return { text, cls: left < 3_600_000 ? 'expiring' : '' };
}

function Jar() {
  const { client, select, setView, setQuery, notify, sendToCodecs } = useApp();
  const [cookies, setCookies] = useState<JarCookieInfo[]>([]);
  const [showInfra, setShowInfra] = useState(false);
  const [domain, setDomain] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showExpired, setShowExpired] = useState(true);
  const [openSession, setOpenSession] = useState<string | null>(null);
  const load = useCallback(() => client.cookies().then(setCookies, (e: Error) => notify(e.message)), [client, notify]);
  useEffect(() => {
    void load();
    let t: number | undefined;
    const off = client.onChange((c) => {
      if (c.kind === 'meta.set' && c.entityId === 'cookieOverrides') void load();
      if (c.kind === 'exchange.response' && t === undefined) t = window.setTimeout(() => ((t = undefined), void load()), 1000);
    });
    return () => {
      off();
      window.clearTimeout(t);
    };
  }, [client, load]);

  const domains = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cookies) m.set(c.domain, (m.get(c.domain) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [cookies]);
  const now = Date.now();
  const infraCount = cookies.filter((c) => c.infra && (!domain || c.domain === domain)).length;
  const shown = cookies.filter((c) => (!domain || c.domain === domain) && (showExpired || !c.expired) && (showInfra || !c.infra) && (!filter || `${c.name} ${c.value}`.toLowerCase().includes(filter.toLowerCase())));

  return (
    <div className="two-pane">
      <aside className="side-list" aria-label="Cookie domains">
        <button aria-pressed={domain === null} onClick={() => setDomain(null)}>
          All domains <span className="faint" style={{ marginLeft: 'auto' }}>{cookies.length}</span>
        </button>
        {domains.map(([d, n]) => (
          <button key={d} aria-pressed={domain === d} onClick={() => setDomain(d)}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{d}</span>
            <span className="faint" style={{ marginLeft: 'auto' }}>
              {n}
            </span>
          </button>
        ))}
      </aside>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="filterbar">
          <input className="input mono" style={{ flex: '1 1 240px' }} placeholder="Filter by name or value" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter cookies" />
          <label className="muted" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={showExpired} onChange={(e) => setShowExpired(e.target.checked)} /> Show expired and deleted
          </label>
          <label className="muted" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }} title="Load balancer, CDN and bot management cookies">
            <input type="checkbox" checked={showInfra} onChange={(e) => setShowInfra(e.target.checked)} /> Show platform cookies{infraCount ? ` (${infraCount})` : ''}
          </label>
          <span className="faint" style={{ fontSize: 12 }}>Built from every Set-Cookie in recorded responses, newest wins.</span>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {shown.length === 0 ? (
            <div className="empty">No cookies recorded{domain ? ` for ${domain}` : ''} yet.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Value</th>
                  <th>Domain and path</th>
                  <th>Expires</th>
                  <th>Flags</th>
                  <th>Set by</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const exp = expiryText(c, now);
                  const hint = decodeHint(c.value);
                  const token = `{{cookie:${c.name}@${c.domain}}}`;
                  const key = `${c.domain}${c.path}${c.name}`;
                  return (
                    <Fragment key={key}>
                    <tr data-testid="cookie-row" data-name={c.name}>
                      <td>
                        {c.name}
                        {c.infra && (
                          <div className="faint" style={{ fontSize: 11 }} title="A platform cookie, not the app's">
                            platform: {c.infra}
                          </div>
                        )}
                      </td>
                      <td className="wrap">
                        {c.value.length > 120 ? `${c.value.slice(0, 120)}…` : c.value ? <DecodableText text={c.value} viewKey={`cookie:${c.domain}:${c.path}:${c.name}`} label={`Cookie ${c.name} value`} /> : <span className="faint">(empty)</span>}
                        {hint && <div className="src-script" style={{ fontSize: 11 }}>{hint}</div>}
                      </td>
                      <td>
                        {c.hostOnly ? '' : '.'}
                        {c.domain}
                        <span className="faint">{c.path}</span>
                      </td>
                      <td className={exp.cls}>{exp.text}</td>
                      <td className="muted">{[c.httpOnly && 'HttpOnly', c.secure && 'Secure', c.sameSite && `SameSite=${c.sameSite}`].filter(Boolean).join(' ')}</td>
                      <td>
                        <button
                          className="pill"
                          title="Show the response that set it"
                          onClick={() => {
                            setQuery('');
                            select(c.setBy);
                            setView('history');
                          }}
                        >
                          {fmtTime(c.setAt)}
                        </button>
                      </td>
                      <td>
                        <button className="btn small" title={`Copy ${token} for use in replays`} onClick={() => navigator.clipboard.writeText(token).then(() => notify(`Copied ${token}`), () => notify(token))}>
                          Copy token
                        </button>{' '}
                        <button className="btn small" title="Open the value in Codecs, with its layers detected" onClick={() => sendToCodecs(c.value, `cookie ${c.name}`)}>
                          Decode
                        </button>{' '}
                        <button className="btn small" aria-expanded={openSession === key} title="Read it as a framework session cookie (Flask, Django, Rails, Laravel, Express)" onClick={() => setOpenSession(openSession === key ? null : key)}>
                          Session
                        </button>{' '}
                        <CookieToggle name={c.name} infra={!!c.infra} onDone={() => void load()} />
                      </td>
                    </tr>
                    {openSession === key && (
                      <tr className="session-row">
                        <td colSpan={7}>
                          <SessionDecode name={c.name} value={c.value} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export function Cookies({ macros, vars, aws }: { macros?: React.ReactNode; vars?: React.ReactNode; aws?: React.ReactNode }) {
  const { subTab } = useApp();
  const [tab, setTab] = useState<Tab>((subTab.cookies as Tab) ?? 'jar');
  useEffect(() => {
    if (subTab.cookies) setTab(subTab.cookies as Tab);
  }, [subTab]);
  const labels: Record<Tab, string> = { jar: 'Cookie jar', macros: 'Login macros', vars: 'Variables', aws: 'AWS SigV4' };
  const body: Record<Tab, React.ReactNode> = {
    jar: <Jar />,
    macros: macros ?? <div className="empty">Login macros arrive with the power tools.</div>,
    vars: vars ?? <div className="empty">Token variables arrive with the power tools.</div>,
    aws: aws ?? <div className="empty">AWS SigV4 signing arrives with the power tools.</div>,
  };
  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="tabs" role="tablist" aria-label="Cookies and auth">
        {(Object.keys(labels) as Tab[]).map((t) => (
          <button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => confirmLeave() && setTab(t)}>
            {labels[t]}
          </button>
        ))}
      </div>
      {body[tab]}
    </div>
  );
}
