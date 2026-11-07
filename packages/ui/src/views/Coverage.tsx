import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CoverageReport, SiteMapHost, SpecCoverage } from '../api';
import { useApp } from '../state';
import { fmtMs, fmtTime } from '../format';
import { bodyText, templatePrefix } from '../actions';
import { ReplayButton } from '../components/ReplayButton';

const AUTH_HEADER = /^(authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-session-token)$/i;

const statusCls = (s: string) => (/^2/.test(s) ? 's-2' : /^3/.test(s) ? 's-3' : /^4/.test(s) ? 's-4' : /^5/.test(s) ? 's-5' : 's-err');

function toMarkdown(r: CoverageReport): string {
  const lines = [`# Endpoints seen on ${r.host}`, '', `${r.endpoints.length} endpoints from ${r.scanned} recorded exchanges.`, '', '| Method | Path | Calls | Statuses | Auth | Parameters | Types |', '|---|---|---|---|---|---|---|'];
  for (const e of r.endpoints) {
    lines.push(
      `| ${e.method} | \`${e.template}\` | ${e.count} | ${Object.entries(e.statuses).map(([s, n]) => `${s}×${n}`).join(' ')} | ${(e.auth ?? []).join(', ')} | ${(e.params ?? []).map((p) => `${p.in === 'query' ? '?' : ''}${p.name}: ${p.types.join('|')}`).join(', ')} | ${e.contentTypes.join(', ')} |`,
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
  const { client, setQuery, select, openReplayById, openDraft, notify, openAt, navigate } = useApp();
  const [docs, setDocs] = useState<SpecCoverage | null>(null);
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
    client.specCoverage(host).then(setDocs, () => setDocs(null));
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
  const hasDocs = !!docs && docs.documented.length > 0;
  const undocumented = new Set(docs?.undocumented ?? []);
  const neverCalled = docs?.documented.filter((d) => d.count === 0) ?? [];

  const exportSpec = async () => {
    if (!host) return;
    try {
      const doc = await client.exportOpenApi(host);
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${host}-openapi.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      notify(`Exported ${Object.keys((doc.paths as object) ?? {}).length} paths as OpenAPI 3.1`);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const tryDocumented = async (specId: string, key: string) => {
    try {
      const r = await client.specRequest(specId, key);
      openDraft({ method: r.method, url: r.url, headers: r.headers, body: r.body }, key.split(' ').pop()!.split('/').filter(Boolean).pop() ?? key);
    } catch (e) {
      notify((e as Error).message);
    }
  };

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
        <button className="btn small" disabled={!host} onClick={() => void exportSpec()} title="Write an OpenAPI 3.1 file from what was seen on this host, with schemas inferred from real bodies">
          Export OpenAPI
        </button>
        <button className="btn small" onClick={() => openAt('api', 'specs')} title="Import OpenAPI, Swagger, Postman or HAR to compare with what was seen">
          Import API file
        </button>
      </div>
      {error && <div className="empty error-text">Could not build coverage: {error}</div>}
      {report && (
        <div className="coverage-body">
          <div className="coverage-summary" aria-live="polite">
            <b>{report.endpoints.length}</b> endpoints from <b>{report.scanned}</b> exchanges · <b className={neverOk ? 's-4' : ''}>{neverOk}</b> never succeeded ·{' '}
            <b>{report.unexercised.length}</b> referenced but never requested
            {hasDocs && (
              <>
                {' '}
                · <b>{docs!.documented.length - neverCalled.length}</b> of {docs!.documented.length} documented called · <b className={undocumented.size ? 's-4' : ''}>{undocumented.size}</b> undocumented
              </>
            )}
          </div>
          <table className="data-table coverage-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Calls</th>
                <th>Statuses</th>
                <th title="How the calls authenticated">Auth</th>
                <th title="Hover a field for its types and an example value">Parameters</th>
                <th>Types</th>
                <th>Slowest</th>
                <th>Last seen</th>
                {hasDocs && <th>Docs</th>}
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
                  <td>
                    {(e.auth ?? []).map((a) => (
                      <span key={a} className={`chip ${a === 'none' ? 's-4' : ''}`} style={{ marginRight: 4 }} title={a === 'none' ? 'Called without credentials' : `Sent with ${a} credentials`}>
                        {a === 'none' ? 'no auth' : a}
                      </span>
                    ))}
                  </td>
                  <td className="mono" style={{ maxWidth: 300 }}>
                    {e.params ? (
                      <>
                        {[e.params.filter((p) => p.in === 'query'), e.params.filter((p) => p.in === 'body')].map((group, gi) =>
                          group.length ? (
                            <div key={gi} className={gi ? 'faint' : undefined}>
                              {gi === 0 ? '?' : ''}
                              {group.slice(0, 12).map((p, i) => (
                                <span key={p.name} title={`${p.in} ${p.name}: ${p.types.join(' | ')}\ne.g. ${p.example}`}>
                                  {i ? (gi === 0 ? ' &' : ', ') : ''}
                                  {p.name}
                                  <span className="faint">:{p.types.join('|')}</span>
                                </span>
                              ))}
                              {group.length > 12 ? ` +${group.length - 12}` : ''}
                            </div>
                          ) : null,
                        )}
                      </>
                    ) : (
                      <>
                        {e.queryParams.length > 0 && <div title="Query parameters">?{e.queryParams.join(' &')}</div>}
                        {e.bodyParams.length > 0 && <div className="faint">{e.bodyParams.slice(0, 12).join(', ')}</div>}
                      </>
                    )}
                  </td>
                  <td className="faint">{e.contentTypes.join(', ')}</td>
                  <td className="mono">{fmtMs(e.maxMs)}</td>
                  <td className="faint">{fmtTime(e.lastAt)}</td>
                  {hasDocs && (
                    <td>{undocumented.has(`${e.method} ${e.template}`) ? <span className="chip s-4" title="No imported API file describes this endpoint">undocumented</span> : <span className="faint">documented</span>}</td>
                  )}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn small"
                      title="Show these calls in Traffic"
                      onClick={() => (setQuery(`host:${report.host} method:${e.method} path:${templatePrefix(e.template)}`), navigate('traffic/requests'))}
                    >
                      Calls
                    </button>{' '}
                    <button className="btn small" title="Inspect one example, a successful one when there is one" onClick={() => (select(e.exampleId), navigate('traffic/requests'))}>
                      Example
                    </button>{' '}
                    <ReplayButton id={e.exampleId} compact />
                    {e.auth && !(e.auth.length === 1 && e.auth[0] === 'none') && (
                      <>
                        {' '}
                        <ReplayButton
                          title="Open the example in Replay with its Authorization, Cookie and API key headers removed, to check whether the endpoint really needs them"
                          label={`${e.method} ${e.template} without auth`}
                          draft={async () => {
                            const ex = await client.get(e.exampleId);
                            const body = ex.reqBodySize ? await bodyText(client, ex.id, 'request').catch(() => '') : '';
                            return { method: ex.method, url: ex.url, headers: ex.requestHeaders.filter(([k]) => !AUTH_HEADER.test(k)), body };
                          }}
                        >
                          Replay without auth
                        </ReplayButton>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {neverCalled.length > 0 && (
            <>
              <div className="panel-title" style={{ margin: '16px 12px 4px' }}>
                Documented but never called
              </div>
              <div className="faint" style={{ margin: '0 12px 8px', fontSize: 12 }}>
                Endpoints the imported API files describe that nothing has requested. Try them to see whether they exist and what they need.
              </div>
              <table className="data-table" aria-label="Documented but never called">
                <tbody>
                  {neverCalled.map((d) => (
                    <tr key={`${d.specId} ${d.endpoint.key}`}>
                      <td className={`mono m-${d.endpoint.method}`}>{d.endpoint.method}</td>
                      <td className="mono">{d.endpoint.path}</td>
                      <td className="faint">{d.endpoint.summary}</td>
                      <td className="faint">{d.specName}</td>
                      <td>
                        <ReplayButton build={() => tryDocumented(d.specId, d.endpoint.key)} title="Open in Replay with example values, real ids from Traffic where it finds them" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
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
                        <button className="btn small" onClick={() => (select(u.foundIn), navigate('traffic/requests'))} title="Inspect the response that mentions it">
                          Where
                        </button>{' '}
                        <ReplayButton build={() => tryPath(u.path)} title="Open a GET for it in Replay" />
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
