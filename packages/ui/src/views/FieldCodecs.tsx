import { useEffect, useState } from 'react';
import type { FieldCodecRule } from '../api';
import { useApp } from '../state';

type Draft = Omit<FieldCodecRule, 'id'> & { id?: string };
const EMPTY: Draft = { host: '*', path: '', side: 'both', field: '', chain: [] };

/** An exact path from the JSON tree ($.items[3].blob) as a rule for every item ($.items[*].blob). */
export const generalizePath = (p: string) => p.replace(/\[\d+\]/g, '[*]');

/**
 * Saved field codecs: JSON fields that hold encoded data (base64 of JSON, hex,
 * a JWT...). The Inspector shows them decoded, and Replay opens them decoded
 * and encodes them again on send.
 */
export function FieldCodecRules({ draft, onDraftDone }: { draft?: { field: string; chain: string[]; label?: string } | null; onDraftDone?(): void }) {
  const { client, notify } = useApp();
  const [rules, setRules] = useState<FieldCodecRule[]>([]);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [chainText, setChainText] = useState('');

  useEffect(() => {
    client.fieldCodecs().then(setRules, (e: Error) => notify(e.message));
    const off = client.onChange((c) => {
      if (c.kind === 'meta.set' && c.entityId === 'fieldCodecs') void client.fieldCodecs().then(setRules, () => undefined);
    });
    return () => {
      off();
    };
  }, [client, notify]);

  useEffect(() => {
    if (!draft) return;
    setEdit({ ...EMPTY, field: generalizePath(draft.field), chain: draft.chain });
    setChainText(draft.chain.join('>'));
  }, [draft]);

  const save = async (list: Draft[], msg: string) => {
    try {
      setRules(await client.setFieldCodecs(list));
      notify(msg);
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    }
  };
  const submit = async () => {
    if (!edit) return;
    const rule = { ...edit, chain: chainText.split(/\s*(?:>|,|→)\s*/).filter(Boolean) };
    const list = edit.id ? rules.map((r) => (r.id === edit.id ? rule : r)) : [...rules, rule];
    if (await save(list, `${rule.field} is decoded as ${rule.chain.join(' > ')} on ${rule.host === '*' ? 'every host' : rule.host}`)) {
      setEdit(null);
      onDraftDone?.();
    }
  };

  return (
    <section className="card" style={{ margin: '0 10px 10px' }} aria-label="Field codecs">
      <div className="sec-head">
        <b style={{ color: 'var(--text)' }}>Field codecs</b>
        <span className="faint">JSON fields that hold encoded data. Inspector shows them decoded; Replay decodes them for editing and encodes them on send.</span>
        <span style={{ flex: 1 }} />
        {!edit && (
          <button
            className="btn small"
            onClick={() => {
              setEdit({ ...EMPTY });
              setChainText('base64>json');
            }}
          >
            Add field codec
          </button>
        )}
      </div>
      {edit && (
        <div className="field-codec-form" data-testid="field-codec-form">
          <label className="check">
            Field
            <input className="input mono" value={edit.field} onChange={(e) => setEdit({ ...edit, field: e.target.value })} placeholder="$.payload or $.items[*].blob" aria-label="Field JSONPath" />
          </label>
          <label className="check">
            Codecs
            <input className="input mono" value={chainText} onChange={(e) => setChainText(e.target.value)} placeholder="base64>json" aria-label="Field codec chain" title="Outermost first: base64>json means the field is base64 of JSON" style={{ width: 140 }} />
          </label>
          <label className="check">
            Host
            <input className="input mono" value={edit.host} onChange={(e) => setEdit({ ...edit, host: e.target.value })} placeholder="* or *.example.com" aria-label="Field codec host" style={{ width: 160 }} />
          </label>
          <label className="check" title="URL path prefix, or a glob with *; empty for every path">
            Path
            <input className="input mono" value={edit.path ?? ''} onChange={(e) => setEdit({ ...edit, path: e.target.value })} placeholder="any" aria-label="Field codec path" style={{ width: 140 }} />
          </label>
          <label className="check">
            In
            <select className="input" value={edit.side} onChange={(e) => setEdit({ ...edit, side: e.target.value as Draft['side'] })} aria-label="Field codec side">
              <option value="both">requests and responses</option>
              <option value="request">requests</option>
              <option value="response">responses</option>
            </select>
          </label>
          <button className="btn small primary" disabled={!edit.field.trim() || !chainText.trim()} onClick={() => void submit()}>
            {edit.id ? 'Save' : 'Add'}
          </button>
          <button
            className="btn small"
            onClick={() => {
              setEdit(null);
              onDraftDone?.();
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {rules.length === 0 && !edit && <div className="faint tech-note">None yet. Decode a field in the JSON tree above and choose Always decode this field, or add one here.</div>}
      {rules.length > 0 && (
        <table className="data-table" aria-label="Saved field codecs">
          <thead>
            <tr>
              <th>Field</th>
              <th>Codecs</th>
              <th>Where</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} data-testid="field-codec-row" style={r.enabled === false ? { opacity: 0.55 } : undefined}>
                <td className="mono">{r.field}</td>
                <td className="mono">{r.chain.join(' > ')}</td>
                <td className="faint">
                  {r.side === 'both' ? 'requests and responses' : `${r.side}s`} on <span className="mono">{r.host === '*' ? 'any host' : r.host}</span>
                  {r.path ? (
                    <>
                      {' '}
                      at <span className="mono">{r.path}</span>
                    </>
                  ) : null}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn small" onClick={() => void save(rules.map((x) => (x.id === r.id ? { ...x, enabled: x.enabled === false } : x)), r.enabled === false ? 'Turned on' : 'Turned off')}>
                    {r.enabled === false ? 'Turn on' : 'Turn off'}
                  </button>{' '}
                  <button
                    className="btn small"
                    onClick={() => {
                      setEdit({ ...r });
                      setChainText(r.chain.join('>'));
                    }}
                  >
                    Edit
                  </button>{' '}
                  <button className="btn small" onClick={() => void save(rules.filter((x) => x.id !== r.id), `Removed ${r.field}`)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
