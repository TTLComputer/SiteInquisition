import { bytesToString, decodeFieldsText, parseChain, type FieldCodec } from '@siteinquisition/codecs';
import { query } from '@siteinquisition/codecs/jsonpath';
import { newId } from './ids.js';
import { globToRegExp } from './scope.js';
import type { CaptureStore } from './store.js';

/**
 * Saved field codecs: "on api.example.com, $.payload in request bodies is
 * base64 of JSON". The Inspector shows such fields decoded, Replay opens them
 * decoded and encodes them again on send, and Codecs can save one from a
 * field it decoded.
 */
export interface FieldCodecRule {
  id: string;
  enabled?: boolean;
  /** Shown in lists; optional. */
  name?: string;
  /** Host or host glob; "*" for every host. */
  host: string;
  /** URL path prefix, or a glob with *; empty for every path. */
  path?: string;
  side: 'request' | 'response' | 'both';
  /** JSONPath of the field. */
  field: string;
  /** Codec ids, outermost first. */
  chain: string[];
}

const pathMatches = (want: string | undefined, path: string) => {
  if (!want) return true;
  const p = path.split('?')[0]!;
  return want.includes('*') ? globToRegExp(want).test(p) : p.startsWith(want);
};

export class FieldCodecs {
  constructor(private readonly store: CaptureStore) {}

  list(): FieldCodecRule[] {
    return this.store.getMeta<FieldCodecRule[]>('fieldCodecs') ?? [];
  }

  set(list: Array<Omit<FieldCodecRule, 'id'> & { id?: string }>): FieldCodecRule[] {
    if (!Array.isArray(list)) throw new Error('field codecs must be a list');
    const out = list.map((r) => {
      if (!r.field?.trim()) throw new Error('a field codec needs a JSONPath for the field');
      const field = r.field.trim().startsWith('$') ? r.field.trim() : `$.${r.field.trim()}`;
      query({}, field); // throws on a bad path
      if (!Array.isArray(r.chain) || !r.chain.length) throw new Error(`${field}: a field codec needs a codec chain, e.g. base64>json`);
      parseChain(r.chain);
      if (!['request', 'response', 'both'].includes(r.side)) throw new Error('side must be request, response or both');
      return { ...r, field, host: (r.host ?? '*').trim().toLowerCase() || '*', id: r.id ?? newId() };
    });
    this.store.setMeta('fieldCodecs', out);
    return out;
  }

  /** The rules that apply to a URL and side, in saved order. */
  rulesFor(url: string, side: 'request' | 'response'): FieldCodecRule[] {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return [];
    }
    const host = u.hostname.toLowerCase();
    return this.list().filter((r) => r.enabled !== false && (r.side === 'both' || r.side === side) && globToRegExp(r.host).test(host) && pathMatches(r.path, u.pathname));
  }

  specsFor(url: string, side: 'request' | 'response'): FieldCodec[] {
    return this.rulesFor(url, side).map((r) => ({ path: r.field, chain: r.chain }));
  }

  /** One side of a recorded exchange with its saved fields decoded, or null when no rule changes anything. */
  decodeExchange(id: string, side: 'request' | 'response'): { text: string; counts: number[]; errors: string[]; rules: FieldCodecRule[] } | null {
    const ex = this.store.getExchange(id);
    if (!ex) throw new Error('no such exchange');
    const rules = this.rulesFor(ex.url, side);
    if (!rules.length) return null;
    const body = this.store.getBody(id, side, true);
    if (!body?.length || body.length > 8 * 1024 * 1024) return null;
    const r = decodeFieldsText(bytesToString(body), rules.map((x) => ({ path: x.field, chain: x.chain })));
    return r ? { ...r, rules } : null;
  }
}
