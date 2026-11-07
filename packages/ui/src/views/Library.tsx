import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiFlow, Assertion, EffectiveValue, Reproduction, ReproRun, SessionProfile } from '../api';
import { useApp } from '../state';
import { fmtTime } from '../format';

const KIND: Record<Reproduction['definition']['kind'], string> = { request: 'Request', flow: 'Flow', ws: 'Conversation' };
const STATE_CLS: Record<ReproRun['state'], string> = { running: 's-3', passed: 's-2', failed: 's-5', canceled: 'faint', interrupted: 's-4' };
const SOURCE_LABEL: Record<EffectiveValue['source'], string> = { run: 'this run', reproduction: 'saved input', profile: 'profile', project: 'project variable' };

export const RUN_META = new Set(['reproductions', 'reproductionRuns', 'sessionProfiles']);

/** One line saying what a run would use, before it runs. */
function sessionSummary(eff: { profile?: string; setupFlow?: string; target?: string } | null): string {
  if (!eff) return '';
  return [eff.profile ? `Profile ${eff.profile}` : 'No profile', eff.setupFlow ? `setup flow ${eff.setupFlow}` : null, eff.target ? `to ${safeOrigin(eff.target)}` : null].filter(Boolean).join(' · ');
}
const safeOrigin = (u: string) => {
  try {
    return new URL(u.replace(/\{\{[^}]*\}\}/g, 'x')).origin;
  } catch {
    return u;
  }
};

/** Replay > Saved: saved reproductions, rerun with explicit inputs, session and checks, and every run they had. */
export function Library() {
  const { client, notify, openDraft, openFlow, select, navigate } = useApp();
  const [list, setList] = useState<Reproduction[] | null>(null);
  const [runs, setRuns] = useState<ReproRun[]>([]);
  const [profiles, setProfiles] = useState<SessionProfile[]>([]);
  const [flows, setFlows] = useState<ApiFlow[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [profile, setProfile] = useState<string>('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [eff, setEff] = useState<{ profile?: string; values: EffectiveValue[]; setupFlow?: string; target?: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [newCheck, setNewCheck] = useState<{ kind: 'status' | 'json' | 'body' | 'time'; name: string; value: string }>({ kind: 'status', name: '', value: '2xx' });

  const load = useCallback(async () => {
    try {
      const [l, r, p, f] = await Promise.all([client.reproductions(), client.reproductionRuns(), client.sessionProfiles(), client.flows()]);
      setList(l);
      setRuns(r);
      setProfiles(p);
      setFlows(f);
      setPick((cur) => cur ?? l[0]?.id ?? null);
    } catch (e) {
      notify((e as Error).message);
    }
  }, [client, notify]);
  useEffect(() => {
    void load();
    return client.onChange((c) => {
      if (c.kind === 'meta.set' && (RUN_META.has(c.entityId) || c.entityId === 'flows')) void load();
    });
  }, [client, load]);

  const repro = list?.find((r) => r.id === pick) ?? null;
  useEffect(() => {
    setProfile(repro?.profile ?? '');
    setInputs({});
  }, [repro?.id, repro?.profile]);
  useEffect(() => {
    if (!repro) return setEff(null);
    let live = true;
    client.reproductionEffective(repro.id, profile || undefined, inputs).then(
      (e) => live && setEff(e),
      (e: Error) => live && (setEff(null), notify(e.message)),
    );
    return () => {
      live = false;
    };
  }, [client, repro, profile, inputs, notify]);

  const myRuns = useMemo(() => runs.filter((r) => r.reproId === pick).reverse(), [runs, pick]);

  const run = async () => {
    if (!repro) return;
    setRunning(true);
    try {
      const out = await client.runReproduction(repro.id, { inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => v !== '')), ...(profile ? { profile } : {}) });
      notify(`${repro.name}: ${out.state}${out.error ? ` (${out.error})` : ''}`);
      await load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const save = async (patch: Partial<Reproduction>) => {
    if (!repro) return;
    try {
      await client.saveReproduction({ ...repro, ...patch }, repro.revision);
      await load();
    } catch (e) {
      // Someone else saved meanwhile: reload so the next change starts from theirs.
      notify((e as Error).message);
      await load();
    }
  };

  const addCheck = () => {
    const c = newCheck;
    const a: Omit<Assertion, 'id'> =
      c.kind === 'status'
        ? { status: c.value }
        : c.kind === 'time'
          ? { maxMs: Number(c.value) }
          : c.kind === 'json'
            ? { where: { in: 'json', name: c.name, value: c.value, side: 'response' } }
            : { where: { in: 'body', op: 'contains', value: c.value, side: 'response' } };
    void save({ assertions: [...repro!.assertions, a as Assertion] });
  };

  const open = async () => {
    if (!repro) return;
    const d = repro.definition;
    if (d.kind === 'request') return openDraft({ method: d.request.method, url: d.request.url, headers: d.request.headers, body: d.request.body ?? '' }, repro.name, { id: repro.id, revision: repro.revision });
    if (d.kind === 'flow') {
      const f = flows.find((x) => x.id === d.flowId);
      return f ? openFlow(f.name) : notify('The flow this runs was deleted');
    }
    notify('Open a conversation from its run: Inspect the connection, then Send to Replay.');
  };

  if (!list) return <div className="empty">Loading saved reproductions...</div>;
  if (!list.length)
    return (
      <div className="empty" data-testid="library-empty">
        Nothing saved yet. Save a request from its Replay editor (Save), or right-click a request in Traffic and choose Save as reproduction.
      </div>
    );

  return (
    <div className="library" aria-label="Saved reproductions">
      <div className="library-list" role="listbox" aria-label="Reproductions">
        {list.map((r) => {
          const last = runs.filter((x) => x.reproId === r.id).at(-1);
          return (
            <button key={r.id} role="option" aria-selected={r.id === pick} className="library-item" onClick={() => setPick(r.id)} data-testid="repro-item">
              <b>{r.name}</b>
              <span className="faint">
                {KIND[r.definition.kind]} · rev {r.revision}
                {last ? (
                  <>
                    {' '}
                    · <span className={STATE_CLS[last.state]}>{last.state}</span>
                  </>
                ) : (
                  ' · never run'
                )}
              </span>
            </button>
          );
        })}
      </div>
      {repro && (
        <div className="library-detail" data-testid="repro-detail">
          <div className="replay-bar">
            <span className="panel-title">{repro.name}</span>
            <span className="faint">
              {KIND[repro.definition.kind]}, revision {repro.revision}, saved {fmtTime(repro.updatedAt)} by {repro.by}
            </span>
            <span style={{ flex: 1 }} />
            <button className="btn primary" onClick={() => void run()} disabled={running}>
              {running ? 'Running...' : 'Run'}
            </button>
            <button className="btn small" onClick={() => void open()}>
              Open in editor
            </button>
            {repro.definition.kind === 'request' && (
              <button className="btn small" onClick={() => client.promoteReproduction(repro.id).then(load, (e: Error) => notify(e.message))} title="Make it a one-step flow you can add setup steps to; it keeps its name, source and runs">
                Make it a flow
              </button>
            )}
            <button className="btn small ghost" aria-label={`Delete ${repro.name}`} onClick={() => client.removeReproduction(repro.id).then(() => (setPick(null), load()), (e: Error) => notify(e.message))}>
              Delete
            </button>
          </div>

          <section>
            <h3>Session</h3>
            <div className="filterbar">
              <label className="check">
                Profile
                <select className="input" aria-label="Session profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
                  <option value="">None (project variables, cookies as written)</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              {profile !== (repro.profile ?? '') && (
                <button className="btn small" onClick={() => void save({ profile: profile || undefined })}>
                  Save as its profile
                </button>
              )}
              <button className="btn small ghost" onClick={() => navigate({ area: 'project', page: 'session', tab: 'profiles' })}>
                Edit profiles
              </button>
            </div>
            <div className="muted" data-testid="repro-session">
              {sessionSummary(eff)}
            </div>
            {eff && eff.values.length > 0 && (
              <table className="data-table" aria-label="Inputs">
                <thead>
                  <tr>
                    <th>Input</th>
                    <th>Value used</th>
                    <th>From</th>
                    <th>Override for this run</th>
                  </tr>
                </thead>
                <tbody>
                  {eff.values.map((v) => (
                    <tr key={v.name} data-testid="repro-input">
                      <td className="mono">{v.name}</td>
                      <td className="mono wrap">{v.value}</td>
                      <td className="faint">{SOURCE_LABEL[v.source]}</td>
                      <td>
                        <input className="input mono" aria-label={`Run with ${v.name}`} value={inputs[v.name] ?? ''} onChange={(e) => setInputs({ ...inputs, [v.name]: e.target.value })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h3>Checks</h3>
            {repro.assertions.length === 0 && <div className="empty-note">No checks: a run passes when it gets an answer.</div>}
            {repro.assertions.map((a) => (
              <div key={a.id} data-testid="repro-check">
                {a.label ?? (a.status !== undefined ? `Status is ${a.status}` : a.maxMs !== undefined ? `Takes at most ${a.maxMs} ms` : `${a.where!.in}${a.where!.name ? ` ${a.where!.name}` : ''} ${a.where!.op ?? 'equals'} ${a.where!.value ?? ''}`)}{' '}
                <button className="btn small ghost" aria-label="Remove check" onClick={() => void save({ assertions: repro.assertions.filter((x) => x.id !== a.id) })}>
                  Remove
                </button>
              </div>
            ))}
            <div className="filterbar">
              <select className="input" aria-label="Check kind" value={newCheck.kind} onChange={(e) => setNewCheck({ kind: e.target.value as never, name: '', value: e.target.value === 'status' ? '2xx' : e.target.value === 'time' ? '1000' : '' })}>
                <option value="status">Status is</option>
                <option value="json">JSON value equals</option>
                <option value="body">Body contains</option>
                <option value="time">Takes at most (ms)</option>
              </select>
              {newCheck.kind === 'json' && <input className="input mono" placeholder="$.order.id" aria-label="Check JSONPath" value={newCheck.name} onChange={(e) => setNewCheck({ ...newCheck, name: e.target.value })} />}
              <input className="input mono" aria-label="Check value" value={newCheck.value} onChange={(e) => setNewCheck({ ...newCheck, value: e.target.value })} />
              <button className="btn small" onClick={addCheck} disabled={!newCheck.value || (newCheck.kind === 'json' && !newCheck.name)}>
                Add check
              </button>
            </div>
          </section>

          <section>
            <h3>Runs</h3>
            {myRuns.length === 0 && <div className="empty-note">Not run yet.</div>}
            {myRuns.length > 0 && (
              <table className="data-table" aria-label="Runs">
                <tbody>
                  {myRuns.map((r) => (
                    <tr key={r.id} data-testid="repro-run" data-state={r.state}>
                      <td className={STATE_CLS[r.state]}>{r.state}</td>
                      <td className="faint">{fmtTime(r.startedAt)}</td>
                      <td className="faint" title="The saved definition this run used">
                        rev {r.revision}
                        {r.revision !== repro.revision ? ' (older)' : ''}
                      </td>
                      <td className="faint">{r.profile ?? 'no profile'}</td>
                      <td className="wrap">
                        {r.assertions.map((a) => (
                          <span key={a.id} className={a.passed ? 's-2' : 's-5'} style={{ marginRight: 8 }} title={a.detail}>
                            {a.passed ? '✓' : '✗'} {a.label}
                          </span>
                        ))}
                        {r.error && <span className="error-text">{r.error}</span>}
                        {r.notes.map((n) => (
                          <div key={n} className="faint">
                            {n}
                          </div>
                        ))}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {r.state === 'running' && (
                          <button className="btn small" onClick={() => void client.cancelReproductionRun(r.id).then(load)}>
                            Cancel
                          </button>
                        )}
                        {r.exchangeIds.at(-1) && (
                          <button className="btn small" onClick={() => (select(r.exchangeIds.at(-1)!), navigate('traffic/requests'))}>
                            Inspect
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

type ProfileDraft = Omit<SessionProfile, 'id' | 'values'> & { id?: string; key: string; valuesText: string };
let pk = 1;

/** Project settings > Session and authentication > Profiles: named values, cookie policy, setup flow and target for runs. */
export function Profiles() {
  const { client, notify } = useApp();
  const [list, setList] = useState<ProfileDraft[] | null>(null);
  const [flows, setFlows] = useState<ApiFlow[]>([]);
  const [dirty, setDirty] = useState(false);
  const load = useCallback(async () => {
    try {
      const [p, f] = await Promise.all([client.sessionProfiles(), client.flows()]);
      setList(p.map((x) => ({ ...x, key: x.id, valuesText: Object.entries(x.values).map(([k, v]) => `${k}=${v}`).join('\n') })));
      setFlows(f);
      setDirty(false);
    } catch (e) {
      notify((e as Error).message);
    }
  }, [client, notify]);
  useEffect(() => {
    void load();
  }, [load]);
  const set = (key: string, p: Partial<ProfileDraft>) => {
    setList((l) => l!.map((x) => (x.key === key ? { ...x, ...p } : x)));
    setDirty(true);
  };
  const save = async () => {
    try {
      await client.setSessionProfiles(
        list!.map(({ key: _k, valuesText, ...p }) => ({
          ...p,
          values: Object.fromEntries(
            valuesText
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => {
                const i = l.indexOf('=');
                return i === -1 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1)];
              }),
          ),
        })),
      );
      notify('Profiles saved');
      await load();
    } catch (e) {
      notify((e as Error).message);
    }
  };
  if (!list) return <div className="empty">Loading profiles...</div>;
  return (
    <div className="page-inner" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="filterbar">
        <button
          className="btn small"
          onClick={() => {
            setList([...list, { key: `new${pk++}`, name: `profile-${list.length + 1}`, valuesText: '', cookies: 'jar' }]);
            setDirty(true);
          }}
        >
          Add profile
        </button>
        <button className="btn small primary" disabled={!dirty} onClick={() => void save()}>
          Save
        </button>
      </div>
      <div className="faint" style={{ fontSize: 12 }}>
        A profile is the session a saved reproduction runs in: named values for {'{{var:...}}'}, which cookies to send, a setup flow to run first, and optionally another origin. Values chosen for one run come first, then the reproduction&apos;s own inputs, then the profile, then project variables. Keep secrets in signing keys or identities, which are sealed with the keyring; a profile is shared with the project.
      </div>
      {list.length === 0 && <div className="empty">No profiles. Runs use project variables and the cookies as recorded.</div>}
      {list.map((p) => (
        <div key={p.key} className="card rule-card" data-testid="profile">
          <div className="rule-head">
            <input className="input" aria-label="Profile name" value={p.name} onChange={(e) => set(p.key, { name: e.target.value })} />
            <label className="check">
              Cookies
              <select className="input" aria-label="Profile cookies" value={p.cookies ?? 'as-written'} onChange={(e) => set(p.key, { cookies: e.target.value as never })}>
                <option value="jar">Current cookie jar</option>
                <option value="as-written">As written in the request</option>
                <option value="none">None</option>
              </select>
            </label>
            <label className="check">
              Setup flow
              <select className="input" aria-label="Profile setup flow" value={p.setupFlow ?? ''} onChange={(e) => set(p.key, { setupFlow: e.target.value || undefined })}>
                <option value="">None</option>
                {flows.map((f) => (
                  <option key={f.id} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <input className="input mono" placeholder="https://staging.example.com (optional)" aria-label="Profile base URL" value={p.baseUrl ?? ''} onChange={(e) => set(p.key, { baseUrl: e.target.value || undefined })} style={{ flex: '1 1 200px' }} />
            <button className="btn small ghost" aria-label={`Delete profile ${p.name}`} onClick={() => (setList(list.filter((x) => x.key !== p.key)), setDirty(true))}>
              Delete
            </button>
          </div>
          <textarea className="input mono" rows={3} aria-label="Profile values" placeholder={'user=ada\ntenant=acme'} value={p.valuesText} onChange={(e) => set(p.key, { valuesText: e.target.value })} style={{ width: '100%' }} />
        </div>
      ))}
    </div>
  );
}
