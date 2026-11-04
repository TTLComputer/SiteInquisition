import { useCallback, useEffect, useState } from 'react';
import { useUnsaved } from '../unsaved';
import type { AwsProfile, Extractor, Macro, ParsedSigV4, VarValue } from '../api';
import { useApp } from '../state';
import { Icon } from '../components/icons';
import { fmtTime, parseRawRequest, toRawRequest } from '../format';
import { bodyText } from '../actions';

// ---------------- Login macros ----------------

type MacroDraft = Omit<Macro, 'id' | 'steps'> & { id?: string; key: string; steps: Array<{ key: string; raw: string }>; statusesText: string };
let n = 1;
const k = () => `m${n++}`;

const toDraft = (m: Macro): MacroDraft => ({
  ...m,
  key: m.id,
  statusesText: (m.statuses ?? [401, 403]).join(', '),
  steps: m.steps.map((s) => ({ key: k(), raw: toRawRequest(s.method, s.url, s.headers, s.body ?? '') })),
});

export function Macros() {
  const { client, notify, selectedId, select, setView } = useApp();
  const [list, setList] = useState<MacroDraft[]>([]);
  const [dirty, setDirty] = useState(false);
  useUnsaved(dirty, 'login macros');
  const [runs, setRuns] = useState<Record<string, Array<{ step: number; exchangeId?: string; status: number | null; error?: string }>>>({});
  const load = useCallback(() => client.macros().then((m) => setList(m.map(toDraft)), () => undefined), [client]);
  useEffect(() => {
    void load();
  }, [load]);
  const set = (key: string, p: Partial<MacroDraft>) => {
    setList(list.map((m) => (m.key === key ? { ...m, ...p } : m)));
    setDirty(true);
  };
  const save = async () => {
    try {
      const out = list.map(({ key: _k, statusesText, steps, ...m }) => ({
        ...m,
        statuses: statusesText.split(/[\s,]+/).map(Number).filter((x) => x >= 100 && x <= 599),
        steps: steps.map((s) => {
          const p = parseRawRequest(s.raw);
          return { method: p.method, url: p.url, headers: p.headers, body: p.body || undefined };
        }),
      }));
      setList((await client.setMacros(out)).map(toDraft));
      setDirty(false);
      notify('Macros saved');
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const addSelected = async (m: MacroDraft) => {
    if (!selectedId) return notify('Select the login request in History first.');
    const ex = await client.get(selectedId);
    const body = ex.reqBodySize ? await bodyText(client, ex.id, 'request').catch(() => '') : '';
    const headers = ex.requestHeaders.filter(([h]) => h.toLowerCase() !== 'cookie');
    set(m.key, { steps: [...m.steps, { key: k(), raw: toRawRequest(ex.method, ex.url, headers, body) }], host: m.host || ex.host });
  };
  return (
    <div className="rules-tool">
      <div className="replay-bar">
        <button
          className="btn small"
          onClick={() => {
            setList([...list, { key: k(), name: 'Log in', enabled: true, host: '', statusesText: '401, 403', steps: [] }]);
            setDirty(true);
          }}
        >
          <Icon name="plus" size={12} /> Add macro
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn small" onClick={() => (setDirty(false), void load())} disabled={!dirty}>
          Revert
        </button>
        <button className="btn small primary" onClick={() => void save()} disabled={!dirty}>
          Save
        </button>
      </div>
      <div className="faint" style={{ padding: '6px 12px', fontSize: 12 }}>
        A macro is the requests that log you in. Replays with &quot;Log in on 401/403&quot; run it when the host answers with one of its statuses, then send again with the new cookies and variables. Steps get fresh cookies from the jar; use {'{{var:...}}'} for CSRF tokens.
      </div>
      {list.length === 0 && <div className="empty">No login macros. Add one, then add the login request from History as its first step.</div>}
      {list.map((m) => (
        <div key={m.key} className="card rule-card">
          <div className="rule-head">
            <input type="checkbox" checked={m.enabled !== false} onChange={(e) => set(m.key, { enabled: e.target.checked })} aria-label="Enabled" />
            <input className="input" value={m.name} onChange={(e) => set(m.key, { name: e.target.value })} aria-label="Macro name" style={{ flex: '1 1 140px' }} />
            <input className="input mono" placeholder="hosts (glob)" value={m.host} onChange={(e) => set(m.key, { host: e.target.value })} aria-label="Macro hosts" />
            <label className="check">
              on
              <input className="input mono" value={m.statusesText} onChange={(e) => set(m.key, { statusesText: e.target.value })} style={{ width: 90 }} aria-label="Statuses" />
            </label>
            <button className="btn small" onClick={() => void addSelected(m)} title="Add the request selected in History as a step">
              Add selected request
            </button>
            <button
              className="btn small"
              disabled={!m.id || dirty}
              title={dirty ? 'Save first' : 'Run the steps now'}
              onClick={() => client.runMacro(m.id!).then((r) => setRuns({ ...runs, [m.key]: r }), (e: Error) => notify(e.message))}
            >
              Run now
            </button>
            <button className="icon-btn" aria-label="Delete macro" onClick={() => (setList(list.filter((x) => x.key !== m.key)), setDirty(true))}>
              <Icon name="trash" size={13} />
            </button>
          </div>
          {m.steps.map((s, i) => (
            <div key={s.key} className="macro-step">
              <div className="sec-head">
                Step {i + 1}
                {runs[m.key]?.[i] && (
                  <button
                    className={`btn small mono ${runs[m.key]![i]!.error ? 's-err' : (runs[m.key]![i]!.status ?? 0) >= 400 ? 's-4' : 's-2'}`}
                    onClick={() => {
                      const id = runs[m.key]![i]!.exchangeId;
                      if (id) (select(id), setView('history'));
                    }}
                  >
                    {runs[m.key]![i]!.error ?? runs[m.key]![i]!.status}
                  </button>
                )}
                <span style={{ flex: 1 }} />
                <button className="icon-btn" aria-label={`Remove step ${i + 1}`} onClick={() => set(m.key, { steps: m.steps.filter((x) => x.key !== s.key) })}>
                  <Icon name="trash" size={12} />
                </button>
              </div>
              <textarea className="editor" style={{ height: 120 }} spellCheck={false} value={s.raw} onChange={(e) => set(m.key, { steps: m.steps.map((x) => (x.key === s.key ? { ...x, raw: e.target.value } : x)) })} aria-label={`Step ${i + 1}`} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------- Variables and extractors ----------------

type ExDraft = Partial<Extractor> & { rk: string };

export function Variables() {
  const { client, notify, select, setView } = useApp();
  const [vars, setVars] = useState<Record<string, VarValue>>({});
  const [ex, setEx] = useState<ExDraft[]>([]);
  const [dirty, setDirty] = useState(false);
  useUnsaved(dirty, 'extractors');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const load = useCallback(
    () =>
      client.vars().then((v) => {
        setVars(v.vars);
        if (!dirty) setEx(v.extractors.map((x) => ({ ...x, rk: x.id })));
      }, () => undefined),
    [client, dirty],
  );
  useEffect(() => {
    void load();
    const off = client.onChange((c) => c.kind === 'meta.set' && (c.entityId === 'vars' || c.entityId === 'extractors') && void load());
    return () => {
      off();
    };
  }, [client, load]);
  const setX = (rk: string, p: Partial<Extractor>) => {
    setEx(ex.map((x) => (x.rk === rk ? { ...x, ...p } : x)));
    setDirty(true);
  };
  const saveX = async () => {
    try {
      const out = await client.setExtractors(ex.map(({ rk: _k, ...x }) => x));
      setEx(out.map((x) => ({ ...x, rk: x.id })));
      setDirty(false);
      notify('Extractors saved. They run on every new response.');
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <div className="rules-tool">
      <div className="card" style={{ margin: '8px 12px' }}>
        <div className="sec-head">
          <b style={{ color: 'var(--text)' }}>Variables</b>
          <span>Use as {'{{var:name}}'} in replays, rules, mocks and macros.</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Set by</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {Object.entries(vars).map(([k2, v]) => (
              <tr key={k2}>
                <td className="mono">{k2}</td>
                <td className="mono" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }} title={v.value}>
                  {v.value}
                </td>
                <td className="faint">
                  {v.exchangeId ? (
                    <button className="btn small" onClick={() => (select(v.exchangeId!), setView('history'))}>
                      {v.source === 'manual' || v.source === 'script' ? v.source : 'extractor'}
                    </button>
                  ) : (
                    v.source
                  )}
                </td>
                <td className="faint">{fmtTime(v.updatedAt)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn small" onClick={() => navigator.clipboard.writeText(`{{var:${k2}}}`).then(() => notify(`Copied {{var:${k2}}}`), () => undefined)}>
                    Copy token
                  </button>{' '}
                  <button className="icon-btn" aria-label={`Delete ${k2}`} onClick={() => client.deleteVar(k2).then(load, (e: Error) => notify(e.message))}>
                    <Icon name="trash" size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="cond-row">
          <input className="input mono" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New variable name" />
          <input className="input mono" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} aria-label="New variable value" style={{ flex: '2 1 200px' }} />
          <button
            className="btn small"
            disabled={!name}
            onClick={() =>
              client.setVar(name, value).then(() => {
                setName('');
                setValue('');
                void load();
              }, (e: Error) => notify(e.message))
            }
          >
            Set
          </button>
        </div>
      </div>
      <div className="card" style={{ margin: '8px 12px' }}>
        <div className="sec-head">
          <b style={{ color: 'var(--text)' }}>Extractors</b>
          <span>Keep a variable up to date from responses: a CSRF header, a token in JSON, a cookie.</span>
          <span style={{ flex: 1 }} />
          <button className="btn small" onClick={() => (setEx([...ex, { rk: k(), name: '', from: 'json' }]), setDirty(true))}>
            <Icon name="plus" size={12} /> Add extractor
          </button>
          <button className="btn small primary" disabled={!dirty} onClick={() => void saveX()}>
            Save
          </button>
        </div>
        {ex.map((x) => (
          <div key={x.rk} className="cond-row">
            <input type="checkbox" checked={x.enabled !== false} onChange={(e) => setX(x.rk, { enabled: e.target.checked })} aria-label="Enabled" />
            <input className="input mono" placeholder="variable" value={x.name ?? ''} onChange={(e) => setX(x.rk, { name: e.target.value })} aria-label="Variable" style={{ width: 120 }} />
            <span className="faint">from</span>
            <select className="input" value={x.from} onChange={(e) => setX(x.rk, { from: e.target.value as Extractor['from'] })} aria-label="Source">
              <option value="json">JSON body</option>
              <option value="header">Header</option>
              <option value="cookie">Set-Cookie</option>
              <option value="body">Body text</option>
            </select>
            {x.from !== 'body' && (
              <input className="input mono" placeholder={x.from === 'json' ? '$.access_token' : x.from === 'header' ? 'X-CSRF-Token' : 'cookie name'} value={x.key ?? ''} onChange={(e) => setX(x.rk, { key: e.target.value })} aria-label="Key" />
            )}
            <input className="input mono" placeholder="regex (optional)" value={x.regex ?? ''} onChange={(e) => setX(x.rk, { regex: e.target.value })} aria-label="Regex" />
            <input className="input mono" placeholder="host glob" value={x.host ?? ''} onChange={(e) => setX(x.rk, { host: e.target.value })} aria-label="Host" style={{ width: 130 }} />
            <input className="input mono" placeholder="path prefix" value={x.pathPrefix ?? ''} onChange={(e) => setX(x.rk, { pathPrefix: e.target.value })} aria-label="Path prefix" style={{ width: 120 }} />
            <button className="icon-btn" aria-label="Delete extractor" onClick={() => (setEx(ex.filter((y) => y.rk !== x.rk)), setDirty(true))}>
              <Icon name="trash" size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------- AWS SigV4 ----------------

export function Aws() {
  const { client, notify, selectedId } = useApp();
  const [profiles, setProfiles] = useState<AwsProfile[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  useUnsaved(dirty, 'AWS profiles');
  const [entry, setEntry] = useState<{ name: string; accessKeyId: string; secretAccessKey: string; sessionToken: string } | null>(null);
  const [parsed, setParsed] = useState<ParsedSigV4 | null | undefined>(undefined);
  const load = useCallback(() => client.aws().then((a) => (setProfiles(a.profiles), setKeys(a.sessionKeys)), () => undefined), [client]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!selectedId) return setParsed(undefined);
    client.parseSigV4(selectedId).then(setParsed, () => setParsed(null));
  }, [client, selectedId]);
  const set = (i: number, p: Partial<AwsProfile>) => {
    setProfiles(profiles.map((x, j) => (j === i ? { ...x, ...p } : x)));
    setDirty(true);
  };
  return (
    <div className="rules-tool">
      <div className="replay-bar">
        <button className="btn small" onClick={() => (setProfiles([...profiles, { name: `profile-${profiles.length + 1}`, source: 'profile:default', region: 'us-east-1', service: 'execute-api' }]), setDirty(true))}>
          <Icon name="plus" size={12} /> Add profile
        </button>
        {parsed && (
          <button
            className="btn small"
            title="Make a profile from the signature on the selected request"
            onClick={() => (setProfiles([...profiles, { name: `${parsed.service}-${parsed.region}`, source: 'profile:default', region: parsed.region, service: parsed.service }]), setDirty(true))}
          >
            Profile from selected request
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn small primary" disabled={!dirty} onClick={() => client.setAws(profiles).then(() => (setDirty(false), notify('Profiles saved')), (e: Error) => notify(e.message))}>
          Save
        </button>
      </div>
      <div className="faint" style={{ padding: '6px 12px', fontSize: 12 }}>
        Replays with SigV4 on are signed again after every edit. Keys come from ~/.aws/credentials, from AWS_* variables, or are typed in for this session only and never written to disk.
      </div>
      {selectedId && (
        <div className="card" style={{ margin: '8px 12px', padding: '8px 12px', fontSize: 12 }}>
          <b>Selected request:</b>{' '}
          {parsed ? (
            <span className="mono">
              signed by {parsed.accessKeyId} for {parsed.service} in {parsed.region} on {parsed.date}, headers {parsed.signedHeaders.join(';')}
            </span>
          ) : (
            <span className="faint">not SigV4 signed</span>
          )}
        </div>
      )}
      {profiles.length === 0 && <div className="empty">No AWS profiles.</div>}
      {profiles.map((p, i) => (
        <div key={i} className="card rule-card">
          <div className="rule-head">
            <input className="input mono" value={p.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Profile name" />
            <select
              className="input"
              value={p.source.startsWith('profile:') ? 'profile' : p.source}
              onChange={(e) => set(i, { source: e.target.value === 'profile' ? 'profile:default' : e.target.value })}
              aria-label="Key source"
            >
              <option value="profile">Credentials file profile</option>
              <option value="env">Environment variables</option>
              <option value="session">Typed in, this session only</option>
            </select>
            {p.source.startsWith('profile:') && <input className="input mono" value={p.source.slice(8)} onChange={(e) => set(i, { source: `profile:${e.target.value}` })} aria-label="Profile in credentials file" style={{ width: 120 }} />}
            <input className="input mono" placeholder="region" value={p.region} onChange={(e) => set(i, { region: e.target.value })} aria-label="Region" style={{ width: 110 }} />
            <input className="input mono" placeholder="service" value={p.service} onChange={(e) => set(i, { service: e.target.value })} aria-label="Service" style={{ width: 110 }} />
            <input className="input mono" placeholder="hosts for auto (glob)" value={p.host ?? ''} onChange={(e) => set(i, { host: e.target.value })} aria-label="Hosts" />
            {p.source === 'session' && (
              <button className="btn small" onClick={() => setEntry({ name: p.name, accessKeyId: '', secretAccessKey: '', sessionToken: '' })}>
                {keys.includes(p.name) ? 'Keys entered: replace' : 'Enter keys'}
              </button>
            )}
            <button className="icon-btn" aria-label="Delete profile" onClick={() => (setProfiles(profiles.filter((_, j) => j !== i)), setDirty(true))}>
              <Icon name="trash" size={13} />
            </button>
          </div>
          {entry?.name === p.name && (
            <div className="cond-row">
              <input className="input mono" placeholder="access key id" value={entry.accessKeyId} onChange={(e) => setEntry({ ...entry, accessKeyId: e.target.value })} aria-label="Access key id" />
              <input className="input mono" type="password" placeholder="secret access key" value={entry.secretAccessKey} onChange={(e) => setEntry({ ...entry, secretAccessKey: e.target.value })} aria-label="Secret access key" />
              <input className="input mono" type="password" placeholder="session token (optional)" value={entry.sessionToken} onChange={(e) => setEntry({ ...entry, sessionToken: e.target.value })} aria-label="Session token" />
              <button
                className="btn small primary"
                disabled={!entry.accessKeyId || !entry.secretAccessKey}
                onClick={() =>
                  client.setAwsKeys({ ...entry, sessionToken: entry.sessionToken || undefined }).then(() => {
                    setEntry(null);
                    void load();
                    notify('Keys held in memory until the app closes');
                  }, (e: Error) => notify(e.message))
                }
              >
                Use keys
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
