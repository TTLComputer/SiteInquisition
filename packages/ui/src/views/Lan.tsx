import { usePlacement } from '../components/placement';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../state';
import type { LanState } from '../api';

function useLan() {
  const { client, connected } = useApp();
  const [state, setState] = useState<LanState | null>(null);
  const load = useCallback(() => void client.lan().then(setState, () => undefined), [client]);
  useEffect(() => {
    if (connected) load();
    return client.onChange((c) => {
      if (c.kind === 'lan.changed') setState(c.data as LanState);
    });
  }, [client, connected, load]);
  return [state, setState] as const;
}

/** Title bar: other machines that tried to connect and are waiting to be let in. */
export function LanChip() {
  const { client, notify } = useApp();
  const [state, setState] = useLan();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  usePlacement(pop, chip, open);
  const pending = state?.pending ?? [];
  useEffect(() => {
    if (!pending.length) setOpen(false);
  }, [pending.length]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!pending.length) return null;
  const act = (p: Promise<LanState>, msg: string) => p.then((s) => (setState(s), notify(msg)), (e: Error) => notify(e.message));
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button ref={chip} className="chip-btn attention" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="lan-chip">
        <span className="dot" style={{ background: 'var(--warn)' }} />
        {pending.length === 1 ? `${pending[0]!.address} wants to connect` : `${pending.length} devices want to connect`}
      </button>
      {open && (
        <div ref={pop} className="approval-pop">
          {pending.map((p) => (
            <div key={p.address} className="card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div>
                <span className="mono">{p.address}</span> <span className="muted">tried {p.via}</span>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                Refused {p.attempts} time{p.attempts === 1 ? '' : 's'} since {new Date(p.firstSeen).toLocaleTimeString()}. Once allowed, its next connection goes through.
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn small primary" onClick={() => act(client.lanAllow(p.address), `${p.address} can now connect`)}>
                  Allow
                </button>
                <button className="btn small" onClick={() => act(client.lanDeny(p.address), `Still refusing ${p.address}`)}>
                  Keep refusing
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Settings, Proxy: the LAN allow list. */
export function LanSettings() {
  const { client, notify } = useApp();
  const [state, setState] = useLan();
  const [draft, setDraft] = useState('');
  if (!state) return <>...</>;
  if (!state.enabled) return <>Refused: only this computer can connect. Start with --lan to accept phones and IoT devices; each one then needs your approval.</>;
  const act = (p: Promise<LanState>) => p.then(setState, (e: Error) => notify(e.message));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="muted">Listening on all interfaces. Devices not listed here are refused and show up in the title bar for you to allow.</span>
      {state.allowed.map((a) => (
        <span key={a} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="mono">{a}</span>
          <button className="btn small" onClick={() => act(client.lanRemove(a))}>
            Remove
          </button>
        </span>
      ))}
      <form
        style={{ display: 'flex', gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          void act(client.lanAllow(draft.trim())).then(() => setDraft(''));
        }}
      >
        <input className="input mono" placeholder="192.168.1.42 or 192.168.1.0/24" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Address or range to allow" />
        <button className="btn small" type="submit">
          Allow
        </button>
      </form>
    </div>
  );
}
