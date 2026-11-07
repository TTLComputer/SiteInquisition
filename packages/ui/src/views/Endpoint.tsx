import { useCallback, useEffect, useState } from 'react';
import type { EndpointDetail } from '../api';
import { useApp } from '../state';
import { fmtMs, fmtTime } from '../format';
import { templatePrefix } from '../actions';
import { ReplayButton } from '../components/ReplayButton';

type View = 'overview' | 'traffic' | 'fields' | 'contract' | 'related';
const VIEWS: Array<[View, string]> = [
  ['overview', 'Overview'],
  ['traffic', 'Traffic'],
  ['fields', 'Fields and values'],
  ['contract', 'Contract'],
  ['related', 'Related work'],
];

const statusCls = (s: string) => (/^2/.test(s) ? 's-2' : /^3/.test(s) ? 's-3' : /^4/.test(s) ? 's-4' : /^5/.test(s) ? 's-5' : 's-err');

/**
 * One endpoint as a document: what was observed, what the imported API files
 * say, the notes, and the rules, mocks, breakpoints and flows that touch it.
 * "No observations" and "No documented operation" are different answers and
 * are shown as such.
 */
export function EndpointDocument({ endpointKey }: { endpointKey: string }) {
  const { client, notify, select, navigate, setQuery } = useApp();
  const [detail, setDetail] = useState<EndpointDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('overview');
  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await client.endpoint(endpointKey);
      setDetail(d);
      setNotes(d.notes?.notes ?? '');
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client, endpointKey]);
  useEffect(() => {
    void load();
    return client.onChange((c) => {
      if (c.kind === 'meta.set' && ['endpointNotes', 'endpointAliases', 'mocks', 'replaceRules', 'breakpoints', 'flows', 'specs'].includes(c.entityId)) void load();
    });
  }, [client, load]);

  if (error) return <div className="empty error-text">Could not load this endpoint: {error}</div>;
  if (!detail) return <div className="empty">Loading endpoint...</div>;
  const { ref, observed, documented, related } = detail;
  const inTraffic = () => (setQuery(`host:${ref.host} method:${ref.method} path:${templatePrefix(ref.template)}`), navigate('traffic/requests'));
  const relatedCount = related.mocks.length + related.rules.length + related.breakpoints.length + related.flows.length;

  const saveNotes = async () => {
    try {
      await client.setEndpointNote(detail.key, notes, detail.notes?.tags ?? []);
      notify('Endpoint note saved');
    } catch (e) {
      notify((e as Error).message);
    }
  };

  return (
    <div className="endpoint-doc" aria-label={`Endpoint ${ref.method} ${ref.template}`} data-testid="endpoint-doc">
      <div>
        <span className={`mono m-${ref.method}`}>{ref.method}</span> <b className="mono">{ref.template}</b> <span className="faint">on {ref.host}</span>
        {detail.aliases.length > 0 && <div className="faint">Also known as {detail.aliases.join(', ')}</div>}
      </div>
      <div className="tabs" role="tablist" aria-label="Endpoint views" style={{ background: 'none' }}>
        {VIEWS.map(([v, label]) => (
          <button key={v} role="tab" className="tab" aria-selected={view === v} onClick={() => setView(v)}>
            {label}
            {v === 'related' && relatedCount ? ` (${relatedCount})` : ''}
          </button>
        ))}
      </div>

      {view === 'overview' && (
        <section>
          {observed ? (
            <div data-testid="endpoint-observed">
              <b>{observed.count}</b> calls, first {fmtTime(observed.firstAt)}, last {fmtTime(observed.lastAt)}, slowest {fmtMs(observed.maxMs)}.{' '}
              {Object.entries(observed.statuses).map(([s, n]) => (
                <span key={s} className={`mono ${statusCls(s)}`} style={{ marginRight: 6 }}>
                  {s}
                  <span className="faint">×{n}</span>
                </span>
              ))}
              <div className="faint">
                Auth: {observed.auth.join(', ') || 'none'} · Content: {observed.contentTypes.join(', ') || 'unknown'} · Sources: {observed.sources.join(', ')}
              </div>
            </div>
          ) : (
            <div className="empty-note" data-testid="endpoint-no-observations">
              No observations. Nothing recorded matches this endpoint yet{documented.length ? ', though an imported API file describes it' : ''}.
            </div>
          )}
          <div className="empty-note" style={{ marginTop: 6 }}>
            {documented.length ? `Documented in ${documented.map((d) => d.specName).join(', ')}.` : 'No documented operation in the imported API files.'}
          </div>
          <h3 style={{ marginTop: 12 }}>Notes</h3>
          <textarea className="input" rows={3} aria-label="Endpoint notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Who owns it, what to watch for" style={{ width: '100%' }} />
          <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
            <button className="btn small" onClick={() => void saveNotes()}>
              Save note
            </button>
            {observed && <ReplayButton id={observed.exampleId} compact />}
            <button className="btn small" onClick={inTraffic}>
              Show calls in Traffic
            </button>
          </div>
        </section>
      )}

      {view === 'traffic' && (
        <section>
          {detail.recent.length === 0 ? (
            <div className="empty-note">No observations.</div>
          ) : (
            <table className="data-table" aria-label="Recent calls">
              <tbody>
                {detail.recent.map((e) => (
                  <tr key={e.id} data-testid="endpoint-call">
                    <td className={`mono ${statusCls(String(e.status ?? 'err'))}`}>{e.status ?? '...'}</td>
                    <td className="mono wrap">{e.path}</td>
                    <td className="faint">{e.source}</td>
                    <td className="mono">{fmtMs(e.durationMs)}</td>
                    <td className="faint">{fmtTime(e.startedAt)}</td>
                    <td>
                      <button className="btn small" onClick={() => (select(e.id), navigate('traffic/requests'))}>
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {view === 'fields' && (
        <section>
          {!observed?.params.length ? (
            <div className="empty-note">{observed ? 'No query or body fields seen.' : 'No observations.'}</div>
          ) : (
            <table className="data-table" aria-label="Fields">
              <thead>
                <tr>
                  <th>In</th>
                  <th>Field</th>
                  <th>Types seen</th>
                  <th>Example</th>
                </tr>
              </thead>
              <tbody>
                {observed.params.map((p) => (
                  <tr key={`${p.in}:${p.name}`}>
                    <td className="faint">{p.in}</td>
                    <td className="mono">{p.name}</td>
                    <td className="mono">{p.types.join(' | ')}</td>
                    <td className="mono wrap">{p.example}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {view === 'contract' && (
        <section>
          {documented.length === 0 ? (
            <div className="empty-note" data-testid="endpoint-undocumented">
              No documented operation. Import an OpenAPI, Swagger, Postman or HAR file in Explore API, API files to compare against.
            </div>
          ) : (
            documented.map((d) => (
              <div key={`${d.specId} ${d.endpoint.key}`} className="card" style={{ padding: '8px 10px', marginBottom: 8 }}>
                <b>{d.endpoint.summary ?? d.endpoint.key}</b> <span className="faint">in {d.specName}</span>
                <div className="faint">
                  Parameters: {d.endpoint.params.map((p) => `${p.name} (${p.in}${p.required ? ', required' : ''})`).join(', ') || 'none'} · Responses: {d.endpoint.responses.join(', ') || 'none listed'} · Security:{' '}
                  {d.endpoint.security.join(', ') || 'none'}
                </div>
                {observed && (
                  <div className="faint">
                    Seen statuses not in the file:{' '}
                    {Object.keys(observed.statuses)
                      .filter((s) => /^\d+$/.test(s) && !d.endpoint.responses.includes(s) && !d.endpoint.responses.includes('default'))
                      .join(', ') || 'none'}
                  </div>
                )}
              </div>
            ))
          )}
          {detail.graphql.length > 0 && (
            <>
              <h3 style={{ marginTop: 12 }}>GraphQL operations</h3>
              <table className="data-table" aria-label="GraphQL operations">
                <tbody>
                  {detail.graphql.map((o, i) => (
                    <tr key={i}>
                      <td className="faint">{o.kind}</td>
                      <td className="mono">{o.name ?? '(anonymous)'}</td>
                      <td className="mono faint">{o.rootFields.join(', ')}</td>
                      <td className="mono">{o.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {view === 'related' && (
        <section data-testid="endpoint-related">
          {relatedCount === 0 && <div className="empty-note">No mocks, replacements, breakpoints or flows touch this endpoint.</div>}
          {[
            ['Mocks', related.mocks.map((m) => ({ id: m.id, name: m.name, on: m.enabled })), 'overrides/mocks'] as const,
            ['Replacements', related.rules.map((r) => ({ id: r.id, name: `${r.name} (${r.phase})`, on: r.enabled })), 'overrides/replace'] as const,
            ['Breakpoints', related.breakpoints.map((b) => ({ id: b.id, name: `Pause ${b.phase}`, on: b.enabled })), 'overrides/breakpoints'] as const,
          ]
            .filter(([, list]) => list.length)
            .map(([title, list, page]) => (
              <div key={title} style={{ marginBottom: 10 }}>
                <h3>{title}</h3>
                {list.map((x) => (
                  <div key={x.id} data-testid="endpoint-related-item">
                    {x.name} <span className="faint">{x.on ? 'on' : 'off'}</span>{' '}
                    <button className="btn small ghost" onClick={() => navigate(page)}>
                      Edit
                    </button>
                  </div>
                ))}
              </div>
            ))}
          {related.flows.length > 0 && (
            <div>
              <h3>Flows</h3>
              {related.flows.map((f) => (
                <div key={f.id} data-testid="endpoint-related-item">
                  {f.name} <span className="faint">step {f.steps.map((s) => s + 1).join(', ')}</span>{' '}
                  <button className="btn small ghost" onClick={() => navigate('replay/flows')}>
                    Open
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
