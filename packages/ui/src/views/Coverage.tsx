import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CoverageReport, SiteMapHost } from '../api';
import { useApp } from '../state';
import { fmtMs, fmtTime } from '../format';
import { templatePrefix } from '../actions';

const statusCls = (s: string) => (/^2/.test(s) ? 's-2' : /^3/.test(s) ? 's-3' : /^4/.test(s) ? 's-4' : /^5/.test(s) ? 's-5' : 's-err');

function toMarkdown(r: CoverageReport): string {
  const lines = [`# Endpoints seen on ${r.host}`, '', `${r.endpoints.length} endpoints from ${r.scanned} recorded exchanges.`, '', '| Method | Path | Calls | Statuses | Query params | Body params | Types |', '|---|---|---|---|---|---|---|'];
  for (const e of r.endpoints) {
    lines.push(
      `| ${e.method} | \`${e.template}\` | ${e.count} | ${Object.entries(e.statuses).map(([s, n]) => `${s}×${n}`).join(' ')} | ${e.queryParams.join(', ')} | ${e.bodyParams.join(', ')} | ${e.contentTypes.join(', ')} |`,
    );
  }
  if (r.unexercised.length) {
    lines.push('', '## Referenced but never requested', '');
    for (const u of r.unexercised) lines.push(`- \`${u.path}\` (mentioned ${u.count}×)`);
  }
  return lines.join('\n');
}

/**
 * Endpoint coverage for one host: every method and path template seen, with
 * statuses, parameters and content types, plus paths the app's own pages and
 * scripts mention that nobody has requested yet.
 */
export function Coverage({ initialHost }: { initialHost: string | null }) {
  const { client, setQuery, select, openReplayById, openDraft, notify } = useApp();
  const [hosts, setHosts] = useState<SiteMapHost[]>([]);
  const [host, setHost] = useState<string | null>(initialHost);
  const [report, setReport] = useState<CoverageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);

  useEffect(() => {
    client.siteMap().then((h) => {
      setHosts(h);
      setHost((cur) => cur ?? h[0]?.host ?? null);
    }, () => undefined);
  }, [client]);
  useEffect(() => {
    if (initialHost) setHost(initialHost);
  }, [initialHost]);

  const load = useCallback(() => {
    if (!host) return;
    setLoading(true);
    client
      .coverage(host)
      .then((r) => (setReport(r), setError(null)), (e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [client, host]);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    if (!report) return [];
    const f = filter.toLowerCase();
    return report.endpoints.filter((e) => {
      if (f && !`${e.method} ${e.template} ${e.queryParams.join(' ')} ${e.bodyParams.join(' ')}`.toLowerCase().includes(f)) return false;
      if (onlyProblems && Object.keys(e.statuses).some((s) => /^[23]/.test(s))) return false;
      return true;
    });
  }, [report, filter, onlyProblems]);

  /** Open a GET for a path nobody requested, with the origin and headers (cookies, auth) of a real request to this host. */
  const tryPath = async (path: string) => {
    try {
      const ex = report?.endpoints.find((e) => e.method === 'GET') ?? report?.endpoints[0];
      if (!ex) throw new Error('no recorded request to copy the origin and headers from');
      const base = await client.get(ex.exampleId);
      const headers = base.requestHeaders.filter(([k]) => !/^(content-type|content-length|:)/i.test(k));
      openDraft({ method: 'GET', url: new URL(path, base.url).href, headers }, path.split('/').filter(Boolean).pop() ?? path);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const neverOk = report?.endpoints.filter((e) => !Object.keys(e.statuses).some((s) => /^[23]/.test(s))).length ?? 0;

  return (
    <div className="coverage" aria-label="Endpoint coverage">
      <div className="filterbar">
        <label className="check">
          Host
          <select className="input" value={host ?? ''} onChange={(e) => setHost(e.target.value)} aria-label="Coverage host">
            {hosts.map((h) => (
              <option key={h.host} value={h.host}>
                {h.host} ({h.count})
              </option>
            ))}
          </select>
        </label>
        <input className="input" placeholder="Filter endpoints or parameters" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter endpoints" style={{ flex: '1 1 200px' }} />
        <label className="check">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Never succeeded
        </label>
        <button className="btn small" onClick={load} disabled={loading}>
          {loading ? 'Scanning...' : 'Rescan'}
        </button>
        <button className="btn small" disabled={!report} onClick={() => report && navigator.clipboard.writeText(toMarkdown(report)).then(() => notify('Copied as Markdown'), () => notify('Could not copy'))}>
          Copy as Markdown
        </button>
      </div>
      {error && <div className="empty error-text">Could not build coverage: {error}</div>}
      {report && (
        <div className="coverage-body">
          <div className="coverage-summary" aria-live="polite">
            <b>{report.endpoints.length}</b> endpoints from <b>{report.scanned}</b> exchanges · <b className={neverOk ? 's-4' : ''}>{neverOk}</b> never succeeded ·{' '}
            <b>{report.unexercised.length}</b> referenced but never requested
          </div>
          <table className="data-table coverage-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Calls</th>
                <th>Statuses</th>
                <th>Parameters</th>
                <th>Types</th>
                <th>Slowest</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={`${e.method} ${e.template}`}>
                  <td className={`mono m-${e.method}`}>{e.method}</td>
                  <td className="mono">{e.template}</td>
                  <td className="mono">{e.count}</td>
                  <td>
                    {Object.entries(e.statuses).map(([s, n]) => (
                      <span key={s} className={`mono ${statusCls(s)}`} style={{ marginRight: 6 }}>
                        {s}
                        <span className="faint">×{n}</span>
                      </span>
                    ))}
                  </td>
                  <td className="mono" style={{ maxWidth: 260 }}>
                    {e.queryParams.length > 0 && <div title="Query parameters">?{e.queryParams.join(' &')}</div>}
                    {e.bodyParams.length > 0 && (
                      <div className="faint" title="Body fields">
                        {e.bodyParams.slice(0, 12).join(', ')}
                        {e.bodyParams.length > 12 ? ` +${e.bodyParams.length - 12}` : ''}
                      </div>
                    )}
                  </td>
                  <td className="faint">{e.contentTypes.join(', ')}</td>
                  <td className="mono">{fmtMs(e.maxMs)}</td>
                  <td className="faint">{fmtTime(e.lastAt)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn small"
                      title="Show these calls in History"
                      onClick={() => setQuery(`host:${report.host} method:${e.method} path:${templatePrefix(e.template)}`)}
                    >
                      Calls
                    </button>{' '}
                    <button className="btn small" title="Inspect one example, a successful one when there is one" onClick={() => select(e.exampleId)}>
                      Example
                    </button>{' '}
                    <button className="btn small" title="Open the example in Replay" onClick={() => openReplayById(e.exampleId).catch((err: Error) => notify(err.message))}>
                      Replay
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.unexercised.length > 0 && (
            <>
              <div className="panel-title" style={{ margin: '16px 12px 4px' }}>
                Referenced but never requested
              </div>
              <div className="faint" style={{ margin: '0 12px 8px', fontSize: 12 }}>
                Paths that this host&apos;s own HTML, scripts and JSON mention. Often hidden features, admin pages or API calls behind a button nobody has clicked.
              </div>
              <table className="data-table">
                <tbody>
                  {report.unexercised.map((u) => (
                    <tr key={u.path}>
                      <td className="mono">{u.path}</td>
                      <td className="faint">mentioned {u.count}×</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn small" onClick={() => select(u.foundIn)} title="Inspect the response that mentions it">
                          Where
                        </button>{' '}
                        <button
                          className="btn small"
                          onClick={() => void tryPath(u.path)}
                          title="Open a GET for it in Replay"
                        >
                          Try it
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
