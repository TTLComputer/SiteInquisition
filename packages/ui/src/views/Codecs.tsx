import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bulk, formatPath, query, type BulkOp, type PathSeg } from '@siteinquisition/codecs/jsonpath';
import { base64ToBytes, type SavedChain } from '../api';
import { useApp } from '../state';
import { Icon } from '../components/icons';
import { asText, hexDump } from '../format';
import { TokenPicker } from './TokenPicker';

type Layer = { kind: 'bytes'; bytes: Uint8Array } | { kind: 'value'; value: unknown };

const enc = new TextEncoder();

function layerText(l: Layer): string {
  if (l.kind === 'value') return JSON.stringify(l.value, null, 2);
  return asText(l.bytes) ?? hexDump(l.bytes);
}

function JsonTree({ value, path, onPick, depth = 0 }: { value: unknown; path: PathSeg[]; onPick(p: PathSeg[]): void; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (value === null || typeof value !== 'object') {
    return (
      <button className={`jt-leaf jt-${value === null ? 'null' : typeof value}`} onClick={() => onPick(path)} title={`Use ${formatPath(path)}`}>
        {JSON.stringify(value)}
      </button>
    );
  }
  const entries: Array<[PathSeg, unknown]> = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  return (
    <span>
      <button className="jt-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
      </button>
      {open && (
        <div className="jt-children">
          {entries.map(([k, v]) => (
            <div key={String(k)}>
              <button className="jt-key" onClick={() => onPick([...path, k])} title={`Use ${formatPath([...path, k])}`}>
                {typeof k === 'number' ? `[${k}]` : k}
              </button>
              : <JsonTree value={v} path={[...path, k]} onPick={onPick} depth={depth + 1} />
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * The codec workbench: decode through a chain of layers, edit the innermost
 * one (with JSONPath bulk edits for JSON), find and replace across layers,
 * and re-encode. Input can come from any screen (Ctrl D, "Decode" buttons)
 * and the result can go back where it came from or out to a replay.
 */
export function Codecs() {
  const { client, codecInput, notify, openDraft } = useApp();
  const [input, setInput] = useState('');
  const [label, setLabel] = useState('');
  const [returnTo, setReturnTo] = useState<((text: string) => void) | null>(null);
  const [chain, setChain] = useState<string[]>([]);
  const [codecs, setCodecs] = useState<Array<{ id: string; label: string; terminal: boolean }>>([]);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState('');
  const [editDirty, setEditDirty] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedChain[]>([]);
  // JSONPath
  const [path, setPath] = useState('');
  const [op, setOp] = useState<BulkOp>('set');
  const [arg, setArg] = useState('');
  // Find and replace
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [regex, setRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [keys, setKeys] = useState(false);
  const [scopeAll, setScopeAll] = useState(false);
  const [counts, setCounts] = useState<number[] | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    client.codecList().then(setCodecs, () => undefined);
    client.chains().then(setSaved, () => undefined);
  }, [client]);

  const detect = useCallback(
    async (text: string) => {
      if (!text) return setChain([]);
      try {
        setChain(await client.detect(enc.encode(text)));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [client],
  );

  // Input from another screen: take it and detect its layers.
  useEffect(() => {
    if (!codecInput) return;
    setInput(codecInput.text);
    setLabel(codecInput.label);
    setReturnTo(() => codecInput.returnTo ?? null);
    setOutput(null);
    void detect(codecInput.text);
  }, [codecInput, detect]);

  useEffect(() => {
    let live = true;
    if (!input) {
      setLayers([]);
      setEdit('');
      return;
    }
    client
      .layers(chain, enc.encode(input))
      .then((ls) => {
        if (!live) return;
        const mapped: Layer[] = ls.map((l) => (l.kind === 'bytes' ? { kind: 'bytes', bytes: base64ToBytes(l.base64) } : { kind: 'value', value: l.value }));
        setLayers(mapped);
        setError(null);
        setEdit(layerText(mapped[mapped.length - 1]!));
        setEditDirty(false);
      })
      .catch((e: Error) => live && (setError(`Could not decode with ${chain.join(' > ') || 'no codecs'}: ${e.message}`), setLayers([])));
    return () => {
      live = false;
    };
  }, [client, chain, input]);

  const inner = layers[layers.length - 1];
  const innerIsJson = inner?.kind === 'value' && typeof inner.value === 'object' && inner.value !== null;
  const parsedEdit = useMemo(() => {
    if (!innerIsJson) return undefined;
    try {
      return JSON.parse(edit) as unknown;
    } catch {
      return undefined;
    }
  }, [edit, innerIsJson]);

  const matches = useMemo(() => {
    if (!path || parsedEdit === undefined) return null;
    try {
      return query(parsedEdit, path);
    } catch (e) {
      return e as Error;
    }
  }, [path, parsedEdit]);

  // Live count for find and replace across the whole chain.
  useEffect(() => {
    if (!find || !input) return setCounts(null);
    const t = window.setTimeout(() => {
      client
        .replaceIn(chain, enc.encode(input), { find, replace, regex, matchCase, keys, scope: scopeAll ? 'all' : 'layer' })
        .then((r) => setCounts(r.counts), () => setCounts(null));
    }, 200);
    return () => window.clearTimeout(t);
  }, [client, chain, input, find, replace, regex, matchCase, keys, scopeAll]);

  const encodeEdit = async () => {
    try {
      const value = inner?.kind === 'value' ? JSON.parse(edit) : enc.encode(edit);
      const bytes = await client.encode(chain, value);
      const text = asText(bytes);
      setOutput(text ?? hexDump(bytes));
      setError(null);
    } catch (e) {
      setError(`Could not encode: ${(e as Error).message}`);
    }
  };

  const applyBulk = () => {
    if (parsedEdit === undefined) return;
    let a: unknown = arg;
    if (op === 'set') {
      try {
        a = JSON.parse(arg);
      } catch {
        a = arg;
      }
    } else if (op === 'increment') a = Number(arg || 1);
    try {
      const r = bulk(parsedEdit, path, op, a);
      setEdit(JSON.stringify(r.value, null, 2));
      setEditDirty(true);
      notify(`${op} changed ${r.count} ${r.count === 1 ? 'value' : 'values'}`);
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const replaceAll = async () => {
    try {
      const r = await client.replaceIn(chain, enc.encode(input), { find, replace, regex, matchCase, keys, scope: scopeAll ? 'all' : 'layer' });
      const text = asText(r.output) ?? hexDump(r.output);
      setInput(text);
      setOutput(text);
      notify(`Replaced ${r.counts.reduce((a, b) => a + b, 0)} matches`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const insertToken = (token: string) => {
    const el = editRef.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    // Inside a JSON string the token goes in as is; elsewhere quote it so the JSON stays valid.
    const before = edit.slice(0, s);
    const inString = innerIsJson && (before.match(/(?<!\\)"/g)?.length ?? 0) % 2 === 1;
    const text = innerIsJson && !inString ? JSON.stringify(token) : token;
    setEdit(edit.slice(0, s) + text + edit.slice(e));
    setEditDirty(true);
    window.setTimeout(() => el.setSelectionRange(s + text.length, s + text.length), 0);
  };

  const saveChain = async () => {
    const name = window.prompt('Name this chain', chain.join(' > '));
    if (!name) return;
    const next = [...saved.filter((c) => c.name !== name), { name, chain }];
    setSaved(next);
    await client.setChains(next);
  };

  const total = counts?.reduce((a, b) => a + b, 0) ?? 0;
  const result = output ?? (editDirty ? null : input);

  return (
    <div className="page codecs">
      <div className="codecs-grid">
        <section className="card codec-input">
          <div className="sec-head">
            <b style={{ color: 'var(--text)' }}>Input</b>
            {label && <span className="badge">from {label}</span>}
            <span style={{ flex: 1 }} />
            <button className="btn small" onClick={() => void detect(input)} disabled={!input}>
              Detect layers
            </button>
            <button
              className="btn small"
              onClick={() => {
                setInput('');
                setLabel('');
                setReturnTo(null);
                setOutput(null);
                setChain([]);
              }}
            >
              Clear
            </button>
          </div>
          <textarea
            className="editor"
            aria-label="Codec input"
            spellCheck={false}
            placeholder="Paste a value, or select text anywhere and press Ctrl D"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setOutput(null);
            }}
            onBlur={() => chain.length === 0 && input && void detect(input)}
          />
        </section>

        <section className="card codec-chain" aria-label="Codec chain">
          <div className="sec-head">
            <b style={{ color: 'var(--text)' }}>Chain</b>
            <span>Outermost first. Each step decodes the one before it.</span>
          </div>
          <div className="chain-row">
            {chain.length === 0 && <span className="faint">No codecs: the input is used as is.</span>}
            {chain.map((c, i) => (
              <span key={`${c}-${i}`} className="chain-step">
                <span className="mono">{c}</span>
                <button className="icon-btn" aria-label={`Remove ${c}`} onClick={() => setChain(chain.filter((_, j) => j !== i))}>
                  <Icon name="close" size={11} />
                </button>
                {i < chain.length - 1 && <span className="faint">›</span>}
              </span>
            ))}
            <select
              className="input"
              aria-label="Add a codec"
              value=""
              onChange={(e) => e.target.value && setChain([...chain, e.target.value])}
              disabled={!!chain.length && !!codecs.find((c) => c.id === chain[chain.length - 1])?.terminal}
            >
              <option value="">Add step...</option>
              {codecs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <span style={{ flex: 1 }} />
            <select
              className="input"
              aria-label="Saved chains"
              value=""
              onChange={(e) => {
                const c = saved.find((s) => s.name === e.target.value);
                if (c) setChain(c.chain);
              }}
            >
              <option value="">Saved chains...</option>
              {saved.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className="btn small" onClick={() => void saveChain()} disabled={!chain.length}>
              Save chain
            </button>
          </div>
          {error && (
            <div className="banner" role="alert" style={{ margin: 8 }}>
              {error}
            </div>
          )}
          <div className="layers">
            {layers.slice(1, -1).map((l, i) => (
              <details key={i} className="layer">
                <summary>
                  <span className="mono">after {chain[i]}</span> <span className="faint">{l.kind === 'bytes' ? `${l.bytes.length} bytes` : 'value'}</span>
                </summary>
                <pre className="raw">{layerText(l).slice(0, 4000)}</pre>
              </details>
            ))}
          </div>
        </section>

        <section className="card codec-edit">
          <div className="sec-head">
            <b style={{ color: 'var(--text)' }}>Innermost layer</b>
            <span>{inner ? (innerIsJson ? 'JSON: edit it, or click a key in the tree to target it' : 'text') : ''}</span>
            <span style={{ flex: 1 }} />
            <TokenPicker onPick={insertToken} />
          </div>
          <div className="codec-edit-split">
            <textarea
              ref={editRef}
              className="editor"
              aria-label="Decoded value"
              spellCheck={false}
              value={edit}
              onChange={(e) => {
                setEdit(e.target.value);
                setEditDirty(true);
                setOutput(null);
              }}
            />
            {innerIsJson && parsedEdit !== undefined && (
              <div className="json-tree" aria-label="JSON tree">
                <JsonTree value={parsedEdit} path={[]} onPick={(p) => setPath(formatPath(p))} />
              </div>
            )}
          </div>
          {innerIsJson && (
            <div className="jsonpath-bar">
              <input className="input mono" aria-label="JSONPath" placeholder="$..token  or  $.items[*].price" value={path} onChange={(e) => setPath(e.target.value)} style={{ flex: '1 1 220px' }} />
              <span className="muted" style={{ fontSize: 12 }} aria-live="polite">
                {matches === null ? '' : matches instanceof Error ? matches.message : `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`}
              </span>
              <select className="input" aria-label="Bulk operation" value={op} onChange={(e) => setOp(e.target.value as BulkOp)}>
                <option value="set">Set to</option>
                <option value="increment">Increment by</option>
                <option value="swap-type">Swap type</option>
                <option value="flip">Flip boolean</option>
                <option value="append">Append text</option>
                <option value="delete">Delete</option>
              </select>
              {(op === 'set' || op === 'increment' || op === 'append') && (
                <input className="input mono" aria-label="Bulk value" placeholder={op === 'increment' ? '1' : 'value or {{token}}'} value={arg} onChange={(e) => setArg(e.target.value)} style={{ width: 160 }} />
              )}
              <button className="btn small" onClick={applyBulk} disabled={!path || !matches || matches instanceof Error || matches.length === 0}>
                Apply to all
              </button>
            </div>
          )}
          <div className="replace-bar" aria-label="Find and replace">
            <input className="input mono" aria-label="Find" placeholder="Find" value={find} onChange={(e) => setFind(e.target.value)} style={{ flex: '1 1 140px' }} />
            <input className="input mono" aria-label="Replace with" placeholder="Replace with (tokens work)" value={replace} onChange={(e) => setReplace(e.target.value)} style={{ flex: '1 1 140px' }} />
            <label className="check">
              <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Regex
            </label>
            <label className="check">
              <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case
            </label>
            <label className="check">
              <input type="checkbox" checked={keys} onChange={(e) => setKeys(e.target.checked)} /> JSON keys too
            </label>
            <label className="check" title="Off: only the innermost layer. On: every layer of the chain.">
              <input type="checkbox" checked={scopeAll} onChange={(e) => setScopeAll(e.target.checked)} /> All layers
            </label>
            <span className="muted" style={{ fontSize: 12 }} aria-live="polite" data-testid="replace-count">
              {counts ? `${total} ${total === 1 ? 'match' : 'matches'}` : ''}
            </span>
            <button className="btn small" onClick={() => void replaceAll()} disabled={!find || !total}>
              Replace all
            </button>
          </div>
        </section>

        <section className="card codec-output">
          <div className="sec-head">
            <b style={{ color: 'var(--text)' }}>Result</b>
            <span>Re-encoded through the chain, innermost last.</span>
            <span style={{ flex: 1 }} />
            <button className="btn small primary" onClick={() => void encodeEdit()} disabled={!inner}>
              Encode
            </button>
            <button className="btn small" disabled={result === null} onClick={() => navigator.clipboard.writeText(result ?? '').then(() => notify('Copied'), () => notify('Could not copy'))}>
              Copy
            </button>
            {returnTo && (
              <button
                className="btn small"
                disabled={result === null}
                onClick={() => {
                  returnTo(result ?? '');
                  notify(`Put back into ${label}`);
                }}
              >
                Put back into {label}
              </button>
            )}
            <button
              className="btn small"
              disabled={result === null}
              title="Open a new Replay tab with this as the body"
              onClick={() => openDraft({ method: 'POST', url: 'http://localhost/', headers: [['Content-Type', 'text/plain']], body: result ?? '' }, 'from Codecs')}
            >
              New replay with this body
            </button>
          </div>
          <pre className="raw" aria-label="Encoded result">
            {result ?? <span className="faint">Edited. Press Encode to rebuild the outer value.</span>}
          </pre>
        </section>
      </div>
    </div>
  );
}
