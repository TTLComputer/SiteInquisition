import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SiteMapHost, ApiSpec, AuthRow, ContractSummary, ExchangeDiff, ExchangeSummary, GlossaryEntry, HeaderList, Identity, NegativeResult, Resource, SeenOperation } from '../api';
import { useApp } from '../state';
import { diffLines } from '../diff';
import { ReplayButton } from '../components/ReplayButton';

export function useHosts() {
  const { client } = useApp();
  const [hosts, setHosts] = useState<SiteMapHost[]>([]);
  useEffect(() => {
    client.siteMap().then(setHosts, () => undefined);
  }, [client]);
  return hosts;
}

/** "Name: value" lines to a header list. */
export const parseHeaderLines = (text: string): HeaderList =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.includes(':'))
    .map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string];
    });
const headerLines = (h: HeaderList) => h.map(([k, v]) => `${k}: ${v}`).join('\n');
const show = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));

function useInspect() {
  const { select, setView } = useApp();
  return useCallback(
    (id: string) => {
      select(id);
      setView('history');
    },
    [select, setView],
  );
}

function HostSelect({ value, onChange, label, allowAll }: { value: string; onChange(h: string): void; label: string; allowAll?: boolean }) {
  const hosts = useHosts();
  useEffect(() => {
    if (!value && !allowAll && hosts.length) onChange(hosts[0]!.host);
  }, [value, allowAll, hosts, onChange]);
  return (
    <label className="check">
      Host
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {allowAll && <option value="">all hosts</option>}
        {hosts.map((h) => (
          <option key={h.host} value={h.host}>
            {h.host}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------- Contract check over recorded traffic ----------

export function ContractScan() {
  const { client, notify } = useApp();
  const inspect = useInspect();
  const [host, setHost] = useState('');
  const [scan, setScan] = useState<ContractSummary | null>(null);
  const run = () => client.contractScan(host).then(setScan, (e: Error) => notify(e.message));
  return (
    <div className="card" style={{ margin: '0 12px 8px' }} aria-label="Contract check">
      <div className="sec-head" style={{ padding: '0 0 6px' }}>
        <b style={{ color: 'var(--text)' }}>Contract check</b>
        <span>Compare recorded traffic with the API files: wrong types, missing fields, values outside an enum or range, undocumented fields and statuses.</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <HostSelect value={host} onChange={setHost} label="Contract host" />
        <button className="btn small primary" disabled={!host} onClick={() => void run()}>
          Check traffic
        </button>
        {scan && (
          <span className="faint">
            {scan.checked} exchanges matched an endpoint; {scan.endpoints.filter((e) => e.failing).length} endpoints have issues
          </span>
        )}
      </div>
      {scan && scan.endpoints.some((e) => e.issues.length) && (
        <table className="data-table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Side</th>
              <th>Path</th>
              <th>Issue</th>
              <th>Seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {scan.endpoints.flatMap((ep) =>
              ep.issues.map((i, n) => (
                <tr key={`${ep.endpoint}${n}`}>
                  <td className="mono">{n === 0 ? ep.endpoint : ''}</td>
                  <td className="faint">{i.side}</td>
                  <td className="mono">{i.path}</td>
                  <td className={i.severity === 'error' ? 'error-text' : 'faint'}>{i.message}</td>
                  <td className="faint">{i.count}×</td>
                  <td>
                    <button className="btn small" onClick={() => inspect(i.exampleId)}>
                      Inspect
                    </button>{' '}
                    <ReplayButton id={i.exampleId} compact />
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
      {scan && !scan.endpoints.some((e) => e.issues.length) && scan.checked > 0 && <div className="faint" style={{ marginTop: 6 }}>Every checked exchange matches the spec.</div>}
    </div>
  );
}

// ---------- GraphQL ----------

type GqlMethod = 'introspection' | 'suggestions' | 'traffic';

export function GraphQL() {
  const { client, notify, openDraft } = useApp();
  const inspect = useInspect();
  const [targetUrl, setTargetUrl] = useState('');
  const [schemaUrl, setSchemaUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [schemaHeaders, setSchemaHeaders] = useState('');
  const [method, setMethod] = useState<GqlMethod>('introspection');
  const [insecure, setInsecure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [specs, setSpecs] = useState<ApiSpec[]>([]);
  const [filter, setFilter] = useState('');
  const [ops, setOps] = useState<SeenOperation[] | null>(null);
  const [drift, setDrift] = useState<Record<string, Array<{ field: string; type: string; count: number; exampleId: string }>>>({});

  const load = useCallback(() => client.specs().then((l) => setSpecs(l.filter((s) => s.format === 'graphql')), () => undefined), [client]);
  useEffect(() => void load(), [load]);

  const fetchSchema = async () => {
    setBusy(true);
    try {
      const s = await client.graphqlImport({
        targetUrl: targetUrl.trim(),
        ...(schemaUrl.trim() ? { schemaUrl: schemaUrl.trim() } : {}),
        headers: parseHeaderLines(headers),
        schemaHeaders: parseHeaderLines(schemaHeaders),
        method,
        ignoreTlsErrors: insecure,
      });
      notify(`${s.name}: ${s.endpoints.length} operations${schemaUrl.trim() ? `, schema from ${new URL(schemaUrl.trim()).host}` : ''}`);
      await load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openOp = async (s: ApiSpec, key: string) => {
    try {
      const r = await client.specRequest(s.id, key);
      openDraft({ method: r.method, url: r.url, headers: r.headers, body: r.body }, key.split(' ').pop());
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const host = (() => {
    try {
      return new URL(targetUrl).hostname;
    } catch {
      return undefined;
    }
  })();

  return (
    <div className="api-pane" aria-label="GraphQL">
      <div className="api-scroll">
        <div className="card" style={{ margin: 12 }}>
          <div className="sec-head" style={{ padding: '0 0 8px' }}>
            <b style={{ color: 'var(--text)' }}>Get a GraphQL schema</b>
            <span>Pull it from a server with introspection on (a beta or dev server) and test the server you point it at, such as pre-prod.</span>
          </div>
          <div className="form-grid">
            <label htmlFor="gql-target">Test against</label>
            <input id="gql-target" className="input mono" placeholder="https://preprod.example.com/graphql" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} />
            <label htmlFor="gql-target-headers">Its headers</label>
            <textarea id="gql-target-headers" className="input mono" style={{ height: 44, padding: 6 }} placeholder="Authorization: Bearer {{flow:login.token}}" value={headers} onChange={(e) => setHeaders(e.target.value)} />
            <label htmlFor="gql-from">Schema from</label>
            <input id="gql-from" className="input mono" placeholder="same server, or https://beta.example.com/graphql" value={schemaUrl} onChange={(e) => setSchemaUrl(e.target.value)} />
            <label htmlFor="gql-from-headers">Schema server headers</label>
            <textarea id="gql-from-headers" className="input mono" style={{ height: 44, padding: 6 }} placeholder="Only when the schema server needs different auth" value={schemaHeaders} onChange={(e) => setSchemaHeaders(e.target.value)} />
            <label htmlFor="gql-method">How</label>
            <select id="gql-method" className="input" value={method} onChange={(e) => setMethod(e.target.value as GqlMethod)}>
              <option value="introspection">Introspection query</option>
              <option value="suggestions">Rebuild from "Did you mean" errors (introspection off)</option>
              <option value="traffic">From operations the app sent (recorded traffic)</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
            <button className="btn primary" disabled={busy || !/^https?:\/\//.test(targetUrl.trim())} onClick={() => void fetchSchema()}>
              {busy ? 'Working...' : 'Get schema'}
            </button>
            <label className="check">
              <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} /> Ignore TLS errors
            </label>
            <button className="btn small" onClick={() => void client.graphqlOperations(host).then(setOps, (e: Error) => notify(e.message))}>
              Show operations the app sent
            </button>
          </div>
        </div>

        {ops && (
          <div className="card" style={{ margin: '0 12px 8px' }} aria-label="Seen operations">
            <div className="sec-head" style={{ padding: '0 0 6px' }}>
              <b style={{ color: 'var(--text)' }}>Operations seen</b>
              <span>{ops.length} from requests and loaded scripts</span>
            </div>
            <table className="data-table">
              <tbody>
                {ops.map((o, i) => (
                  <tr key={i}>
                    <td className="mono">{o.kind}</td>
                    <td className="mono">{o.name ?? '(anonymous)'}</td>
                    <td className="mono faint">{o.rootFields.join(', ') || (o.hash ? `persisted ${o.hash.slice(0, 12)}` : '')}</td>
                    <td className="faint">{o.from === 'bundle' ? 'in a script' : `${o.count}×`}</td>
                    <td>
                      <button className="btn small" onClick={() => inspect(o.exampleId)}>
                        Inspect
                      </button>{' '}
                      <ReplayButton id={o.exampleId} compact />
                    </td>
                  </tr>
                ))}
                {!ops.length && (
                  <tr>
                    <td className="faint">None recorded for this host yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {specs.map((s) => {
          const f = filter.toLowerCase();
          const target = s.servers[0] ?? '';
          const from = s.warnings.find((w) => w.startsWith('schema from'));
          const d = drift[s.id];
          return (
            <div key={s.id} className="card spec-card" style={{ margin: '0 12px 8px' }} aria-label={`GraphQL schema ${s.name}`}>
              <div className="race-item-head">
                <b>{s.name}</b>
                <span className="faint">{s.endpoints.length} operations</span>
                <span className="mono faint">{target}</span>
                {from && <span className="chip" title={from}>schema from {from.replace(/^schema from (\S+?),.*$/, '$1').replace(/^https?:\/\//, '')}</span>}
                <span style={{ flex: 1 }} />
                <button className="btn small" onClick={() => void client.graphqlDrift(target).then((r) => setDrift((m) => ({ ...m, [s.id]: r })), (e: Error) => notify(e.message))} title="Fields the target rejected with 'Cannot query field': the schema it was pulled from is ahead of it">
                  Check drift
                </button>
                <button className="btn small" onClick={() => void client.deleteSpec(s.id).then(load)}>
                  Remove
                </button>
              </div>
              {d && (
                <div className={d.length ? 'error-text' : 'faint'} style={{ fontSize: 12, margin: '4px 0' }}>
                  {d.length
                    ? `The target rejected ${d.length} ${d.length === 1 ? 'field' : 'fields'} from this schema: ${d.map((x) => `${x.type}.${x.field}`).join(', ')}`
                    : 'No drift: the target has not rejected any field from this schema.'}
                </div>
              )}
              <input className="input" placeholder="Filter operations" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter GraphQL operations" style={{ margin: '6px 0', width: 300 }} />
              <table className="data-table">
                <tbody>
                  {s.endpoints
                    .filter((e) => !f || e.key.toLowerCase().includes(f))
                    .slice(0, 300)
                    .map((e) => (
                      <tr key={e.key}>
                        <td className="mono">{e.graphql?.kind}</td>
                        <td className="mono">
                          {e.graphql?.field}
                          {e.deprecated && <span className="chip" style={{ marginLeft: 6 }}>deprecated</span>}
                        </td>
                        <td className="mono faint">{e.graphql?.args.map((a) => `${a.name}: ${a.type}`).join(', ')}</td>
                        <td className="mono faint">{e.graphql?.returns}</td>
                        <td>
                          <ReplayButton build={() => openOp(s, e.key)} title="Open in Replay with example variables" />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          );
        })}
        {!specs.length && <div className="empty">No GraphQL schemas yet. Point it at an endpoint above.</div>}
      </div>
    </div>
  );
}

// ---------- Resources (lifecycle) ----------

const OPS = ['list', 'create', 'read', 'replace', 'update', 'delete'] as const;

export function Resources() {
  const { client, notify } = useApp();
  const inspect = useInspect();
  const [host, setHost] = useState('');
  const [rows, setRows] = useState<Resource[] | null>(null);
  useEffect(() => {
    if (host) client.lifecycle(host).then(setRows, (e: Error) => notify(e.message));
  }, [client, host, notify]);
  return (
    <div className="api-pane" aria-label="Resources">
      <div className="filterbar">
        <HostSelect value={host} onChange={setHost} label="Resources host" />
        <span className="faint" style={{ fontSize: 12 }}>
          What you have done to each resource. Gaps are where to test next: a resource you can create but never deleted, or update without a read.
        </span>
      </div>
      <div className="api-scroll">
        <table className="data-table lifecycle" aria-label="Resource lifecycle">
          <thead>
            <tr>
              <th>Resource</th>
              {OPS.map((o) => (
                <th key={o} style={{ textAlign: 'center' }}>
                  {o}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.collection}>
                <td className="mono">
                  {r.collection}
                  {r.item && <div className="faint">{r.item}</div>}
                </td>
                {OPS.map((o) => {
                  const c = r.cells.find((x) => x.op === o);
                  if (!c) return <td key={o} className="lc-cell missing" title="Not seen and not in the API files">-</td>;
                  const statuses = Object.entries(c.statuses).map(([k, n]) => `${k}${n > 1 ? `×${n}` : ''}`).join(' ');
                  const cls = c.seen ? (c.succeeded ? 'seen' : 'failed') : 'doc';
                  return (
                    <td key={o} className={`lc-cell ${cls}`} title={`${c.method} ${c.template}`}>
                      {c.seen ? (
                        <button className="sample" onClick={() => c.exampleId && inspect(c.exampleId)} aria-label={`${o} ${r.collection}: ${statuses}`}>
                          {statuses}
                        </button>
                      ) : (
                        'in spec, never called'
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rows && !rows.length && <div className="empty">No resources seen for this host yet.</div>}
      </div>
    </div>
  );
}

// ---------- Glossary ----------

export function Glossary() {
  const { client, notify, setQuery, setView } = useApp();
  const inspect = useInspect();
  const [host, setHost] = useState('');
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState<GlossaryEntry[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    client.glossary(host || undefined).then(setRows, (e: Error) => notify(e.message));
  }, [client, host, notify]);
  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    return (rows ?? []).filter((r) => !f || `${r.name} ${r.values?.join(' ') ?? ''} ${r.seenIn.join(' ')}`.toLowerCase().includes(f)).slice(0, 500);
  }, [rows, filter]);
  const toggle = (name: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  /** Every request that carried the field (up to what the glossary kept), as a History search. */
  const showAll = (ids: string[]) => {
    setQuery(`id:${[...new Set(ids)].join(',')}`);
    setView('history');
  };
  return (
    <div className="api-pane" aria-label="Glossary">
      <div className="filterbar">
        <HostSelect value={host} onChange={setHost} label="Glossary host" allowAll />
        <input className="input" placeholder="Filter fields" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter glossary" style={{ flex: '1 1 200px' }} />
        {rows && <span className="faint">{rows.length} fields</span>}
      </div>
      <div className="api-scroll">
        <table className="data-table" aria-label="Field glossary">
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Values seen</th>
              <th>Seen</th>
              <th>Where</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const sources = r.sources ?? r.seenIn.map((where) => ({ where, exchangeIds: [], count: 0 }));
              const expanded = open.has(r.name);
              const list = expanded ? sources : sources.slice(0, 2);
              const allIds = sources.flatMap((s) => s.exchangeIds);
              return (
                <tr key={r.name} data-testid="glossary-row" data-field={r.name}>
                  <td className="mono">{r.name}</td>
                  <td className="mono faint">
                    {r.types.join(' | ')}
                    {r.nullable && ' | null'}
                    {r.format && <span className="chip" style={{ marginLeft: 6 }}>{r.format}</span>}
                  </td>
                  <td className="mono">
                    {r.values ? (
                      r.values.join(', ')
                    ) : r.min !== undefined ? (
                      <span className="faint">
                        {r.min} to {r.max}
                      </span>
                    ) : r.minLength !== undefined ? (
                      <span className="faint">
                        {r.minLength === r.maxLength ? `${r.minLength} chars` : `${r.minLength} to ${r.maxLength} chars`}
                      </span>
                    ) : null}
                  </td>
                  <td className="faint">
                    {allIds.length > 0 ? (
                      <button className="link-btn" onClick={() => showAll(allIds)} title="Show the requests that carried this field in History">
                        {r.count}× · {r.distinct} distinct
                      </button>
                    ) : (
                      <>
                        {r.count}× · {r.distinct} distinct
                      </>
                    )}
                  </td>
                  <td className="mono faint glossary-where">
                    {list.map((s) => (
                      <div key={s.where}>
                        {s.exchangeIds.length ? (
                          <button className="link-btn" onClick={() => inspect(s.exchangeIds[0]!)} title={`Open the newest request here${s.count > 1 ? ` (${s.count} in all)` : ''}`}>
                            {s.where}
                          </button>
                        ) : (
                          s.where
                        )}
                        {s.exchangeIds.length > 1 && (
                          <>
                            {' '}
                            <button className="pill" onClick={() => showAll(s.exchangeIds)} title="Show all of them in History">
                              {s.count} requests
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                    {sources.length > 2 && (
                      <button className="pill" aria-expanded={expanded} onClick={() => toggle(r.name)} title={expanded ? 'Show fewer' : sources.map((s) => s.where).join('\n')}>
                        {expanded ? 'show fewer' : `+${sources.length - 2} more`}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Auth matrix and negative tests ----------

function Identities({ list, onChange }: { list: Identity[]; onChange(l: Identity[]): void }) {
  const { client, notify } = useApp();
  const [edit, setEdit] = useState(() => list.map((i) => ({ ...i, text: headerLines(i.headers) })));
  useEffect(() => setEdit(list.map((i) => ({ ...i, text: headerLines(i.headers) }))), [list]);
  const save = () =>
    client.setIdentities(edit.map(({ text, ...i }) => ({ ...i, headers: parseHeaderLines(text) }))).then(
      (l) => {
        onChange(l);
        notify(`Saved ${l.length} identities`);
      },
      (e: Error) => notify(e.message),
    );
  return (
    <div className="card" style={{ margin: 12 }} aria-label="Identities">
      <div className="sec-head" style={{ padding: '0 0 6px' }}>
        <b style={{ color: 'var(--text)' }}>Identities</b>
        <span>Who to try each request as. Headers replace the original ones; tokens such as {'{{flow:login-bob.token}}'} log in fresh each run.</span>
      </div>
      {edit.map((i, n) => (
        <div key={n} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
          <input className="input mono" style={{ width: 140 }} value={i.name} onChange={(e) => setEdit(edit.map((x, k) => (k === n ? { ...x, name: e.target.value } : x)))} aria-label={`Identity ${n + 1} name`} />
          <textarea
            className="input mono"
            style={{ flex: 1, height: 40, padding: 6 }}
            placeholder="Authorization: Bearer ..."
            value={i.text}
            onChange={(e) => setEdit(edit.map((x, k) => (k === n ? { ...x, text: e.target.value } : x)))}
            aria-label={`Identity ${n + 1} headers`}
          />
          <label className="check" title="Remove the original auth headers and cookies first">
            <input type="checkbox" checked={!!i.anonymous} onChange={(e) => setEdit(edit.map((x, k) => (k === n ? { ...x, anonymous: e.target.checked } : x)))} /> Strip auth
          </label>
          <button className="btn small" onClick={() => setEdit(edit.filter((_, k) => k !== n))} aria-label={`Remove identity ${i.name}`}>
            Remove
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn small" onClick={() => setEdit([...edit, { name: `user ${edit.length + 1}`, headers: [], text: '', anonymous: false }])}>
          Add identity
        </button>
        <button className="btn small primary" onClick={() => void save()}>
          Save identities
        </button>
      </div>
    </div>
  );
}

const VERDICT: Record<string, string> = { same: 'same data', allowed: 'allowed', denied: 'denied', 'not-found': 'not found', error: 'error', other: 'other' };

export function AuthAndNegative() {
  const { client, notify, apiInput, selectedId } = useApp();
  const inspect = useInspect();
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [ids, setIds] = useState<string[]>([]);
  const [rows, setRows] = useState<ExchangeSummary[]>([]);
  const [filter, setFilter] = useState('');
  const [matrix, setMatrix] = useState<AuthRow[] | null>(null);
  const [negFor, setNegFor] = useState<string | null>(null);
  const [neg, setNeg] = useState<NegativeResult[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [insecure, setInsecure] = useState(false);

  useEffect(() => void client.identities().then(setIdentities, () => undefined), [client]);
  useEffect(() => {
    if (!apiInput || apiInput.kind === 'compare') return;
    if (apiInput.kind === 'auth') setIds((cur) => [...new Set([...cur, ...apiInput.ids])]);
    else setNegFor(apiInput.ids[0] ?? null);
  }, [apiInput]);
  useEffect(() => {
    if (!negFor && selectedId) setNegFor(selectedId);
  }, [negFor, selectedId]);
  useEffect(() => {
    const all = [...new Set([...ids, ...(negFor ? [negFor] : [])])];
    Promise.all(all.map((id) => client.get(id).catch(() => null))).then((l) => setRows(l.filter((x): x is NonNullable<typeof x> => !!x)));
  }, [client, ids, negFor]);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const addFiltered = async () => {
    const found = await client.search(filter, { limit: 50 });
    setIds([...new Set([...ids, ...found.filter((e) => !e.isWebSocket).map((e) => e.id)])]);
  };
  const runMatrix = async () => {
    setBusy('auth');
    try {
      setMatrix((await client.authMatrix(ids, undefined, insecure)).rows);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const runNeg = async () => {
    if (!negFor) return;
    setBusy('neg');
    try {
      setNeg((await client.negativeTests(negFor, undefined, insecure)).results);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const label = (id: string) => {
    const r = byId.get(id);
    return r ? `${r.method} ${r.path.split('?')[0]}` : id.slice(0, 8);
  };

  return (
    <div className="api-pane" aria-label="Auth and negative tests">
      <div className="api-scroll">
        <Identities list={identities} onChange={setIdentities} />

        <div className="card" style={{ margin: '0 12px 8px' }} aria-label="Auth matrix">
          <div className="sec-head" style={{ padding: '0 0 6px' }}>
            <b style={{ color: 'var(--text)' }}>Auth matrix</b>
            <span>Each request is sent again as every identity. "Same data" for another user or no auth is a likely access control bug.</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="input mono" style={{ flex: '1 1 260px' }} placeholder="Add requests matching a History filter, e.g. path:/api/orders/ method:GET" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Auth matrix filter" />
            <button className="btn small" disabled={!filter.trim()} onClick={() => void addFiltered()}>
              Add matching
            </button>
            <button className="btn small" disabled={!ids.length} onClick={() => (setIds([]), setMatrix(null))}>
              Clear
            </button>
            <label className="check">
              <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} /> Ignore TLS errors
            </label>
            <button className="btn small primary" disabled={!ids.length || busy !== null} onClick={() => void runMatrix()}>
              {busy === 'auth' ? 'Sending...' : `Run for ${ids.length} ${ids.length === 1 ? 'request' : 'requests'}`}
            </button>
          </div>
          {!matrix && ids.length > 0 && (
            <div className="faint mono" style={{ fontSize: 12, marginTop: 6 }}>
              {ids.map(label).join(' · ')}
            </div>
          )}
          {!ids.length && <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Right-click a request in History and choose Try as other users, or add requests by filter.</div>}
          {matrix && (
            <table className="data-table matrix" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Original</th>
                  {matrix[0]?.cells.map((c) => <th key={c.identity}>{c.identity}</th>)}
                </tr>
              </thead>
              <tbody>
                {matrix.map((r) => (
                  <tr key={r.exchangeId} className={r.flagged ? 'flagged' : undefined}>
                    <td className="mono">
                      {r.flagged && <span className="chip chip-bad" style={{ marginRight: 6 }}>check</span>}
                      {r.method} {r.endpoint}
                    </td>
                    <td className="mono">{r.status ?? ''}</td>
                    {r.cells.map((c) => (
                      <td key={c.identity} className={`v-${c.verdict}`} title={c.error ?? `${Math.round(c.similarity * 100)}% similar to the original`}>
                        <button className="sample" disabled={!c.exchangeId} onClick={() => c.exchangeId && inspect(c.exchangeId)}>
                          {c.status ?? 'failed'} {VERDICT[c.verdict]}
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card" style={{ margin: '0 12px 8px' }} aria-label="Negative tests">
          <div className="sec-head" style={{ padding: '0 0 6px' }}>
            <b style={{ color: 'var(--text)' }}>Negative tests</b>
            <span>Broken variants of one request: wrong types, missing and extra fields, huge and special values, other ids. Uses the API file's schema when there is one.</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="mono">{negFor ? label(negFor) : <span className="faint">Select a request in History, or right-click it and choose Run negative tests.</span>}</span>
            <span style={{ flex: 1 }} />
            <button className="btn small primary" disabled={!negFor || busy !== null} onClick={() => void runNeg()}>
              {busy === 'neg' ? 'Sending...' : 'Run negative tests'}
            </button>
          </div>
          {neg && (
            <>
              <div className="faint" style={{ fontSize: 12, margin: '6px 0' }}>
                {neg.length} cases: {neg.filter((n) => n.verdict === 'server-error').length} server errors, {neg.filter((n) => n.verdict === 'accepted').length} accepted, {neg.filter((n) => n.verdict === 'rejected').length} rejected
              </div>
              <table className="data-table">
                <tbody>
                  {[...neg]
                    .sort((a, b) => ['server-error', 'accepted', 'failed', 'rejected'].indexOf(a.verdict) - ['server-error', 'accepted', 'failed', 'rejected'].indexOf(b.verdict))
                    .map((n, i) => (
                      <tr key={i}>
                        <td>
                          <span className={`chip ${n.verdict === 'server-error' ? 'chip-bad' : n.verdict === 'accepted' ? 'chip-warn' : n.verdict === 'rejected' ? 'chip-good' : ''}`}>{n.verdict}</span>
                        </td>
                        <td className="mono">{n.status ?? ''}</td>
                        <td>{n.name}</td>
                        <td className="mono faint">{n.target}</td>
                        <td className="mono faint" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={n.excerpt}>
                          {n.error ?? n.excerpt}
                        </td>
                        <td>
                          {n.exchangeId && (
                            <>
                              <button className="btn small" onClick={() => inspect(n.exchangeId!)}>
                                Inspect
                              </button>{' '}
                              <ReplayButton id={n.exchangeId!} compact />
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Compare two exchanges ----------

function JsonChanges({ changes }: { changes: ExchangeDiff['request']['json'] }) {
  if (!changes) return null;
  if (!changes.length) return <div className="faint">Bodies are the same.</div>;
  return (
    <table className="data-table">
      <tbody>
        {changes.map((c, i) => (
          <tr key={i}>
            <td className="diff-path">{c.path}</td>
            <td className="faint">{c.kind}</td>
            <td className="diff-before">{show(c.before)}</td>
            <td className="diff-after">{show(c.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HeaderChanges({ list }: { list: Array<{ name: string; before?: string; after?: string }> }) {
  if (!list.length) return <div className="faint">Same.</div>;
  return (
    <table className="data-table">
      <tbody>
        {list.map((h) => (
          <tr key={h.name}>
            <td className="mono">{h.name}</td>
            <td className="diff-before">{h.before ?? '(none)'}</td>
            <td className="diff-after">{h.after ?? '(none)'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SideDiffView({ title, d }: { title: string; d: ExchangeDiff['request'] }) {
  const text = d.json === null && d.textA !== null && d.textB !== null && d.textA !== d.textB ? diffLines(d.textA, d.textB).filter((l) => l.op !== '=') : null;
  return (
    <section style={{ padding: '6px 12px' }} aria-label={`${title} differences`}>
      <div className="panel-title">{title}</div>
      <div className="label">Headers</div>
      <HeaderChanges list={d.headers} />
      <div className="label" style={{ marginTop: 6 }}>
        Body
      </div>
      {d.json !== null ? (
        <JsonChanges changes={d.json} />
      ) : text ? (
        <pre className="raw">
          {text.slice(0, 400).map((l, i) => (
            <div key={i} className={l.op === '+' ? 'diff-after' : 'diff-before'}>
              {l.op} {l.text}
            </div>
          ))}
        </pre>
      ) : (
        <div className="faint">{d.textA === null || d.textB === null ? 'Binary bodies; compare in Codecs.' : 'Same.'}</div>
      )}
    </section>
  );
}

export function Compare() {
  const { client, notify, apiInput, compareMark } = useApp();
  const inspect = useInspect();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [diff, setDiff] = useState<ExchangeDiff | null>(null);
  const run = useCallback((x: string, y: string) => client.diffExchanges(x, y).then(setDiff, (e: Error) => notify(e.message)), [client, notify]);
  useEffect(() => {
    if (apiInput?.kind === 'compare' && apiInput.ids.length === 2) {
      setA(apiInput.ids[0]!);
      setB(apiInput.ids[1]!);
      void run(apiInput.ids[0]!, apiInput.ids[1]!);
    }
  }, [apiInput, run]);
  useEffect(() => {
    if (!a && compareMark) setA(compareMark);
  }, [a, compareMark]);
  return (
    <div className="api-pane" aria-label="Compare">
      <div className="filterbar">
        <input className="input mono" placeholder="First exchange id" value={a} onChange={(e) => setA(e.target.value)} aria-label="First exchange" style={{ flex: 1 }} />
        <input className="input mono" placeholder="Second exchange id" value={b} onChange={(e) => setB(e.target.value)} aria-label="Second exchange" style={{ flex: 1 }} />
        <button className="btn small primary" disabled={!a || !b} onClick={() => void run(a.trim(), b.trim())}>
          Compare
        </button>
      </div>
      <div className="api-scroll">
        {!diff && <div className="empty">In History, right-click a request and choose Mark to compare, then right-click another and choose Compare with the marked request.</div>}
        {diff && (
          <>
            <div className="card" style={{ margin: 12 }}>
              {[diff.a, diff.b].map((x, i) => (
                <div key={x.id} className="origin-row">
                  <span className="faint">{i === 0 ? 'A' : 'B'}</span>
                  <span className={`mono m-${x.method}`}>{x.method}</span>
                  <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {x.url}
                  </span>
                  <span className="mono">{x.status ?? ''}</span>
                  <button className="btn small" onClick={() => inspect(x.id)}>
                    Inspect
                  </button>
                  <ReplayButton id={x.id} compact />
                </div>
              ))}
              {diff.query.length > 0 && (
                <>
                  <div className="label">Query parameters</div>
                  <HeaderChanges list={diff.query} />
                </>
              )}
            </div>
            <div className="two-col">
              <SideDiffView title="Request" d={diff.request} />
              <SideDiffView title="Response" d={diff.response} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
