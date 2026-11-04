import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunResult, Script, ScriptStats } from '../api';
import { useApp } from '../state';
import { Icon } from '../components/icons';
import { fmtMs, fmtTime } from '../format';

const TEMPLATES: Record<Script['kind'], string> = {
  hook: `// Runs on every in-scope request and response the proxy may modify.
// Keep it quick: each call has a 50 ms budget.
function onRequest(req) {
  // req.setHeader('X-Debug', siq.getVar('debug') ?? 'on');
}

function onResponse(req, res) {
  // if (res.status === 401) console.warn('logged out', req.url);
}
`,
  test: `// A test suite. Run it from here, or from an agent with run_script.
test('the profile endpoint answers', async () => {
  const [last] = siq.search('path:/api/profile status:200', 1);
  expect(last).toBeTruthy();
  const res = await siq.resend(last.id, { refreshCookies: true });
  expect(res.status).toBe(200);
});
`,
  script: `// A one-off script. The last expression's value is shown below.
const errors = siq.search('status:>=500 since:' + new Date(Date.now() - 3600e3).toISOString(), 500);
errors.map((e) => e.method + ' ' + e.path);
`,
};

const SDK_HELP = [
  ['siq.search(query, limit)', 'exchanges matching a History filter'],
  ['siq.get(id)', 'one exchange with headers'],
  ['siq.body(id, side)', 'decoded body as text'],
  ['siq.json(id, side)', 'decoded body parsed as JSON'],
  ['await siq.send({method,url,headers,body}, opts)', 'send a request (opts: refreshCookies, applyRules, loginMacro, csrf, sigv4...)'],
  ['await siq.resend(id, opts)', 'send a copy of a recorded request'],
  ['await siq.race(requests, opts)', 'race-timed sends'],
  ['siq.vars() · getVar · setVar', 'token variables'],
  ['siq.cookies()', 'the cookie jar (platform cookies carry an infra reason)'],
  ['siq.tech(host?)', 'what a host runs on, or every host when no host is given'],
  ['siq.csrf(id)', 'CSRF tokens a request carries and where they come from'],
  ['siq.tag(id, tags) · siq.notes(id, text)', 'annotate History'],
  ['siq.flow(flowId)', 'a redirect or race flow'],
  ['await siq.runMacro(id)', 'run a login macro'],
  ['codecs.decode(chain, text) · encode · detect', 'codec chains, e.g. "base64>json"'],
  ['jsonpath.query(obj, path) · bulk · update', 'JSONPath helpers'],
  ['test(name, fn) · expect(v).toBe(...)', 'tests: toBe toEqual toContain toMatch toBeGreaterThan toBeLessThan toBeTruthy, .not'],
];

function Output({ r }: { r: RunResult | null }) {
  if (!r) return <div className="faint" style={{ padding: 12, fontSize: 12 }}>Run the script to see its tests, logs and result here.</div>;
  return (
    <div className="script-output" aria-label="Script output">
      <div className="sec-head">
        <b className={r.ok ? 's-2' : 's-5'}>{r.ok ? 'OK' : 'Failed'}</b>
        <span>{fmtMs(r.ms)}</span>
        {r.tests.length > 0 && (
          <span>
            {r.tests.filter((t) => t.ok).length} of {r.tests.length} tests passed
          </span>
        )}
      </div>
      {r.error && <pre className="raw error-text">{r.error}</pre>}
      {r.tests.map((t) => (
        <div key={t.name} className="test-row">
          <span className={t.ok ? 's-2' : 's-5'}>{t.ok ? '✓' : '✗'}</span> {t.name} <span className="faint">{fmtMs(t.ms)}</span>
          {t.error && <div className="error-text mono" style={{ marginLeft: 18 }}>{t.error}</div>}
        </div>
      ))}
      {r.logs.length > 0 && (
        <pre className="raw">
          {r.logs.map((l, i) => (
            <div key={i} className={l.level === 'error' ? 'error-text' : l.level === 'warn' ? 's-4' : undefined}>
              <span className="faint">{fmtTime(l.at)} </span>
              {l.text}
            </div>
          ))}
        </pre>
      )}
      {r.value !== undefined && <pre className="raw">{r.value}</pre>}
    </div>
  );
}

function Console() {
  const { client } = useApp();
  const [code, setCode] = useState('');
  const [entries, setEntries] = useState<Array<{ code: string; r: RunResult }>>([]);
  const [hist, setHist] = useState(-1);
  const endRef = useRef<HTMLDivElement>(null);
  const run = async () => {
    if (!code.trim()) return;
    const c = code;
    setCode('');
    setHist(-1);
    try {
      const r = await client.runScript({ code: c });
      setEntries((e) => [...e, { code: c, r }]);
    } catch (e) {
      setEntries((x) => [...x, { code: c, r: { ok: false, error: (e as Error).message, logs: [], tests: [], ms: 0 } }]);
    }
    window.setTimeout(() => endRef.current?.scrollIntoView({ block: 'end' }), 0);
  };
  return (
    <div className="console" aria-label="Console">
      <div className="console-log">
        {entries.length === 0 && <div className="faint" style={{ fontSize: 12 }}>Try: siq.search(&apos;status:&gt;=400&apos;, 5).map(e =&gt; e.url)</div>}
        {entries.map((e, i) => (
          <div key={i}>
            <div className="mono muted">› {e.code}</div>
            {e.r.logs.map((l, j) => (
              <div key={j} className="mono">
                {l.text}
              </div>
            ))}
            {e.r.error ? <div className="mono error-text">{e.r.error}</div> : e.r.value !== undefined && <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{e.r.value}</pre>}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="console-input">
        <span className="mono muted">›</span>
        <input
          className="input mono"
          aria-label="Console input"
          value={code}
          placeholder="JavaScript with the siq SDK. Enter runs; Up and Down walk history."
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
            if (e.key === 'ArrowUp' && entries.length) {
              const i = hist === -1 ? entries.length - 1 : Math.max(0, hist - 1);
              setHist(i);
              setCode(entries[i]!.code);
            }
            if (e.key === 'ArrowDown' && hist !== -1) {
              const i = hist + 1;
              setHist(i >= entries.length ? -1 : i);
              setCode(i >= entries.length ? '' : entries[i]!.code);
            }
          }}
        />
      </div>
    </div>
  );
}

export function Scripts() {
  const { client, notify } = useApp();
  const [scripts, setScripts] = useState<Script[]>([]);
  const [stats, setStats] = useState<Record<string, ScriptStats>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [help, setHelp] = useState(false);

  const load = useCallback(
    () =>
      client.scripts().then((s) => {
        setScripts(s.scripts);
        setStats(s.stats);
        setErrors(s.errors);
      }, () => undefined),
    [client],
  );
  useEffect(() => {
    void load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [load]);

  const cur = scripts.find((s) => s.id === sel);
  useEffect(() => {
    if (cur && !dirty) setCode(cur.code);
  }, [cur, dirty]);

  const saveAll = async (list: Array<Partial<Script>>) => {
    try {
      const out = await client.setScripts(list);
      setScripts(out);
      setDirty(false);
      await load();
      return out;
    } catch (e) {
      notify((e as Error).message);
      return null;
    }
  };

  const add = async (kind: Script['kind']) => {
    const name = window.prompt(`Name the new ${kind}`, kind === 'hook' ? 'my-hook' : kind === 'test' ? 'smoke-tests' : 'report');
    if (!name) return;
    const out = await saveAll([...scripts, { name, kind, code: TEMPLATES[kind], enabled: kind !== 'hook' }]);
    if (out) {
      setSel(out[out.length - 1]!.id);
      setResult(null);
    }
  };

  const save = () => cur && saveAll(scripts.map((s) => (s.id === cur.id ? { ...s, code } : s)));

  const run = async () => {
    if (!cur) return;
    if (dirty) await save();
    setRunning(true);
    try {
      setResult(await client.runScript({ id: cur.id }));
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="scripts">
      <div className="two-pane" style={{ flex: 1, minHeight: 0 }}>
        <aside className="side-list" aria-label="Scripts">
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
            <button className="btn small" onClick={() => void add('hook')} title="Runs on live traffic">
              <Icon name="plus" size={11} /> Hook
            </button>
            <button className="btn small" onClick={() => void add('test')}>
              <Icon name="plus" size={11} /> Tests
            </button>
            <button className="btn small" onClick={() => void add('script')}>
              <Icon name="plus" size={11} /> Script
            </button>
          </div>
          {scripts.length === 0 && <div className="faint" style={{ fontSize: 12 }}>No scripts yet. A hook changes live traffic; tests and scripts run when you press Run.</div>}
          {scripts.map((s) => {
            const st = stats[s.id];
            return (
              <button
                key={s.id}
                className="saved-view"
                aria-pressed={s.id === sel}
                onClick={() => {
                  if (dirty && !window.confirm('Discard unsaved changes?')) return;
                  setDirty(false);
                  setSel(s.id);
                  setResult(null);
                }}
                style={{ background: s.id === sel ? 'var(--bg-selected)' : undefined }}
              >
                <span>
                  <span className="badge">{s.kind}</span> {s.name}
                  {s.kind === 'hook' && <span className="faint">{s.enabled === false ? ' (off)' : ' (on)'}</span>}
                </span>
                {errors[s.id] ? (
                  <span className="error-text" style={{ fontSize: 11 }}>
                    {errors[s.id]}
                  </span>
                ) : st ? (
                  <span className="mono faint" style={{ fontSize: 11 }}>
                    {st.calls} calls · {st.errors} errors · avg {fmtMs(st.totalMs / Math.max(1, st.calls))} · max {fmtMs(st.maxMs)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </aside>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {!cur ? (
            <div className="empty">
              <div className="panel-title">Scripts</div>
              <div style={{ maxWidth: 560 }}>Hooks run on live traffic. Tests and scripts run on demand with the siq SDK: search History, send and resend requests, read cookies and variables. The console below runs one line at a time.</div>
            </div>
          ) : (
            <>
              <div className="replay-bar">
                <span className="panel-title">{cur.name}</span>
                <span className="badge">{cur.kind}</span>
                {cur.kind === 'hook' && (
                  <label className="check">
                    <input type="checkbox" checked={cur.enabled !== false} onChange={(e) => void saveAll(scripts.map((s) => (s.id === cur.id ? { ...s, code: dirty ? code : s.code, enabled: e.target.checked } : s)))} /> Active on
                    live traffic
                  </label>
                )}
                <span style={{ flex: 1 }} />
                <button className="btn small" onClick={() => setHelp(!help)} aria-expanded={help}>
                  SDK reference
                </button>
                <button
                  className="btn small"
                  onClick={() => {
                    if (window.confirm(`Delete ${cur.name}?`)) void saveAll(scripts.filter((s) => s.id !== cur.id)).then(() => setSel(null));
                  }}
                >
                  Delete
                </button>
                <button className="btn small" onClick={() => void save()} disabled={!dirty}>
                  Save
                </button>
                {cur.kind !== 'hook' && (
                  <button className="btn small primary" onClick={() => void run()} disabled={running} title="Ctrl Enter">
                    {running ? 'Running...' : 'Run'}
                  </button>
                )}
              </div>
              {help && (
                <table className="data-table" style={{ margin: '0 0 4px' }}>
                  <tbody>
                    {SDK_HELP.map(([a, b]) => (
                      <tr key={a}>
                        <td className="mono">{a}</td>
                        <td className="faint">{b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="script-split">
                <textarea
                  className="editor"
                  aria-label="Script code"
                  spellCheck={false}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setDirty(true);
                  }}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      void run();
                    }
                    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                      e.preventDefault();
                      void save();
                    }
                    if (e.key === 'Tab') {
                      e.preventDefault();
                      const el = e.currentTarget;
                      const s = el.selectionStart;
                      setCode(code.slice(0, s) + '  ' + code.slice(el.selectionEnd));
                      setDirty(true);
                      window.setTimeout(() => el.setSelectionRange(s + 2, s + 2), 0);
                    }
                  }}
                />
                {cur.kind !== 'hook' ? (
                  <Output r={result} />
                ) : (
                  <div className="script-output">
                    <div className="sec-head">Live stats</div>
                    {stats[cur.id] ? (
                      <dl className="kv">
                        <dt>Calls</dt>
                        <dd>{stats[cur.id]!.calls}</dd>
                        <dt>Errors</dt>
                        <dd>{stats[cur.id]!.errors}</dd>
                        <dt>Average</dt>
                        <dd>{fmtMs(stats[cur.id]!.totalMs / Math.max(1, stats[cur.id]!.calls))}</dd>
                        <dt>Slowest</dt>
                        <dd>{fmtMs(stats[cur.id]!.maxMs)}</dd>
                        {stats[cur.id]!.lastError && (
                          <>
                            <dt>Last error</dt>
                            <dd className="error-text">{stats[cur.id]!.lastError}</dd>
                          </>
                        )}
                      </dl>
                    ) : (
                      <div className="faint" style={{ padding: 12, fontSize: 12 }}>
                        Not called yet. Hooks run on in-scope traffic whose scope rule allows changes. Exchanges a hook changed are tagged script:{cur.name}.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <Console />
    </div>
  );
}
