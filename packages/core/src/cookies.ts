import type { CaptureStore, HeaderList } from './store.js';

/**
 * The cookie jar as the recorded traffic built it: every Set-Cookie seen in a
 * response, with later ones replacing earlier ones for the same domain, path
 * and name, the way a browser would.
 */
export interface JarCookie {
  name: string;
  value: string;
  /** Domain the cookie is sent to, without a leading dot. */
  domain: string;
  /** True when the server sent no Domain attribute, so only that exact host gets it. */
  hostOnly: boolean;
  path: string;
  /** Epoch ms, or null for a session cookie. */
  expires: number | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | null;
  /** The exchange whose response set it, and when. */
  setBy: string;
  setAt: number;
  /** True when it has expired or the server deleted it (Max-Age=0 or a past Expires). */
  expired: boolean;
}

export interface ParsedSetCookie {
  name: string;
  value: string;
  attrs: Record<string, string | true>;
}

export function parseSetCookie(header: string): ParsedSetCookie | null {
  const [pair = '', ...rest] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  if (!name) return null;
  const attrs: Record<string, string | true> = {};
  for (const part of rest) {
    const i = part.indexOf('=');
    const key = (i === -1 ? part : part.slice(0, i)).trim().toLowerCase();
    if (key) attrs[key] = i === -1 ? true : part.slice(i + 1).trim();
  }
  return { name, value: pair.slice(eq + 1).trim(), attrs };
}

/** RFC 6265 default-path: the request path up to, not including, its last slash. */
function defaultPath(path: string): string {
  const p = path.split('?')[0] ?? '/';
  if (!p.startsWith('/')) return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function cookiesFromResponse(res: { id: string; host: string; path: string; startedAt: number; headers: HeaderList }): JarCookie[] {
  const out: JarCookie[] = [];
  for (const [k, v] of res.headers) {
    if (k.toLowerCase() !== 'set-cookie') continue;
    const c = parseSetCookie(v);
    if (!c) continue;
    const domainAttr = typeof c.attrs.domain === 'string' ? c.attrs.domain.replace(/^\./, '').toLowerCase() : '';
    const path = typeof c.attrs.path === 'string' && c.attrs.path.startsWith('/') ? c.attrs.path : defaultPath(res.path);
    let expires: number | null = null;
    const maxAge = typeof c.attrs['max-age'] === 'string' ? Number(c.attrs['max-age']) : NaN;
    if (Number.isFinite(maxAge)) expires = res.startedAt + maxAge * 1000;
    else if (typeof c.attrs.expires === 'string') {
      const t = Date.parse(c.attrs.expires);
      if (!Number.isNaN(t)) expires = t;
    }
    out.push({
      name: c.name,
      value: c.value,
      domain: domainAttr || res.host.toLowerCase(),
      hostOnly: !domainAttr,
      path,
      expires,
      httpOnly: c.attrs.httponly === true,
      secure: c.attrs.secure === true,
      sameSite: typeof c.attrs.samesite === 'string' ? c.attrs.samesite : null,
      setBy: res.id,
      setAt: res.startedAt,
      expired: false,
    });
  }
  return out;
}

export function cookieJar(store: CaptureStore, now = Date.now()): JarCookie[] {
  const jar = new Map<string, JarCookie>();
  for (const res of store.setCookieResponses()) {
    for (const c of cookiesFromResponse(res)) jar.set(`${c.domain}\n${c.path}\n${c.name}`, c);
  }
  return [...jar.values()]
    .map((c) => ({ ...c, expired: c.expires !== null && c.expires <= now }))
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}
