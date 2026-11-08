import type { ExchangeSummary, HeaderList } from './api';

export const fmtSize = (n: number | null | undefined): string =>
  n === null || n === undefined ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export const fmtMs = (n: number | null | undefined): string =>
  n === null || n === undefined ? '' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`;

export const fmtTime = (epochMs: number): string => {
  const d = new Date(epochMs);
  const pad = (x: number, w = 2) => String(x).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const fmtCount = (n: number) => n.toLocaleString('en-US');

/** Text shown in the status column: the code, or what happened instead. */
export const statusText = (e: Pick<ExchangeSummary, 'status' | 'state' | 'scheme'>): string => {
  if (e.status !== null) return String(e.status);
  if (e.state === 'complete') return e.scheme.startsWith('mqtt') ? 'OK' : '';
  if (e.state === 'pending') return '...';
  return e.state === 'aborted' ? 'ABRT' : 'ERR';
};

export const statusClass = (e: Pick<ExchangeSummary, 'status' | 'state'>): string =>
  e.status !== null ? `s-${String(e.status)[0]}` : e.state === 'error' || e.state === 'aborted' ? 's-err' : e.state === 'complete' ? 's-2' : '';

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const lenientDecoder = new TextDecoder('utf-8');

/** Decode bytes as UTF-8 text, or return null when they are not text. */
export function asText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return '';
  const sample = bytes.subarray(0, 4096);
  let control = 0;
  for (const c of sample) {
    if (c === 0) return null;
    if (c < 9 || (c > 13 && c < 32)) control++;
  }
  if (control / sample.length > 0.05) return null;
  try {
    return textDecoder.decode(bytes);
  } catch {
    return null;
  }
}

export const lenientText = (bytes: Uint8Array) => lenientDecoder.decode(bytes);

export function hexDump(bytes: Uint8Array, max = 4096): string {
  const lines: string[] = [];
  for (let i = 0; i < Math.min(bytes.length, max); i += 16) {
    const row = bytes.subarray(i, i + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > max) lines.push(`... ${bytes.length - max} more bytes`);
  return lines.join('\n');
}

/** Pretty-print JSON when the body is JSON; otherwise return the text unchanged. */
export function prettyBody(text: string, headers: HeaderList | null): string {
  const type = headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const trimmed = text.trimStart();
  if (/json/i.test(type) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

export const header = (headers: HeaderList | null | undefined, name: string) =>
  headers?.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

/** The editable raw form used by the replay editor: an absolute-URL request line, headers, blank line, body. */
/**
 * The protocol as people write it: HTTP/1.1, HTTP/2, HTTP/3. Node reports
 * HTTP/2 as "2.0", which is not a real version string, so that becomes
 * HTTP/2. Labels that already name a protocol (MQTT/5.0) pass through.
 */
export function httpLabel(version: string | null | undefined): string {
  const v = (version ?? '').trim();
  if (!v) return 'HTTP/1.1';
  if (/^[A-Za-z]+\//.test(v)) return v.replace(/^HTTP\/([23])(?:\.0)?$/i, 'HTTP/$1');
  if (/^[23](?:\.0)?$/.test(v)) return `HTTP/${v[0]}`;
  return `HTTP/${v}`;
}

/** HTTP/2 and HTTP/3 carry the method, scheme, host and path as pseudo-headers, whose names start with a colon. */
export const isPseudoHeader = (name: string) => name.startsWith(':');

/** True for exchanges that went over HTTP/2 or HTTP/3. */
export const isFramedHttp = (version: string | null | undefined) => /^(?:HTTP\/)?[23](?:\.0)?$/i.test((version ?? '').trim());

/**
 * A request as editable text. Pseudo-headers (:method, :path...) are left
 * out: the request line already says the same thing, and whichever protocol
 * Replay sends over builds its own from it.
 */
export function toRawRequest(method: string, url: string, headers: HeaderList, body: string): string {
  return `${method} ${url} HTTP/1.1\n${headers.filter(([k]) => !isPseudoHeader(k)).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${body}`;
}

export interface ParsedRequest {
  method: string;
  url: string;
  headers: HeaderList;
  body: string;
}

export function parseRawRequest(raw: string): ParsedRequest {
  const text = raw.replace(/\r\n/g, '\n');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : text.slice(split + 2);
  const [requestLine = '', ...headerLines] = head.split('\n');
  const m = /^([A-Za-z]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/.exec(requestLine.trim());
  if (!m) throw new Error('First line must look like: METHOD https://host/path HTTP/1.1');
  let url: URL;
  try {
    url = new URL(m[2]!);
  } catch {
    throw new Error('The request line needs an absolute URL, e.g. https://example.com/path');
  }
  const headers: HeaderList = [];
  for (const line of headerLines) {
    if (!line.trim()) continue;
    // A pasted HTTP/2 pseudo-header (":method: GET") has its colon after the leading one.
    const i = line.indexOf(':', line.trimStart().startsWith(':') ? line.indexOf(':') + 1 : 0);
    if (i <= 0) throw new Error(`Header line is missing a colon: ${line}`);
    const name = line.slice(0, i).trim();
    // The request line is what counts; pseudo-headers pasted from HTTP/2 traffic would only repeat it.
    if (isPseudoHeader(name)) continue;
    headers.push([name, line.slice(i + 1).trim()]);
  }
  return { method: m[1]!.toUpperCase(), url: url.href, headers, body };
}

/** Save text as a file through the browser's download. */
export function downloadText(name: string, text: string, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
