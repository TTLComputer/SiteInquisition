import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiFlow, ApiSpec, FlowDraft, FlowRunResult, HeaderList, SiteMapHost, ValueField, ValueOrigin } from '../api';
import { useApp } from '../state';
import { Icon } from '../components/icons';
import { downloadText, fmtMs, fmtTime } from '../format';
import { ContractScan, useHosts } from './ApiExtras';
import { ReplayButton } from '../components/ReplayButton';


const copy = (text: string, notify: (m: string) => void, what = 'Copied') =>
  navigator.clipboard.writeText(text).then(
    () => notify(`${what}: ${text.length > 60 ? `${text.slice(0, 60)}...` : text}`),
    () => notify('Could not copy'),
  );

/** "{{pick:...}}" for a catalog field. */
export const pickToken = (f: Pick<ValueField, 'method' | 'template' | 'side' | 'path'>, kind: 'pick' | 'each' = 'pick') =>
  `{{${kind}:${f.method} ${f.template}${f.side === 'request' ? ' req' : ''} ${f.path}}}`;

// ---------- Values ----------

export function Values() {
  const { client, notify, select, setView, traceInput } = useApp();
  const hosts = useHosts();
  const [host, setHost] = useState('');
  const [filter, setFilter] = useState('');
  const [idOnly, setIdOnly] = useState(true);
  const [fields, setFields] = useState<ValueField[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [trace, setTrace] = useState('');
  const [origins, setOrigins] = useState<ValueOrigin[] | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    client
      .values({ host: host || undefined })
      .then(setFields, (e: Error) => notify(e.message))
      .finally(() => setLoading(false));
  }, [client, host, notify]);
  useEffect(load, [load]);

  const runTrace = useCallback(
    (v: string, beforeId?: string) => {
      if (!v.trim()) return;
      client.valueOrigin(v.trim(), beforeId).then(setOrigins, (e: Error) => notify(e.message));
    },
    [client, notify],
  );
  useEffect(() => {
    if (traceInput) {
      setTrace(traceInput.value);
      runTrace(traceInput.value, traceInput.beforeId);
    }
  }, [traceInput, runTrace]);

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    return (fields ?? []).filter((x) => (!idOnly || x.idLike) && (!f || `${x.method} ${x.template} ${x.path} ${x.samples.join(' ')}`.toLowerCase().includes(f))).slice(0, 500);
  }, [fields, filter, idOnly]);

  const inspect = (id: string) => {
    select(id);
    setView('history');
  };

  return (
    <div className="api-pane" aria-label="Values">
      <div className="filterbar">
        <label className="check">
          Host
          <select className="input" value={host} onChange={(e) => setHost(e.target.value)} aria-label="Values host">
            <option value="">all hosts</option>
            {hosts.map((h) => (
              <option key={h.host} value={h.host}>
                {h.host}
              </option>
            ))}
          </select>
        </label>
        <input className="input" placeholder="Filter fields or values" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter values" style={{ flex: '1 1 200px' }} />
        <label className="check" title="Fields named like id, sku, number, code, or whose values look like ids">
          <input type="checkbox" checked={idOnly} onChange={(e) => setIdOnly(e.target.checked)} /> Ids and numbers only
        </label>
        <button className="btn small" onClick={load} disabled={loading}>
          {loading ? 'Scanning...' : 'Rescan'}
        </button>
      </div>
      <div className="trace-bar">
        <span className="panel-title">Where did this come from?</span>
        <input
          className="input mono"
          placeholder="Paste a value seen in a request: an id, a token, an order number"
          value={trace}
          onChange={(e) => setTrace(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runTrace(trace)}
          aria-label="Value to trace"
          style={{ flex: 1 }}
        />
        <button className="btn small" onClick={() => runTrace(trace)}>
          Trace
        </button>
      </div>
      {origins && (
        <div className="card origin-list" aria-label="Value origins" style={{ margin: '0 12px 8px' }}>
          {origins.length === 0 ? (
            <div className="faint">No earlier response contains {trace}. The client made it up, or it came from somewhere not recorded.</div>
          ) : (
            origins.map((o, i) => (
              <div key={o.exchangeId} className="origin-row">
                <span className="faint">{i === 0 ? 'First seen in' : 'Also in'}</span>
                <span className={`mono m-${o.method}`}>{o.method}</span>
                <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {o.url}
                </span>
                <span className="mono chip">{o.where === 'json' ? o.at : o.where === 'header' ? `header ${o.at}` : 'body text'}</span>
                <span className="faint">{fmtTime(o.startedAt)}</span>
                <button className="btn small" onClick={() => inspect(o.exchangeId)}>
                  Inspect
                </button>
                <ReplayButton id={o.exchangeId} compact />
              </div>
            ))
          )}
        </div>
      )}
      {fields && (
        <div className="api-scroll">
          <div className="faint" style={{ padding: '4px 12px 8px', fontSize: 12 }}>
            {shown.length} of {fields.length} fields. Click a value to copy it, or copy a token that always uses the newest recorded value.
          </div>
          <table className="data-table values-table">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Field</th>
                <th>Values seen</th>
                <th>Count</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((f) => (
                <tr key={`${f.method} ${f.template} ${f.side} ${f.path}`}>
                  <td className="mono">
                    <span className={`m-${f.method}`}>{f.method}</span> {f.template}
                  </td>
                  <td className="mono">
                    {f.path}
                    {f.side === 'request' && <span className="chip" style={{ marginLeft: 6 }}>sent</span>}
                  </td>
                  <td className="samples">
                    {f.samples.slice(0, 6).map((s) => (
                      <button key={s} className="sample" title="Copy this value" onClick={() => void copy(s, notify)}>
                        {s.length > 28 ? `${s.slice(0, 28)}...` : s}
                      </button>
                    ))}
                    {f.distinct > 6 && <span className="faint">+{f.distinct - 6}</span>}
                  </td>
                  <td className="mono">{f.count}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small" title="A token for the newest recorded value of this field" onClick={() => void copy(pickToken(f), notify, 'Token copied')}>
                      Copy token
                    </button>{' '}
                    <button className="btn small" title="A batch token: one send per value in the newest response" onClick={() => void copy(pickToken(f, 'each'), notify, 'Token copied')}>
                      Each
                    </button>{' '}
                    <button className="btn small" onClick={() => inspect(f.lastExchangeId)}>
                      Example
                    </button>{' '}
                    <ReplayButton id={f.lastExchangeId} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Flows ----------

type EditStep = ApiFlow['steps'][number] & { raw?: string };

function stepRaw(s: EditStep): string {
  return `${s.method ?? 'GET'} ${s.url ?? ''}\n${(s.headers ?? []).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${s.body ?? ''}`;
}

/** Like parseRawRequest, but the URL may be all tokens. */
function parseStepRaw(raw: string): { method: string; url: string; headers: HeaderList; body?: string } {
  const text = raw.replace(/\r\n/g, '\n');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : text.slice(split + 2);
  const [line = '', ...rest] = head.split('\n');
  const m = /^([A-Za-z]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/.exec(line.trim());
  if (!m) throw new Error('The first line must look like: POST https://host/path');
  const headers: HeaderList = rest
    .filter((l) => l.trim())
    .map((l) => {
      const i = l.indexOf(':', l.startsWith(':') ? 1 : 0);
      if (i <= 0) throw new Error(`Header line needs "Name: value": ${l}`);
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string];
    });
  return { method: m[1]!.toUpperCase(), url: m[2]!, headers, body: body || undefined };
}

const blankFlow = (): Partial<ApiFlow> & { steps: EditStep[] } => ({
  name: 'new-flow',
  steps: [{ id: `s${Date.now()}`, kind: 'request', method: 'POST', url: 'https://', headers: [], extract: [] }],
});

function FlowEditor({ flow, onSaved, onDeleted, draft }: { flow: Partial<ApiFlow> & { steps: EditStep[] }; onSaved(f: ApiFlow): void; onDeleted(): void; draft?: FlowDraft | null }) {
  const { client, notify, select, setView } = useApp();
  const [f, setF] = useState(flow);
  const [raws, setRaws] = useState<string[]>(() => flow.steps.map(stepRaw));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<FlowRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setF(flow);
    setRaws(flow.steps.map(stepRaw));
    setResult(null);
    setError(null);
  }, [flow]);

  const patchStep = (i: number, p: Partial<EditStep>) => setF({ ...f, steps: f.steps.map((s, k) => (k === i ? { ...s, ...p } : s)) });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= f.steps.length) return;
    const steps = [...f.steps];
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    const r = [...raws];
    [r[i], r[j]] = [r[j]!, r[i]!];
    setF({ ...f, steps });
    setRaws(r);
  };
  const add = (kind: 'request' | 'script') => {
    const s: EditStep = kind === 'request' ? { id: `s${Date.now()}`, kind, method: 'GET', url: f.steps.find((x) => x.url)?.url ?? 'https://', headers: [], extract: [] } : { id: `s${Date.now()}`, kind, code: '// vars holds this flow\'s variables\nvars.ref = \'PO-\' + vars.po' };
    setF({ ...f, steps: [...f.steps, s] });
    setRaws([...raws, stepRaw(s)]);
  };
  const remove = (i: number) => {
    setF({ ...f, steps: f.steps.filter((_, k) => k !== i) });
    setRaws(raws.filter((_, k) => k !== i));
  };

  const build = (): Partial<ApiFlow> => ({
    ...f,
    steps: f.steps.map((s, i) => {
      if (s.kind === 'script') return { id: s.id, name: s.name, kind: 'script', code: s.code ?? '' };
      const p = parseStepRaw(raws[i] ?? '');
      return { id: s.id, name: s.name, kind: 'request', ...p, extract: (s.extract ?? []).filter((e) => e.name && e.from), expect: s.expect || undefined, tag: s.tag || undefined, bodyChain: s.bodyChain?.length ? s.bodyChain : undefined };
    }),
  });

  const save = async () => {
    try {
      const saved = await client.saveFlow(build());
      setError(null);
      notify(`Saved flow "${saved.name}"`);
      onSaved(saved);
      return saved;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };
  const run = async () => {
    const saved = await save();
    if (!saved) return;
    setRunning(true);
    try {
      setResult(await client.runFlow(saved.name));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const del = async () => {
    if (!f.id) return onDeleted();
    const all = await client.flows();
    await client.setFlows(all.filter((x) => x.id !== f.id));
    notify(`Deleted flow "${f.name}"`);
    onDeleted();
  };
  // Extracted names, plus anything a script step set on the last run.
  const outVars = [...new Set([...f.steps.flatMap((s) => (s.extract ?? []).map((e) => e.name)), ...Object.keys(result?.vars ?? {})].filter(Boolean))];

  return (
    <div className="flow-editor" aria-label="Flow editor">
      <div className="replay-bar">
        <input className="input mono" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Flow name" style={{ width: 200 }} />
        <input className="input" placeholder="What it sets up" value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} aria-label="Flow description" style={{ flex: 1 }} />
        <button className="btn small" onClick={() => void del()}>
          Delete
        </button>
        <button className="btn small" onClick={() => void save()}>
          Save
        </button>
        <button
          className="btn small"
          disabled={!f.id}
          title="Download as a Postman v2.1 collection, with test scripts that pass each value on"
          onClick={() =>
            void client.exportPostman({ flow: f.name }).then(
              (c) => {
                downloadText(`${f.name}.postman_collection.json`, JSON.stringify(c, null, 2));
                notify('Exported as a Postman collection');
              },
              (e: Error) => notify(e.message),
            )
          }
        >
          Export Postman
        </button>
        <button
          className="btn small"
          disabled={!f.id}
          title="Save a test script that runs this flow and checks every step; run it after each deploy in the Script console"
          onClick={() => void client.flowToTest(f.name!).then((sc) => notify(`Saved test script "${sc.name}". Run it in Advanced tools, Script console.`), (e: Error) => notify(e.message))}
        >
          Make test
        </button>
        <button className="btn primary" onClick={() => void run()} disabled={running}>
          {running ? 'Running...' : 'Save and run'}
        </button>
      </div>
      <div className="replay-options">
        <label className="check" title="After a successful run, copy its variables into project variables ({{var:name}} everywhere)">
          <input type="checkbox" checked={!!f.saveVars} onChange={(e) => setF({ ...f, saveVars: e.target.checked })} /> Save variables to the project
        </label>
        <label className="check" title="Run this flow when a send with 'Log in on 401/403' gets refused by this host">
          Log in for host
          <input
            className="input mono"
            placeholder="none"
            value={f.onAuthFail?.host ?? ''}
            onChange={(e) => setF({ ...f, onAuthFail: e.target.value ? { host: e.target.value } : undefined })}
            aria-label="Login flow host"
            style={{ width: 180 }}
          />
        </label>
        <span style={{ flex: 1 }} />
        {outVars.length > 0 && (
          <span className="faint" style={{ fontSize: 12 }}>
            Use in any request:{' '}
            {outVars.map((v) => (
              <button key={v} className="sample mono" onClick={() => void copy(`{{flow:${f.name}.${v}}}`, notify, 'Token copied')} title="Runs the flow for each send and uses this variable">
                {`{{flow:${f.name}.${v}}}`}
              </button>
            ))}
          </span>
        )}
      </div>
      {error && (
        <div className="banner" role="alert" style={{ margin: 8 }}>
          {error}
        </div>
      )}
      {draft && (draft.wiring.length > 0 || draft.generated.length > 0) && (
        <div className="card" aria-label="Wiring" style={{ margin: '8px 12px' }}>
          <div className="panel-title">Wired automatically. Check it, then save.</div>
          {draft.wiring.map((w) => (
            <div key={`${w.variable}-${w.toStep}`} className="mono" style={{ fontSize: 12 }}>
              step {w.fromStep + 1} <span className="faint">{w.from}</span> → <b>{`{{var:${w.variable}}}`}</b> → step {w.toStep + 1} <span className="faint">{w.usedIn.join(', ')}</span> <span className="faint">(was {w.value})</span>
            </div>
          ))}
          {draft.generated.map((g) => (
            <div key={`${g.step}-${g.value}`} className="mono" style={{ fontSize: 12 }}>
              step {g.step + 1}: {g.value} → <b>{g.token}</b> <span className="faint">(made up by the client, so fresh each run)</span>
            </div>
          ))}
        </div>
      )}
      <div className="flow-steps">
        {f.steps.map((s, i) => {
          const r = result?.steps.find((x) => x.index === i);
          return (
            <div key={s.id ?? i} className={`card flow-step${r?.error ? ' failed' : r ? ' passed' : ''}`} aria-label={`Step ${i + 1}`}>
              <div className="race-item-head">
                <span className="mono faint">#{i + 1}</span>
                <input className="input" placeholder={s.kind === 'script' ? 'Script' : 'Step name'} value={s.name ?? ''} onChange={(e) => patchStep(i, { name: e.target.value })} aria-label={`Step ${i + 1} name`} style={{ flex: 1 }} />
                {s.kind === 'request' && (
                  <>
                    <label className="check" title="Fail the flow unless the status matches: 2xx, 201, or 200,201">
                      Expect
                      <input className="input mono" value={s.expect ?? ''} placeholder="any" onChange={(e) => patchStep(i, { expect: e.target.value })} aria-label={`Step ${i + 1} expected status`} style={{ width: 70 }} />
                    </label>
                    <label className="check" title="Move this tag onto the step's exchange each run, so {{$tag.field}} follows the newest one">
                      Tag
                      <input className="input mono" value={s.tag ?? ''} placeholder="none" onChange={(e) => patchStep(i, { tag: e.target.value })} aria-label={`Step ${i + 1} tag`} style={{ width: 110 }} />
                    </label>
                    <label className="check" title="Write the body decoded; it is encoded with this chain after tokens are filled in, e.g. base64,json">
                      Encode
                      <input
                        className="input mono"
                        value={(s.bodyChain ?? []).join(',')}
                        placeholder="none"
                        onChange={(e) => patchStep(i, { bodyChain: e.target.value.split(/[,>\s]+/).filter(Boolean) })}
                        aria-label={`Step ${i + 1} body encoding`}
                        style={{ width: 110 }}
                      />
                    </label>
                  </>
                )}
                <button className="icon-btn" aria-label={`Move step ${i + 1} up`} onClick={() => move(i, -1)}>
                  <Icon name="up" size={13} />
                </button>
                <button className="icon-btn" aria-label={`Move step ${i + 1} down`} onClick={() => move(i, 1)}>
                  <Icon name="down" size={13} />
                </button>
                <button className="icon-btn" aria-label={`Remove step ${i + 1}`} onClick={() => remove(i)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
              {s.kind === 'script' ? (
                <textarea className="editor" style={{ height: 110 }} spellCheck={false} value={s.code ?? ''} onChange={(e) => patchStep(i, { code: e.target.value })} aria-label={`Step ${i + 1} script`} />
              ) : (
                <>
                  <textarea
                    className="editor"
                    style={{ height: 130 }}
                    spellCheck={false}
                    value={raws[i] ?? ''}
                    onChange={(e) => setRaws(raws.map((x, k) => (k === i ? e.target.value : x)))}
                    aria-label={`Step ${i + 1} request`}
                  />
                  <div className="extract-rows">
                    <span className="faint" style={{ fontSize: 12 }}>
                      Keep from the response:
                    </span>
                    {(s.extract ?? []).map((e, k) => (
                      <span key={k} className="extract-row">
                        <input className="input mono" value={e.name} placeholder="variable" onChange={(ev) => patchStep(i, { extract: s.extract!.map((x, j) => (j === k ? { ...x, name: ev.target.value } : x)) })} aria-label={`Step ${i + 1} variable ${k + 1}`} style={{ width: 110 }} />
                        <span className="faint">from</span>
                        <input
                          className="input mono"
                          value={e.from}
                          placeholder="$.order.number, number, header.Location"
                          onChange={(ev) => patchStep(i, { extract: s.extract!.map((x, j) => (j === k ? { ...x, from: ev.target.value } : x)) })}
                          aria-label={`Step ${i + 1} variable ${k + 1} source`}
                          style={{ width: 200 }}
                        />
                        {r?.extracted[e.name] !== undefined && <span className="mono s-2">= {r.extracted[e.name]}</span>}
                        <button className="icon-btn" aria-label={`Remove variable ${k + 1} of step ${i + 1}`} onClick={() => patchStep(i, { extract: s.extract!.filter((_, j) => j !== k) })}>
                          <Icon name="close" size={12} />
                        </button>
                      </span>
                    ))}
                    <button className="btn small" onClick={() => patchStep(i, { extract: [...(s.extract ?? []), { name: '', from: '' }] })}>
                      Add variable
                    </button>
                  </div>
                </>
              )}
              {r && (
                <div className="flow-result">
                  <span className={r.error ? 's-err' : 's-2'}>{r.error ?? 'ok'}</span>
                  {r.status !== null && <span className="mono">{r.status}</span>}
                  <span className="faint">{fmtMs(r.ms)}</span>
                  {r.exchangeId && (
                    <button
                      className="btn small"
                      onClick={() => {
                        select(r.exchangeId!);
                        setView('history');
                      }}
                    >
                      Inspect
                    </button>
                  )}
                  {r.exchangeId && <ReplayButton id={r.exchangeId} compact />}
                  {(r.logs ?? []).map((l, k) => (
                    <span key={k} className="mono faint">
                      {l.text}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn small" onClick={() => add('request')}>
            <Icon name="plus" size={12} /> Request step
          </button>
          <button className="btn small" onClick={() => add('script')}>
            <Icon name="plus" size={12} /> Script step
          </button>
        </div>
      </div>
      {result && (
        <div className="card" aria-label="Flow result" style={{ margin: '8px 12px' }}>
          <div className="sec-head">
            <b className={result.ok ? 's-2' : 's-err'}>{result.ok ? 'Flow ran' : 'Flow failed'}</b>
            <span>{fmtMs(result.ms)}</span>
            {result.error && <span className="s-err">{result.error}</span>}
          </div>
          {Object.entries(result.vars).map(([k, v]) => (
            <div key={k} className="mono" style={{ fontSize: 12 }}>
              {k} = <b>{v}</b>{' '}
              <button className="btn small" onClick={() => void copy(`{{flow:${f.name}.${k}}}`, notify, 'Token copied')} title="A token that runs this flow for each send and uses this value">
                Copy token
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Flows() {
  const { client, notify, flowPicks, setFlowPicks } = useApp();
  const [flows, setFlows] = useState<ApiFlow[]>([]);
  const [current, setCurrent] = useState<(Partial<ApiFlow> & { steps: EditStep[] }) | null>(null);
  const [draft, setDraft] = useState<FlowDraft | null>(null);
  const load = useCallback(() => client.flows().then(setFlows, () => undefined), [client]);
  useEffect(() => void load(), [load]);

  const makeFromPicks = async () => {
    try {
      const d = await client.draftFlow(flowPicks, 'recorded-flow');
      setDraft(d);
      setCurrent(d.flow as Partial<ApiFlow> & { steps: EditStep[] });
      setFlowPicks([]);
      notify(`Made a ${d.flow.steps.length}-step flow with ${d.wiring.length} values wired`);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  return (
    <div className="api-split" aria-label="Flows">
      <aside className="flow-list">
        <button className="btn small" onClick={() => (setDraft(null), setCurrent(blankFlow()))}>
          <Icon name="plus" size={12} /> New flow
        </button>
        <button className="btn small primary" disabled={!flowPicks.length} onClick={() => void makeFromPicks()} title="Pick requests in Traffic (right-click, Add to flow) and turn them into a flow">
          Make flow from {flowPicks.length} picked
        </button>
        {flowPicks.length > 0 && (
          <button className="btn small" onClick={() => setFlowPicks([])}>
            Clear picks
          </button>
        )}
        <div className="nav-heading">Saved flows</div>
        {flows.map((fl) => (
          <button key={fl.id} className="saved-view" aria-current={current?.id === fl.id ? 'true' : undefined} onClick={() => (setDraft(null), setCurrent(fl as ApiFlow & { steps: EditStep[] }))}>
            <span className="mono">{fl.name}</span>
            <span className="faint" style={{ fontSize: 11 }}>
              {fl.steps.length} steps{fl.onAuthFail ? ` · logs in for ${fl.onAuthFail.host}` : ''}
            </span>
          </button>
        ))}
        {!flows.length && (
          <div className="faint" style={{ fontSize: 12, padding: 6 }}>
            A flow is setup you repeat: log in, make a cart, create a PO. Requests use its values with {'{{flow:name.var}}'}, and every send gets a fresh run.
          </div>
        )}
      </aside>
      {current ? (
        <FlowEditor
          flow={current}
          draft={draft}
          onSaved={(saved) => {
            void load();
            setCurrent(saved as ApiFlow & { steps: EditStep[] });
          }}
          onDeleted={() => {
            setCurrent(null);
            void load();
          }}
        />
      ) : (
        <div className="empty">
          <div className="panel-title">Pick a flow, or make one</div>
          <div style={{ maxWidth: 520 }}>The quickest way: do the steps by hand in the browser, pick those requests in Traffic (right-click, Add to flow), then Make flow. Values passed from one response to the next request are wired for you.</div>
        </div>
      )}
    </div>
  );
}

// ---------- API files ----------

export function Specs() {
  const { client, notify, openDraft, refreshInfo } = useApp();
  const [specs, setSpecs] = useState<ApiSpec[]>([]);
  const [text, setText] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(
    () =>
      client.specs().then((list) => {
        setSpecs(list);
        // With a single API file, show its endpoints straight away.
        setOpen((o) => o ?? (list.length === 1 ? list[0]!.id : null));
      }, () => undefined),
    [client],
  );
  useEffect(() => void load(), [load]);

  const doImport = async (body: string, name?: string) => {
    try {
      let isHar = false;
      try {
        const j = JSON.parse(body) as { log?: { entries?: unknown } };
        isHar = Array.isArray(j?.log?.entries);
      } catch {
        // YAML
      }
      if (isHar) {
        const r = await client.importHar(body, name ? `har:${name}` : 'har');
        notify(`Added ${r.imported} requests to Traffic${r.skipped ? `, skipped ${r.skipped}` : ''}`);
        refreshInfo();
      } else {
        const s = await client.importSpec(body, name);
        notify(`Imported ${s.name}: ${s.endpoints.length} endpoints${s.warnings.length ? ` (${s.warnings.length} warnings)` : ''}`);
        setOpen(s.id);
        await load();
      }
      setText('');
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const openEndpoint = async (s: ApiSpec, key: string) => {
    try {
      const r = await client.specRequest(s.id, key);
      openDraft({ method: r.method, url: r.url, headers: r.headers, body: r.body }, key.split('#')[0]!.split(' ').pop()!.split('/').filter(Boolean).pop() ?? key);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  return (
    <div className="api-pane" aria-label="API files">
      <div className="card" style={{ margin: 12 }}>
        <div className="sec-head">
          <b style={{ color: 'var(--text)' }}>Import</b>
          <span>OpenAPI 3, Swagger 2 (JSON or YAML), Postman v2.1 collections, or a HAR file (added to Traffic)</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea className="editor" style={{ height: 90, flex: 1 }} placeholder="Paste a spec, a collection or a HAR file here" value={text} onChange={(e) => setText(e.target.value)} aria-label="Spec text" spellCheck={false} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button className="btn primary" disabled={!text.trim()} onClick={() => void doImport(text)}>
              Import
            </button>
            <button className="btn small" onClick={() => fileRef.current?.click()}>
              Choose file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.yaml,.yml,.har,.txt"
              style={{ display: 'none' }}
              aria-label="Spec file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void file.text().then((t) => doImport(t, file.name.replace(/\.[^.]+$/, '')));
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </div>
      <div className="api-scroll">
        {specs.some((s) => s.format !== 'graphql') && <ContractScan />}
        {specs.map((s) => {
          const f = filter.toLowerCase();
          const eps = s.endpoints.filter((e) => !f || `${e.key} ${e.summary ?? ''} ${e.tags.join(' ')}`.toLowerCase().includes(f));
          return (
            <div key={s.id} className="card spec-card" style={{ margin: '0 12px 8px' }}>
              <div className="race-item-head">
                <button className="btn small" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
                  {open === s.id ? 'Hide' : 'Show'}
                </button>
                <b>{s.name}</b>
                <span className="chip">{s.format === 'openapi3' ? 'OpenAPI 3' : s.format === 'swagger2' ? 'Swagger 2' : s.format === 'graphql' ? 'GraphQL' : 'Postman'}</span>
                {s.version && <span className="faint">v{s.version}</span>}
                <span className="faint">{s.endpoints.length} endpoints</span>
                <span className="mono faint" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.servers.join(', ') || 'any host'}
                </span>
                <button
                  className="icon-btn"
                  aria-label={`Delete ${s.name}`}
                  onClick={() => void client.deleteSpec(s.id).then(load)}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
              {s.warnings.map((w) => (
                <div key={w} className="faint s-4" style={{ fontSize: 12 }}>
                  {w}
                </div>
              ))}
              {open === s.id && (
                <>
                  <input className="input" placeholder="Filter endpoints" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter spec endpoints" style={{ margin: '6px 0', width: 300 }} />
                  <table className="data-table">
                    <tbody>
                      {eps.map((e) => (
                        <tr key={e.key}>
                          <td className={`mono m-${e.method}`}>{e.method}</td>
                          <td className="mono">
                            {e.path}
                            {e.deprecated && <span className="chip" style={{ marginLeft: 6 }}>deprecated</span>}
                          </td>
                          <td className="faint">{e.summary}</td>
                          <td className="mono faint">{e.params.map((p) => `${p.in === 'query' ? '?' : p.in === 'header' ? 'h:' : ''}${p.name}${p.required ? '' : '?'}`).join(' ')}</td>
                          <td className="faint">{e.security.filter((x) => x !== 'none').join(', ') || (e.security.includes('none') ? 'no auth' : '')}</td>
                          <td>
                            <ReplayButton build={() => openEndpoint(s, e.key)} title="Open in Replay with example values, real ids from Traffic where it finds them" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          );
        })}
        {!specs.length && <div className="empty">No API descriptions yet. When the app has none, record some traffic and use Export OpenAPI in Explore API, Endpoints.</div>}
      </div>
    </div>
  );
}
