import { bytesToString } from '@siteinquisition/codecs';
import { query } from '@siteinquisition/codecs/jsonpath';
import { cookiesFromResponse } from './cookies.js';
import { newId } from './ids.js';
import { globToRegExp } from './scope.js';
import type { CaptureStore, Exchange } from './store.js';

/**
 * Variables for `{{var:name}}` tokens. Values are set by hand, by scripts, or
 * by extraction rules that watch responses (a CSRF token in a header, an
 * access token in a JSON body, a cookie) and keep the latest value.
 */
export interface VarValue {
  value: string;
  /** "manual", "script", or the extractor id that set it. */
  source: string;
  updatedAt: number;
  /** The exchange it was extracted from. */
  exchangeId?: string;
}

export interface Extractor {
  id: string;
  /** Variable to set. */
  name: string;
  enabled?: boolean;
  /** Host glob; empty matches every host. */
  host?: string;
  pathPrefix?: string;
  from: 'header' | 'cookie' | 'json' | 'body';
  /** Header name, cookie name, or a JSONPath for "json". Unused for "body". */
  key?: string;
  /** Optional regex; the first group (or the whole match) becomes the value. */
  regex?: string;
}

export class Vars {
  constructor(private readonly store: CaptureStore) {}

  all(): Record<string, VarValue> {
    return this.store.getMeta<Record<string, VarValue>>('vars') ?? {};
  }

  values(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.all()).map(([k, v]) => [k, v.value]));
  }

  set(name: string, value: string, source = 'manual', exchangeId?: string): void {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`invalid variable name "${name}": use letters, digits, _ . -`);
    const all = this.all();
    if (all[name]?.value === value && all[name]?.source === source) return;
    all[name] = { value, source, updatedAt: Date.now(), ...(exchangeId ? { exchangeId } : {}) };
    this.store.setMeta('vars', all);
  }

  delete(name: string): void {
    const all = this.all();
    delete all[name];
    this.store.setMeta('vars', all);
  }

  extractors(): Extractor[] {
    return this.store.getMeta<Extractor[]>('extractors') ?? [];
  }

  setExtractors(list: Array<Omit<Extractor, 'id'> & { id?: string }>): Extractor[] {
    const out = list.map((e) => {
      if (!e.name || !/^[\w.-]+$/.test(e.name)) throw new Error(`invalid variable name "${e.name}"`);
      if (!['header', 'cookie', 'json', 'body'].includes(e.from)) throw new Error(`invalid source "${e.from}"`);
      if (e.regex) new RegExp(e.regex); // throws on a bad pattern
      if (e.from === 'json' && e.key) query({}, e.key); // validates the path
      return { ...e, id: e.id ?? newId() };
    });
    this.store.setMeta('extractors', out);
    return out;
  }

  /** Run extractors against a completed exchange; returns the names that changed. */
  extract(ex: Exchange): string[] {
    const changed: string[] = [];
    for (const e of this.extractors()) {
      if (e.enabled === false) continue;
      if (e.host && !globToRegExp(e.host).test(ex.host)) continue;
      if (e.pathPrefix && !ex.path.startsWith(e.pathPrefix)) continue;
      const v = this.valueFor(e, ex);
      if (v === undefined) continue;
      const before = this.all()[e.name]?.value;
      this.set(e.name, v, e.id, ex.id);
      if (before !== v) changed.push(e.name);
    }
    return changed;
  }

  private valueFor(e: Extractor, ex: Exchange): string | undefined {
    let text: string | undefined;
    if (e.from === 'header') text = ex.responseHeaders?.find(([k]) => k.toLowerCase() === (e.key ?? '').toLowerCase())?.[1];
    else if (e.from === 'cookie') {
      const c = cookiesFromResponse({ id: ex.id, host: ex.host, path: ex.path, startedAt: ex.startedAt, headers: ex.responseHeaders ?? [] }).find((x) => x.name === e.key);
      text = c?.value;
    } else {
      const body = this.store.getBody(ex.id, 'response', true);
      if (!body?.length) return undefined;
      const s = bytesToString(body);
      if (e.from === 'body') text = s;
      else {
        try {
          const hit = query(JSON.parse(s), e.key || '$')[0];
          if (hit !== undefined) text = typeof hit.value === 'string' ? hit.value : JSON.stringify(hit.value);
        } catch {
          return undefined;
        }
      }
    }
    if (text === undefined) return undefined;
    if (!e.regex) return text;
    const m = new RegExp(e.regex).exec(text);
    return m ? (m[1] ?? m[0]) : undefined;
  }
}
