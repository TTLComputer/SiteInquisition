import { coverage, pathTemplate, type EndpointCoverage } from './coverage.js';
import { harvestOperations, type SeenOperation } from './graphql.js';
import type { ApiFlow } from './flows.js';
import type { Breakpoint } from './intercept.js';
import { conditionsMatch, requestSubject, type MockRule, type ReplaceRule } from './rules.js';
import { specMatches, type ApiSpec, type SpecEndpoint } from './specs.js';
import type { CaptureStore, ExchangeSummary } from './store.js';

/**
 * One endpoint, seen as one thing: what was observed, what the API files
 * say, the notes, and every rule, mock, breakpoint and flow that touches it.
 *
 * An endpoint is named by its reference, "host METHOD /template", the same
 * key endpoint notes already use. Templates can change when ids are
 * collapsed differently, so a reference can be an alias of another; aliases
 * are followed when reading, and notes saved under an alias still show.
 */

export interface EndpointRef {
  host: string;
  method: string;
  template: string;
}

export const endpointKey = (r: EndpointRef) => `${r.host} ${r.method.toUpperCase()} ${r.template}`;

export function parseEndpointKey(key: string): EndpointRef | null {
  const m = /^(\S+) ([A-Z]+) (\/\S*)$/.exec(key.trim());
  return m ? { host: m[1]!, method: m[2]!, template: m[3]! } : null;
}

export interface EndpointDetail {
  ref: EndpointRef;
  key: string;
  /** Other references that point at this one. */
  aliases: string[];
  /** Null when nothing recorded matches: "No observations", distinct from "No documented operation". */
  observed: EndpointCoverage | null;
  /** Most recent first, at most 50. */
  recent: Array<Pick<ExchangeSummary, 'id' | 'startedAt' | 'status' | 'durationMs' | 'source' | 'tags' | 'path'>>;
  /** Empty when no imported API file describes it. */
  documented: Array<{ specId: string; specName: string; endpoint: SpecEndpoint }>;
  notes: { notes: string; tags: string[]; updatedAt: number; by: string } | null;
  related: {
    mocks: Array<{ id: string; name: string; enabled: boolean }>;
    rules: Array<{ id: string; name: string; enabled: boolean; phase: string }>;
    breakpoints: Array<{ id: string; enabled: boolean; phase: string }>;
    flows: Array<{ id: string; name: string; steps: number[] }>;
  };
  graphql: SeenOperation[];
}

export interface EndpointSources {
  store: CaptureStore;
  specs: ApiSpec[];
  notes: Record<string, { notes: string; tags: string[]; updatedAt: number; by: string }>;
  mocks: MockRule[];
  rules: ReplaceRule[];
  breakpoints: Breakpoint[];
  flows: ApiFlow[];
}

/** The alias map, from an old reference to the one it now means. */
export function aliasesOf(store: CaptureStore): Record<string, string> {
  return store.getMeta<Record<string, string>>('endpointAliases') ?? {};
}

/** Follow aliases to the reference in use (stops on a loop). */
export function resolveEndpoint(store: CaptureStore, key: string): string {
  const map = aliasesOf(store);
  const seen = new Set<string>();
  let k = key;
  while (map[k] && !seen.has(k)) {
    seen.add(k);
    k = map[k]!;
  }
  return k;
}

/** Make `from` an alias of `to`, or remove the alias when `to` is null. */
export function setEndpointAlias(store: CaptureStore, from: string, to: string | null): Record<string, string> {
  if (!parseEndpointKey(from) || (to !== null && !parseEndpointKey(to))) throw new Error('endpoint references look like "host METHOD /path"');
  const map = { ...aliasesOf(store) };
  if (to === null || to === from) delete map[from];
  else {
    if (resolveEndpointWith(map, to) === from) throw new Error('that alias would make a loop');
    map[from] = to;
  }
  store.setMeta('endpointAliases', map);
  return map;
}

function resolveEndpointWith(map: Record<string, string>, key: string): string {
  const seen = new Set<string>();
  let k = key;
  while (map[k] && !seen.has(k)) {
    seen.add(k);
    k = map[k]!;
  }
  return k;
}

const TOKEN = '__siq_token__';

/** A flow step's path against a template; a segment that is a {{token}} matches any segment. */
function flowPathMatches(path: string, template: string): boolean {
  if (sameTemplate(path, template)) return true;
  const a = path.split('/');
  const b = template.split('/');
  return a.length === b.length && a.every((seg, i) => seg.includes(TOKEN) || seg === b[i] || pathTemplate(`/${seg}`) === `/${b[i]}`);
}

const sameTemplate = (a: string, b: string) => a === b || pathTemplate(a) === b;

export function endpointDetail(src: EndpointSources, key: string): EndpointDetail {
  const canonical = resolveEndpoint(src.store, key);
  const ref = parseEndpointKey(canonical);
  if (!ref) throw new Error('endpoint references look like "host METHOD /path"');
  const map = aliasesOf(src.store);
  const aliases = Object.keys(map).filter((k) => resolveEndpointWith(map, k) === canonical);
  const names = [canonical, ...aliases].map(parseEndpointKey).filter((r): r is EndpointRef => !!r);

  const report = coverage(src.store, ref.host);
  const observed = report.endpoints.find((e) => e.method === ref.method && names.some((n) => n.method === e.method && n.template === e.template)) ?? null;

  const recent = src.store
    .search(`host:${JSON.stringify(ref.host)} method:${ref.method}`, { limit: 2000 })
    .filter((e) => names.some((n) => sameTemplate(e.path.split('?')[0]!, n.template)))
    .slice(0, 50)
    .map((e) => ({ id: e.id, startedAt: e.startedAt, status: e.status, durationMs: e.durationMs, source: e.source, tags: e.tags, path: e.path }));

  const documented = src.specs
    .filter((s) => !s.hosts.length || s.hosts.includes(ref.host))
    .flatMap((spec) => spec.endpoints.filter((ep) => specMatches(spec, ep, ref.method, ref.template)).map((endpoint) => ({ specId: spec.id, specName: spec.name, endpoint })));

  const notes = [canonical, ...aliases].map((k) => src.notes[k]).find(Boolean) ?? null;

  // Rules are matched against a real request when there is one, so conditions on headers or bodies count.
  const example = recent[0] ? src.store.getExchange(recent[0].id) : undefined;
  const subject = example
    ? requestSubject({ method: example.method, url: example.url, headers: example.requestHeaders, body: src.store.getBody(example.id, 'request', true) ?? new Uint8Array() })
    : { method: ref.method, url: `https://${ref.host}${ref.template}`, phase: 'request' as const };
  // Response-side conditions (status, response headers) are unknown here, so they count as "may match".
  const touches = (c: object, phase: string = 'request') =>
    conditionsMatch({ ...c, status: undefined } as never, phase === 'response' ? { ...subject, phase: 'response' } : subject, { lenient: true });

  const flows = src.flows
    .map((f) => ({
      id: f.id,
      name: f.name,
      steps: f.steps
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => {
          if (s.kind !== 'request' || !s.url || (s.method ?? 'GET').toUpperCase() !== ref.method) return false;
          try {
            const u = new URL(s.url.replace(/\{\{[^}]*\}\}/g, TOKEN));
            return (u.hostname === ref.host || u.host === ref.host) && flowPathMatches(u.pathname, ref.template);
          } catch {
            return false;
          }
        })
        .map(({ i }) => i),
    }))
    .filter((f) => f.steps.length);

  const graphql = /graphql/i.test(ref.template) || documented.some((d) => d.endpoint.graphql) ? harvestOperations(src.store, { host: ref.host }).filter((o) => o.from === 'request' && safePath(o.url) === ref.template) : [];

  return {
    ref,
    key: canonical,
    aliases,
    observed,
    recent,
    documented,
    notes,
    related: {
      mocks: src.mocks.filter((m) => touches(m)).map((m) => ({ id: m.id, name: m.name, enabled: m.enabled !== false })),
      rules: src.rules.filter((r) => touches(r, r.phase)).map((r) => ({ id: r.id, name: r.name, enabled: r.enabled !== false, phase: r.phase })),
      breakpoints: src.breakpoints.filter((b) => b.phase !== 'messages' && touches(b, b.phase === 'response' ? 'response' : 'request')).map((b) => ({ id: b.id, enabled: b.enabled !== false, phase: b.phase })),
      flows,
    },
    graphql,
  };
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}
