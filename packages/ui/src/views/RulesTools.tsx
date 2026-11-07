import { useCallback, useEffect, useState } from 'react';
import { useUnsaved } from '../unsaved';
import type { Breakpoint, MatchCondition, MatchOp, MockRule, Paused, ReplaceRule } from '../api';
import { base64ToBytes, bytesToBase64 } from '../api';
import { useApp } from '../state';
import { Icon } from '../components/icons';
import { asText, fmtTime, parseRawRequest, toRawRequest } from '../format';
import { diffLines } from '../diff';
import { TokenPicker } from './TokenPicker';
import { RegionEditor, useRegions } from '../components/Decoded';

type Keyed<T> = Partial<T> & { key: string };
let n = 1;
const key = () => `k${n++}`;
const keyed = <T extends { id?: string }>(list: T[]): Array<Keyed<T>> => list.map((x) => ({ ...x, key: x.id ?? key() }));
const strip = <T,>({ key: _k, ...rest }: Keyed<T>) => rest as Partial<T>;

function useRulesData() {
  const { client } = useApp();
  const [data, setData] = useState<{ rules: ReplaceRule[]; mocks: MockRule[]; breakpoints: Breakpoint[]; hits: Record<string, number> } | null>(null);
  const load = useCallback(() => client.rules().then(setData, () => undefined), [client]);
  useEffect(() => {
    void load();
    const off = client.onChange((c) => {
      if (c.kind === 'meta.set' && ['replaceRules', 'mocks', 'breakpoints'].includes(c.entityId)) void load();
    });
    const t = window.setInterval(load, 4000); // hit counts
    return () => {
      off();
      window.clearInterval(t);
    };
  }, [client, load]);
  return { data, load };
}

type PathMode = 'prefix' | 'exact' | 'glob' | 'template' | 'regex';

interface Cond {
  host?: string;
  method?: string;
  pathPrefix?: string;
  path?: string;
  pathMatch?: Exclude<PathMode, 'prefix'>;
  status?: string | number;
  where?: MatchCondition[];
}
type CondPatch = Partial<Omit<Cond, 'status'>> & { status?: string };

const PATH_MODES: Array<[PathMode, string, string]> = [
  ['prefix', 'starts with', '/api/'],
  ['exact', 'is exactly', '/api/users'],
  ['template', 'template', '/users/{id}/orders'],
  ['glob', 'glob', '/api/*/items, /static/**'],
  ['regex', 'regex', '^/v[0-9]+/'],
];

const SOURCES: Array<[MatchCondition['in'], string, string]> = [
  ['query', 'Query param', 'name'],
  ['header', 'Header', 'name'],
  ['cookie', 'Cookie', 'name'],
  ['json', 'JSON', '$.user.role'],
  ['graphql', 'GraphQL', ''],
  ['body', 'Body text', ''],
  ['path', 'Path', ''],
];

const OPS: Array<[MatchOp, string]> = [
  ['equals', '='],
  ['contains', 'contains'],
  ['prefix', 'starts with'],
  ['suffix', 'ends with'],
  ['glob', 'glob'],
  ['regex', 'regex'],
  ['exists', 'exists'],
  ['absent', 'is absent'],
  ['gt', '>'],
  ['gte', '>='],
  ['lt', '<'],
  ['lte', '<='],
];

const pathMode = (r: Cond): PathMode => r.pathMatch ?? (r.path !== undefined ? 'exact' : 'prefix');

/** One "and" condition: source, name, side, negation, operator, value. */
function WhereRow({ c, set, remove, withSide }: { c: MatchCondition; set(c: MatchCondition): void; remove(): void; withSide: boolean }) {
  const src = SOURCES.find(([id]) => id === c.in)!;
  const op = c.op ?? 'equals';
  const noValue = op === 'exists' || op === 'absent';
  const sided = withSide && ['header', 'cookie', 'json', 'body'].includes(c.in);
  return (
    <div className="cond-row where-row" data-testid="where-row">
      <span className="label">and</span>
      <select className="input" value={c.in} onChange={(e) => set({ ...c, in: e.target.value as MatchCondition['in'], name: undefined })} aria-label="Condition source" style={{ flex: '0 0 auto' }}>
        {SOURCES.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      {sided && (
        <select className="input" value={c.side ?? ''} onChange={(e) => set({ ...c, side: (e.target.value || undefined) as MatchCondition['side'] })} aria-label="Request or response" style={{ flex: '0 0 auto' }}>
          <option value="">this message</option>
          <option value="request">of the request</option>
          <option value="response">of the response</option>
        </select>
      )}
      {c.in === 'graphql' ? (
        <select className="input" value={c.name ?? 'operation'} onChange={(e) => set({ ...c, name: e.target.value === 'operation' ? undefined : e.target.value })} aria-label="GraphQL part" style={{ flex: '0 0 auto' }}>
          <option value="operation">operation name</option>
          <option value="type">operation type</option>
          <option value="field">root field</option>
          <option value="hash">persisted query hash</option>
        </select>
      ) : (
        src[2] && <input className="input mono" placeholder={src[2]} value={c.name ?? ''} onChange={(e) => set({ ...c, name: e.target.value })} aria-label="Condition name" />
      )}
      <label className="check" title="Match when this does not hold">
        <input type="checkbox" checked={!!c.not} onChange={(e) => set({ ...c, not: e.target.checked || undefined })} aria-label="Not" />
        not
      </label>
      <select className="input" value={op} onChange={(e) => set({ ...c, op: e.target.value as MatchOp })} aria-label="Operator" style={{ flex: '0 0 auto' }}>
        {OPS.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      {!noValue && <input className="input mono" placeholder={c.in === 'graphql' && !c.name ? 'GetUser' : 'value'} value={c.value ?? ''} onChange={(e) => set({ ...c, value: e.target.value })} aria-label="Condition value" />}
      {!noValue && !['gt', 'gte', 'lt', 'lte'].includes(op) && (
        <label className="check" title="Ignore letter case">
          <input type="checkbox" checked={!!c.ignoreCase} onChange={(e) => set({ ...c, ignoreCase: e.target.checked || undefined })} aria-label="Ignore case" />
          Aa
        </label>
      )}
      <button className="icon-btn" aria-label="Remove condition" onClick={remove}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function Conditions({ r, set, withStatus, withMethod = true, withSide = false, urlOnly = false }: { r: Cond; set(p: CondPatch): void; withStatus?: boolean; withMethod?: boolean; withSide?: boolean; urlOnly?: boolean }) {
  const mode = pathMode(r);
  const placeholder = PATH_MODES.find(([m]) => m === mode)![2];
  const where = r.where ?? [];
  const setWhere = (next: MatchCondition[]) => set({ where: next });
  const setPath = (m: PathMode, value: string) =>
    set(m === 'prefix' ? { pathPrefix: value, path: undefined, pathMatch: undefined } : { pathPrefix: undefined, path: value, pathMatch: m === 'exact' ? undefined : m });
  return (
    <>
      <div className="cond-row">
        <span className="label">When</span>
        <input className="input mono" placeholder="host (glob, empty = any)" value={r.host ?? ''} onChange={(e) => set({ host: e.target.value })} aria-label="Host" />
        {withMethod && <input className="input mono" placeholder="method(s)" title="One method, or several: GET,HEAD" value={r.method ?? ''} onChange={(e) => set({ method: e.target.value.toUpperCase() })} style={{ width: 90, flex: '0 0 auto' }} aria-label="Method" />}
        <select className="input" value={mode} onChange={(e) => setPath(e.target.value as PathMode, (mode === 'prefix' ? r.pathPrefix : r.path) ?? '')} aria-label="Path match" style={{ flex: '0 0 auto' }}>
          {PATH_MODES.map(([m, label]) => (
            <option key={m} value={m}>
              path {label}
            </option>
          ))}
        </select>
        <input className="input mono" placeholder={placeholder} value={(mode === 'prefix' ? r.pathPrefix : r.path) ?? ''} onChange={(e) => setPath(mode, e.target.value)} aria-label="Path" />
        {withStatus && <input className="input mono" placeholder="status (4xx, >=400)" value={String(r.status ?? '')} onChange={(e) => set({ status: e.target.value })} style={{ width: 130, flex: '0 0 auto' }} aria-label="Status" />}
        <button
          className="link-btn"
          onClick={() => setWhere([...where, { in: urlOnly ? 'query' : 'header', name: '' }])}
          title={urlOnly ? 'Add a condition on the connection URL' : 'Add a condition on a query parameter, header, cookie, JSON value, GraphQL operation or body text'}
        >
          + condition
        </button>
      </div>
      {where.map((c, i) => (
        <WhereRow key={i} c={c} withSide={withSide} set={(next) => setWhere(where.map((x, j) => (j === i ? next : x)))} remove={() => setWhere(where.filter((_, j) => j !== i))} />
      ))}
      {urlOnly && where.some((c) => c.in !== 'query' && c.in !== 'path') && <div className="faint" style={{ padding: '0 12px 6px', fontSize: 12 }}>Message breakpoints only see the connection URL, so only path and query conditions apply.</div>}
    </>
  );
}

function SaveBar({ dirty, save, revert, add, addLabel }: { dirty: boolean; save(): void; revert(): void; add(): void; addLabel: string }) {
  useUnsaved(dirty, addLabel.replace(/^Add (a |an )?/i, '').toLowerCase() + ' edits');
  return (
    <div className="replay-bar">
      <button className="btn small" onClick={add}>
        <Icon name="plus" size={12} /> {addLabel}
      </button>
      <span style={{ flex: 1 }} />
      {dirty && <span className="muted" style={{ fontSize: 12 }}>Unsaved changes</span>}
      <button className="btn small" onClick={revert} disabled={!dirty}>
        Revert
      </button>
      <button className="btn small primary" onClick={save} disabled={!dirty}>
        Save
      </button>
    </div>
  );
}

// ---------------- Match and replace ----------------

export function ReplaceRules() {
  const { client, notify, selectedId } = useApp();
  const { data, load } = useRulesData();
  const [list, setList] = useState<Array<Keyed<ReplaceRule>>>([]);
  const [dirty, setDirty] = useState(false);
  const [test, setTest] = useState<{ key: string; matched: boolean; count: number; before: string; after: string } | null>(null);
  useEffect(() => {
    if (data && !dirty) setList(keyed(data.rules));
  }, [data, dirty]);
  const set = (k: string, p: Partial<ReplaceRule>) => {
    setList(list.map((r) => (r.key === k ? { ...r, ...p } : r)));
    setDirty(true);
  };
  const save = async () => {
    try {
      await client.setRules(list.map(strip));
      setDirty(false);
      await load();
      notify('Rules saved');
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const runTest = async (r: Keyed<ReplaceRule>) => {
    if (!selectedId) return notify('Select an exchange in Traffic to test against.');
    try {
      setTest({ key: r.key, ...(await client.testRule(strip(r), selectedId)) });
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <div className="rules-tool">
      <SaveBar
        dirty={dirty}
        save={() => void save()}
        revert={() => (setDirty(false), data && setList(keyed(data.rules)))}
        add={() => (setList([...list, { key: key(), name: 'New rule', enabled: true, phase: 'request', target: 'header', action: 'set', header: '' }]), setDirty(true))}
        addLabel="Add rule"
      />
      <div className="faint" style={{ padding: '6px 12px', fontSize: 12 }}>
        Rules run in order on in-scope traffic that is allowed to be modified, and on replays with Apply rules on. Replace text can use tokens such as {'{{cookie:session}}'} or {'{{var:csrf}}'}.
      </div>
      {list.length === 0 && <div className="empty">No match and replace rules yet.</div>}
      {list.map((r) => (
        <div key={r.key} className="card rule-card">
          <div className="rule-head">
            <input type="checkbox" checked={r.enabled !== false} onChange={(e) => set(r.key, { enabled: e.target.checked })} aria-label="Enabled" />
            <input className="input" value={r.name ?? ''} onChange={(e) => set(r.key, { name: e.target.value })} aria-label="Rule name" style={{ flex: '1 1 160px' }} />
            <select className="input" value={r.phase} onChange={(e) => set(r.key, { phase: e.target.value as ReplaceRule['phase'] })} aria-label="Phase">
              <option value="request">Request</option>
              <option value="response">Response</option>
            </select>
            <select className="input" value={r.target} onChange={(e) => set(r.key, { target: e.target.value as ReplaceRule['target'] })} aria-label="Target">
              <option value="header">Header</option>
              <option value="body">Body</option>
              <option value="url">URL</option>
              {r.phase === 'response' && <option value="status">Status</option>}
            </select>
            <span className="mono faint" title="Times this rule changed something since the core started">
              {r.id && data?.hits[r.id] ? `${data.hits[r.id]} hits` : '0 hits'}
            </span>
            <button className="btn small" onClick={() => void runTest(r)} title="Run this rule (unsaved edits included) against the exchange selected in Traffic">
              Test on selected
            </button>
            <button className="icon-btn" aria-label="Delete rule" onClick={() => (setList(list.filter((x) => x.key !== r.key)), setDirty(true))}>
              <Icon name="trash" size={13} />
            </button>
          </div>
          <Conditions r={r} set={(p) => set(r.key, p)} withStatus={r.phase === 'response'} withSide={r.phase === 'response'} />
          <div className="cond-row">
            <span className="label">Do</span>
            {r.target === 'header' && (
              <>
                <select className="input" value={r.action ?? 'replace'} onChange={(e) => set(r.key, { action: e.target.value as ReplaceRule['action'] })} aria-label="Action">
                  <option value="set">Set header</option>
                  <option value="replace">Replace in header</option>
                  <option value="remove">Remove header</option>
                </select>
                <input className="input mono" placeholder="Header name" value={r.header ?? ''} onChange={(e) => set(r.key, { header: e.target.value })} aria-label="Header" />
              </>
            )}
            {r.target === 'body' && (
              <>
                <input className="input mono" placeholder="codec chain: auto, json, base64>json" value={r.chain ?? ''} onChange={(e) => set(r.key, { chain: e.target.value })} aria-label="Codec chain" style={{ width: 200 }} />
                <input className="input mono" placeholder="JSONPath (optional): $.user.role" value={r.jsonPath ?? ''} onChange={(e) => set(r.key, { jsonPath: e.target.value })} aria-label="JSONPath" />
              </>
            )}
            {!(r.target === 'header' && r.action !== 'replace') && !r.jsonPath && (
              <input className="input mono" placeholder="Find" value={r.find ?? ''} onChange={(e) => set(r.key, { find: e.target.value })} aria-label="Find" />
            )}
            {!(r.target === 'header' && r.action === 'remove') && (
              <input className="input mono" placeholder={r.jsonPath ? 'New value (JSON or text)' : 'Replace with'} value={r.replace ?? ''} onChange={(e) => set(r.key, { replace: e.target.value })} aria-label="Replace with" />
            )}
            <TokenPicker label="Token" onPick={(t) => set(r.key, { replace: `${r.replace ?? ''}${t}` })} />
            {!r.jsonPath && r.action !== 'set' && r.action !== 'remove' && (
              <>
                <label className="check">
                  <input type="checkbox" checked={!!r.regex} onChange={(e) => set(r.key, { regex: e.target.checked })} /> Regex
                </label>
                <label className="check">
                  <input type="checkbox" checked={!!r.matchCase} onChange={(e) => set(r.key, { matchCase: e.target.checked })} /> Match case
                </label>
              </>
            )}
          </div>
          {test?.key === r.key && (
            <div className="rule-test">
              <div className="sec-head">
                {test.matched ? `${test.count} ${test.count === 1 ? 'change' : 'changes'} on the selected exchange` : 'The conditions do not match the selected exchange.'}
                <span style={{ flex: 1 }} />
                <button className="icon-btn" aria-label="Close test" onClick={() => setTest(null)}>
                  <Icon name="close" size={12} />
                </button>
              </div>
              {test.matched && (
                <pre className="raw" style={{ maxHeight: 240, overflow: 'auto' }}>
                  {diffLines(test.before, test.after)
                    .filter((l, i, all) => l.op !== '=' || all.slice(Math.max(0, i - 2), i + 3).some((x) => x.op !== '='))
                    .map((l, i) => (
                      <div key={i} className={l.op === '+' ? 'diff-add' : l.op === '-' ? 'diff-del' : undefined}>
                        {l.op === '=' ? '  ' : `${l.op} `}
                        {l.text}
                      </div>
                    ))}
                </pre>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------- Mocks ----------------

const headersToText = (h: Array<[string, string]> = []) => h.map(([k, v]) => `${k}: ${v}`).join('\n');
const textToHeaders = (t: string): Array<[string, string]> =>
  t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string];
    })
    .filter(([k]) => k);

export function Mocks() {
  const { client, notify } = useApp();
  const { data, load } = useRulesData();
  const [list, setList] = useState<Array<Keyed<MockRule> & { headersText: string }>>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (data && !dirty) setList(keyed(data.mocks).map((m) => ({ ...m, headersText: headersToText(m.headers) })));
  }, [data, dirty]);
  const set = (k: string, p: Partial<MockRule> & { headersText?: string }) => {
    setList(list.map((r) => (r.key === k ? { ...r, ...p } : r)));
    setDirty(true);
  };
  const save = async () => {
    try {
      await client.setMocks(list.map(({ headersText, ...m }) => ({ ...strip(m), headers: textToHeaders(headersText), status: Number(m.status) || 200 })));
      setDirty(false);
      await load();
      notify('Mocks saved');
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <div className="rules-tool">
      <SaveBar
        dirty={dirty}
        save={() => void save()}
        revert={() => setDirty(false)}
        add={() => (setList([...list, { key: key(), name: 'New mock', enabled: true, status: 200, headersText: 'Content-Type: application/json', body: '{}' }]), setDirty(true))}
        addLabel="Add mock"
      />
      <div className="faint" style={{ padding: '6px 12px', fontSize: 12 }}>
        A matching request gets this response without reaching the server. Make one from any recorded response with Mock in the inspector. Tokens in the body are resolved per request.
      </div>
      {list.length === 0 && <div className="empty">No mocks yet.</div>}
      {list.map((m) => (
        <div key={m.key} className="card rule-card">
          <div className="rule-head">
            <input type="checkbox" checked={m.enabled !== false} onChange={(e) => set(m.key, { enabled: e.target.checked })} aria-label="Enabled" />
            <input className="input" value={m.name ?? ''} onChange={(e) => set(m.key, { name: e.target.value })} aria-label="Mock name" style={{ flex: '1 1 160px' }} />
            <label className="check">
              Status
              <input className="input mono" type="number" value={m.status ?? 200} onChange={(e) => set(m.key, { status: Number(e.target.value) })} style={{ width: 72 }} aria-label="Status" />
            </label>
            <label className="check">
              Delay ms
              <input className="input mono" type="number" min={0} value={m.delayMs ?? 0} onChange={(e) => set(m.key, { delayMs: Number(e.target.value) || 0 })} style={{ width: 72 }} aria-label="Delay" />
            </label>
            <span className="mono faint">{m.id && data?.hits[m.id] ? `${data.hits[m.id]} served` : '0 served'}</span>
            <button className="icon-btn" aria-label="Delete mock" onClick={() => (setList(list.filter((x) => x.key !== m.key)), setDirty(true))}>
              <Icon name="trash" size={13} />
            </button>
          </div>
          <Conditions r={{ ...m, status: undefined }} set={({ status: _s, ...p }) => set(m.key, p)} />
          <div className="mock-split">
            <textarea className="editor" style={{ height: 90 }} spellCheck={false} value={m.headersText} onChange={(e) => set(m.key, { headersText: e.target.value })} aria-label="Mock headers" placeholder="Header: value" />
            <textarea className="editor" style={{ height: 90 }} spellCheck={false} value={m.body ?? ''} onChange={(e) => set(m.key, { body: e.target.value })} aria-label="Mock body" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------- Breakpoints and the paused queue ----------------

function responseRaw(p: Paused): string {
  const body = asText(base64ToBytes(p.message.bodyBase64)) ?? '';
  return [`${p.message.status ?? ''} ${p.message.statusMessage ?? ''}`.trim(), ...p.message.headers.map(([k, v]) => `${k}: ${v}`), '', body].join('\n');
}

function parseResponseRaw(raw: string) {
  const [head = '', ...rest] = raw.split(/\r?\n\r?\n/);
  const [first = '', ...lines] = head.split(/\r?\n/);
  const status = Number(first.trim().split(/\s+/)[0]);
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('The first line must start with a status code.');
  return { status, statusMessage: first.trim().split(/\s+/).slice(1).join(' ') || undefined, headers: textToHeaders(lines.join('\n')), body: rest.join('\n\n') };
}

function PausedQueue() {
  const { client, paused, notify } = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const [raw, setRaw] = useState('');
  const [rawFor, setRawFor] = useState<string | null>(null);
  // Parts shown decoded in place; encoded again on Forward.
  const dec = useRegions(raw, setRaw);
  const cur = paused.find((p) => p.id === selected) ?? paused[0];
  const [wsFormat, setWsFormat] = useState<'text' | 'base64'>('text');
  useEffect(() => {
    if (!cur || rawFor === cur.id) return;
    if (cur.phase === 'message') {
      const bytes = base64ToBytes(cur.message.bodyBase64);
      const text = cur.ws?.opcode === 'text' ? asText(bytes) : null;
      setWsFormat(text === null ? 'base64' : 'text');
      setRaw(text ?? cur.message.bodyBase64);
    } else setRaw(cur.phase === 'request' ? toRawRequest(cur.message.method, cur.message.url, cur.message.headers, asText(base64ToBytes(cur.message.bodyBase64)) ?? '') : responseRaw(cur));
    setRawFor(cur.id);
  }, [cur, rawFor]);
  if (!cur) return <div className="faint" style={{ padding: 12, fontSize: 12 }}>Nothing is paused. Matching traffic will wait here until you forward or drop it.</div>;

  const resolve = async (action: 'forward' | 'drop' | 'forward-pause-response') => {
    try {
      let edits: Record<string, unknown> | undefined;
      const raw = await dec.encoded();
      if (action !== 'drop') {
        if (cur.phase === 'message') {
          const bytes = wsFormat === 'text' ? new TextEncoder().encode(raw) : base64ToBytes(raw.replace(/\s+/g, ''));
          edits = { bodyBase64: bytesToBase64(bytes), opcode: wsFormat === 'text' ? 'text' : 'binary' };
        } else if (cur.phase === 'request') {
          const p = parseRawRequest(raw);
          edits = { method: p.method, url: p.url, headers: p.headers, bodyBase64: bytesToBase64(new TextEncoder().encode(p.body ?? '')) };
        } else {
          const p = parseResponseRaw(raw);
          edits = { status: p.status, statusMessage: p.statusMessage, headers: p.headers, bodyBase64: bytesToBase64(new TextEncoder().encode(p.body)) };
        }
      }
      await client.resolvePaused(cur.id, action, edits);
      setSelected(null);
      setRawFor(null);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  return (
    <div className="card" style={{ margin: '8px 12px' }} aria-label="Paused traffic">
      <div className="sec-head">
        <b style={{ color: 'var(--warn)' }}>{paused.length} paused</b>
        <span>Each one forwards unchanged after 5 minutes.</span>
        <span style={{ flex: 1 }} />
        <button className="btn small" onClick={() => client.releaseAll().catch((e: Error) => notify(e.message))}>
          Forward all
        </button>
      </div>
      <div className="paused-split">
        <div className="paused-list">
          {paused.map((p) => (
            <button key={p.id} className="saved-view" aria-pressed={p.id === cur.id} onClick={() => setSelected(p.id)} style={{ background: p.id === cur.id ? 'var(--bg-selected)' : undefined }}>
              <span>
                {p.phase === 'message' ? (
                  <>
                    <span className="badge">{p.ws?.direction === 'server' ? '↓ server message' : '↑ client message'}</span> <span className="mono m-WS">WS</span>
                  </>
                ) : (
                  <>
                    <span className="badge">{p.phase}</span> <span className={`mono m-${p.message.method}`}>{p.message.method}</span>
                  </>
                )}
              </span>
              <span className="mono faint" style={{ fontSize: 11 }}>
                {p.message.url.slice(0, 60)} · {fmtTime(p.pausedAt)}
              </span>
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {cur.phase === 'message' && (
            <div className="sec-head">
              <span>
                {cur.ws?.direction === 'server' ? 'From the server to the client' : 'From the client to the server'}
                {cur.ws && cur.ws.fragments > 1 ? `, sent in ${cur.ws.fragments} frames (an edit goes as one frame)` : ''}. Later messages on this side wait behind it.
              </span>
              <span style={{ flex: 1 }} />
              <div className="segmented" role="group" aria-label="Payload format">
                {(['text', 'base64'] as const).map((f) => (
                  <button
                    key={f}
                    className="seg"
                    aria-pressed={wsFormat === f}
                    onClick={() => {
                      if (f === wsFormat) return;
                      try {
                        setRaw(f === 'base64' ? bytesToBase64(new TextEncoder().encode(raw)) : (asText(base64ToBytes(raw.replace(/\s+/g, ''))) ?? raw));
                      } catch {
                        // leave the text as it is
                      }
                      setWsFormat(f);
                    }}
                  >
                    {f === 'text' ? 'Text' : 'Binary (base64)'}
                  </button>
                ))}
              </div>
            </div>
          )}
          <RegionEditor {...dec.editor} className="editor" style={{ height: 220 }} spellCheck={false} aria-label="Paused message" />
          <div className="replay-bar">
            <button className="btn small" onClick={() => void dec.decode()} title="Show the selection, or the value under the caret, decoded in place. It is encoded again on Forward. Ctrl D">
              Decode
            </button>
            <button className="btn primary small" onClick={() => void resolve('forward')}>
              Forward
            </button>
            {cur.phase === 'request' && (
              <button className="btn small" onClick={() => void resolve('forward-pause-response')}>
                Forward and pause response
              </button>
            )}
            <button className="btn small" onClick={() => void resolve('drop')}>
              Drop
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function KeepAliveSetting() {
  const { client, notify } = useApp();
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    client.keepAlivePaused().then(setMs).catch(() => setMs(0));
  }, [client]);
  const apply = (v: number) => {
    setMs(v);
    client.setKeepAlivePaused(v).then(setMs).catch((e: Error) => notify(e.message));
  };
  const on = (ms ?? 0) > 0;
  return (
    <div className="card" style={{ margin: '0 0 8px', padding: '8px 10px' }}>
      <label className="check" title="While a request or response is paused here, send PING frames on its HTTP/2 or HTTP/3 connections, to the client and the server, so neither times out while you compose an edit. HTTP/1.1 keeps its own sockets alive.">
        <input type="checkbox" checked={on} onChange={(e) => apply(e.target.checked ? 15000 : 0)} /> Keep HTTP/2 and HTTP/3 connections alive while paused
      </label>
      {on && (
        <label className="check" style={{ marginLeft: 12 }} title="Seconds between PING frames on a held connection">
          every
          <input
            className="input mono"
            type="number"
            min={1}
            max={120}
            value={Math.round((ms ?? 15000) / 1000)}
            onChange={(e) => apply(Math.max(1, Math.min(120, Number(e.target.value) || 15)) * 1000)}
            style={{ width: 56 }}
            aria-label="Keepalive interval seconds"
          />
          s
        </label>
      )}
    </div>
  );
}

export function Breakpoints() {
  const { client, notify } = useApp();
  const { data, load } = useRulesData();
  const [list, setList] = useState<Array<Keyed<Breakpoint>>>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (data && !dirty) setList(keyed(data.breakpoints));
  }, [data, dirty]);
  const set = (k: string, p: Partial<Breakpoint>) => {
    setList(list.map((r) => (r.key === k ? { ...r, ...p } : r)));
    setDirty(true);
  };
  const save = async () => {
    try {
      await client.setBreakpoints(list.map(strip));
      setDirty(false);
      await load();
      notify('Breakpoints saved');
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <div className="rules-tool">
      <PausedQueue />
      <KeepAliveSetting />
      <SaveBar
        dirty={dirty}
        save={() => void save()}
        revert={() => setDirty(false)}
        add={() => (setList([...list, { key: key(), enabled: true, phase: 'request' }]), setDirty(true))}
        addLabel="Add breakpoint"
      />
      {list.length === 0 && <div className="empty">No breakpoints. Add one here, or use Break in the inspector to pause the next call to an endpoint (or the messages of a WebSocket).</div>}
      {list.map((b) => (
        <div key={b.key} className="card rule-card">
          <div className="rule-head">
            <input type="checkbox" checked={b.enabled !== false} onChange={(e) => set(b.key, { enabled: e.target.checked })} aria-label="Enabled" />
            <select className="input" value={b.phase} onChange={(e) => set(b.key, { phase: e.target.value as Breakpoint['phase'] })} aria-label="Pause on">
              <option value="request">Pause requests</option>
              <option value="response">Pause responses</option>
              <option value="both">Pause both</option>
              <option value="messages">Pause WebSocket messages</option>
            </select>
            {b.phase === 'messages' && (
              <>
                <select className="input" value={b.direction ?? 'both'} onChange={(e) => set(b.key, { direction: e.target.value as Breakpoint['direction'] })} aria-label="Messages from">
                  <option value="both">from either side</option>
                  <option value="client">from the client</option>
                  <option value="server">from the server</option>
                </select>
                <input className="input mono" placeholder="containing (text or /regex/, empty = all)" value={b.match ?? ''} onChange={(e) => set(b.key, { match: e.target.value })} aria-label="Message contains" style={{ width: 260 }} />
              </>
            )}
            <span style={{ flex: 1 }} />
            <button className="icon-btn" aria-label="Delete breakpoint" onClick={() => (setList(list.filter((x) => x.key !== b.key)), setDirty(true))}>
              <Icon name="trash" size={13} />
            </button>
          </div>
          <Conditions r={b} set={(p) => set(b.key, p)} withStatus={b.phase === 'response' || b.phase === 'both'} withMethod={b.phase !== 'messages'} withSide={b.phase === 'response' || b.phase === 'both'} urlOnly={b.phase === 'messages'} />
        </div>
      ))}
    </div>
  );
}
