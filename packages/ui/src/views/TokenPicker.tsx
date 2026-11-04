import { useEffect, useRef, useState } from 'react';
import type { ApiFlow, JarCookie, ValueField, VarValue } from '../api';
import { pickToken } from './Api';
import { useApp } from '../state';

const GENERATORS: Array<[string, string]> = [
  ['{{uuid}}', 'random UUID'],
  ['{{now}}', 'ISO time'],
  ['{{now:unix}}', 'unix seconds'],
  ['{{now:ms}}', 'epoch ms'],
  ['{{random:16}}', '16 random characters'],
  ['{{counter:1..10}}', 'one send per number'],
  ['{{list:a,b,c}}', 'one send per item (or a file name)'],
];

const REFERENCES: Array<[string, string]> = [
  ['{{$my-tag.field}}', 'a field of the newest request tagged my-tag (right-click a row, Move a reference tag here)'],
  ['{{$my-tag.@status}}', 'its status; also @url @path @id header.Name query.name'],
  ['{{var:name | base64}}', 'pipes encode any token: url base64 base64url hex json jsonesc upper lower'],
];

/** A menu of {{tokens}}: generators, cookies in the jar, and variables. */
export function TokenPicker({ onPick, label = 'Insert token' }: { onPick(token: string): void; label?: string }) {
  const { client } = useApp();
  const [open, setOpen] = useState(false);
  const [cookies, setCookies] = useState<JarCookie[]>([]);
  const [vars, setVars] = useState<Record<string, VarValue>>({});
  const [values, setValues] = useState<ValueField[]>([]);
  const [flows, setFlows] = useState<ApiFlow[]>([]);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    client.cookies().then((c) => setCookies(c.filter((x) => !x.expired)), () => undefined);
    client.vars().then((v) => setVars(v.vars), () => undefined);
    client.values({ limit: 400 }).then((v) => setValues(v.filter((x) => x.idLike && x.side === 'response').slice(0, 60)), () => undefined);
    client.flows().then(setFlows, () => undefined);
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open, client]);

  const pick = (t: string) => {
    onPick(t);
    setOpen(false);
  };
  const f = filter.toLowerCase();
  const names = new Map<string, JarCookie[]>();
  for (const c of cookies) names.set(c.name, [...(names.get(c.name) ?? []), c]);
  const items: Array<{ token: string; hint: string; group: string }> = [
    ...Object.entries(vars).map(([k, v]) => ({ token: `{{var:${k}}}`, hint: v.value.slice(0, 40), group: 'Variables' })),
    ...[...names.entries()].flatMap(([name, list]) =>
      list.length === 1 ? [{ token: `{{cookie:${name}}}`, hint: `${list[0]!.domain} · ${list[0]!.value.slice(0, 30)}`, group: 'Cookies' }] : list.map((c) => ({ token: `{{cookie:${name}@${c.domain}}}`, hint: c.value.slice(0, 30), group: 'Cookies' })),
    ),
    ...flows.flatMap((fl) => [...new Set(fl.steps.flatMap((st) => (st.extract ?? []).map((e) => e.name)))].map((v) => ({ token: `{{flow:${fl.name}.${v}}}`, hint: 'runs the flow for each send', group: 'Flows' }))),
    ...values.map((v) => ({ token: pickToken(v), hint: v.samples[0] ?? '', group: 'From responses' })),
    ...REFERENCES.map(([token, hint]) => ({ token, hint, group: 'Tagged requests and pipes' })),
    ...GENERATORS.map(([token, hint]) => ({ token, hint, group: 'Generators' })),
  ].filter((i) => !f || i.token.toLowerCase().includes(f) || i.hint.toLowerCase().includes(f));
  const groups = [...new Set(items.map((i) => i.group))];

  return (
    <div className="token-picker" ref={ref}>
      <button className="btn small" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {'{{ }}'} {label}
      </button>
      {open && (
        <div className="context-menu token-menu" role="menu">
          <input className="input" autoFocus placeholder="Filter tokens" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter tokens" />
          {groups.map((g) => (
            <div key={g}>
              <div className="nav-heading" style={{ margin: '8px 6px 4px' }}>
                {g}
              </div>
              {items
                .filter((i) => i.group === g)
                .map((i) => (
                  <button key={i.token} role="menuitem" onClick={() => pick(i.token)} title={i.hint}>
                    <span className="mono">{i.token}</span> <span className="faint">{i.hint}</span>
                  </button>
                ))}
            </div>
          ))}
          {items.length === 0 && <div className="faint" style={{ padding: 8 }}>Nothing matches.</div>}
        </div>
      )}
    </div>
  );
}
