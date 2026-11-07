/**
 * Building requests by hand: curl commands in, query strings, form bodies,
 * cookie headers and multipart bodies taken apart into rows and put back
 * together. Plain TypeScript with no Node APIs, so the renderer and the core
 * both use it.
 *
 * Rows keep the text they were parsed from, so a row nobody edited goes back
 * byte for byte, however oddly it was encoded. Tokens such as {{var:id}} are
 * never percent-encoded.
 */

export type HeaderPair = [string, string];

// ---------- small helpers ----------

const TOKEN_SPLIT = /(\{\{[\s\S]*?\}\})/;

/** Percent-encode like encodeURIComponent, leaving {{tokens}} as written. */
export function encodePart(s: string, opts: { space?: '+' | '%20' } = {}): string {
  return s
    .split(TOKEN_SPLIT)
    .map((p, i) => (i % 2 ? p : encodeURIComponent(p).replace(/%20/g, opts.space === '+' ? '+' : '%20')))
    .join('');
}

/** decodeURIComponent that never throws: a bad escape stays as written. */
export function safeDecode(s: string, plusIsSpace = false): string {
  const t = plusIsSpace ? s.replace(/\+/g, ' ') : s;
  try {
    return decodeURIComponent(t);
  } catch {
    return t.replace(/(%[0-9a-f]{2})+/gi, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    });
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 of a string's UTF-8 bytes, for Basic auth. */
export function base64Utf8(s: string): string {
  const b = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < b.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < b.length ? B64[n & 63]! : '=');
  }
  return out;
}

/** Text from base64 (standard or url-safe), or null when it is not base64 of UTF-8 text. */
export function unbase64Utf8(s: string): string | null {
  const t = s.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(t) || t.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const c of t) {
    buf = (buf << 6) | B64.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 255);
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

export const headerValue = (headers: HeaderPair[], name: string): string | undefined => headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

/** Set (or with null, remove) a header, keeping its place and case when it is already there. */
export function setHeader(headers: HeaderPair[], name: string, value: string | null): HeaderPair[] {
  const i = headers.findIndex(([k]) => k.toLowerCase() === name.toLowerCase());
  if (value === null) return headers.filter(([k]) => k.toLowerCase() !== name.toLowerCase());
  if (i === -1) return [...headers, [name, value]];
  return headers.map((h, j): HeaderPair => (j === i ? [h[0], value] : h)).filter(([k], j) => j <= i || k.toLowerCase() !== name.toLowerCase());
}

// ---------- name=value rows: query strings, form bodies, cookie headers ----------

export type PairKind = 'query' | 'form' | 'cookie';

export interface Pair {
  name: string;
  value: string;
  /** Written without "=" (a bare flag, or an encoded blob as the whole query). */
  bare?: boolean;
  /** Where the row came from, so an unedited row goes back exactly as it was. */
  raw?: { text: string; name: string; value: string };
}

const SEP: Record<PairKind, RegExp> = { query: /&/, form: /&/, cookie: /;\s*/ };

/** Split a query string (no "?"), a form body or a Cookie header into rows, decoded for reading. */
export function parsePairs(text: string, kind: PairKind): Pair[] {
  if (!text) return [];
  const plus = kind !== 'cookie';
  return text
    .split(SEP[kind])
    .filter((p) => p !== '')
    .map((piece) => {
      const at = piece.indexOf('=');
      const rawName = at === -1 ? piece : piece.slice(0, at);
      const rawValue = at === -1 ? '' : piece.slice(at + 1);
      // A piece with no "=" is a value on its own (an encoded blob as the whole query, say).
      const bare = at === -1;
      const name = bare ? '' : kind === 'cookie' ? rawName.trim() : safeDecode(rawName, plus);
      const value = bare ? (kind === 'cookie' ? piece : safeDecode(piece, plus)) : kind === 'cookie' ? rawValue : safeDecode(rawValue, plus);
      return { name, value, ...(bare ? { bare } : {}), raw: { text: piece, name, value } };
    });
}

/** Put rows back together; rows nobody changed keep their original text. */
export function buildPairs(pairs: Pair[], kind: PairKind): string {
  const pieces = pairs.map((p) => {
    if (p.raw && p.raw.name === p.name && p.raw.value === p.value && !!p.bare === !p.raw.text.includes('=')) return p.raw.text;
    if (kind === 'cookie') return p.bare && !p.name ? p.value : `${p.name}=${p.value}`;
    const space = kind === 'form' ? '+' : '%20';
    if (p.bare && !p.name) return encodePart(p.value, { space });
    return `${encodePart(p.name, { space })}=${encodePart(p.value, { space })}`;
  });
  return pieces.join(kind === 'cookie' ? '; ' : '&');
}

/** A URL in three parts. Works on text, so tokens and odd encodings survive. */
export function splitUrl(url: string): { base: string; query: string | null; hash: string } {
  const h = url.indexOf('#');
  const hash = h === -1 ? '' : url.slice(h);
  const rest = h === -1 ? url : url.slice(0, h);
  const q = rest.indexOf('?');
  return q === -1 ? { base: rest, query: null, hash } : { base: rest.slice(0, q), query: rest.slice(q + 1), hash };
}

export function joinUrl(parts: { base: string; query: string | null; hash: string }): string {
  return `${parts.base}${parts.query !== null && parts.query !== '' ? `?${parts.query}` : ''}${parts.hash}`;
}

export const queryRows = (url: string): Pair[] => parsePairs(splitUrl(url).query ?? '', 'query');

export const withQueryRows = (url: string, rows: Pair[]): string => {
  const p = splitUrl(url);
  return joinUrl({ ...p, query: buildPairs(rows, 'query') });
};

// ---------- multipart/form-data ----------

export interface Part {
  name: string;
  /** Text of the part, or a {{file:...}} token for a file. */
  value: string;
  filename?: string;
  contentType?: string;
  /** Other part headers, kept as they were. */
  headers?: HeaderPair[];
}

export const FILE_TOKEN_RE = /\{\{\s*file:([^}|]+?)\s*\}\}/g;

/** The file a part sends, when its value is a single {{file:name}} token. */
export function partFile(p: Pick<Part, 'value'>): string | null {
  const m = /^\{\{\s*file:([^}|]+?)\s*\}\}$/.exec(p.value.trim());
  return m ? m[1]! : null;
}

export const fileToken = (name: string): string => `{{file:${name}}}`;

export function boundaryOf(contentType: string | undefined): string | null {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  return m ? (m[1] ?? m[2]!) : null;
}

export function newBoundary(): string {
  let s = '';
  for (let i = 0; i < 24; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)];
  return `----siq${s}`;
}

const quoteParam = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;

function dispositionParams(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of v.matchAll(/;\s*([\w*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g)) out[m[1]!.toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]!.trim();
  return out;
}

/** Parse the head of one part: its name, filename, content type and any other headers. */
function partHead(lines: string[]): Omit<Part, 'value'> {
  const p: Omit<Part, 'value'> = { name: '' };
  const other: HeaderPair[] = [];
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k.toLowerCase() === 'content-disposition') {
      const params = dispositionParams(v);
      p.name = params.name ?? '';
      if (params.filename !== undefined) p.filename = params.filename;
    } else if (k.toLowerCase() === 'content-type') p.contentType = v;
    else other.push([k, v]);
  }
  if (other.length) p.headers = other;
  return p;
}

/** Take a multipart body (as text, with \n or \r\n line ends) apart. Null when the boundary is not in it. */
export function parseMultipart(body: string, boundary: string): Part[] | null {
  const text = body.replace(/\r\n/g, '\n');
  const delim = `--${boundary}`;
  if (!text.includes(delim)) return null;
  const chunks = text.split(new RegExp(`(?:^|\\n)${delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const parts: Part[] = [];
  for (const chunk of chunks.slice(1)) {
    if (chunk.startsWith('--')) break;
    const c = chunk.replace(/^[ \t]*\n/, '');
    const split = c.indexOf('\n\n');
    const head = split === -1 ? c : c.slice(0, split);
    const value = split === -1 ? '' : c.slice(split + 2);
    parts.push({ ...partHead(head.split('\n')), value });
  }
  return parts;
}

/** A multipart body with \n line ends (Replay turns them into \r\n on send). */
export function buildMultipart(parts: Part[], boundary: string): string {
  const out: string[] = [];
  for (const p of parts) {
    out.push(`--${boundary}`);
    out.push(`Content-Disposition: form-data; name=${quoteParam(p.name)}${p.filename !== undefined ? `; filename=${quoteParam(p.filename)}` : ''}`);
    if (p.contentType) out.push(`Content-Type: ${p.contentType}`);
    for (const [k, v] of p.headers ?? []) out.push(`${k}: ${v}`);
    out.push('');
    out.push(p.value);
  }
  out.push(`--${boundary}--`);
  return `${out.join('\n')}\n`;
}

/** Turn \n line ends into \r\n, as multipart needs, leaving \r\n alone. */
export const crlf = (s: string): string => s.replace(/\r?\n/g, '\r\n');

const indexOfBytes = (hay: Uint8Array, needle: Uint8Array, from: number): number => {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};

const isText = (b: Uint8Array): boolean => {
  if (b.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};

/**
 * Take a captured multipart body apart at the byte level: text parts come
 * back as text, binary parts as bytes, so a captured upload can be edited
 * with its files attached.
 */
export function parseMultipartBytes(body: Uint8Array, boundary: string): Array<Omit<Part, 'value'> & { text?: string; bytes?: Uint8Array }> | null {
  const enc = new TextEncoder();
  const delim = enc.encode(`--${boundary}`);
  let at = indexOfBytes(body, delim, 0);
  if (at === -1) return null;
  const out: Array<Omit<Part, 'value'> & { text?: string; bytes?: Uint8Array }> = [];
  for (;;) {
    let start = at + delim.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // closing --boundary--
    while (body[start] === 0x20 || body[start] === 0x09) start++;
    if (body[start] === 0x0d) start++;
    if (body[start] === 0x0a) start++;
    const next = indexOfBytes(body, delim, start);
    if (next === -1) return null;
    let end = next;
    if (body[end - 1] === 0x0a) end--;
    if (body[end - 1] === 0x0d) end--;
    const chunk = body.subarray(start, end);
    let headEnd = indexOfBytes(chunk, enc.encode('\r\n\r\n'), 0);
    let sepLen = 4;
    if (headEnd === -1) {
      headEnd = indexOfBytes(chunk, enc.encode('\n\n'), 0);
      sepLen = 2;
    }
    const headText = new TextDecoder().decode(headEnd === -1 ? chunk : chunk.subarray(0, headEnd));
    const content = headEnd === -1 ? new Uint8Array() : chunk.subarray(headEnd + sepLen);
    const head = partHead(headText.split(/\r?\n/));
    // Fields stay inline as text; uploaded files do too when they are small text files.
    const inline = isText(content) && (head.filename === undefined || (content.length < 64 * 1024 && !/octet|image|audio|video|zip|pdf|protobuf/i.test(head.contentType ?? '')));
    out.push(inline ? { ...head, text: new TextDecoder().decode(content) } : { ...head, bytes: content.slice() });
    at = next;
  }
  return out;
}

// ---------- curl ----------

export interface CurlImport {
  method: string;
  url: string;
  headers: HeaderPair[];
  body: string;
  /** Local files the command reads (as written in it); the body refers to each one with {{file:path}}. */
  files: string[];
  /** Send options the command asks for. */
  options: { insecure?: boolean; followRedirects?: boolean; protocol?: 'h1' | 'h2' | 'h3'; h2PriorKnowledge?: boolean };
  /** What was left out, and why. */
  warnings: string[];
}

/** Split a shell command into words: bash quoting, $'...', and Windows cmd (^) and PowerShell (`) line continuations. */
export function shellWords(input: string): string[] {
  let s = input.trim().replace(/^\$\s+/, '');
  // Chrome's "Copy as cURL (cmd)" escapes with carets: ^" ^\^" ^& and a trailing ^ for a new line.
  if (/\^\r?\n|\^"/.test(s)) s = s.replace(/\^\r?\n/g, ' ').replace(/\^(.)/g, '$1');
  // PowerShell continues lines with a backtick.
  s = s.replace(/`\r?\n/g, ' ');
  const words: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  const ansi = (): void => {
    i += 2;
    while (i < s.length && s[i] !== "'") {
      if (s[i] === '\\' && i + 1 < s.length) {
        const c = s[++i]!;
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '0': '\0' };
        if (c === 'x') {
          const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1))![0];
          cur += String.fromCharCode(parseInt(m, 16));
          i += m.length;
        } else if (c === 'u' || c === 'U') {
          const m = /^[0-9a-fA-F]{1,8}/.exec(s.slice(i + 1))?.[0] ?? '';
          cur += m ? String.fromCodePoint(parseInt(m, 16)) : c;
          i += m.length;
        } else cur += map[c] ?? `\\${c}`;
      } else cur += s[i];
      i++;
    }
    i++;
  };
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && (s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n'))) {
      i += s[i + 1] === '\r' ? 3 : 2;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) words.push(cur);
      cur = '';
      has = false;
      i++;
      continue;
    }
    has = true;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) throw new Error('A single quote is not closed.');
      cur += s.slice(i + 1, end);
      i = end + 1;
    } else if (c === '$' && s[i + 1] === "'") ansi();
    else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1]!)) {
          if (s[i + 1] !== '\n') cur += s[i + 1];
          i += 2;
        } else cur += s[i++];
      }
      if (i >= s.length) throw new Error('A double quote is not closed.');
      i++;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[i + 1];
      i += 2;
    } else {
      cur += c;
      i++;
    }
  }
  if (has) words.push(cur);
  return words;
}

/** Long options that take a value; short ones are mapped to these. */
const SHORT: Record<string, string> = {
  X: 'request', H: 'header', d: 'data', F: 'form', u: 'user', b: 'cookie', A: 'user-agent', e: 'referer', T: 'upload-file', r: 'range',
  o: 'output', m: 'max-time', x: 'proxy', w: 'write-out', c: 'cookie-jar', D: 'dump-header', E: 'cert', K: 'config', U: 'proxy-user', Y: 'speed-limit', y: 'speed-time', z: 'time-cond', C: 'continue-at', P: 'ftp-port', Q: 'quote', t: 'telnet-option',
};
const SHORT_FLAGS: Record<string, string> = { k: 'insecure', L: 'location', G: 'get', I: 'head', s: 'silent', S: 'show-error', v: 'verbose', i: 'include', f: 'fail', g: 'globoff', N: 'no-buffer', '#': 'progress-bar', '0': 'http1.0', '4': 'ipv4', '6': 'ipv6', j: 'junk-session-cookies', l: 'list-only', n: 'netrc', O: 'remote-name', R: 'remote-time', q: 'disable', Z: 'parallel', J: 'remote-header-name', V: 'version', M: 'manual', h: 'help', a: 'append', B: 'use-ascii', p: 'proxytunnel', 2: 'sslv2', 3: 'sslv3' };
const TAKES_VALUE = new Set([
  ...Object.values(SHORT),
  'url', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json', 'form-string', 'oauth2-bearer', 'aws-sigv4', 'connect-timeout', 'retry', 'retry-delay', 'retry-max-time', 'cacert', 'capath', 'key', 'pass', 'resolve', 'connect-to', 'limit-rate', 'interface', 'max-redirs', 'max-filesize', 'url-query', 'variable', 'expand-url', 'proxy-header', 'unix-socket', 'abstract-unix-socket', 'dns-servers', 'cert-type', 'key-type', 'ciphers', 'tls13-ciphers', 'pinnedpubkey', 'local-port', 'happy-eyeballs-timeout-ms', 'keepalive-time', 'expect100-timeout', 'trace', 'trace-ascii', 'stderr', 'request-target', 'netrc-file', 'output-dir', 'create-file-mode', 'etag-save', 'etag-compare', 'hsts', 'alt-svc', 'doh-url', 'sasl-authzid', 'login-options', 'mail-from', 'mail-rcpt', 'mail-auth', 'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'preproxy', 'noproxy', 'proxy-cacert', 'proxy-cert', 'proxy-key', 'proxy-pass', 'proxy-ciphers', 'parallel-max', 'rate', 'ip-tos', 'vlan-priority', 'mptcp', 'service-name',
]);
/** Options that change nothing about the request itself. */
const IGNORED = new Set(['silent', 'show-error', 'verbose', 'include', 'fail', 'fail-with-body', 'globoff', 'no-buffer', 'progress-bar', 'ipv4', 'ipv6', 'output', 'max-time', 'connect-timeout', 'retry', 'retry-delay', 'retry-max-time', 'write-out', 'dump-header', 'compressed', 'path-as-is', 'no-progress-meter', 'remote-name', 'remote-name-all', 'remote-header-name', 'tcp-nodelay', 'no-keepalive', 'keepalive-time', 'limit-rate', 'max-redirs', 'max-filesize', 'stderr', 'trace', 'trace-ascii', 'create-dirs', 'output-dir', 'parallel', 'parallel-max', 'location-trusted', 'post301', 'post302', 'post303', 'tlsv1', 'tlsv1.0', 'tlsv1.1', 'tlsv1.2', 'tlsv1.3', 'tls-max', 'sslv2', 'sslv3', 'ssl-no-revoke', 'no-sessionid', 'no-alpn', 'no-npn', 'raw', 'tr-encoding', 'http0.9', 'happy-eyeballs-timeout-ms', 'expect100-timeout', 'remote-time', 'disable', 'junk-session-cookies', 'styled-output', 'no-styled-output', 'ca-native', 'proxy-ca-native', 'netrc', 'netrc-optional']);

/** Content types worth guessing from a file name. */
export function guessType(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
    pdf: 'application/pdf', json: 'application/json', xml: 'application/xml', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
    txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html', js: 'text/javascript', css: 'text/css', md: 'text/markdown',
    mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', bin: 'application/octet-stream', wasm: 'application/wasm', proto: 'application/x-protobuf',
  };
  return map[ext] ?? 'application/octet-stream';
}

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

/** Does this text look like a curl command (as copied from browser devtools, docs or a terminal)? */
export const looksLikeCurl = (text: string): boolean => /^\s*(\$\s+)?curl(\.exe)?\s/i.test(text);

/**
 * Turn a curl command into a request. Understands what browsers' "Copy as
 * cURL" (bash and cmd) writes and the common options from API docs: -X, -H,
 * -d and its variants, --json, -F, -G, -u, -b, -A, -e, -T, -I, -k, -L,
 * --oauth2-bearer and the HTTP version flags. Files the command reads become
 * {{file:path}} tokens, and anything it cannot carry over is listed in warnings.
 */
export function parseCurl(command: string): CurlImport {
  const words = shellWords(command);
  if (!words.length || !/^curl(\.exe)?$/i.test(words[0]!.replace(/^.*[\\/]/, ''))) throw new Error('This does not start with curl.');
  const out: CurlImport = { method: '', url: '', headers: [], body: '', files: [], options: {}, warnings: [] };
  const data: string[] = [];
  const form: Part[] = [];
  const urls: string[] = [];
  let get = false;
  let head = false;
  let json = false;
  let upload: string | null = null;
  const file = (path: string) => {
    if (!out.files.includes(path)) out.files.push(path);
    return fileToken(path);
  };
  const warn = (w: string) => {
    if (!out.warnings.includes(w)) out.warnings.push(w);
  };

  const opts: Array<[string, string | null]> = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w === '--') {
      urls.push(...words.slice(i + 1));
      break;
    }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      let name = (eq === -1 ? w.slice(2) : w.slice(2, eq)).toLowerCase();
      if (name.startsWith('no-') && !TAKES_VALUE.has(name) && !IGNORED.has(name)) name = `!${name.slice(3)}`;
      if (eq !== -1) opts.push([name, w.slice(eq + 1)]);
      else if (TAKES_VALUE.has(name)) opts.push([name, words[++i] ?? '']);
      else opts.push([name, null]);
    } else if (w.startsWith('-') && w.length > 1) {
      // Bundles like -sSL, or -XPOST with its value attached.
      for (let j = 1; j < w.length; j++) {
        const c = w[j]!;
        if (SHORT[c]) {
          const rest = w.slice(j + 1);
          opts.push([SHORT[c]!, rest || (words[++i] ?? '')]);
          break;
        }
        if (SHORT_FLAGS[c]) opts.push([SHORT_FLAGS[c]!, null]);
        else warn(`Left out unknown option -${c}.`);
      }
    } else urls.push(w);
  }

  for (const [name, v] of opts) {
    const val = v ?? '';
    switch (name) {
      case 'url':
        urls.push(val);
        break;
      case 'request':
        out.method = val.toUpperCase();
        break;
      case 'header': {
        if (val.startsWith('@')) {
          warn(`Left out headers read from the file ${val.slice(1)}.`);
          break;
        }
        const i = val.indexOf(':');
        const semi = val.endsWith(';') && i === -1;
        if (semi) out.headers.push([val.slice(0, -1).trim(), '']);
        else if (i > 0) {
          const k = val.slice(0, i).trim();
          const hv = val.slice(i + 1).trim();
          // "-H 'X-Thing:'" removes a header curl would add; nothing to remove here.
          if (hv || val.slice(i + 1).length) out.headers.push([k, hv]);
        } else warn(`Left out a header without a colon: ${val}`);
        break;
      }
      case 'data':
      case 'data-ascii':
        data.push(val.startsWith('@') ? file(val.slice(1)) : val);
        break;
      case 'data-raw':
        data.push(val);
        break;
      case 'data-binary':
        data.push(val.startsWith('@') ? file(val.slice(1)) : val);
        break;
      case 'json':
        json = true;
        data.push(val.startsWith('@') ? file(val.slice(1)) : val);
        break;
      case 'data-urlencode': {
        const at = val.indexOf('@');
        const eq = val.indexOf('=');
        if (at !== -1 && (eq === -1 || at < eq)) {
          const n = val.slice(0, at);
          warn(`The file ${val.slice(at + 1)} is sent as it is, not URL-encoded; encode it with a pipe or in Codecs if the server needs that.`);
          data.push(`${n ? `${n}=` : ''}${file(val.slice(at + 1))}`);
        } else if (eq === -1) data.push(encodePart(val, { space: '+' }));
        else data.push(`${val.slice(0, eq)}${eq > 0 ? '=' : ''}${encodePart(val.slice(eq + 1), { space: '+' })}`);
        break;
      }
      case 'form':
      case 'form-string': {
        const eq = val.indexOf('=');
        if (eq <= 0) {
          warn(`Left out a form field without a name: ${val}`);
          break;
        }
        const fname = val.slice(0, eq);
        let rest = val.slice(eq + 1);
        if (name === 'form' && (rest.startsWith('@') || rest.startsWith('<'))) {
          const asFile = rest.startsWith('@');
          const segs = rest.slice(1).split(';');
          const path = segs[0]!.replace(/^"|"$/g, '');
          const part: Part = { name: fname, value: file(path) };
          if (asFile) part.filename = baseName(path);
          for (const s of segs.slice(1)) {
            const [k, ...vv] = s.split('=');
            const pv = vv.join('=').replace(/^"|"$/g, '');
            if (k!.trim() === 'type') part.contentType = pv;
            else if (k!.trim() === 'filename') part.filename = pv;
          }
          if (asFile && !part.contentType) part.contentType = guessType(part.filename ?? path);
          form.push(part);
        } else {
          let type: string | undefined;
          if (name === 'form') {
            const m = /^(.*?);type=([^;]+)$/.exec(rest);
            if (m) {
              rest = m[1]!;
              type = m[2];
            }
            if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
          }
          form.push({ name: fname, value: rest, ...(type ? { contentType: type } : {}) });
        }
        break;
      }
      case 'get':
        get = true;
        break;
      case 'head':
        head = true;
        break;
      case 'user': {
        out.headers.push(['Authorization', `Basic ${base64Utf8(val.includes(':') ? val : `${val}:`)}`]);
        if (!val.includes(':')) warn('curl would ask for the password; it is left empty in the Authorization header.');
        break;
      }
      case 'oauth2-bearer':
        out.headers.push(['Authorization', `Bearer ${val}`]);
        break;
      case 'cookie':
        if (val.includes('=')) out.headers.push(['Cookie', val]);
        else warn(`Left out the cookie file ${val}; the cookie jar has the cookies this project has seen (Fresh cookies).`);
        break;
      case 'user-agent':
        out.headers.push(['User-Agent', val]);
        break;
      case 'referer':
        out.headers.push(['Referer', val.replace(/;auto$/, '')]);
        break;
      case 'range':
        out.headers.push(['Range', `bytes=${val}`]);
        break;
      case 'upload-file':
        upload = val;
        break;
      case 'insecure':
        out.options.insecure = true;
        break;
      case 'location':
        out.options.followRedirects = true;
        break;
      case 'http1.1':
      case 'http1.0':
        out.options.protocol = 'h1';
        break;
      case 'http2':
        out.options.protocol = 'h2';
        break;
      case 'http2-prior-knowledge':
        out.options.protocol = 'h2';
        out.options.h2PriorKnowledge = true;
        break;
      case 'http3':
      case 'http3-only':
        out.options.protocol = 'h3';
        break;
      case 'aws-sigv4':
        warn('curl signed this with AWS SigV4: pick a profile in the SigV4 send option to sign it here.');
        break;
      case 'url-query':
        warn(`Left out --url-query ${val}; add it in Params.`);
        break;
      case 'config':
        warn(`Left out options read from the config file ${val}.`);
        break;
      case 'proxy':
      case 'proxy-user':
        warn('Left out the proxy settings; Replay sends straight to the server.');
        break;
      case 'cert':
      case 'key':
      case 'cacert':
      case 'capath':
      case 'pass':
      case 'cert-type':
      case 'key-type':
        warn('Left out the TLS client certificate and CA options; set client certificates and trust in Settings.');
        break;
      case 'resolve':
      case 'connect-to':
        warn(`Left out --${name} ${val}; Replay resolves hosts the normal way.`);
        break;
      default:
        if (!IGNORED.has(name) && !name.startsWith('!')) warn(`Left out --${name}${v !== null ? ` ${v}` : ''}.`);
    }
  }

  if (!urls.length) throw new Error('The curl command has no URL.');
  if (urls.length > 1) warn(`The command has ${urls.length} URLs; only the first was imported.`);
  let url = urls[0]!;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  // curl's globbing ([1-3], {a,b}) is rare in copied commands; keep braces as written.

  const has = (n: string) => out.headers.some(([k]) => k.toLowerCase() === n.toLowerCase());
  if (form.length) {
    if (data.length) warn('The command mixes -d and -F; curl would refuse it. The form fields were imported.');
    const existing = headerValue(out.headers, 'content-type');
    const boundary = boundaryOf(existing) ?? newBoundary();
    out.body = buildMultipart(form, boundary);
    out.headers = setHeader(out.headers, 'Content-Type', existing && boundaryOf(existing) ? existing : `multipart/form-data; boundary=${boundary}`);
    out.method ||= 'POST';
  } else if (data.length) {
    const joined = data.join('&');
    if (get) {
      const p = splitUrl(url);
      url = joinUrl({ ...p, query: p.query ? `${p.query}&${joined}` : joined });
      out.method ||= head ? 'HEAD' : 'GET';
    } else {
      out.body = joined;
      out.method ||= 'POST';
      if (json) {
        if (!has('content-type')) out.headers.push(['Content-Type', 'application/json']);
        if (!has('accept')) out.headers.push(['Accept', 'application/json']);
      } else if (!has('content-type')) out.headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    }
  } else if (upload) {
    out.body = file(upload);
    out.method ||= 'PUT';
    if (!has('content-type')) out.headers.push(['Content-Type', guessType(upload)]);
    // curl -T with a URL ending in "/" appends the file name.
    if (url.endsWith('/')) url += encodeURIComponent(baseName(upload));
  }
  out.method ||= head ? 'HEAD' : 'GET';
  out.url = url;
  return out;
}
