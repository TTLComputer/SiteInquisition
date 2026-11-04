import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AwsRequestInfo, ErrorFinding, CsrfBinding, CsrfFinding, EffectiveTech, ExchangeDetail, ExchangeTech, JwtFlag, KeyInfo, ParsedJwt, Signature, TechOverride } from '../api';
import { useApp } from '../state';

const STATUS_LABEL: Record<EffectiveTech['status'], string> = { detected: 'detected', possible: 'possible', pinned: 'pinned by you', implied: 'implied' };
const STATUS_CLASS: Record<EffectiveTech['status'], string> = { detected: 'badge ok', possible: 'badge', pinned: 'badge ok', implied: 'badge' };

// Providers first, then everything else by kind.
const VENDOR_ORDER = ['Amazon Web Services', 'Google Cloud', 'Microsoft Azure', 'Cloudflare'];
const CATEGORY_GROUP: Record<string, string> = {
  cdn: 'CDNs and edge',
  security: 'Bot protection and WAFs',
  hosting: 'Hosting platforms',
  cloud: 'Other cloud',
  server: 'Web servers and proxies',
  language: 'Languages and runtimes',
  framework: 'Server frameworks',
  frontend: 'Front-end frameworks',
  cms: 'CMS',
  database: 'Databases',
  auth: 'Identity and auth',
  protocol: 'Protocols',
};
const CATEGORY_ORDER = Object.keys(CATEGORY_GROUP);

const LEADS = new Set(['aws', 'gcp', 'azure', 'cloudflare']);

export const groupOf = (s: Signature) => s.vendor ?? CATEGORY_GROUP[s.category] ?? s.category;

/** Signatures in labelled groups: providers in a fixed order, then categories, then any other vendors a user added. */
export function groupSignatures(list: Signature[]): Array<{ group: string; sigs: Signature[] }> {
  const map = new Map<string, Signature[]>();
  for (const s of list) map.set(groupOf(s), [...(map.get(groupOf(s)) ?? []), s]);
  const rank = (g: string) => {
    const v = VENDOR_ORDER.indexOf(g);
    if (v !== -1) return v;
    const c = CATEGORY_ORDER.findIndex((k) => CATEGORY_GROUP[k] === g);
    return c !== -1 ? VENDOR_ORDER.length + c : 100;
  };
  return [...map.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([group, sigs]) => ({
      group,
      // The umbrella entry (plain "AWS") first, then by name.
      sigs: [...sigs].sort((a, b) => Number(LEADS.has(b.id)) - Number(LEADS.has(a.id)) || a.name.localeCompare(b.name)),
    }));
}

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
            {groupSignatures(sigs).map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.sigs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
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

      <JwtPanel ex={ex} />
      <AwsPanel ex={ex} />

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
  const shown = builtIn.filter((s) => !filter || `${s.name} ${s.id} ${s.category} ${groupOf(s)}`.toLowerCase().includes(filter.toLowerCase()));
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
        {groupSignatures(shown).map((g) => {
          const on = g.sigs.filter((x) => !disabled.includes(x.id)).length;
          const ids = g.sigs.map((x) => x.id);
          return (
            <details key={g.group} className="tech-group" open={!!filter} data-testid="sig-group">
              <summary>
                <b>{g.group}</b>
                <span className="faint">
                  {on} of {g.sigs.length} on
                </span>
                <span style={{ flex: 1 }} />
                <button
                  className="btn small"
                  onClick={(e) => {
                    e.preventDefault();
                    const allOn = on === g.sigs.length;
                    const next = allOn ? [...new Set([...disabled, ...ids])] : disabled.filter((x) => !ids.includes(x));
                    void run(client.setTechDisabled(next).then(() => client.techRescan()), `${g.group}: ${allOn ? 'all off' : 'all on'}`);
                  }}
                >
                  {on === g.sigs.length ? 'Turn all off' : 'Turn all on'}
                </button>
              </summary>
              <div className="tech-sig-grid">
                {g.sigs.map((s) => (
                  <label key={s.id} className="check" title={s.id}>
                    <input
                      type="checkbox"
                      checked={!disabled.includes(s.id)}
                      onChange={(e) => void run(client.setTechDisabled(e.target.checked ? disabled.filter((x) => x !== s.id) : [...disabled, s.id]).then(() => client.techRescan()), e.target.checked ? `${s.name} on` : `${s.name} off`)}
                    />
                    {s.name}
                    {s.vendor && <span className="faint">{s.category}</span>}
                  </label>
                ))}
              </div>
            </details>
          );
        })}
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

const PLACE: Record<string, string> = { query: 'query parameter', path: 'path', form: 'form field', json: 'JSON field', header: 'header', cookie: 'cookie', body: 'request body' };

/** Server errors found in the response, with the request parts that most likely caused them. */
export function ErrorBanner({ ex }: { ex: ExchangeDetail }) {
  const { client, setQuery, setView } = useApp();
  const [list, setList] = useState<ErrorFinding[]>([]);
  useEffect(() => {
    if (!ex.errors?.length) {
      setList([]);
      return;
    }
    client.errors(ex.id).then(setList, () => setList([]));
  }, [client, ex.id, ex.errors?.join(',')]);
  if (!list.length) return null;
  return (
    <div className="err-banner" role="region" aria-label="Server errors in this response">
      {list.map((f) => {
        const [top, ...rest] = f.causes;
        return (
          <details key={f.sig} open data-testid="error-finding">
            <summary>
              <span className={`badge sev-${f.severity}`}>{f.severity}</span>
              <b>{f.name}</b>
              {top ? (
                <span>
                  {' '}
                  likely caused by the {PLACE[top.in] ?? top.in} <span className="mono">{top.in === 'path' || top.in === 'body' ? '' : top.name}</span> = <span className="mono">{short(top.value, 60)}</span>{' '}
                  <span className="faint">({pct(top.confidence)})</span>
                </span>
              ) : (
                <span className="faint"> no single cause found in the request</span>
              )}
              <span style={{ flex: 1 }} />
              <button
                className="btn small"
                onClick={(e) => {
                  e.preventDefault();
                  setQuery(`error:${f.sig}`);
                  setView('history');
                }}
              >
                All like this
              </button>
            </summary>
            <div className="err-body">
              <div className="mono err-excerpt">{f.excerpt}</div>
              {top && <div className="muted">Why: {top.reasons.join('; ')}.</div>}
              {rest.length > 0 && (
                <div className="muted">
                  Also possible:{' '}
                  {rest.map((c, i) => (
                    <span key={i}>
                      {i > 0 ? ', ' : ''}
                      {PLACE[c.in] ?? c.in} <span className="mono">{c.in === 'path' || c.in === 'body' ? short(c.value, 30) : c.name}</span> ({pct(c.confidence)}, {c.reasons[0]})
                    </span>
                  ))}
                </div>
              )}
              {(f.file || f.line) && (
                <div className="muted">
                  Fails in <span className="mono">{f.file}{f.line ? `:${f.line}` : ''}</span>
                </div>
              )}
              <div className="faint">{f.hint}</div>
            </div>
          </details>
        );
      })}
    </div>
  );
}

const bearerOf = (ex: ExchangeDetail): { token: string; where: string } | null => {
  const auth = ex.requestHeaders.find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  const m = auth && /^Bearer\s+(eyJ[\w-]*\.eyJ[\w-]*\.[\w-]*)$/i.exec(auth);
  if (m) return { token: m[1]!, where: 'Authorization: Bearer' };
  for (const [k, v] of ex.requestHeaders) {
    const t = /(eyJ[\w-]*\.eyJ[\w-]*\.[\w-]*)/.exec(v);
    if (t && k.toLowerCase() !== 'cookie') return { token: t[1]!, where: `header ${k}` };
  }
  return null;
};

const FLAG_CLASS: Record<JwtFlag['severity'], string> = { high: 'badge sev-high', medium: 'badge sev-medium', low: 'badge', info: 'badge' };
const fmtClaimTime = (ms?: number) => (ms === undefined ? '—' : new Date(ms).toLocaleString());

/** JWT bearer token: claims, risks, expiry, and re-signing with a held key. */
export function JwtPanel({ ex }: { ex: ExchangeDetail }) {
  const { client, notify } = useApp();
  const found = useMemo(() => bearerOf(ex), [ex.id, ex.requestHeaders]);
  const [jwt, setJwt] = useState<ParsedJwt | null>(null);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState('');
  const [resigned, setResigned] = useState<string | null>(null);
  const [edited, setEdited] = useState('');

  useEffect(() => {
    setJwt(null);
    setResigned(null);
    if (!found) return;
    client.parseJwt(found.token).then((p) => {
      setJwt(p);
      setEdited(JSON.stringify(p.payload, null, 2));
    }, () => setJwt(null));
    client.keys().then(setKeys, () => undefined);
  }, [client, found?.token]);

  if (!found) return null;
  const now = Date.now();

  const resign = async (keyName?: string) => {
    if (!jwt) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(edited) as Record<string, unknown>;
    } catch (e) {
      notify(`Payload is not valid JSON: ${(e as Error).message}`);
      return;
    }
    try {
      const token = await client.signJwt({ header: jwt.header, payload, ...(keyName ? { keyName } : { secret }), alg: String(jwt.header.alg) });
      setResigned(token);
      notify('Token re-signed. Copy it into Replay.');
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const checkSecret = async () => {
    if (!secret) return;
    try {
      const hit = await client.tryJwtSecrets(found.token, [secret]);
      notify(hit ? `The token verifies with "${hit}" — it is forgeable.` : 'That secret does not verify this token.');
    } catch (e) {
      notify((e as Error).message);
    }
  };

  return (
    <section>
      <div className="sec-head">
        <b style={{ color: 'var(--text)' }}>JWT</b>
        <span className="faint">{found.where}</span>
      </div>
      {!jwt ? (
        <div className="faint tech-note">Reading token…</div>
      ) : (
        <div className="jwt-panel">
          <div className="tech-line">
            <span className="badge">{String(jwt.header.alg)}</span>
            {jwt.subject && <span className="mono">sub: {jwt.subject}</span>}
            {jwt.issuer && <span className="mono">iss: {jwt.issuer}</span>}
            <span className={jwt.expired ? 'expired' : 'muted'}>exp: {fmtClaimTime(jwt.expiresAt)}{jwt.expired ? ' (expired)' : ''}</span>
          </div>
          {jwt.flags.map((f) => (
            <div key={f.id} className="tech-check">
              <span className={FLAG_CLASS[f.severity]}>{f.severity}</span>
              <span className="muted">{f.text}</span>
            </div>
          ))}
          <div className="tech-check">
            <button className="btn small" onClick={() => setOpen((o) => !o)}>
              {open ? 'Hide' : 'Edit and re-sign'}
            </button>
          </div>
          {open && (
            <div className="jwt-edit">
              <label className="label">Payload</label>
              <textarea className="input mono" style={{ height: 140, padding: 8, width: '100%' }} value={edited} onChange={(e) => setEdited(e.target.value)} aria-label="JWT payload" />
              <div className="tech-line">
                <input className="input mono" style={{ flex: '1 1 200px' }} placeholder="HMAC secret (for HS*)" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="Signing secret" />
                <button className="btn small" onClick={() => void checkSecret()} disabled={!secret}>
                  Test secret
                </button>
                <button className="btn small primary" onClick={() => void resign()} disabled={!secret && !String(jwt.header.alg).match(/^none$/i)}>
                  Re-sign with secret
                </button>
              </div>
              {keys.length > 0 && (
                <div className="tech-line">
                  <span className="faint">or a stored key:</span>
                  {keys.map((k) => (
                    <button key={k.name} className="btn small" onClick={() => void resign(k.name)}>
                      {k.name}
                    </button>
                  ))}
                </div>
              )}
              {resigned && (
                <div className="jwt-out">
                  <label className="label">Re-signed token</label>
                  <textarea className="input mono" style={{ height: 70, padding: 8, width: '100%' }} readOnly value={resigned} aria-label="Re-signed token" onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn small" onClick={() => navigator.clipboard.writeText(resigned).then(() => notify('Copied'), () => undefined)}>
                    Copy
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const fmtLeft = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 0) return 'expired';
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
};

/** AWS-specific details of a request. */
export function AwsPanel({ ex }: { ex: ExchangeDetail }) {
  const { client } = useApp();
  const [info, setInfo] = useState<AwsRequestInfo | null>(null);
  useEffect(() => {
    client.awsRequestInfo(ex.id).then(setInfo, () => setInfo(null));
  }, [client, ex.id]);
  if (!info || (!info.presigned && !info.amzTarget && !info.s3 && !info.apiGateway)) return null;
  const now = Date.now();
  return (
    <section>
      <div className="sec-head">
        <b style={{ color: 'var(--text)' }}>AWS</b>
      </div>
      <dl className="kv">
        {info.amzTarget && (
          <>
            <dt>Operation</dt>
            <dd>{info.amzTarget.operation} <span className="faint">({info.amzTarget.service})</span></dd>
          </>
        )}
        {info.s3 && (
          <>
            <dt>S3</dt>
            <dd>{info.s3.bucket}/{info.s3.key} <span className="faint">({info.s3.style})</span></dd>
          </>
        )}
        {info.apiGateway && (
          <>
            <dt>API Gateway</dt>
            <dd>{info.apiGateway.apiId}{info.apiGateway.stage ? ` · stage ${info.apiGateway.stage}` : ''}</dd>
          </>
        )}
        {info.presigned && (
          <>
            <dt>Presigned URL</dt>
            <dd>
              <span className={info.presigned.expiresAt <= now ? 'expired' : info.presigned.expiresAt - now < 60_000 ? 'expiring' : ''}>
                {info.presigned.expiresAt <= now ? `expired ${new Date(info.presigned.expiresAt).toLocaleString()}` : `valid for ${fmtLeft(info.presigned.expiresAt - now)} (until ${new Date(info.presigned.expiresAt).toLocaleTimeString()})`}
              </span>
              <div className="faint">{info.presigned.service} · {info.presigned.region} · {info.presigned.accessKeyId}</div>
            </dd>
          </>
        )}
      </dl>
      {info.presigned && info.presigned.expiresAt <= now && <div className="tech-note faint">This presigned URL has expired, so a replay will be rejected. Generate a fresh one, or re-sign with credentials.</div>}
    </section>
  );
}

/** Settings: signing keys for JWT and cookies. Session only until the key store lands. */
export function KeySettings() {
  const { client, notify } = useApp();
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [pem, setPem] = useState('');
  useEffect(() => {
    client.keys().then(setKeys, (e: Error) => notify(e.message));
  }, [client, notify]);
  const run = (p: Promise<KeyInfo[]>, msg: string) => p.then((k) => (setKeys(k), notify(msg)), (e: Error) => notify(e.message));
  return (
    <>
      <div className="panel-title" style={{ padding: '12px 14px' }}>
        Signing keys
      </div>
      <p className="muted" style={{ padding: '0 14px', margin: 0, fontSize: 13 }}>
        Secrets and private keys used to re-sign JWTs (and, later, signed cookies). They are held for this session only and never written to disk. Reference them by name when re-signing.
      </p>
      <div className="settings-block">
        <div className="label">Your keys</div>
        {keys.length === 0 ? (
          <div className="faint">None yet.</div>
        ) : (
          <table className="data-table">
            <tbody>
              {keys.map((k) => (
                <tr key={k.name}>
                  <td className="mono">{k.name}</td>
                  <td>{k.kind === 'hmac' ? 'HMAC secret' : 'private key (PEM)'}</td>
                  <td>
                    <button className="btn small" onClick={() => void run(client.deleteKey(k.name), `${k.name} removed`)}>
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
        <div className="label">Add a key</div>
        <input className="input mono" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Key name" />
        <input className="input mono" placeholder="HMAC secret (for HS256/384/512)" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="HMAC secret" />
        <textarea className="input mono" style={{ height: 120, padding: 8 }} placeholder={'-----BEGIN PRIVATE KEY-----\n… (for RS/PS/ES/EdDSA)'} value={pem} onChange={(e) => setPem(e.target.value)} aria-label="Private key PEM" />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={!name.trim() || (!secret && !pem.trim())} onClick={() => void run(pem.trim() ? client.setKeyPem(name, pem) : client.setKeySecret(name, secret), `${name} added`).then(() => { setName(''); setSecret(''); setPem(''); })}>
            Add key
          </button>
        </div>
      </div>
    </>
  );
}
