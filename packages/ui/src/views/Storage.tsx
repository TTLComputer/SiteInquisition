import { useEffect, useState } from 'react';
import { useApp } from '../state';

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;

/** Settings, Storage: how much traffic the project keeps, and deleting it. */
export function StorageSettings({ Row }: { Row: (p: { label: string; children: React.ReactNode }) => React.ReactElement }) {
  const { client, info, notify } = useApp();
  const [age, setAge] = useState('');
  const [size, setSize] = useState('');
  const [saved, setSaved] = useState<{ maxAgeDays?: number; maxSizeMB?: number } | null>(null);
  const [stats, setStats] = useState(info?.stats);
  const refresh = () => void client.call<{ exchanges: number; databaseBytes: number }>('traffic.stats').then(setStats, () => undefined);
  useEffect(() => {
    void client.retention().then((r) => {
      setSaved(r);
      setAge(r.maxAgeDays ? String(r.maxAgeDays) : '');
      setSize(r.maxSizeMB ? String(r.maxSizeMB) : '');
    }, (e: Error) => notify(e.message));
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  const dirty = saved !== null && (String(saved.maxAgeDays ?? '') !== age.trim() || String(saved.maxSizeMB ?? '') !== size.trim());
  const save = () => {
    const n = (v: string) => (v.trim() ? Number(v) : undefined);
    const next = { maxAgeDays: n(age), maxSizeMB: n(size) };
    if (Object.values(next).some((v) => v !== undefined && !(v > 0))) return notify('Limits must be positive numbers, or empty for no limit');
    const before = stats?.exchanges ?? 0;
    client.setRetention(next).then(
      (r) => {
        setSaved(r);
        void client.call<{ exchanges: number; databaseBytes: number }>('traffic.stats').then((s) => {
          setStats(s);
          notify(before > s.exchanges ? `Saved. ${before - s.exchanges} old requests deleted.` : 'Saved');
        });
      },
      (e: Error) => notify(e.message),
    );
  };
  return (
    <>
      <div className="panel-title" style={{ padding: '12px 14px' }}>
        Storage
      </div>
      <Row label="Recorded">{stats ? `${stats.exchanges.toLocaleString()} requests, ${mb(stats.databaseBytes)} on disk` : '...'}</Row>
      <Row label="Database">
        <span className="mono">{info?.projectDir}</span>
        <span className="muted"> · readable only by your user account</span>
      </Row>
      <Row label="Keep traffic">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="muted">
            for{' '}
            <input className="input" style={{ width: 70 }} inputMode="numeric" placeholder="ever" value={age} onChange={(e) => setAge(e.target.value)} aria-label="Days to keep traffic" /> days
          </label>
          <label className="muted">
            up to <input className="input" style={{ width: 80 }} inputMode="numeric" placeholder="no limit" value={size} onChange={(e) => setSize(e.target.value)} aria-label="Most MB of bodies to keep" /> MB of bodies
          </label>
          <button className="btn small primary" disabled={!dirty} onClick={save}>
            Save
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Older requests are deleted when you save, when the app starts and every hour. Leave both empty to keep everything.
        </div>
      </Row>
      <Row label="Delete">
        <button
          className="btn small danger"
          onClick={() => {
            if (!window.confirm('Delete all recorded traffic in this project?\n\nScope, rules, scripts, flows and settings stay. This cannot be undone.')) return;
            client.clearTraffic().then(
              (r) => {
                notify(`Deleted ${r.deleted} requests`);
                refresh();
              },
              (e: Error) => notify(e.message),
            );
          }}
        >
          Clear project traffic
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {' '}
          To delete some of it, filter History and use Delete matching.
        </span>
      </Row>
    </>
  );
}
