import { useEffect, useRef } from 'react';

/** A question with a few buttons, e.g. Save, Discard or Cancel when closing unsaved work. */
export interface DialogRequest {
  title: string;
  text: string;
  choices: Array<{ id: string; label: string; primary?: boolean; tone?: 'danger' }>;
}

/** Shows one DialogRequest. Esc and clicking outside answer "cancel". The primary choice has focus. */
export function Dialog({ req, onAnswer }: { req: DialogRequest; onAnswer(id: string): void }) {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primary.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onAnswer('cancel');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAnswer]);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={req.title} onMouseDown={() => onAnswer('cancel')}>
      <div className="card overlay-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="panel-title" style={{ padding: '12px 14px' }}>
          {req.title}
        </div>
        <div style={{ padding: '0 14px 12px' }}>{req.text}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '0 14px 14px' }}>
          {req.choices.map((c) => (
            <button key={c.id} ref={c.primary ? primary : undefined} className={`btn${c.primary ? ' primary' : ''}${c.tone === 'danger' ? ' danger' : ''}`} onClick={() => onAnswer(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
