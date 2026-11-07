import { useEffect, useRef, useState } from 'react';
import { parseCurl } from '@siteinquisition/codecs/httpmsg';
import { useApp } from '../state';
import { usePlacement } from '../components/placement';

/** "+" on the workspace tabs: a blank request, or one from a pasted curl command, in a new Replay tab. */
export function NewRequestButton() {
  const { openDraft, notify } = useApp();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  usePlacement(menu, button, open, { align: 'start' });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const create = () => {
    if (!text.trim()) {
      openDraft({ method: 'GET', url: 'https://example.com/', headers: [['Accept', '*/*']] }, 'new request');
      setOpen(false);
      return;
    }
    try {
      const r = parseCurl(text);
      const o = r.options;
      openDraft({
        method: r.method,
        url: r.url,
        headers: r.headers,
        body: r.body,
        imported: { warnings: r.warnings, files: r.files },
        options: {
          ...(o.insecure ? { ignoreTls: true } : {}),
          ...(o.followRedirects ? { followRedirects: true } : {}),
          ...(o.protocol ? { protocol: o.protocol, ...(o.h2PriorKnowledge ? { h2Method: 'prior-knowledge' as const } : {}) } : {}),
        },
      });
      setText('');
      setOpen(false);
    } catch (e) {
      notify(`Could not read that curl command: ${(e as Error).message}`);
    }
  };

  return (
    <>
      <button ref={button} className="tab new-tab" aria-label="New request" title="New request: blank, or from a curl command" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        +
      </button>
      {open && (
        <div ref={menu} className="context-menu new-request" role="dialog" aria-label="New request">
          <textarea
            className="input mono"
            autoFocus
            aria-label="curl command for the new request"
            placeholder="Paste a curl command, or leave this empty for a blank request"
            rows={5}
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                create();
              }
            }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn small primary" onClick={create}>
              {text.trim() ? 'Open in Replay' : 'Blank request'}
            </button>
            <span className="faint" style={{ fontSize: 11 }}>
              Ctrl Enter
            </span>
          </div>
        </div>
      )}
    </>
  );
}
