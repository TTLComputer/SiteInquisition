import { useCallback, useEffect, useState } from 'react';
import { useUnsaved } from '../unsaved';
import type { ScopeConfig, ScopeRule, SeenHost } from '../api';
import { useApp } from '../state';
import { Icon } from '../components/icons';
import { fmtTime } from '../format';


type RuleDraft = Omit<ScopeRule, 'id'> & { id?: string; key: string };

let nextKey = 1;
const draftOf = (r: ScopeRule): RuleDraft => ({ ...r, key: r.id });
const newRule = (host: string, extra: Partial<RuleDraft> = {}): RuleDraft => ({ key: `new-${nextKey++}`, action: 'include', host, decrypt: true, record: true, modify: true, enabled: true, ...extra });

/** TLS handshake failure causes (from the core's interceptor) that usually mean the client refuses our CA, e.g. certificate pinning. */
const PINNING_CAUSES = new Set(['cert-rejected', 'closed', 'reset']);

function Flag({ value, onChange, label, disabled }: { value: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  return <input type="checkbox" aria-label={label} checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
}

export function ScopeEditor() {
  const { client, scope, notify } = useApp();
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [defaultAction, setDefaultAction] = useState<ScopeConfig['defaultAction']>('ignore');
  const [dirty, setDirty] = useState(false);
  useUnsaved(dirty, 'scope rules');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [seen, setSeen] = useState<SeenHost[]>([]);
  const [failures, setFailures] = useState<Array<{ host: string | null; cause: string; count: number; lastAt: number }>>([]);

  // Follow the core's scope unless there are unsaved edits.
  useEffect(() => {
    if (!scope || dirty) return;
    setRules(scope.rules.map(draftOf));
    setDefaultAction(scope.defaultAction);
  }, [scope, dirty]);

  const loadSide = useCallback(() => {
    client.seen().then(setSeen, () => undefined);
    client.tlsFailures().then(setFailures, () => undefined);
  }, [client]);
  useEffect(() => {
    loadSide();
    const t = window.setInterval(loadSide, 5000);
    return () => window.clearInterval(t);
  }, [loadSide]);

  const edit = (next: RuleDraft[]) => {
    setRules(next);
    setDirty(true);
  };
  const patch = (key: string, p: Partial<RuleDraft>) => edit(rules.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j]!, next[i]!];
    edit(next);
  };

  const save = async (nextRules = rules, nextDefault = defaultAction) => {
    setSaving(true);
    setError(null);
    try {
      const config: ScopeConfig = {
        defaultAction: nextDefault,
        rules: nextRules.map(({ key: _key, ...r }) => {
          const out = { ...r } as ScopeRule;
          if (!out.id) delete (out as Partial<ScopeRule>).id;
          if (!out.pathPrefix) delete out.pathPrefix;
          if (!out.port) delete out.port;
          if (!out.scheme) delete out.scheme;
          return out;
        }),
      };
      const saved = await client.setScope(config);
      setRules(saved.rules.map(draftOf));
      setDefaultAction(saved.defaultAction);
      setDirty(false);
      notify('Scope saved');
      loadSide();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const addSeen = (host: string) => {
    const next = [...rules, newRule(host)];
    void save(next);
  };

  const pinned = failures.filter((f) => f.host && PINNING_CAUSES.has(f.cause) && !rules.some((r) => r.host === f.host && r.decrypt === false));

  return (
    <div className="page-inner">
      <div style={{ flex: '3 1 640px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {pinned.map((f) => (
          <div className="banner" key={`${f.host}-${f.cause}`} role="alert">
            <span>
              <b>{f.host}</b> rejected our certificate {f.count} {f.count === 1 ? 'time' : 'times'} ({f.cause}, last at {fmtTime(f.lastAt)}). The client may pin its certificate.
            </span>
            <button className="btn small" onClick={() => void save([newRule(f.host!, { decrypt: false, record: false, modify: false }), ...rules])}>
              Pass through without decrypting
            </button>
          </div>
        ))}
        <div className="card" style={{ overflowX: 'auto' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 12px' }}>
            <span className="panel-title">Scope</span>
            <span className="muted" style={{ fontSize: 12 }}>
              First matching rule wins. Hosts are globs: <span className="mono">*.example.com</span>
            </span>
            <span style={{ flex: 1 }} />
            <label className="muted" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
              Everything else
              <select
                className="input"
                style={{ height: 26 }}
                value={defaultAction}
                onChange={(e) => {
                  setDefaultAction(e.target.value as ScopeConfig['defaultAction']);
                  setDirty(true);
                }}
              >
                <option value="ignore">pass through, not recorded</option>
                <option value="record">record (no decryption)</option>
              </select>
            </label>
          </div>
          <div className="scope-grid head">
            <span>On</span>
            <span>Action</span>
            <span>Host</span>
            <span>Port</span>
            <span>Path prefix</span>
            <span>Decrypt</span>
            <span>Record</span>
            <span>Modify</span>
            <span className="sr-only">Order</span>
          </div>
          {rules.length === 0 && <div className="empty">No rules yet, so nothing is decrypted or recorded. Add a host below or from the seen list.</div>}
          {rules.map((r, i) => {
            const inc = r.action === 'include';
            return (
              <div className="scope-grid item" key={r.key} data-testid="scope-rule">
                <button className="switch" role="switch" aria-checked={r.enabled !== false} aria-label={`Rule ${r.host || i + 1} enabled`} onClick={() => patch(r.key, { enabled: r.enabled === false })} />
                <select value={r.action} aria-label="Action" className={inc ? 'kind-include' : 'kind-exclude'} onChange={(e) => patch(r.key, { action: e.target.value as ScopeRule['action'] })}>
                  <option value="include">include</option>
                  <option value="exclude">exclude</option>
                </select>
                <input type="text" aria-label="Host pattern" value={r.host} placeholder="*.example.com" onChange={(e) => patch(r.key, { host: e.target.value })} />
                <input
                  type="number"
                  aria-label="Port"
                  value={r.port ?? ''}
                  placeholder="any"
                  min={1}
                  max={65535}
                  onChange={(e) => patch(r.key, { port: e.target.value ? Number(e.target.value) : undefined })}
                />
                <input type="text" aria-label="Path prefix" value={r.pathPrefix ?? ''} placeholder="/" onChange={(e) => patch(r.key, { pathPrefix: e.target.value || undefined })} />
                <Flag label="Decrypt" value={inc && r.decrypt !== false} disabled={!inc} onChange={(v) => patch(r.key, { decrypt: v })} />
                <Flag label="Record" value={inc && r.record !== false} disabled={!inc} onChange={(v) => patch(r.key, { record: v })} />
                <Flag label="Modify" value={inc && r.modify !== false} disabled={!inc} onChange={(v) => patch(r.key, { modify: v })} />
                <span style={{ display: 'flex' }}>
                  <button className="icon-btn" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                    <Icon name="up" size={13} />
                  </button>
                  <button className="icon-btn" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === rules.length - 1}>
                    <Icon name="down" size={13} />
                  </button>
                  <button className="icon-btn" aria-label="Delete rule" onClick={() => edit(rules.filter((x) => x.key !== r.key))}>
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              </div>
            );
          })}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12, borderTop: '1px solid var(--line-soft)', alignItems: 'center' }}>
            <button className="btn small" onClick={() => edit([...rules, newRule('')])}>
              <Icon name="plus" size={13} /> Add rule
            </button>
            <span style={{ flex: 1 }} />
            {error && <span className="error-text" role="alert">{error}</span>}
            {dirty && (
              <button
                className="btn small"
                onClick={() => {
                  setDirty(false);
                  setError(null);
                }}
              >
                Discard
              </button>
            )}
            <button className="btn small primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Saving...' : 'Save scope'}
            </button>
          </div>
        </div>
        <p className="faint" style={{ fontSize: 12, margin: 0 }}>
          Changing which hosts are decrypted restarts the proxy listener on the same port; open connections reconnect.
        </p>
      </div>
      <div className="card" style={{ flex: '1 1 280px', padding: 12, minWidth: 0 }}>
        <div className="panel-title" style={{ marginBottom: 4 }}>
          Seen but not in scope
        </div>
        <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>
          Hosts that sent traffic through the proxy since it started.
        </div>
        {seen.length === 0 && <div className="muted" style={{ fontSize: 12 }}>Nothing yet.</div>}
        {seen.map((s) => (
          <div className="seen-row" key={s.host} data-testid="seen-host">
            <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.host}>
              {s.host}
            </span>
            <span className="faint mono" style={{ fontSize: 11 }}>
              {s.kinds.join(' ')} · {s.count}
            </span>
            <button className="btn small" onClick={() => addSeen(s.host)} disabled={saving} aria-label={`Add ${s.host} to scope`}>
              Add
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
