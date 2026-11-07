import { useEffect, useRef, useState } from 'react';
import {
  base64Utf8,
  boundaryOf,
  buildMultipart,
  buildPairs,
  fileToken,
  guessType,
  newBoundary,
  parseMultipart,
  parsePairs,
  partFile,
  queryRows,
  splitUrl,
  unbase64Utf8,
  withQueryRows,
  FILE_TOKEN_RE,
  type HeaderPair,
  type Pair,
  type PairKind,
  type Part,
} from '@siteinquisition/codecs/httpmsg';
import type { CoreClient, DecodedValue } from '../api';
import { useApp } from '../state';
import { fmtSize } from '../format';
import { OAuthPanel } from './OAuthPanel';

/**
 * Structured views over Replay's raw request: query parameters, headers,
 * the body (form fields, multipart parts, a file) and auth. The raw text
 * stays the one source of truth: each view reads it, and an edit writes the
 * changed part of it back, leaving everything else as typed.
 *
 * Every value runs through the codec detector, so a parameter that is
 * base64 of JSON with a url-encoded field inside opens as JSON with that
 * field opened too. Editing the decoded form encodes it back through the
 * same layers; an untouched value goes back exactly as it was.
 */

export type BuilderTab = 'raw' | 'params' | 'headers' | 'body' | 'auth';

export interface Attachment {
  bytes: Uint8Array;
  type: string;
}

// ---------- the raw request as text ----------

interface RawParts {
  method: string;
  url: string;
  version: string;
  headers: HeaderPair[];
  body: string;
}

/** Read the raw editor without normalising anything (the URL keeps its encoding and tokens). */
export function splitRaw(raw: string): RawParts | null {
  const text = raw.replace(/\r\n/g, '\n');
  const at = text.indexOf('\n\n');
  const head = at === -1 ? text : text.slice(0, at);
  const body = at === -1 ? '' : text.slice(at + 2);
  const [first = '', ...lines] = head.split('\n');
  const m = /^\s*([A-Za-z]+)\s+(\S+)(?:\s+(HTTP\/[\d.]+))?\s*$/.exec(first);
  if (!m) return null;
  const headers: HeaderPair[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    const i = l.indexOf(':');
    headers.push(i <= 0 ? [l.trim(), ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]);
  }
  return { method: m[1]!, url: m[2]!, version: m[3] ?? 'HTTP/1.1', headers, body };
}

export function joinRaw(p: RawParts): string {
  return `${p.method} ${p.url} ${p.version}\n${p.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${p.body}`;
}

const getHeader = (h: HeaderPair[], n: string) => h.find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1];
const setHeader = (h: HeaderPair[], n: string, v: string | null): HeaderPair[] => {
  const i = h.findIndex(([k]) => k.toLowerCase() === n.toLowerCase());
  if (v === null) return h.filter(([k]) => k.toLowerCase() !== n.toLowerCase());
  return i === -1 ? [...h, [n, v]] : h.map((x, j): HeaderPair => (j === i ? [x[0], v] : x));
};

/** Names a body refers to with {{file:name}}. */
export function fileRefs(text: string): string[] {
  return [...new Set([...text.matchAll(FILE_TOKEN_RE)].map((m) => m[1]!.trim()))];
}

// ---------- decoding values, batched ----------

const cache = new Map<string, DecodedValue | null>();
let queue: Array<{ text: string; done: (d: DecodedValue | null) => void }> = [];
let timer: number | undefined;

function decodeLater(client: CoreClient, text: string): Promise<DecodedValue | null> {
  if (cache.has(text)) return Promise.resolve(cache.get(text)!);
  return new Promise((done) => {
    queue.push({ text, done });
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      const batch = queue;
      queue = [];
      timer = undefined;
      client.decodeValues(batch.map((b) => b.text)).then(
        (out) =>
          batch.forEach((b, i) => {
            if (cache.size > 2000) cache.clear();
            cache.set(b.text, out[i] ?? null);
            b.done(out[i] ?? null);
          }),
        () => batch.forEach((b) => b.done(null)),
      );
    }, 40);
  });
}

function useDecoded(value: string): DecodedValue | null {
  const { client } = useApp();
  const [d, setD] = useState<DecodedValue | null>(cache.get(value) ?? null);
  useEffect(() => {
    let live = true;
    if (value.length < 2) return setD(null);
    // The last result stays up while the new value decodes, so an open editor is not torn down mid-typing.
    void decodeLater(client, value).then((x) => live && setD(x));
    return () => {
      live = false;
    };
  }, [client, value]);
  return d;
}

const chainLabel = (d: DecodedValue) => d.chain.join(' › ');

/** A value with its decoded structure underneath when it has one. */
export function ValueEditor({ value, onChange, label, multiline = false }: { value: string; onChange(v: string): void; label: string; multiline?: boolean }) {
  const d = useDecoded(value);
  const [open, setOpen] = useState(false);
  return (
    <div className="rb-value">
      <div className="rb-value-line">
        {multiline ? (
          <textarea className="input mono" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} rows={Math.min(6, value.split('\n').length)} />
        ) : (
          <input className="input mono" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
        )}
        {d && (
          <button className={`chip rb-chain${open ? ' on' : ''}`} aria-expanded={open} aria-label={`Decoded ${label}: ${chainLabel(d)}`} title="Edit it decoded; it is encoded the same way again" onClick={() => setOpen((o) => !o)}>
            {chainLabel(d)}
          </button>
        )}
      </div>
      {d && open && <DecodedEditor d={d} onChange={onChange} label={label} />}
    </div>
  );
}

/** The decoded side of a value: JSON, form rows or text. Edits are encoded back through the value's layers. */
function DecodedEditor({ d, onChange, label }: { d: DecodedValue; onChange(v: string): void; label: string }) {
  const { client } = useApp();
  const [draft, setDraft] = useState(d.display);
  const [error, setError] = useState<string | null>(null);
  const emitted = useRef(new Set<string>());
  // A new value from outside (not one this editor wrote) resets the draft.
  useEffect(() => {
    if (!emitted.current.has(d.original)) setDraft(d.display);
    if (emitted.current.size > 50) emitted.current.clear();
  }, [d]);
  const push = (shown: string) => {
    setDraft(shown);
    client.encodeValue(d, shown).then(
      (v) => {
        setError(null);
        emitted.current.add(v);
        onChange(v);
      },
      (e: Error) => setError(e.message),
    );
  };
  const nested = d.fields.length ? `Also opened inside: ${d.fields.map((f) => `${f.path} (${f.chain.join(' › ')})`).join(', ')}` : null;
  return (
    <div className="rb-decoded" aria-label={`${label} decoded`}>
      {d.kind === 'form' ? (
        <PairsTable rows={parsePairs(draft, 'form')} kind="form" label={`${label} field`} onChange={(rows) => push(buildPairs(rows, 'form'))} />
      ) : d.kind === 'json' ? (
        <textarea className="input mono rb-json" aria-label={`${label} as JSON`} value={draft} spellCheck={false} rows={Math.min(14, draft.split('\n').length + 1)} onChange={(e) => push(e.target.value)} />
      ) : (
        <textarea className="input mono" aria-label={`${label} decoded text`} value={draft} spellCheck={false} rows={Math.min(6, draft.split('\n').length)} onChange={(e) => push(e.target.value)} />
      )}
      <div className="faint rb-note">
        {chainLabel(d)}
        {d.chain.includes('jwt') ? '. The signature is kept as it was; re-sign it in Codecs if the server checks it.' : ''}
        {nested ? `. ${nested}` : ''}
      </div>
      {error && <div className="error-text rb-note">{error}</div>}
    </div>
  );
}

/** name = value rows (query, form fields, cookies), each value decodable. */
export function PairsTable({ rows, onChange, kind, label }: { rows: Pair[]; onChange(rows: Pair[]): void; kind: PairKind; label: string }) {
  const set = (i: number, p: Partial<Pair>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p, ...(p.name ? { bare: false } : {}) } : r)));
  return (
    <div className="rb-rows" role="table" aria-label={`${label}s`}>
      {rows.map((r, i) => (
        <div className="rb-row" role="row" key={i}>
          <input className="input mono rb-name" aria-label={`${label} name ${i + 1}`} value={r.name} placeholder={r.bare ? '(no name)' : 'name'} onChange={(e) => set(i, { name: e.target.value })} spellCheck={false} />
          <ValueEditor value={r.value} label={`${label} ${r.name || i + 1}`} onChange={(v) => set(i, { value: v })} />
          <button className="icon-btn" aria-label={`Remove ${label} ${r.name || i + 1}`} title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button className="btn small" onClick={() => onChange([...rows, { name: '', value: '' }])}>
        {kind === 'cookie' ? 'Add cookie' : kind === 'query' ? 'Add parameter' : 'Add field'}
      </button>
      {kind === 'query' && <span className="faint rb-note">Values are shown decoded; edited ones are percent-encoded on the way back, tokens left as written.</span>}
    </div>
  );
}

// ---------- tabs ----------

function ParamsTab({ parts, write }: { parts: RawParts; write(p: RawParts): void }) {
  const { base, hash } = splitUrl(parts.url);
  return (
    <div className="rb-pane">
      <label className="rb-field">
        <span className="label">URL without the query</span>
        <input
          className="input mono"
          aria-label="URL without the query"
          value={base}
          spellCheck={false}
          onChange={(e) => {
            const q = splitUrl(parts.url);
            write({ ...parts, url: `${e.target.value}${q.query !== null ? `?${q.query}` : ''}${q.hash}` });
          }}
        />
      </label>
      <PairsTable rows={queryRows(parts.url)} kind="query" label="Parameter" onChange={(rows) => write({ ...parts, url: withQueryRows(parts.url, rows) })} />
      {hash && <div className="faint rb-note">Fragment {hash} is not sent to the server.</div>}
    </div>
  );
}

const COMMON = ['Accept', 'Accept-Language', 'Authorization', 'Cache-Control', 'Content-Type', 'Cookie', 'If-None-Match', 'Origin', 'Referer', 'User-Agent', 'X-Requested-With', 'X-CSRF-Token', 'X-Api-Key'];

/** A credentials value after its scheme: "Bearer eyJ..." decodes the token. */
const schemeSplit = (v: string) => /^([A-Za-z][\w-]*)\s+(\S[\s\S]*)$/.exec(v);

function HeaderValue({ name, value, onChange, label }: { name: string; value: string; onChange(v: string): void; label: string }) {
  if (name.toLowerCase() === 'cookie') {
    return (
      <div className="rb-value">
        <input className="input mono" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
        <div className="rb-decoded">
          <PairsTable rows={parsePairs(value, 'cookie')} kind="cookie" label="Cookie" onChange={(rows) => onChange(buildPairs(rows, 'cookie'))} />
        </div>
      </div>
    );
  }
  const m = /^(authorization|proxy-authorization)$/i.test(name) ? schemeSplit(value) : null;
  if (m) {
    return (
      <div className="rb-value rb-scheme">
        <input className="input mono rb-scheme-name" aria-label={`${label} scheme`} value={m[1]} onChange={(e) => onChange(`${e.target.value} ${m[2]}`)} spellCheck={false} />
        <ValueEditor value={m[2]!} label={`${label} credentials`} onChange={(v) => onChange(`${m[1]} ${v}`)} />
      </div>
    );
  }
  return <ValueEditor value={value} label={label} onChange={onChange} />;
}

function HeadersTab({ parts, write }: { parts: RawParts; write(p: RawParts): void }) {
  const set = (i: number, h: HeaderPair) => write({ ...parts, headers: parts.headers.map((x, j) => (j === i ? h : x)) });
  return (
    <div className="rb-pane">
      <datalist id="rb-header-names">
        {COMMON.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <div className="rb-rows" role="table" aria-label="Headers">
        {parts.headers.map(([k, v], i) => (
          <div className="rb-row" role="row" key={i}>
            <input className="input mono rb-name" list="rb-header-names" aria-label={`Header name ${i + 1}`} value={k} onChange={(e) => set(i, [e.target.value, v])} spellCheck={false} />
            <HeaderValue name={k} value={v} label={`Header ${k || i + 1}`} onChange={(nv) => set(i, [k, nv])} />
            <button className="icon-btn" aria-label={`Remove header ${k || i + 1}`} title="Remove" onClick={() => write({ ...parts, headers: parts.headers.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
        ))}
        <button className="btn small" onClick={() => write({ ...parts, headers: [...parts.headers, ['', '']] })}>
          Add header
        </button>
        <span className="faint rb-note">Host and Content-Length are set on send. Cookie and Authorization values open into their parts.</span>
      </div>
    </div>
  );
}

type BodyMode = 'none' | 'raw' | 'form' | 'multipart' | 'file';

function bodyMode(parts: RawParts): BodyMode {
  const ct = (getHeader(parts.headers, 'content-type') ?? '').toLowerCase();
  if (ct.startsWith('multipart/') && boundaryOf(getHeader(parts.headers, 'content-type'))) return 'multipart';
  if (ct.startsWith('application/x-www-form-urlencoded')) return 'form';
  if (partFile({ value: parts.body })) return 'file';
  return parts.body.trim() ? 'raw' : 'none';
}

/** Pick a local file and attach it; resolves to the name it is attached as. */
function useFilePicker(attach: (name: string, a: Attachment) => void, taken: () => string[]) {
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<((name: string | null) => void) | null>(null);
  const as = useRef<string | null>(null);
  const pick = (name?: string) =>
    new Promise<string | null>((resolve) => {
      pending.current = resolve;
      as.current = name ?? null;
      input.current?.click();
    });
  const el = (
    <input
      ref={input}
      type="file"
      aria-label="Choose a file to attach"
      style={{ display: 'none' }}
      onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return pending.current?.(null);
        let name = as.current ?? f.name;
        if (!as.current) for (let n = 2; taken().includes(name); n++) name = f.name.replace(/(\.[^.]*)?$/, `-${n}$1`);
        attach(name, { bytes: new Uint8Array(await f.arrayBuffer()), type: f.type || guessType(f.name) });
        pending.current?.(name);
      }}
    />
  );
  return { pick, el };
}

function BodyTab({ parts, write, attachments, attach, detach }: { parts: RawParts; write(p: RawParts): void; attachments: Record<string, Attachment>; attach(name: string, a: Attachment): void; detach(name: string): void }) {
  const mode = bodyMode(parts);
  const { pick, el } = useFilePicker(attach, () => Object.keys(attachments));
  const ct = getHeader(parts.headers, 'content-type');
  const refs = fileRefs(parts.body);
  const missing = refs.filter((r) => !attachments[r]);

  const switchTo = async (to: BodyMode) => {
    if (to === mode) return;
    if (to === 'none') return write({ ...parts, body: '', headers: setHeader(parts.headers, 'Content-Type', null) });
    if (to === 'raw') return write({ ...parts, headers: setHeader(parts.headers, 'Content-Type', ct && !/multipart|form-urlencoded/i.test(ct) ? ct : 'application/json') });
    // Carry name=value fields across between form and multipart.
    const fields: Pair[] = mode === 'form' ? parsePairs(parts.body, 'form') : mode === 'multipart' ? (parseMultipart(parts.body, boundaryOf(ct)!) ?? []).filter((p) => !partFile(p)).map((p) => ({ name: p.name, value: p.value })) : [];
    if (to === 'form') return write({ ...parts, body: buildPairs(fields.map(({ name, value }) => ({ name, value })), 'form'), headers: setHeader(parts.headers, 'Content-Type', 'application/x-www-form-urlencoded') });
    if (to === 'multipart') {
      const b = newBoundary();
      return write({ ...parts, body: buildMultipart(fields.map((f) => ({ name: f.name, value: f.value })), b), headers: setHeader(parts.headers, 'Content-Type', `multipart/form-data; boundary=${b}`) });
    }
    const name = await pick();
    if (!name) return;
    write({ ...parts, body: fileToken(name), headers: setHeader(parts.headers, 'Content-Type', guessTypeFor(name, attachments)) });
  };
  const guessTypeFor = (name: string, list: Record<string, Attachment>) => list[name]?.type || guessType(name);

  return (
    <div className="rb-pane">
      {el}
      <div className="segmented" role="group" aria-label="Body type">
        {(['none', 'raw', 'form', 'multipart', 'file'] as BodyMode[]).map((m) => (
          <button key={m} className="seg" aria-pressed={mode === m} onClick={() => void switchTo(m)}>
            {{ none: 'None', raw: 'Raw', form: 'Form fields', multipart: 'Multipart', file: 'File' }[m]}
          </button>
        ))}
      </div>
      {mode === 'none' && <div className="faint rb-note">No body.</div>}
      {mode === 'raw' && (
        <>
          <div className="faint rb-note">Edit the body in Raw. Here it is opened up when it holds encoded or nested JSON.</div>
          <ValueEditor value={parts.body} label="Body" multiline onChange={(v) => write({ ...parts, body: v })} />
        </>
      )}
      {mode === 'form' && <PairsTable rows={parsePairs(parts.body.replace(/\n$/, ''), 'form')} kind="form" label="Field" onChange={(rows) => write({ ...parts, body: buildPairs(rows, 'form') })} />}
      {mode === 'multipart' && <MultipartEditor parts={parts} write={write} attachments={attachments} pick={pick} />}
      {mode === 'file' && (
        <div className="rb-row">
          <span className="mono">{partFile({ value: parts.body })}</span>
          <button className="btn small" onClick={() => void pick().then((n) => n && write({ ...parts, body: fileToken(n), headers: setHeader(parts.headers, 'Content-Type', guessTypeFor(n, attachments)) }))}>
            Choose another file
          </button>
          <span className="faint rb-note">Sent as the whole body, byte for byte.</span>
        </div>
      )}
      {(Object.keys(attachments).length > 0 || missing.length > 0) && (
        <div className="rb-attachments" aria-label="Attached files">
          <span className="label">Files</span>
          {Object.entries(attachments).map(([n, a]) => (
            <div key={n} className="rb-row">
              <span className="mono">{n}</span>
              <span className="faint">
                {a.type} · {fmtSize(a.bytes.length)}
                {refs.includes(n) ? '' : ' · not used in the body'}
              </span>
              <button className="btn small" onClick={() => void pick(n)}>
                Replace
              </button>
              <button className="icon-btn" aria-label={`Remove file ${n}`} onClick={() => detach(n)}>
                ×
              </button>
            </div>
          ))}
          {missing.map((n) => (
            <div key={n} className="rb-row banner" role="alert">
              <span>
                The body sends <span className="mono">{n}</span>, which is not attached. Without it, a file by that name in the project folder is used.
              </span>
              <button className="btn small" onClick={() => void pick(n)}>
                Attach {n}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MultipartEditor({ parts, write, attachments, pick }: { parts: RawParts; write(p: RawParts): void; attachments: Record<string, Attachment>; pick(name?: string): Promise<string | null> }) {
  const boundary = boundaryOf(getHeader(parts.headers, 'content-type'))!;
  const list = parseMultipart(parts.body, boundary);
  if (!list) return <div className="banner">The body does not contain the boundary from Content-Type ({boundary}). Fix it in Raw, or switch the body type to start again.</div>;
  const save = (next: Part[]) => write({ ...parts, body: buildMultipart(next, boundary) });
  const set = (i: number, p: Partial<Part>) => save(list.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="rb-rows" role="table" aria-label="Parts">
      {list.map((p, i) => {
        const file = partFile(p);
        return (
          <div className="rb-part" role="row" key={i}>
            <input className="input mono rb-name" aria-label={`Part name ${i + 1}`} value={p.name} placeholder="name" onChange={(e) => set(i, { name: e.target.value })} spellCheck={false} />
            {file !== null ? (
              <div className="rb-value-line">
                <span className="mono">{file}</span>
                <span className="faint">{attachments[file] ? fmtSize(attachments[file].bytes.length) : 'not attached'}</span>
                <button className="btn small" onClick={() => void pick().then((n) => n && set(i, { value: fileToken(n), filename: p.filename ?? n, contentType: attachments[n]?.type || p.contentType || guessType(n) }))}>
                  Choose file
                </button>
              </div>
            ) : (
              <ValueEditor value={p.value} label={`Part ${p.name || i + 1}`} multiline={p.value.includes('\n')} onChange={(v) => set(i, { value: v })} />
            )}
            <input className="input mono" aria-label={`Part filename ${i + 1}`} value={p.filename ?? ''} placeholder="filename" onChange={(e) => set(i, { filename: e.target.value || undefined })} spellCheck={false} />
            <input className="input mono" aria-label={`Part content type ${i + 1}`} value={p.contentType ?? ''} placeholder="content type" onChange={(e) => set(i, { contentType: e.target.value || undefined })} spellCheck={false} />
            <button className="icon-btn" aria-label={`Remove part ${p.name || i + 1}`} onClick={() => save(list.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        );
      })}
      <div className="rb-row">
        <button className="btn small" onClick={() => save([...list, { name: '', value: '' }])}>
          Add field
        </button>
        <button
          className="btn small"
          onClick={() =>
            void pick().then((n) => {
              if (n) save([...list, { name: 'file', value: fileToken(n), filename: n, contentType: guessType(n) }]);
            })
          }
        >
          Add file
        </button>
        <span className="faint rb-note">Line ends become CRLF on send; files are sent as their bytes.</span>
      </div>
    </div>
  );
}

type AuthMode = 'none' | 'basic' | 'bearer' | 'oauth' | 'other';

function AuthTab({ parts, write }: { parts: RawParts; write(p: RawParts): void }) {
  const value = getHeader(parts.headers, 'authorization');
  const m = value ? schemeSplit(value) : null;
  const oauth = value ? /^Bearer\s+\{\{\s*oauth:([\w.-]*?)\s*\}\}$/i.exec(value) : null;
  const mode: AuthMode = !value ? 'none' : oauth ? 'oauth' : /^basic$/i.test(m?.[1] ?? '') ? 'basic' : /^bearer$/i.test(m?.[1] ?? '') ? 'bearer' : 'other';
  const setAuth = (v: string | null) => write({ ...parts, headers: setHeader(parts.headers, 'Authorization', v) });
  const basic = mode === 'basic' ? unbase64Utf8(m![2]!) : null;
  const [user, pass] = basic !== null ? [basic.slice(0, basic.indexOf(':') === -1 ? basic.length : basic.indexOf(':')), basic.indexOf(':') === -1 ? '' : basic.slice(basic.indexOf(':') + 1)] : ['', ''];
  const switchTo = (to: AuthMode) => {
    if (to === mode) return;
    if (to === 'none') setAuth(null);
    else if (to === 'basic') setAuth(`Basic ${base64Utf8(':')}`);
    else if (to === 'bearer') setAuth('Bearer ');
    else if (to === 'oauth') setAuth('Bearer {{oauth:}}');
    else setAuth(value ?? '');
  };
  return (
    <div className="rb-pane">
      <div className="segmented" role="group" aria-label="Auth type">
        {(['none', 'basic', 'bearer', 'oauth', 'other'] as AuthMode[]).map((a) => (
          <button key={a} className="seg" aria-pressed={mode === a} onClick={() => switchTo(a)}>
            {{ none: 'None', basic: 'Basic', bearer: 'Bearer token', oauth: 'OAuth 2.0', other: 'Other' }[a]}
          </button>
        ))}
      </div>
      {mode === 'none' && <div className="faint rb-note">No Authorization header. Cookies are in Headers.</div>}
      {mode === 'basic' && (
        <div className="rb-grid">
          <label className="rb-field">
            <span className="label">User</span>
            <input className="input mono" aria-label="Basic auth user" value={user} onChange={(e) => setAuth(`Basic ${base64Utf8(`${e.target.value}:${pass}`)}`)} spellCheck={false} />
          </label>
          <label className="rb-field">
            <span className="label">Password</span>
            <input className="input mono" aria-label="Basic auth password" value={pass} onChange={(e) => setAuth(`Basic ${base64Utf8(`${user}:${e.target.value}`)}`)} spellCheck={false} />
          </label>
          {basic === null && <div className="banner">The Basic credentials are not base64 of user:password; edit them in Headers.</div>}
        </div>
      )}
      {mode === 'bearer' && (
        <label className="rb-field">
          <span className="label">Token</span>
          <ValueEditor value={m?.[2] ?? ''} label="Bearer token" onChange={(v) => setAuth(`Bearer ${v}`)} />
        </label>
      )}
      {mode === 'oauth' && <OAuthPanel selected={oauth?.[1] ?? ''} onSelect={(n) => setAuth(`Bearer {{oauth:${n}}}`)} />}
      {mode === 'other' && <HeaderValue name="Authorization" value={value ?? ''} label="Authorization" onChange={(v) => setAuth(v)} />}
    </div>
  );
}

/** The tab strip and the structured view for the current tab; Raw is drawn by Replay itself. */
export function RequestBuilder({
  tab,
  raw,
  setRaw,
  attachments,
  attach,
  detach,
}: {
  tab: Exclude<BuilderTab, 'raw'>;
  raw: string;
  setRaw(raw: string): void;
  attachments: Record<string, Attachment>;
  attach(name: string, a: Attachment): void;
  detach(name: string): void;
}) {
  const parts = splitRaw(raw);
  if (!parts) return <div className="banner" style={{ margin: 8 }}>The first line must look like METHOD https://host/path HTTP/1.1. Fix it in Raw.</div>;
  const write = (p: RawParts) => setRaw(joinRaw(p));
  return (
    <div className="rb" aria-label="Request builder">
      {tab === 'params' && <ParamsTab parts={parts} write={write} />}
      {tab === 'headers' && <HeadersTab parts={parts} write={write} />}
      {tab === 'body' && <BodyTab parts={parts} write={write} attachments={attachments} attach={attach} detach={detach} />}
      {tab === 'auth' && <AuthTab parts={parts} write={write} />}
    </div>
  );
}

export const builderCounts = (raw: string): Record<BuilderTab, string> => {
  const p = splitRaw(raw);
  if (!p) return { raw: '', params: '', headers: '', body: '', auth: '' };
  const q = queryRows(p.url).length;
  const auth = getHeader(p.headers, 'authorization');
  return { raw: '', params: q ? String(q) : '', headers: String(p.headers.length), body: p.body.trim() ? fmtSize(new TextEncoder().encode(p.body).length) : '', auth: auth ? (schemeSplit(auth)?.[1] ?? 'set') : '' };
};
