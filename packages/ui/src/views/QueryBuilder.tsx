import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state';
import { Icon } from '../components/icons';
import { usePlacement } from '../components/placement';

/** Where a condition looks, and the search key it writes. */
interface Field {
  key: string;
  label: string;
  group: 'Text' | 'Request' | 'Response' | 'Other';
  placeholder: string;
  hint?: string;
}

const FIELDS: Field[] = [
  { key: '', label: 'Anywhere', group: 'Text', placeholder: 'text in the URL, headers or bodies', hint: 'Matches any part of a word, ignoring case.' },
  { key: 'req', label: 'Request (headers or body)', group: 'Text', placeholder: 'apikey' },
  { key: 'res', label: 'Response (headers or body)', group: 'Text', placeholder: 'stack trace' },
  { key: 'reqbody', label: 'Request body', group: 'Text', placeholder: 'password' },
  { key: 'resbody', label: 'Response body', group: 'Text', placeholder: '"admin":true' },
  { key: 'reqheader', label: 'Request headers', group: 'Text', placeholder: 'authorization: bearer', hint: 'Headers read as "name: value".' },
  { key: 'resheader', label: 'Response headers', group: 'Text', placeholder: 'server: nginx', hint: 'Headers read as "name: value".' },
  { key: 'body', label: 'Either body', group: 'Text', placeholder: 'token' },
  { key: 'header', label: 'Either headers', group: 'Text', placeholder: 'x-request-id' },
  { key: 'host', label: 'Host', group: 'Request', placeholder: 'api.example.com or *.example.com' },
  { key: 'path', label: 'Path starts with', group: 'Request', placeholder: '/api/ or /api/*/orders' },
  { key: 'url', label: 'URL contains', group: 'Request', placeholder: 'token=' },
  { key: 'method', label: 'Method', group: 'Request', placeholder: 'POST' },
  { key: 'scheme', label: 'Scheme', group: 'Request', placeholder: 'https' },
  { key: 'status', label: 'Status', group: 'Response', placeholder: '404, 4xx, >=400 or 200-299' },
  { key: 'error', label: 'Server error', group: 'Response', placeholder: 'any, high, sql…' },
  { key: 'tech', label: 'Technology', group: 'Response', placeholder: 'nginx, django…' },
  { key: 'source', label: 'Recorded by', group: 'Other', placeholder: 'proxy, browser or replay' },
  { key: 'tag', label: 'Tag', group: 'Other', placeholder: 'tag name' },
  { key: 'ws', label: 'WebSocket', group: 'Other', placeholder: 'true or false' },
  { key: 'since', label: 'Since', group: 'Other', placeholder: '2026-11-04T09:00' },
  { key: 'until', label: 'Until', group: 'Other', placeholder: '2026-11-04T18:00' },
];
const KNOWN = new Set(FIELDS.map((f) => f.key).filter(Boolean));
const ALIASES: Record<string, string> = { request: 'req', response: 'res', reqheaders: 'reqheader', resheaders: 'resheader', headers: 'header' };
/** Keys the builder does not offer but a typed query may hold; kept as they are. */
const PASSTHROUGH = new Set(['state', 'flow', 'replayof', 'id']);

export interface Condition {
  key: string;
  value: string;
  not: boolean;
}

/** Split a query into conditions, the way the search reads it. */
export function parseConditions(q: string): Condition[] {
  const out: Condition[] = [];
  const re = /(-)?(?:([a-z]+):)?(?:"((?:[^"\\]|\\.)*)"|(\S+))/gi;
  for (const m of q.matchAll(re)) {
    const [, neg, rawKey, quoted, bare] = m;
    const lower = rawKey?.toLowerCase();
    const key = lower ? (ALIASES[lower] ?? lower) : '';
    if (key && !KNOWN.has(key) && !PASSTHROUGH.has(key)) {
      out.push({ key: '', value: m[0].replace(/^-/, ''), not: !!neg });
      continue;
    }
    const value = quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : (bare ?? '');
    if (value) out.push({ key, value, not: !!neg });
  }
  return out;
}

const quote = (v: string) => (/[\s"]/.test(v) || v === '' ? `"${v.replace(/(["\\])/g, '\\$1')}"` : v);

export function formatConditions(cs: Condition[]): string {
  return cs
    .filter((c) => c.value.trim() !== '')
    .map((c) => `${c.not ? '-' : ''}${c.key ? `${c.key}:` : ''}${quote(c.value.trim())}`)
    .join(' ');
}

const EXAMPLES: Array<[string, string]> = [
  ['Responses that leak a stack trace', 'resbody:"stack trace" status:>=500'],
  ['Requests that send a password', 'reqbody:password method:POST'],
  ['Calls with a bearer token', 'reqheader:"authorization: bearer"'],
  ['JSON APIs that are not cached', 'resheader:"application/json" -resheader:"cache-control"'],
  ['Anything mentioning an id', 'PO-7781'],
];

/**
 * A helper for writing History searches: pick where to look, type what to
 * look for, and see how many requests match before searching.
 */
export function QueryBuilder({ query, onSearch }: { query: string; onSearch(q: string): void }) {
  const { client } = useApp();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Condition[]>([]);
  const [count, setCount] = useState<number | string | null>(null);
  const [hosts, setHosts] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  usePlacement(menu, button, open, { align: 'start' });

  useEffect(() => {
    if (!open) return;
    const start = parseConditions(query);
    setRows(start.length ? start : [{ key: '', value: '', not: false }]);
    client.siteMap().then((h) => setHosts(h.map((x) => x.host)), () => undefined);
    client.tags().then((t) => setTags(t.map((x) => x.tag)), () => undefined);
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
    // The builder starts from the query each time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, client]);

  const text = useMemo(() => formatConditions(rows), [rows]);

  // How many requests match, as you build it.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const t = window.setTimeout(() => {
      client.count(text, 10_000).then(
        (n) => live && setCount(n),
        (e: Error) => live && setCount(e.message),
      );
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [client, open, text]);

  const set = (i: number, patch: Partial<Condition>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const suggestions = (key: string): string[] => {
    if (key === 'host') return hosts;
    if (key === 'tag') return tags;
    if (key === 'method') return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
    if (key === 'status') return ['2xx', '3xx', '4xx', '5xx', '>=400', '401', '403', '404', '500'];
    if (key === 'source') return ['proxy', 'browser', 'replay'];
    if (key === 'error') return ['any', 'high', 'sql', 'stack', 'debug'];
    if (key === 'ws') return ['true', 'false'];
    if (key === 'scheme') return ['http', 'https'];
    return [];
  };
  const search = (q = text) => {
    onSearch(q);
    setOpen(false);
  };

  return (
    <div className="qb-wrap" ref={wrap}>
      <button ref={button} className="btn small" aria-expanded={open} aria-haspopup="dialog" title="Build a search: pick where to look and what for" onClick={() => setOpen(!open)}>
        <Icon name="filter" size={12} /> Build search
      </button>
      {open && (
        <div ref={menu} className="popover query-builder" role="dialog" aria-label="Build a search">
          <div className="qb-rows">
            {rows.map((r, i) => {
              const field = FIELDS.find((f) => f.key === r.key);
              const list = suggestions(r.key);
              return (
                <div className="qb-row" key={i} data-testid="qb-row">
                  <select className="input" aria-label={`Condition ${i + 1} where`} value={r.key} onChange={(e) => set(i, { key: e.target.value })}>
                    {(['Text', 'Request', 'Response', 'Other'] as const).map((g) => (
                      <optgroup key={g} label={g === 'Text' ? 'Text in' : g}>
                        {FIELDS.filter((f) => f.group === g).map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    {!field && <option value={r.key}>{r.key}</option>}
                  </select>
                  <select className="input qb-not" aria-label={`Condition ${i + 1} match`} value={r.not ? 'not' : 'is'} onChange={(e) => set(i, { not: e.target.value === 'not' })}>
                    <option value="is">{field?.group === 'Text' ? 'contains' : 'is'}</option>
                    <option value="not">{field?.group === 'Text' ? 'does not contain' : 'is not'}</option>
                  </select>
                  <input
                    className="input mono"
                    aria-label={`Condition ${i + 1} value`}
                    placeholder={field?.placeholder}
                    title={field?.hint}
                    value={r.value}
                    list={list.length ? `qb-list-${r.key}` : undefined}
                    autoFocus={i === rows.length - 1 && !r.value}
                    onChange={(e) => set(i, { value: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && search()}
                  />
                  {list.length > 0 && (
                    <datalist id={`qb-list-${r.key}`}>
                      {list.map((v) => (
                        <option key={v} value={v} />
                      ))}
                    </datalist>
                  )}
                  <button className="icon-btn" aria-label={`Remove condition ${i + 1}`} onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ key: '', value: '', not: false }])}>
                    <Icon name="close" size={11} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="qb-actions">
            <button className="btn small" onClick={() => setRows([...rows, { key: '', value: '', not: false }])}>
              Add condition
            </button>
            <span className="faint">All conditions must match.</span>
          </div>
          <div className="qb-preview">
            <code className="mono" aria-label="Search text" data-testid="qb-text">
              {text || <span className="faint">everything recorded</span>}
            </code>
            <span className="muted" aria-live="polite" data-testid="qb-count">
              {count === null ? '' : typeof count === 'string' ? count : `${count >= 10_000 ? '10,000+' : count.toLocaleString()} ${count === 1 ? 'request matches' : 'requests match'}`}
            </span>
          </div>
          <div className="qb-actions">
            <button className="btn small primary" onClick={() => search()}>
              Search
            </button>
            <button className="btn small" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          <details className="qb-help">
            <summary>Examples</summary>
            {EXAMPLES.map(([label, q]) => (
              <button key={q} className="link-btn" onClick={() => setRows(parseConditions(q))} title={q}>
                {label} <span className="mono faint">{q}</span>
              </button>
            ))}
          </details>
        </div>
      )}
    </div>
  );
}
