import { Fragment, useEffect, useState, type ReactNode, type RefObject } from 'react';

/**
 * Search highlighting: marks each place a text term appears, ignoring case.
 * Pretty-printed JSON puts a space after ":" and ",", so a term typed
 * against the raw body ("number":"PO) still finds it there.
 */
export function termPattern(terms: string[]): RegExp | null {
  const parts = terms
    .filter((t) => t.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/([:,])(?:\\s\*)?\s*/g, '$1\\s*'));
  return parts.length ? new RegExp(parts.join('|'), 'gi') : null;
}

const MAX_MARKS = 2000;

export function Highlight({ text, pattern }: { text: string; pattern: RegExp | null }): ReactNode {
  if (!pattern || !text) return text;
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m && n < MAX_MARKS; m = pattern.exec(text)) {
    if (m[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <mark key={n} className="hit">
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
    n++;
  }
  if (!n) return text;
  out.push(text.slice(last));
  return <Fragment>{out}</Fragment>;
}

/**
 * Step through the marks inside a container: scrolls the first one into view
 * whenever `key` changes, and next/previous after that.
 */
export function useHitNavigator(container: RefObject<HTMLElement | null>, key: unknown) {
  const [count, setCount] = useState(0);
  const [at, setAt] = useState(0);
  const marks = () => Array.from(container.current?.querySelectorAll<HTMLElement>('mark.hit') ?? []);
  const show = (i: number) => {
    const all = marks();
    all.forEach((m) => m.classList.remove('current'));
    const m = all[i];
    if (!m) return;
    m.classList.add('current');
    m.scrollIntoView({ block: 'center', inline: 'nearest' });
    setAt(i);
  };
  useEffect(() => {
    // After the highlighted text has rendered.
    const t = window.setTimeout(() => {
      const n = marks().length;
      setCount(n);
      if (n) show(0);
      else setAt(0);
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return {
    count,
    at,
    next: () => count && show((at + 1) % count),
    prev: () => count && show((at - 1 + count) % count),
  };
}
