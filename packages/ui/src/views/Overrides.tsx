import { useCallback, useEffect, useState } from 'react';
import type { Breakpoint, MockRule, ReplaceRule, Script } from '../api';
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
export const OVERRIDE_META = new Set(['replaceRules', 'mocks', 'breakpoints', 'scripts']);

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
  const { client, notify, navigate, paused } = useApp();
  const [rows, setRows] = useState<OverrideRow[] | null>(null);
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

  if (!rows) return <div className="empty">Loading overrides...</div>;
  const enabled = rows.filter((r) => r.enabled).length;
  return (
    <div className="page-inner" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="muted" data-testid="override-summary">
        {rows.length === 0
          ? 'Nothing changes live traffic. Create a mock, replacement or breakpoint from any request (right-click it in Traffic), or from the pages above.'
          : `${rows.length} configured, ${enabled} on${paused.length ? `, ${paused.length} paused at a breakpoint` : ''}. These change traffic passing through the proxy. Replay sends skip them unless Apply rules is on in the editor.`}
      </div>
      {rows.length > 0 && (
        <table className="data-table" aria-label="Overrides">
          <thead>
            <tr>
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
              <tr key={r.key} data-testid="override-row" data-kind={r.kind}>
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
    </div>
  );
}
