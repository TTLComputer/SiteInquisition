import { useEffect, useState } from 'react';
import type { FramePreset, PlanStep } from '../api';
import { base64ToBytes, bytesToBase64 } from '../api';
import { useApp } from '../state';

const OPCODES = ['text', 'binary', 'continuation', 'close', 'ping', 'pong', 3, 4, 5, 6, 7, 11, 12, 13, 14, 15] as const;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const enc = new TextEncoder();

/** A payload shown as text when it is clean UTF-8, otherwise as hex. */
function showPayload(b64: string): { text: string; hex: boolean } {
  const bytes = base64ToBytes(b64);
  try {
    const t = utf8.decode(bytes);
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(t)) return { text: t, hex: false };
  } catch {
    // not UTF-8
  }
  return { text: [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' '), hex: true };
}

function readPayload(text: string, hex: boolean): string {
  if (!hex) return bytesToBase64(enc.encode(text));
  const clean = text.replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2) throw new Error('hex needs an even number of digits');
  return bytesToBase64(new Uint8Array(clean.match(/../g)?.map((h) => parseInt(h, 16)) ?? []));
}

function PayloadCell({ value, onChange }: { value: string; onChange(b64: string): void }) {
  const shown = showPayload(value);
  const [hex, setHex] = useState(shown.hex);
  const [text, setText] = useState(shown.text);
  const [bad, setBad] = useState(false);
  // Follow outside changes (a rebuilt plan) without fighting the user's typing.
  useEffect(() => {
    try {
      if (readPayload(text, hex) === value) return;
    } catch {
      // mid-edit hex; fall through and resync
    }
    const s = showPayload(value);
    setHex(s.hex);
    setText(s.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const toggle = () => {
    const bytes = base64ToBytes(value);
    if (hex) {
      try {
        setText(utf8.decode(bytes));
        setHex(false);
      } catch {
        notifyInvalid();
      }
    } else {
      setText([...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' '));
      setHex(true);
    }
  };
  const notifyInvalid = () => setBad(true);
  return (
    <span style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 160 }}>
      <input
        className="input mono"
        aria-label="Frame payload"
        style={{ flex: 1, minWidth: 0, borderColor: bad ? 'var(--err)' : undefined }}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(readPayload(e.target.value, hex));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      <button className="seg" aria-pressed={hex} title="Edit as hex (stays hex when the bytes are not UTF-8)" onClick={toggle}>
        hex
      </button>
    </span>
  );
}

/**
 * Build and send exact WebSocket frames: start from a preset (fragmenting,
 * control frames, malformed frames, timing), edit any field of any frame,
 * then send. On a connection the proxy is relaying, frames can go to either
 * side; on a replay connection they go to the server.
 */
export function FramePlanner({ exchangeId, payload, opcode, proxied }: { exchangeId: string; payload: () => Uint8Array; opcode: 'text' | 'binary'; proxied: boolean }) {
  const { client, notify } = useApp();
  const [presets, setPresets] = useState<FramePreset[]>([]);
  const [preset, setPreset] = useState('fragment');
  const [options, setOptions] = useState<Record<string, number | string>>({});
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [to, setTo] = useState<'server' | 'client'>('server');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void client.framePresets().then(setPresets, () => undefined);
  }, [client]);
  const info = presets.find((p) => p.id === preset);
  useEffect(() => {
    setOptions(Object.fromEntries((info?.options ?? []).map((o) => [o.key, o.default])));
  }, [info]);

  const build = async () => {
    try {
      setSteps(await client.buildFramePlan(preset, payload(), opcode, options));
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const update = (i: number, patch: Partial<PlanStep>) => setSteps((s) => s.map((x, j) => (j === i ? ({ ...x, ...patch } as PlanStep) : x)));
  const move = (i: number, d: -1 | 1) =>
    setSteps((s) => {
      const j = i + d;
      if (j < 0 || j >= s.length) return s;
      const c = [...s];
      [c[i], c[j]] = [c[j]!, c[i]!];
      return c;
    });

  const send = async () => {
    setBusy(true);
    try {
      const sent = await client.sendFramePlan(exchangeId, steps, proxied ? to : undefined);
      notify(`Sent ${sent.length} of ${steps.length} steps${sent.length < steps.length ? ' (the connection closed first)' : ''}`);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const numInput = (value: number | undefined, set: (v: number | undefined) => void, label: string, width = 64) => (
    <input
      className="input mono"
      aria-label={label}
      style={{ width }}
      inputMode="numeric"
      value={value ?? ''}
      placeholder="-"
      onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))}
    />
  );

  return (
    <div className="frame-planner" aria-label="Frame plan">
      <div className="composer-row">
        <select className="input" aria-label="Frame preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {(info?.options ?? []).map((o) => (
          <label key={o.key} className="check">
            {o.label}
            <input
              className="input mono"
              style={{ width: typeof o.default === 'number' ? 70 : 140 }}
              aria-label={o.label}
              value={options[o.key] ?? ''}
              onChange={(e) => setOptions({ ...options, [o.key]: typeof o.default === 'number' ? Number(e.target.value) : e.target.value })}
            />
          </label>
        ))}
        <button className="btn small" onClick={() => void build()} title="Turn the payload below into frames with this preset">
          Build frames
        </button>
        <span style={{ flex: 1 }} />
        {proxied && (
          <select className="input" aria-label="Send to" value={to} onChange={(e) => setTo(e.target.value as 'server' | 'client')}>
            <option value="server">To the server, as the client</option>
            <option value="client">To the client, as the server</option>
          </select>
        )}
        <button className="btn primary small" disabled={!steps.length || busy} onClick={() => void send()}>
          {busy ? 'Sending…' : `Send ${steps.length || ''} ${steps.length === 1 ? 'step' : 'steps'}`}
        </button>
      </div>
      {info && <div className="faint" style={{ fontSize: 12, padding: '0 12px 6px' }}>{info.expect}</div>}
      {steps.length > 0 && (
        <div style={{ maxHeight: 240, overflow: 'auto', borderTop: '1px solid var(--line-soft)' }}>
          <table className="msg-table frame-table">
            <thead>
              <tr>
                <th>#</th>
                <th title="Wait before this step">Delay ms</th>
                <th>Opcode</th>
                <th>FIN</th>
                <th title="Reserved bits">RSV 1 2 3</th>
                <th>Mask</th>
                <th title="Length field size">Length</th>
                <th title="Claim this payload length instead of the real one">Claimed</th>
                <th title="Send only this many bytes of the frame">Cut at</th>
                <th>Payload</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {steps.map((s, i) => (
                <tr key={i}>
                  <td className="faint">{i + 1}</td>
                  <td>{numInput(s.delayMs, (v) => update(i, { delayMs: v }), `Delay before step ${i + 1}`)}</td>
                  {s.kind === 'frame' ? (
                    <>
                      <td>
                        <select className="input" aria-label={`Opcode of step ${i + 1}`} value={String(s.opcode)} onChange={(e) => update(i, { opcode: /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value })}>
                          {OPCODES.map((o) => (
                            <option key={o} value={String(o)}>
                              {typeof o === 'number' ? `op${o} (reserved)` : o}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input type="checkbox" aria-label={`FIN of step ${i + 1}`} checked={s.fin !== false} onChange={(e) => update(i, { fin: e.target.checked })} />
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {(['rsv1', 'rsv2', 'rsv3'] as const).map((k) => (
                          <input key={k} type="checkbox" aria-label={`${k.toUpperCase()} of step ${i + 1}`} checked={!!s[k]} onChange={(e) => update(i, { [k]: e.target.checked })} />
                        ))}
                      </td>
                      <td>
                        <input
                          className="input mono"
                          style={{ width: 84 }}
                          list="mask-options"
                          aria-label={`Mask of step ${i + 1}`}
                          value={s.mask ?? 'auto'}
                          onChange={(e) => update(i, { mask: e.target.value })}
                          title="auto, none, random, zero, or 8 hex digits"
                        />
                      </td>
                      <td>
                        <select className="input" aria-label={`Length field of step ${i + 1}`} value={String(s.lengthField ?? 'auto')} onChange={(e) => update(i, { lengthField: e.target.value === 'auto' ? 'auto' : (Number(e.target.value) as 16 | 64) })}>
                          <option value="auto">auto</option>
                          <option value="16">16-bit</option>
                          <option value="64">64-bit</option>
                        </select>
                      </td>
                      <td>{numInput(s.declaredLength, (v) => update(i, { declaredLength: v }), `Claimed length of step ${i + 1}`, 80)}</td>
                      <td>{numInput(s.truncateTo, (v) => update(i, { truncateTo: v }), `Cut step ${i + 1} at`)}</td>
                      <td>
                        <PayloadCell value={s.payload} onChange={(b64) => update(i, { payload: b64 })} />
                      </td>
                    </>
                  ) : s.kind === 'raw' ? (
                    <>
                      <td colSpan={7} className="faint">
                        raw bytes{s.note ? `: ${s.note}` : ''}
                      </td>
                      <td>
                        <PayloadCell value={s.bytes} onChange={(b64) => update(i, { bytes: b64 })} />
                      </td>
                    </>
                  ) : (
                    <td colSpan={8}>
                      <select className="input" aria-label={`Socket action of step ${i + 1}`} value={s.action} onChange={(e) => update(i, { action: e.target.value as 'end' | 'destroy' })}>
                        <option value="end">End the TCP connection (FIN)</option>
                        <option value="destroy">Drop the TCP connection</option>
                      </select>
                    </td>
                  )}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small" aria-label={`Move step ${i + 1} up`} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button className="btn small" aria-label={`Move step ${i + 1} down`} onClick={() => move(i, 1)}>
                      ↓
                    </button>
                    <button className="btn small" aria-label={`Copy step ${i + 1}`} onClick={() => setSteps((x) => [...x.slice(0, i + 1), { ...s }, ...x.slice(i + 1)])}>
                      ⧉
                    </button>
                    <button className="btn small" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="mask-options">
            {['auto', 'none', 'random', 'zero'].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      )}
      <div className="composer-row" style={{ paddingTop: steps.length ? 6 : 0 }}>
        <button className="btn small" onClick={() => setSteps((s) => [...s, { kind: 'frame', opcode: 'text', payload: bytesToBase64(payload()) }])}>
          Add frame
        </button>
        <button className="btn small" onClick={() => setSteps((s) => [...s, { kind: 'frame', opcode: 'ping', payload: '' }])}>
          Add ping
        </button>
        <button className="btn small" onClick={() => setSteps((s) => [...s, { kind: 'raw', bytes: '' }])}>
          Add raw bytes
        </button>
        <button className="btn small" onClick={() => setSteps((s) => [...s, { kind: 'socket', action: 'end' }])}>
          Add TCP close
        </button>
        {steps.length > 0 && (
          <button className="btn small" onClick={() => setSteps([])}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
