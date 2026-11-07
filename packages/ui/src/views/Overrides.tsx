import { useCallback, useEffect, useState } from 'react';
import type { Breakpoint, MockRule, OverrideGroup, OverrideState, ReplaceRule, Script } from '../api';
import { useApp } from '../state';

/** One thing that changes live traffic, whichever engine runs it. */
export interface OverrideRow {
  key: string;
  kind: 'mock' | 'replace' | 'breakpoint' | 'hook';
  id: string;
  name: string;
  target: string;
  phase: string;
  enabled: boolean;
  hits?: number;
  /** The page that edits it. */
  page: 'mocks' | 'replace' | 'breakpoints' | 'hooks';
}

/** Project metadata keys that hold overrides; a change to any of them redraws the list. */
export const OVERRIDE_META = new Set(['replaceRules', 'mocks', 'breakpoints', 'scripts', 'overridesSuspended', 'overrideGroups']);

/** The master switch and groups, kept current for everyone looking at the project. */
export function useOverrideState(): [OverrideState | null, () => Promise<void>] {
  const { client, connected } = useApp();
  const [state, setState] = useState<OverrideState | null>(null);
  const load = useCallback(async () => {
    try {
      setState(await client.overrideState());
    } catch {
      // older core, or not connected yet
    }
  }, [client]);
  useEffect(() => {
    if (!connected) return;
    void load();
    return client.onChange((c) => {
      if (c.kind === 'meta.set' && (c.entityId === 'overridesSuspended' || c.entityId === 'overrideGroups')) void load();
    });
  }, [client, connected, load]);
  return [state, load];
}

const KIND_LABEL: Record<OverrideRow['kind'], string> = { mock: 'Mock', replace: 'Replace', breakpoint: 'Breakpoint', hook: 'Live hook' };

const target = (r: { host?: string; method?: string; path?: string; pathPrefix?: string }) =>
  [r.method || 'any method', r.host || 'any host', r.path || (r.pathPrefix ? `${r.pathPrefix}…` : '')].filter(Boolean).join(' ');

export function overrideRows(data: { rules: ReplaceRule[]; mocks: MockRule[]; breakpoints: Breakpoint[]; hits: Record<string, number> }, scripts: Script[]): OverrideRow[] {
  return [
    ...data.mocks.map<OverrideRow>((m) => ({ key: `mock:${m.id}`, kind: 'mock', id: m.id, name: m.name, target: target(m), phase: 'answers the request', enabled: m.enabled !== false, hits: data.hits[m.id] ?? 0, page: 'mocks' })),
    ...data.rules.map<OverrideRow>((r) => ({ key: `replace:${r.id}`, kind: 'replace', id: r.id, name: r.name, target: target(r), phase: `${r.phase} ${r.target}`, enabled: r.enabled !== false, hits: data.hits[r.id] ?? 0, page: 'replace' })),
    ...data.breakpoints.map<OverrideRow>((b) => ({
      key: `bp:${b.id}`,
      kind: 'breakpoint',
      id: b.id,
      name: b.phase === 'messages' ? `Pause ${b.direction ?? 'both'} messages` : `Pause ${b.phase === 'both' ? 'request and response' : b.phase}`,
      target: target(b),
      phase: b.phase,
      enabled: b.enabled !== false,
      page: 'breakpoints',
    })),
    ...scripts.filter((s) => s.kind === 'hook').map<OverrideRow>((s) => ({ key: `hook:${s.id}`, kind: 'hook', id: s.id, name: s.name, target: 'all traffic in scope', phase: 'request and response', enabled: s.enabled !== false, page: 'hooks' })),
  ];
}

/** Overrides > Active: every mock, replacement, breakpoint and live hook in one list, with its state. */
export function ActiveOverrides() {
  const { client, notify, navigate, paused, ask } = useApp();
  const [rows, setRows] = useState<OverrideRow[] | null>(null);
  const [state, reloadState] = useOverrideState();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([client.rules(), client.scripts()]);
      setRows(overrideRows(r, s.scripts));
    } catch (e) {
      notify((e as Error).message);
    }
  }, [client, notify]);
  useEffect(() => {
    void load();
    return client.onChange((c) => {
      if (c.kind === 'meta.set' && OVERRIDE_META.has(c.entityId)) void load();
    });
  }, [client, load]);

  const toggle = async (row: OverrideRow, on: boolean) => {
    try {
      if (row.kind === 'hook') {
        const { scripts } = await client.scripts();
        await client.setScripts(scripts.map((s) => (s.id === row.id ? { ...s, enabled: on } : s)));
      } else {
        const r = await client.rules();
        if (row.kind === 'mock') await client.setMocks(r.mocks.map((m) => (m.id === row.id ? { ...m, enabled: on } : m)));
        if (row.kind === 'replace') await client.setRules(r.rules.map((m) => (m.id === row.id ? { ...m, enabled: on } : m)));
        if (row.kind === 'breakpoint') await client.setBreakpoints(r.breakpoints.map((m) => (m.id === row.id ? { ...m, enabled: on } : m)));
      }
      await load();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const suspend = async (on: boolean) => {
    try {
      await client.suspendOverrides(on);
      await reloadState();
      notify(on ? 'Overrides suspended. Their own switches are unchanged; traffic already paused stays paused.' : 'Overrides resumed');
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const refOf = (key: string) => {
    const r = rows?.find((x) => x.key === key);
    return r ? { kind: r.kind, id: r.id } : null;
  };
  const nameOf = (m: { kind: string; id: string }) => rows?.find((r) => r.kind === m.kind && r.id === m.id)?.name ?? `${m.kind} (deleted)`;

  const makeGroup = async () => {
    const name = groupName;
    if (!name.trim()) return notify('Name the group first');
    const members = [...picked].map(refOf).filter((m): m is NonNullable<ReturnType<typeof refOf>> => !!m);
    try {
      await client.setOverrideGroups([...(state?.groups ?? []), { name: name.trim(), members }]);
      setPicked(new Set());
      setGroupName('');
      await reloadState();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const deleteGroup = async (g: OverrideGroup) => {
    try {
      await client.setOverrideGroups((state?.groups ?? []).filter((x) => x.id !== g.id));
      await reloadState();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  /** Shows what would change first, including members shared with other groups, then changes all of them or none. */
  const applyGroup = async (g: OverrideGroup, on: boolean) => {
    try {
      const plan = await client.applyOverrideGroup(g.id, on, true);
      if (!plan.changed.length) return notify(`Every member of ${g.name} is already ${on ? 'on' : 'off'}`);
      if (plan.shared.length) {
        const text = `${plan.changed.length} will turn ${on ? 'on' : 'off'}. Also in other groups: ${plan.shared.map((m) => `${nameOf(m)} (${m.groups.join(', ')})`).join('; ')}.`;
        if ((await ask({ title: `Turn ${on ? 'on' : 'off'} ${g.name}?`, text, choices: [{ id: 'cancel', label: 'Cancel' }, { id: 'go', label: `Turn ${on ? 'on' : 'off'}`, primary: true }] })) !== 'go') return;
      }
      const done = await client.applyOverrideGroup(g.id, on);
      notify(`${g.name}: turned ${on ? 'on' : 'off'} ${done.changed.map(nameOf).join(', ')}`);
      await load();
    } catch (e) {
      // All or nothing: the core changed nothing.
      notify((e as Error).message);
    }
  };

  if (!rows) return <div className="empty">Loading overrides...</div>;
  const enabled = rows.filter((r) => r.enabled).length;
  const suspended = !!state?.suspended;
  return (
    <div className="page-inner" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className={`card override-master${suspended ? ' suspended' : ''}`} data-testid="override-master">
        <button className="switch" role="switch" aria-checked={!suspended} aria-label={suspended ? 'Resume all overrides' : 'Suspend all overrides'} onClick={() => void suspend(!suspended)} />
        <div>
          <b>{suspended ? 'All overrides suspended' : 'Overrides active'}</b>
          <div className="faint">
            {suspended
              ? `Since ${state?.suspendedAt ? new Date(state.suspendedAt).toLocaleTimeString() : 'earlier'}. Traffic passes through unchanged and nothing new pauses. Each override keeps its own switch, so resuming puts back exactly what was on.${paused.length ? ` ${paused.length} already paused stay paused until you answer them.` : ''}`
              : 'Suspend to see the real traffic without turning anything off one by one. Reopening the project keeps it suspended.'}
          </div>
        </div>
      </div>
      <div className="muted" data-testid="override-summary">
        {rows.length === 0
          ? 'Nothing changes live traffic. Create a mock, replacement or breakpoint from any request (right-click it in Traffic), or from the pages above.'
          : `${rows.length} configured, ${enabled} on${paused.length ? `, ${paused.length} paused at a breakpoint` : ''}. These change traffic passing through the proxy. Replay sends skip them unless Apply rules is on in the editor.`}
      </div>
      {rows.length > 0 && (
        <table className="data-table" aria-label="Overrides">
          <thead>
            <tr>
              <th>
                <span className="sr-only">Pick for a group</span>
              </th>
              <th>On</th>
              <th>Kind</th>
              <th>Name</th>
              <th>Matches</th>
              <th>Acts on</th>
              <th>Hits</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-testid="override-row" data-kind={r.kind} className={suspended ? 'faint' : undefined}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Pick ${KIND_LABEL[r.kind]} ${r.name} for a group`}
                    checked={picked.has(r.key)}
                    onChange={(e) => setPicked((p) => {
                      const n = new Set(p);
                      if (e.target.checked) n.add(r.key);
                      else n.delete(r.key);
                      return n;
                    })}
                  />
                </td>
                <td>
                  <button className="switch" role="switch" aria-checked={r.enabled} aria-label={`${r.enabled ? 'Turn off' : 'Turn on'} ${KIND_LABEL[r.kind]} ${r.name}`} onClick={() => void toggle(r, !r.enabled)} />
                </td>
                <td>
                  <span className="badge">{KIND_LABEL[r.kind]}</span>
                </td>
                <td>{r.name}</td>
                <td className="wrap">{r.target}</td>
                <td>{r.phase}</td>
                <td>{r.hits === undefined ? '' : r.hits}</td>
                <td>
                  <button className="btn small" onClick={() => navigate({ area: 'overrides', page: r.page })}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 0 && (
        <div className="filterbar">
          <input className="input" placeholder="Group name, e.g. Checkout outage" aria-label="New group name" value={groupName} onChange={(e) => setGroupName(e.target.value)} style={{ width: 260 }} />
          <button className="btn small" disabled={!picked.size || !groupName.trim()} onClick={() => void makeGroup()} title="Turn the picked overrides on or off together later">
            Group {picked.size || ''} picked
          </button>
        </div>
      )}
      {!!state?.groups.length && (
        <>
          <div className="panel-title" style={{ margin: '12px 0 4px' }}>
            Groups
          </div>
          <table className="data-table" aria-label="Override groups">
            <tbody>
              {state.groups.map((g) => {
                const members = g.members.map((m) => rows.find((r) => r.kind === m.kind && r.id === m.id));
                const on = members.filter((m) => m?.enabled).length;
                const missing = members.filter((m) => !m).length;
                return (
                  <tr key={g.id} data-testid="override-group">
                    <td>
                      <b>{g.name}</b>
                    </td>
                    <td className="wrap">
                      {g.members.map(nameOf).join(', ')}
                      {missing > 0 && <span className="s-4"> · {missing} deleted, edit the group</span>}
                    </td>
                    <td>{on === g.members.length ? 'all on' : on === 0 ? 'all off' : `${on} of ${g.members.length} on`}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn small" onClick={() => void applyGroup(g, true)}>
                        Turn on
                      </button>{' '}
                      <button className="btn small" onClick={() => void applyGroup(g, false)}>
                        Turn off
                      </button>{' '}
                      <button className="btn small ghost" aria-label={`Delete group ${g.name}`} onClick={() => void deleteGroup(g)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/** Title bar chip: says plainly when overrides are suspended, wherever you are. */
export function OverridesChip() {
  const { navigate } = useApp();
  const [state] = useOverrideState();
  if (!state?.suspended) return null;
  return (
    <button className="chip-btn attention" data-testid="overrides-suspended-chip" onClick={() => navigate('overrides/active')} title="Mocks, replacements, breakpoints and live hooks are not running">
      <span className="dot" style={{ background: 'var(--warn)' }} />
      Overrides suspended
    </button>
  );
}
