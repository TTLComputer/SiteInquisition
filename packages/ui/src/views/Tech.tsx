import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CsrfBinding, CsrfFinding, EffectiveTech, ExchangeDetail, ExchangeTech, Signature, TechOverride } from '../api';
import { useApp } from '../state';

const STATUS_LABEL: Record<EffectiveTech['status'], string> = { detected: 'detected', possible: 'possible', pinned: 'pinned by you', implied: 'implied' };
const STATUS_CLASS: Record<EffectiveTech['status'], string> = { detected: 'badge ok', possible: 'badge', pinned: 'badge ok', implied: 'badge' };

const pct = (n: number) => `${Math.round(n * 100)}%`;
const short = (v: string, n = 28) => (v.length > n ? `${v.slice(0, n)}…` : v);

function sourceText(f: CsrfFinding): string {
  if (!f.source) return 'source not found in recorded traffic';
  const s = f.source;
  const where = { cookie: `cookie ${s.name}`, header: `response header ${s.name}`, meta: `<meta name="${s.name}">`, input: `form field ${s.name}`, json: `JSON field ${s.name}`, regex: `page text /${short(s.name, 30)}/` }[s.from];
  const how = { 'cookie-echo': 'the same value is in a cookie (double submit)', 'value-match': 'found in an earlier response', 'framework-pattern': 'the usual place for this framework, not confirmed', unknown: '' }[f.how];
  return `${where}${s.urlDecode ? ' (URL decoded)' : ''}${how ? ` · ${how}` : ''}`;
}

/** The Inspector's Tech tab: what the host runs on, CSRF tokens in this request, platform cookies. */
export function TechPanel({ ex }: { ex: ExchangeDetail }) {
  const { client, notify, select } = useApp();
  const [data, setData] = useState<ExchangeTech | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bindings, setBindings] = useState<CsrfBinding[]>([]);
  const [sigs, setSigs] = useState<Signature[]>([]);
  const [pinId, setPinId] = useState('');
  const [pinHost, setPinHost] = useState(ex.host);

  const load = useCallback(async () => {
    try {
      const [d, b] = await Promise.all([client.techExchange(ex.id), client.csrfBindings()]);
      setData(d);
      setBindings(b);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client, ex.id]);

  useEffect(() => {
    void load();
    setPinHost(ex.host);
    client.techSignatures().then((s) => {
      const off = new Set(s.disabled);
      const map = new Map<string, Signature>();
      for (const x of [...s.builtIn, ...s.custom]) if (!off.has(x.id)) map.set(x.id, x);
      setSigs([...map.values()].sort((a, b) => a.name.localeCompare(b.name)));
    }, () => undefined);
    const off = client.onChange((c) => {
      if (c.kind === 'meta.set' && /^(tech|cookie|csrf)/.test(c.entityId)) void load();
      if (c.kind === 'tech.detected' && c.entityId === ex.host.toLowerCase()) void load();
    });
    return () => {
      off();
    };
  }, [client, ex.id, ex.host, load]);

  const act = (p: Promise<unknown>, msg: string) => p.then(() => (notify(msg), load()), (e: Error) => notify(e.message));

  const runCheck = async (t: EffectiveTech, index: number) => {
    try {
      const res = await client.techCheck(ex.host + (ex.port && ![80, 443].includes(ex.port) ? `:${ex.port}` : ''), t.id, index, ex.scheme === 'http' ? 'http' : 'https');
      notify(`Check sent: ${res.status ?? res.state}. It is in History, tagged "check".`);
      select(res.id);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  if (error) return <div className="empty error-text">Could not read technologies: {error}</div>;
  if (!data) return <div className="empty" aria-busy="true" />;
  const { host } = data;
  const bindingById = new Map(bindings.map((b) => [b.id, b]));

  return (
    <div className="tech-panel">
      <section>
        <div className="sec-head">
          <b style={{ color: 'var(--text)' }}>{host.host} runs on</b>
          <span className="faint">Read from captured traffic only. Correct anything that is wrong.</span>
        </div>
        {host.tech.length === 0 && <div className="faint tech-note">Nothing recognized yet. Pin what you know below, or add a signature in Settings › Technologies.</div>}
        <ul className="tech-list">
          {host.tech.map((t) => (
            <li key={t.id} data-testid="tech-row">
              <div className="tech-line">
                <b>{t.name}</b>
                <span className="faint">{t.category}</span>
                <span className={STATUS_CLASS[t.status]} title={t.status === 'possible' ? 'Weak evidence; pin it if it is right' : undefined}>
                  {STATUS_LABEL[t.status]}
                  {t.status === 'detected' || t.status === 'possible' ? ` ${pct(t.confidence)}` : ''}
                </span>
                <span style={{ flex: 1 }} />
                {t.status === 'pinned' ? (
                  <button className="btn small" onClick={() => act(client.techOverride(host.host, t.id, 'clear'), `Unpinned ${t.name}`)}>
                    Unpin
                  </button>
                ) : (
                  <>
                    {t.status === 'possible' && (
                      <button className="btn small" onClick={() => act(client.techOverride(host.host, t.id, 'pin'), `Pinned ${t.name} for ${host.host}`)}>
                        Confirm
                      </button>
                    )}
                    <button className="btn small" title={`Tell SiteInquisition ${host.host} does not use ${t.name}`} onClick={() => act(client.techOverride(host.host, t.id, 'reject'), `${t.name} hidden for ${host.host}`)}>
                      Not this
                    </button>
                  </>
                )}
              </div>
              <div className="tech-evidence mono">{t.evidence.join(' · ')}</div>
              {t.checks.map((c, i) => {
                const probeIndex = t.checks.slice(0, i).filter((x) => x.probe).length;
                return (
                  <div key={i} className="tech-check">
                    <span className="muted">{c.text}</span>
                    {c.probe && (
                      <button className="btn small" title="Sends one request now. Nothing is sent unless you click." onClick={() => void runCheck(t, probeIndex)}>
                        Send {c.probe.method} {c.probe.path}
                      </button>
                    )}
                  </div>
                );
              })}
            </li>
          ))}
        </ul>
        {host.rejected.length > 0 && (
          <div className="tech-note">
            <span className="muted">Hidden by you: </span>
            {host.rejected.map((r) => (
              <button key={r.overrideId} className="pill" title={`Rule for ${r.host}. Click to show it again.`} onClick={() => act(client.techOverride(r.host, r.id, 'clear'), `${r.name} restored`)}>
                {r.name} ✕
              </button>
            ))}
          </div>
        )}
        <div className="tech-pin">
          <label className="muted" htmlFor="pin-tech">
            Missed something?
          </label>
          <select id="pin-tech" className="input" value={pinId} onChange={(e) => setPinId(e.target.value)}>
            <option value="">Choose a technology</option>
            {sigs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input className="input mono" aria-label="Host or host glob" title="This host, or a glob like *.example.com" value={pinHost} onChange={(e) => setPinHost(e.target.value)} />
          <button className="btn small primary" disabled={!pinId || !pinHost.trim()} onClick={() => act(client.techOverride(pinHost, pinId, 'pin'), `Pinned for ${pinHost}`).then(() => setPinId(''))}>
            Pin
          </button>
        </div>
      </section>

      <section>
        <div className="sec-head">
          <b style={{ color: 'var(--text)' }}>CSRF tokens in this request</b>
        </div>
        {data.csrf.length === 0 ? (
          <div className="faint tech-note">This request carries no token that looks like CSRF protection.</div>
        ) : (
          <ul className="tech-list">
            {data.csrf.map((f, i) => {
              const bound = f.bindingId ? bindingById.get(f.bindingId) : undefined;
              return (
                <li key={i} data-testid="csrf-row">
                  <div className="tech-line">
                    <b className="mono">
                      {f.sink.in} {f.sink.name}
                    </b>
                    <span className="mono faint">{short(f.value)}</span>
                    {f.tech && <span className="badge">{f.tech}</span>}
                    <span style={{ flex: 1 }} />
                    {bound ? (
                      <>
                        <span className="badge ok">kept fresh as {`{{var:${bound.varName}}}`}</span>
                        <button className="btn small" onClick={() => act(client.setCsrfBindings(bindings.filter((b) => b.id !== bound.id)), 'Stopped refreshing this token')}>
                          Stop
                        </button>
                      </>
                    ) : f.suggestion ? (
                      <button
                        className="btn small primary"
                        title="Watch responses for this token and put the latest one in replays that use Fresh CSRF token"
                        onClick={() => act(client.setCsrfBindings([...bindings, f.suggestion!]), `Watching for ${f.sink.name}. Turn on "Fresh CSRF token" in Replay.`)}
                      >
                        Keep fresh on replay
                      </button>
                    ) : null}
                  </div>
                  <div className="tech-evidence">
                    Comes from {sourceText(f)}
                    {f.sourceExchangeId && (
                      <>
                        {' '}
                        <button className="pill" onClick={() => select(f.sourceExchangeId!)}>
                          show response
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <div className="sec-head">
          <b style={{ color: 'var(--text)' }}>Cookies</b>
          <span className="faint">Platform cookies are hidden in the cookie jar by default.</span>
        </div>
        {data.cookies.length === 0 ? (
          <div className="faint tech-note">No cookies sent or set.</div>
        ) : (
          <ul className="tech-list">
            {data.cookies.map((c, i) => (
              <li key={i} className="tech-line">
                <span className="mono">{c.name}</span>
                <span className="faint">{c.set ? 'set by response' : 'sent'}</span>
                {c.infra ? <span className="badge">platform: {c.infra}</span> : <span className="faint">app cookie</span>}
                <span style={{ flex: 1 }} />
                <CookieToggle name={c.name} infra={!!c.infra} onDone={load} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.hits.length > 0 && (
        <section>
          <div className="sec-head">
            <b style={{ color: 'var(--text)' }}>Seen in this exchange</b>
          </div>
          <ul className="tech-list">
            {data.hits.map((h) => (
              <li key={h.tech}>
                <div className="tech-line">
                  <b>{h.name}</b>
                  <span className="faint">{pct(h.confidence)}</span>
                </div>
                <div className="tech-evidence mono">{h.evidence.join(' · ')}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Mark a cookie as platform or app; the latest rule for a name wins. */
export function CookieToggle({ name, infra, onDone }: { name: string; infra: boolean; onDone?(): void }) {
  const { client, notify } = useApp();
  const flip = async () => {
    try {
      const list = (await client.cookieOverrides()).filter((o) => o.name !== name || o.domain);
      await client.setCookieOverrides([...list, { name, infra: !infra }]);
      notify(infra ? `${name} is treated as an app cookie` : `${name} is treated as a platform cookie`);
      onDone?.();
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <button className="btn small" title={infra ? 'It matters to the app: show it everywhere' : 'It belongs to the platform: hide it from the jar by default'} onClick={() => void flip()}>
      {infra ? 'It is an app cookie' : 'Mark as platform'}
    </button>
  );
}

const SIG_EXAMPLE = `[
  {
    "id": "acme",
    "name": "Acme framework",
    "category": "framework",
    "matchers": [
      { "in": "header", "name": "x-acme-version", "weight": 0.95 },
      { "in": "cookie", "name": "acme_sid" }
    ],
    "csrf": [
      { "source": { "from": "meta", "name": "acme-csrf" }, "sinks": [{ "in": "header", "name": "X-Acme-CSRF" }] }
    ]
  }
]`;

/** Settings › Technologies: overrides, signatures on and off, custom signatures, rescans. */
export function TechSettings() {
  const { client, notify } = useApp();
  const [overrides, setOverrides] = useState<TechOverride[]>([]);
  const [builtIn, setBuiltIn] = useState<Signature[]>([]);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const [filter, setFilter] = useState('');
  const [bindings, setBindings] = useState<CsrfBinding[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [o, s, b] = await Promise.all([client.techOverrides(), client.techSignatures(), client.csrfBindings()]);
    setOverrides(o);
    setBuiltIn(s.builtIn);
    setDisabled(s.disabled);
    setCustom(s.custom.length ? JSON.stringify(s.custom, null, 2) : '');
    setBindings(b);
  }, [client]);
  useEffect(() => {
    load().catch((e: Error) => notify(e.message));
  }, [load, notify]);

  const names = useMemo(() => new Map(builtIn.map((s) => [s.id, s.name])), [builtIn]);
  const shown = builtIn.filter((s) => !filter || `${s.name} ${s.id} ${s.category}`.toLowerCase().includes(filter.toLowerCase()));
  const run = (p: Promise<unknown>, msg: string) => p.then(() => (notify(msg), load()), (e: Error) => notify(e.message));

  const saveCustom = () => {
    let list: unknown[];
    try {
      list = custom.trim() ? (JSON.parse(custom) as unknown[]) : [];
      if (!Array.isArray(list)) throw new Error('Signatures must be a JSON list');
    } catch (e) {
      notify(`Not valid JSON: ${(e as Error).message}`);
      return;
    }
    void run(client.setTechSignatures(list).then(() => client.techRescan()), 'Signatures saved and traffic rescanned');
  };

  return (
    <>
      <div className="panel-title" style={{ padding: '12px 14px' }}>
        Technologies
      </div>
      <p className="muted" style={{ padding: '0 14px', margin: 0, fontSize: 13 }}>
        Detection only reads traffic you have captured. Checks a technology suggests are sent only when you click them.
      </p>

      <div className="settings-block">
        <div className="label">Your corrections</div>
        {overrides.length === 0 ? (
          <div className="faint">None yet. Use "Not this" or "Pin" in the Inspector's Tech tab.</div>
        ) : (
          <table className="data-table">
            <tbody>
              {overrides.map((o) => (
                <tr key={o.id}>
                  <td>{o.action === 'pin' ? 'Pinned' : 'Hidden'}</td>
                  <td>{names.get(o.tech) ?? o.tech}</td>
                  <td className="mono">{o.host}</td>
                  <td className="muted">{o.note ?? ''}</td>
                  <td>
                    <button className="btn small" onClick={() => void run(client.setTechOverrides(overrides.filter((x) => x.id !== o.id)), 'Correction removed')}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="settings-block">
        <div className="label">CSRF tokens kept fresh</div>
        {bindings.length === 0 ? (
          <div className="faint">None yet. Use "Keep fresh on replay" in the Inspector's Tech tab.</div>
        ) : (
          <table className="data-table">
            <tbody>
              {bindings.map((b) => (
                <tr key={b.id}>
                  <td className="mono">{b.host}</td>
                  <td className="mono">
                    {b.source.from} {short(b.source.name, 30)} → {b.sinks.map((s) => `${s.in} ${s.name}`).join(', ')}
                  </td>
                  <td className="mono">{`{{var:${b.varName}}}`}</td>
                  <td>
                    <label className="check">
                      <input type="checkbox" checked={b.enabled !== false} onChange={(e) => void run(client.setCsrfBindings(bindings.map((x) => (x.id === b.id ? { ...x, enabled: e.target.checked } : x))), 'Saved')} /> On
                    </label>
                  </td>
                  <td>
                    <button className="btn small" onClick={() => void run(client.setCsrfBindings(bindings.filter((x) => x.id !== b.id)), 'Removed')}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="settings-block">
        <div className="label">Built-in signatures</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <input className="input" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter signatures" />
          <span className="faint">Turn one off if it keeps guessing wrong in this project.</span>
        </div>
        <div className="tech-sig-grid">
          {shown.map((s) => (
            <label key={s.id} className="check" title={s.id}>
              <input
                type="checkbox"
                checked={!disabled.includes(s.id)}
                onChange={(e) => void run(client.setTechDisabled(e.target.checked ? disabled.filter((x) => x !== s.id) : [...disabled, s.id]).then(() => client.techRescan()), e.target.checked ? `${s.name} on` : `${s.name} off`)}
              />
              {s.name} <span className="faint">{s.category}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-block">
        <div className="label">Your signatures (JSON)</div>
        <div className="faint" style={{ marginBottom: 6 }}>
          Same shape as the built-in ones. An id that matches a built-in one replaces it.
        </div>
        <textarea className="input mono" style={{ height: 200, padding: 8, width: '100%' }} value={custom} placeholder={SIG_EXAMPLE} onChange={(e) => setCustom(e.target.value)} aria-label="Custom signatures" />
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button className="btn primary" onClick={saveCustom}>
            Save and rescan
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void run(
                client.techRescan().then((r) => notify(`Rescanned ${r.exchanges} exchanges on ${r.hosts} hosts`)),
                'Rescan finished',
              ).finally(() => setBusy(false));
            }}
          >
            Rescan traffic
          </button>
        </div>
      </div>
    </>
  );
}
