import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state';
import { commands, matchCommands, type Selection } from '../workspace/registry';

/**
 * Command search (Ctrl Shift P): every action and every page by name. Actions
 * act on the exchange selected in Traffic; ones that cannot run say why.
 * Ctrl K stays the traffic filter.
 */
export function CommandSearch({ onClose }: { onClose(): void }) {
  const app = useApp();
  const { client, selectedId, notify } = app;
  const [row, setRow] = useState<Selection | null>(null);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    if (selectedId) client.get(selectedId).then(setRow, () => setRow(null));
  }, [client, selectedId]);
  const list = useMemo(() => matchCommands(commands(app, row), q).slice(0, 60), [app, row, q]);
  useEffect(() => setAt(0), [q]);
  const pick = (i: number) => {
    const c = list[i];
    if (!c || c.disabled) return;
    onClose();
    Promise.resolve(c.run()).catch((e: Error) => notify(e.message));
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Command search" onMouseDown={onClose}>
      <div className="card overlay-card palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder={row ? `Do something with ${row.method} ${row.path}, or go somewhere` : 'Go somewhere, or select a request in Traffic to act on it'}
          aria-label="Search commands"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-list"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') (e.preventDefault(), setAt((i) => Math.min(list.length - 1, i + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setAt((i) => Math.max(0, i - 1)));
            else if (e.key === 'Enter') (e.preventDefault(), pick(at));
          }}
        />
        <ul id="command-list" role="listbox" aria-label="Commands">
          {list.map((c, i) => (
            <li key={c.key} role="option" aria-selected={i === at} aria-disabled={c.disabled ? true : undefined} title={c.disabled} onMouseEnter={() => setAt(i)} onClick={() => pick(i)}>
              <span>{c.label}</span>
              <span className="detail">{c.disabled ?? c.detail ?? ''}</span>
              {c.shortcut && <kbd>{c.shortcut}</kbd>}
            </li>
          ))}
          {!list.length && <li aria-disabled="true">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}
