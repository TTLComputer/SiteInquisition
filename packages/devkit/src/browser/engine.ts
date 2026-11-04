/**
 * The in-page half of the driver. `engine` is sent to the page as source
 * (Function.prototype.toString), so it must stay self-contained: no imports,
 * no helpers from outside its body. It resolves a locator's steps to
 * elements and runs one operation on them.
 *
 * Matching follows the rules the UI tests were written against:
 * - css: querySelectorAll inside each current element, with optional hasText.
 * - role: implicit or explicit ARIA role, hidden elements excluded, name
 *   matched case-insensitively as a substring unless exact or a RegExp.
 * - label: aria-labelledby, aria-label or <label> text.
 * - text: the innermost elements whose text matches.
 * - testid: [data-testid].
 * Strings match after whitespace is collapsed.
 */

export type Matcher = string | { re: string; flags: string };
export type Step =
  | { kind: 'css'; selector: string; hasText?: Matcher }
  | { kind: 'role'; role: string; name?: Matcher; exact?: boolean; checked?: boolean }
  | { kind: 'label'; text: Matcher; exact?: boolean }
  | { kind: 'text'; text: Matcher; exact?: boolean }
  | { kind: 'testid'; id: string }
  | { kind: 'filter'; hasText?: Matcher; hasNotText?: Matcher }
  | { kind: 'nth'; index: number };

export type Op =
  | { op: 'count' }
  | { op: 'texts' }
  | { op: 'text' }
  | { op: 'value' }
  | { op: 'checked' }
  | { op: 'visible' }
  | { op: 'box' }
  | { op: 'target'; position?: { x: number; y: number }; force?: boolean }
  | { op: 'hit'; x: number; y: number }
  | { op: 'lastChecked' }
  | { op: 'focus'; select?: boolean }
  | { op: 'select'; values: string[] }
  | { op: 'eval'; fn: string; arg: unknown };

export function engine(steps: Step[], op: Op): unknown {
  const doc: any = (globalThis as any).document;
  const win: any = globalThis as any;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

  const matches = (value: string, m: Matcher | undefined, exact?: boolean) => {
    if (m === undefined) return true;
    const v = norm(value);
    if (typeof m !== 'string') return new RegExp(m.re, m.flags).test(v);
    return exact ? v === norm(m) : v.toLowerCase().includes(norm(m).toLowerCase());
  };

  const visible = (el: any) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return win.getComputedStyle(el).visibility !== 'hidden';
  };

  const ariaHidden = (el: any) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.getAttribute('aria-hidden') === 'true') return true;
      if (e.checkVisibility && !e.checkVisibility({ visibilityProperty: true })) return true;
    }
    return false;
  };

  const roleOf = (el: any): string => {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.localName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    switch (tag) {
      case 'button': return 'button';
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : '';
      case 'input':
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
        if (type === 'hidden' || type === 'file' || type === 'color' || type === 'password') return '';
        return el.hasAttribute('list') ? 'combobox' : 'textbox';
      case 'textarea': return 'textbox';
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'option': return 'option';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'aside': return 'complementary';
      case 'header': return el.closest('article,aside,main,nav,section') ? '' : 'banner';
      case 'footer': return el.closest('article,aside,main,nav,section') ? '' : 'contentinfo';
      case 'form': return 'form';
      case 'section': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '';
      case 'article': return 'article';
      case 'dialog': return 'dialog';
      case 'fieldset': case 'details': case 'optgroup': return 'group';
      case 'ul': case 'ol': case 'menu': return 'list';
      case 'li': return 'listitem';
      case 'table': return 'table';
      case 'thead': case 'tbody': case 'tfoot': return 'rowgroup';
      case 'tr': return 'row';
      case 'td': return 'cell';
      case 'th': return 'columnheader';
      case 'img': return el.getAttribute('alt') === '' ? 'presentation' : 'img';
      case 'progress': return 'progressbar';
      case 'hr': return 'separator';
      case 'summary': return 'button';
      default: return '';
    }
  };

  const FROM_CONTENT = new Set(['button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem']);

  const contentText = (node: any): string => {
    if (node.nodeType === 3) return node.data;
    if (node.nodeType !== 1) return '';
    const el = node;
    if (el.localName === 'script' || el.localName === 'style') return '';
    if (el.getAttribute('aria-hidden') === 'true' || (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true }))) return '';
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return ` ${label} `;
    if (el.localName === 'img') return el.getAttribute('alt') || '';
    if (el.localName === 'input' && ['button', 'submit', 'reset'].includes(el.type)) return el.value;
    let s = '';
    for (const c of el.childNodes) s += contentText(c);
    const display = win.getComputedStyle(el).display;
    return display.startsWith('inline') ? s : ` ${s} `;
  };

  const textOfIds = (el: any, attr: string) =>
    (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean).map((id: string) => doc.getElementById(id)).filter(Boolean);

  const labelText = (el: any): string[] => {
    const out: string[] = [];
    for (const ref of textOfIds(el, 'aria-labelledby')) out.push(contentTextOf(ref));
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) out.push(aria);
    if (el.labels) for (const l of el.labels) out.push(labelContent(l, el));
    return out;
  };
  const contentTextOf = (el: any) => {
    let s = '';
    for (const c of el.childNodes) s += contentText(c);
    return s;
  };
  // A label's own text, without the value of the control it wraps.
  const labelContent = (label: any, control: any) => {
    let s = '';
    for (const c of label.childNodes) if (c !== control) s += contentText(c);
    return s;
  };

  const nameOf = (el: any, role: string): string => {
    const byIds = textOfIds(el, 'aria-labelledby');
    if (byIds.length) return norm(byIds.map(contentTextOf).join(' '));
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return norm(aria);
    const tag = el.localName;
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(el.type)) return norm(el.value || el.getAttribute('title') || '');
    if (tag === 'img' || (tag === 'input' && el.type === 'image')) return norm(el.getAttribute('alt') || el.getAttribute('title') || '');
    if (el.labels && el.labels.length) return norm([...el.labels].map((l: any) => labelContent(l, el)).join(' '));
    if (FROM_CONTENT.has(role)) {
      const s = norm(contentTextOf(el));
      if (s) return s;
    }
    return norm(el.getAttribute('title') || el.getAttribute('placeholder') || '');
  };

  const all = (root: any): any[] => [...root.querySelectorAll('*')];

  const byText = (root: any, m: Matcher, exact?: boolean) => {
    const out: any[] = [];
    const skip = new Set(['script', 'style', 'head', 'title', 'noscript', 'template']);
    const walk = (el: any): boolean => {
      if (skip.has(el.localName)) return false;
      let childMatched = false;
      for (const c of el.children) if (walk(c)) childMatched = true;
      if (childMatched) return true;
      if (matches(el.textContent || '', m, exact)) {
        out.push(el);
        return true;
      }
      return false;
    };
    for (const c of root.nodeType === 9 ? [root.documentElement] : root.children) walk(c);
    return out;
  };

  let current: any[] = [doc];
  for (const step of steps) {
    const next: any[] = [];
    const seen = new Set();
    const add = (el: any) => {
      if (!seen.has(el)) {
        seen.add(el);
        next.push(el);
      }
    };
    if (step.kind === 'filter') {
      for (const el of current) {
        const t = el.textContent || '';
        if (step.hasText !== undefined && !matches(t, step.hasText)) continue;
        if (step.hasNotText !== undefined && matches(t, step.hasNotText)) continue;
        add(el);
      }
    } else if (step.kind === 'nth') {
      const el = step.index < 0 ? current[current.length + step.index] : current[step.index];
      if (el) add(el);
    } else {
      for (const root of current) {
        let found: any[];
        if (step.kind === 'css') {
          found = [...root.querySelectorAll(step.selector)];
          if (step.hasText !== undefined) found = found.filter((el) => matches(el.textContent || '', step.hasText));
        } else if (step.kind === 'testid') {
          found = [...root.querySelectorAll(`[data-testid=${JSON.stringify(step.id)}]`)];
        } else if (step.kind === 'role') {
          found = all(root).filter((el) => {
            if (roleOf(el) !== step.role || ariaHidden(el)) return false;
            if (step.checked !== undefined && !!(el.checked ?? el.getAttribute('aria-checked') === 'true') !== step.checked) return false;
            return step.name === undefined || matches(nameOf(el, step.role), step.name, step.exact);
          });
        } else if (step.kind === 'label') {
          found = all(root).filter((el) => labelText(el).some((t) => matches(t, step.text, step.exact)));
        } else {
          found = byText(root, step.text, step.exact);
        }
        found.forEach(add);
      }
      if (current.length > 1) next.sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1));
    }
    current = next;
  }
  const els = current.filter((e) => e !== doc);

  const one = () => {
    if (els.length === 0) return { retry: 'no element matches' };
    if (els.length > 1) return { strict: els.length };
    return null;
  };

  switch (op.op) {
    case 'count': return els.length;
    case 'texts': return els.map((e) => e.textContent ?? '');
    case 'visible': return els.length === 1 && visible(els[0]);
    case 'lastChecked': {
      // The element the last click resolved to, which a re-query might no longer single out.
      const last = win.__siqLastTarget;
      return last ? { value: last.localName === 'input' ? !!last.checked : last.getAttribute('aria-checked') === 'true' } : { error: 'no clicked element' };
    }
    case 'hit': {
      // Called after the mouse has moved: is the point still over the target?
      const bad = one();
      if (bad) return bad;
      const hit = doc.elementFromPoint(op.x, op.y);
      return { ok: !!hit && (hit === els[0] || els[0].contains(hit)) };
    }
    default: break;
  }
  const bad = one();
  if (bad) return bad;
  const el = els[0];
  switch (op.op) {
    case 'text': return { value: el.textContent ?? '' };
    case 'value': {
      if (!('value' in el) || !['input', 'textarea', 'select'].includes(el.localName)) return { error: 'inputValue: not an input, textarea or select' };
      return { value: el.value };
    }
    case 'checked': return { value: el.localName === 'input' ? !!el.checked : el.getAttribute('aria-checked') === 'true' };
    case 'box': {
      if (!visible(el)) return { value: null };
      const r = el.getBoundingClientRect();
      return { value: { x: r.x, y: r.y, width: r.width, height: r.height } };
    }
    case 'target': {
      if (!visible(el)) return { retry: 'element is not visible' };
      if (!op.force && (el.disabled || el.getAttribute('aria-disabled') === 'true')) return { retry: 'element is disabled' };
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const x = r.x + (op.position ? op.position.x : r.width / 2);
      const y = r.y + (op.position ? op.position.y : r.height / 2);
      if (!op.force) {
        const hit = doc.elementFromPoint(x, y);
        if (!hit || !(hit === el || el.contains(hit))) {
          const who = hit ? `<${hit.localName}${hit.className && typeof hit.className === 'string' ? ` class="${hit.className}"` : ''}>` : 'nothing';
          return { retry: `${who} receives the click instead` };
        }
      }
      win.__siqLastTarget = el;
      return { value: { x, y } };
    }
    case 'focus': {
      el.focus();
      if (op.select) {
        if (typeof el.select === 'function' && ['input', 'textarea'].includes(el.localName)) el.select();
        else if (el.isContentEditable) {
          const range = doc.createRange();
          range.selectNodeContents(el);
          const sel = win.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } else return { error: 'fill: element is not an input, textarea or contenteditable' };
      }
      return { value: true };
    }
    case 'select': {
      if (el.localName !== 'select') return { error: 'selectOption: not a <select>' };
      const opts = [...el.options];
      const picked = op.values.map((v) => opts.find((o: any) => o.value === v) ?? opts.find((o: any) => norm(o.label) === norm(v)));
      if (picked.some((o) => !o)) return { retry: 'option not found' };
      for (const o of opts) o.selected = picked.includes(o);
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
      return { value: picked.map((o: any) => o.value) };
    }
    case 'eval': {
      // eslint-disable-next-line no-new-func
      const fn = (0, eval)(`(${op.fn})`);
      return Promise.resolve(fn(el, op.arg)).then((value) => ({ value }));
    }
  }
  return { error: 'unknown op' };
}
