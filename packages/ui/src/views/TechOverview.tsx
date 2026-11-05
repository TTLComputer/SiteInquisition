import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CsrfBinding, TechOverview as Overview, TechOverviewEntry } from '../api';
import { useApp } from '../state';
import { fmtTime } from '../format';
import { groupSignatures, PageTokenRow, STATUS_CLASS, STATUS_LABEL } from './Tech';

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Every technology seen across all captured traffic, grouped by provider, with the requests that show it. */
export function TechOverview() {
  const { client, notify, select, setView, setQuery } = useApp();
  const [data, setData] = useState<Overview | null>(null);
  const [bindings, setBindings] = useState<CsrfBinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showPossible, setShowPossible] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, b] = await Promise.all([client.techOverview(), client.csrfBindings()]);
      setData(d);
      setBindings(b);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client]);

  useEffect(() => {
    void load();
    let timer: number | undefined;
    // Detections arrive with traffic; refresh at most every few seconds.
    const off = client.onChange((c) => {
      if (c.kind !== 'tech.detected' && !(c.kind === 'meta.set' && /^(tech|csrf)/.test(c.entityId))) return;
      if (timer === undefined) timer = window.setTimeout(() => ((timer = undefined), void load()), 3000);
    });
    return () => {
      off();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [client, load]);

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    return (data?.tech ?? [])
      .map((t) => ({ ...t, hosts: showPossible ? t.hosts : t.hosts.filter((h) => h.status !== 'possible') }))
      .filter((t) => t.hosts.length)
      .filter((t) => !f || `${t.name} ${t.id} ${t.vendor ?? ''} ${t.category} ${t.hosts.map((h) => h.host).join(' ')}`.toLowerCase().includes(f));
  }, [data, filter, showPossible]);
  const groups = useMemo(() => groupSignatures(shown), [shown]);

  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const inspect = (id: string) => {
    select(id);
    setView('history');
  };
  const rescan = async () => {
    setBusy(true);
    try {
      const r = await client.techRescan();
      notify(`Rescanned ${r.exchanges} requests on ${r.hosts} hosts`);
      await load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="empty error-text">Could not read technologies: {error}</div>;
  if (!data) return <div className="empty" aria-busy="true" />;
  const possibleCount = data.tech.filter((t) => t.hosts.every((h) => h.status === 'possible')).length;

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }} aria-label="Technologies">
      <div className="filterbar">
        <b>Technologies</b>
        <span className="faint">
          {shown.length} across {data.hosts.length} {data.hosts.length === 1 ? 'host' : 'hosts'}, read from captured traffic only
        </span>
        <input className="input" placeholder="Filter by name, provider or host" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter technologies" style={{ flex: '1 1 200px' }} />
        <label className="check" title="Weak matches that need more evidence or your confirmation">
          <input type="checkbox" checked={showPossible} onChange={(e) => setShowPossible(e.target.checked)} /> Show possible{possibleCount ? ` (${possibleCount})` : ''}
        </label>
        <button className="btn small" disabled={busy} onClick={() => void rescan()} title="Forget detections and run the signatures over recent traffic again">
          {busy ? 'Rescanning…' : 'Rescan'}
        </button>
      </div>
      <div className="api-scroll">
        {groups.length === 0 && <div className="empty">Nothing recognized yet. Browse the site through the proxy, or pin what you know from a request's Tech and CSRF tab.</div>}
        {groups.map((g) => (
          <section key={g.group} data-testid="tech-group">
            <div className="nav-heading" style={{ margin: '14px 12px 4px' }}>
              {g.group}
            </div>
            <ul className="tech-list">
              {g.sigs.map((t) => (
                <TechRow key={t.id} t={t} open={open.has(t.id)} onToggle={() => toggle(t.id)} onInspect={inspect} onHost={(h) => (setQuery(`host:${h}`), setView('history'))} />
              ))}
            </ul>
          </section>
        ))}
        <section style={{ marginTop: 12 }}>
          <div className="sec-head">
            <b style={{ color: 'var(--text)' }}>CSRF tokens pages hand out</b>
            <span className="faint">{'<meta name="csrf-token">'} and hidden form fields, newest per host</span>
          </div>
          {data.csrf.length === 0 ? (
            <div className="faint tech-note">No CSRF tokens found in recorded pages.</div>
          ) : (
            <ul className="tech-list">
              {data.csrf.map((t) => (
                <PageTokenRow key={`${t.host} ${t.source.from} ${t.source.name}`} t={t} bindings={bindings} onDone={load} showHost />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function TechRow({ t, open, onToggle, onInspect, onHost }: { t: TechOverviewEntry; open: boolean; onToggle(): void; onInspect(id: string): void; onHost(host: string): void }) {
  return (
    <li data-testid="tech-overview-row">
      <div className="tech-line">
        <button className="link-btn" aria-expanded={open} onClick={onToggle} title={open ? 'Hide hosts' : 'Show hosts and evidence'}>
          {open ? '▾' : '▸'} <b>{t.name}</b>
        </button>
        <span className="faint">{t.category}</span>
        <span className={STATUS_CLASS[t.status]}>
          {STATUS_LABEL[t.status]}
          {t.status === 'detected' || t.status === 'possible' ? ` ${pct(t.confidence)}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <span className="faint">
          {t.hosts.length === 1 ? t.hosts[0]!.host : `${t.hosts.length} hosts`}
        </span>
        {!open && t.hosts[0]?.sampleId && (
          <button className="pill" onClick={() => onInspect(t.hosts[0]!.sampleId!)} title="Open the request this was seen in">
            show request
          </button>
        )}
        {t.docs && (
          <a className="pill" href={t.docs} target="_blank" rel="noreferrer">
            docs
          </a>
        )}
      </div>
      {open && (
        <ul className="tech-list" style={{ marginTop: 4 }}>
          {t.hosts.map((h) => (
            <li key={h.host} style={{ padding: '4px 0 4px 18px' }}>
              <div className="tech-line">
                <button className="link-btn mono" onClick={() => onHost(h.host)} title="Show this host's traffic in History">
                  {h.host}
                </button>
                <span className={STATUS_CLASS[h.status]}>
                  {STATUS_LABEL[h.status]}
                  {h.status === 'detected' || h.status === 'possible' ? ` ${pct(h.confidence)}` : ''}
                </span>
                {h.hits > 0 && <span className="faint">{h.hits} {h.hits === 1 ? 'request' : 'requests'}</span>}
                {h.lastAt && <span className="faint">last {fmtTime(h.lastAt)}</span>}
                <span style={{ flex: 1 }} />
                {h.sampleId && (
                  <button className="pill" onClick={() => onInspect(h.sampleId!)}>
                    show request
                  </button>
                )}
              </div>
              <div className="tech-evidence mono">{h.evidence.join(' · ')}</div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
