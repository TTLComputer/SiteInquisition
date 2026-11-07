/**
 * Where things live. The app is organised around an investigation: watch the
 * traffic, understand the API, reproduce a request, change live behaviour.
 * Four work areas hold that work; Project settings and Advanced tools sit in
 * the footer of the navigation rail.
 *
 * A route names an area, one of its pages and, for pages with their own tabs,
 * a tab. Older screen names (History, Rules, Cookies, API...) still resolve to
 * the page that now owns the capability, so links, shortcuts and saved
 * habits keep working.
 */

export type AreaId = 'traffic' | 'explore' | 'replay' | 'overrides' | 'project' | 'advanced';

export interface Route {
  area: AreaId;
  page: string;
  /** A tab inside the page, e.g. Session and authentication > Variables. */
  tab?: string;
}

export interface PageDef {
  id: string;
  label: string;
  /** One line shown as the tab's tooltip. */
  hint?: string;
}

export interface AreaDef {
  id: AreaId;
  label: string;
  /** Icon name from components/icons. */
  icon: string;
  hint: string;
  pages: PageDef[];
  /** Footer areas sit below the work areas. */
  footer?: boolean;
}

export const AREAS: AreaDef[] = [
  {
    id: 'traffic',
    label: 'Traffic',
    icon: 'history',
    hint: 'What was recorded: requests, the built-in browser, the timeline and live connections',
    pages: [
      { id: 'requests', label: 'Requests', hint: 'Every recorded exchange, with the inspector' },
      { id: 'browser', label: 'Browser', hint: 'The built-in Chromium, already pointed at the proxy' },
      { id: 'timeline', label: 'Timeline', hint: 'Requests over time, grouped by page, flow or connection' },
      { id: 'connections', label: 'Live connections', hint: 'WebSocket and MQTT connections: messages, and sending more' },
    ],
  },
  {
    id: 'explore',
    label: 'Explore API',
    icon: 'api',
    hint: 'The API behind the traffic: endpoints, values, descriptions and technology',
    pages: [
      { id: 'endpoints', label: 'Endpoints', hint: 'Endpoints seen per host, what was exercised, and paths referenced but never called' },
      { id: 'resources', label: 'Resources', hint: 'The things the API manages and the operations seen on each' },
      { id: 'values', label: 'Values', hint: 'Values the API hands out and where they are used again' },
      { id: 'fields', label: 'Fields', hint: 'What each field and parameter means, with examples' },
      { id: 'specs', label: 'API files', hint: 'Imported OpenAPI, Swagger, Postman and HAR, compared with what was seen' },
      { id: 'graphql', label: 'GraphQL', hint: 'Schemas and operations' },
      { id: 'tech', label: 'Technology', hint: 'Frameworks, servers and services detected, with the evidence' },
    ],
  },
  {
    id: 'replay',
    label: 'Replay',
    icon: 'replay',
    hint: 'Reproduce requests and conversations, chain them into flows, compare and test them',
    pages: [
      { id: 'editors', label: 'Open editors', hint: 'Replay editors for HTTP requests and WebSocket conversations' },
      { id: 'flows', label: 'Flows', hint: 'Requests chained together, with values carried between steps' },
      { id: 'compare', label: 'Compare', hint: 'Two exchanges side by side' },
      { id: 'probes', label: 'Auth and negative tests', hint: 'Rerun a request as other users, or with broken input' },
    ],
  },
  {
    id: 'overrides',
    label: 'Overrides',
    icon: 'rules',
    hint: 'Everything that changes live traffic: mocks, replacements, breakpoints and hooks',
    pages: [
      { id: 'active', label: 'Active', hint: 'Every override in one list, and whether it is on' },
      { id: 'mocks', label: 'Mocks', hint: 'Answer requests without the server' },
      { id: 'replace', label: 'Match and replace', hint: 'Rewrite requests and responses as they pass' },
      { id: 'breakpoints', label: 'Breakpoints', hint: 'Pause requests, responses or messages to edit them' },
      { id: 'hooks', label: 'Live hooks', hint: 'Scripts that run on live traffic' },
    ],
  },
  {
    id: 'project',
    label: 'Project settings',
    icon: 'settings',
    hint: 'Capture scope, sessions and sign-in, proxy, certificates, storage and integrations',
    footer: true,
    pages: [
      { id: 'scope', label: 'Capture scope', hint: 'Which hosts are recorded and decrypted' },
      { id: 'session', label: 'Session and authentication', hint: 'Cookie jar, variables, login macros, signed tokens, AWS signing' },
      { id: 'proxy', label: 'Proxy and TLS' },
      { id: 'servers', label: 'Server certificates' },
      { id: 'signing', label: 'Signing keys' },
      { id: 'tech', label: 'Technologies' },
      { id: 'storage', label: 'Storage' },
      { id: 'mcp', label: 'MCP and agents' },
      { id: 'appearance', label: 'Appearance' },
      { id: 'keys', label: 'Keyboard' },
      { id: 'together', label: 'Work together' },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced tools',
    icon: 'codecs',
    hint: 'Race, the protocol lab, the decoder and the script console',
    footer: true,
    pages: [
      { id: 'codecs', label: 'Decode', hint: 'Chain codecs on any text: base64, JWT, gzip, protobuf...' },
      { id: 'race', label: 'Race', hint: 'Send requests at precisely timed offsets' },
      { id: 'h3', label: 'Protocol lab', hint: 'Frame-level HTTP/2 and HTTP/3' },
      { id: 'scripts', label: 'Script console', hint: 'Hooks, test scripts and one-off scripts' },
    ],
  },
];

export const areaDef = (id: AreaId): AreaDef => AREAS.find((a) => a.id === id)!;

export const pageDef = (r: Pick<Route, 'area' | 'page'>): PageDef | undefined => areaDef(r.area)?.pages.find((p) => p.id === r.page);

export const defaultRoute = (area: AreaId): Route => ({ area, page: areaDef(area).pages[0]!.id });

/** Screen names from before the work areas, kept so existing links and calls resolve. */
export type LegacyView = 'browser' | 'history' | 'timeline' | 'replay' | 'race' | 'h3' | 'rules' | 'codecs' | 'cookies' | 'streams' | 'scripts' | 'api' | 'tech' | 'settings';

const API_TABS: Record<string, Route> = {
  values: { area: 'explore', page: 'values' },
  resources: { area: 'explore', page: 'resources' },
  glossary: { area: 'explore', page: 'fields' },
  specs: { area: 'explore', page: 'specs' },
  graphql: { area: 'explore', page: 'graphql' },
  coverage: { area: 'explore', page: 'endpoints' },
  flows: { area: 'replay', page: 'flows' },
  compare: { area: 'replay', page: 'compare' },
  probes: { area: 'replay', page: 'probes' },
};

const SETTINGS_SECTIONS = new Set(['proxy', 'servers', 'storage', 'tech', 'signing', 'mcp', 'appearance', 'keys', 'together']);

/** Where an old screen (and one of its tabs) lives now. */
export function legacyRoute(view: LegacyView, tab?: string): Route {
  switch (view) {
    case 'history':
      return tab === 'coverage' ? { area: 'explore', page: 'endpoints' } : { area: 'traffic', page: 'requests' };
    case 'browser':
      return { area: 'traffic', page: 'browser' };
    case 'timeline':
      return { area: 'traffic', page: 'timeline' };
    case 'streams':
      return { area: 'traffic', page: 'connections' };
    case 'replay':
      return { area: 'replay', page: 'editors' };
    case 'race':
    case 'h3':
    case 'codecs':
      return { area: 'advanced', page: view };
    case 'scripts':
      return tab === 'hooks' ? { area: 'overrides', page: 'hooks' } : { area: 'advanced', page: 'scripts' };
    case 'rules':
      if (tab === 'scope' || !tab) return { area: 'project', page: 'scope' };
      return { area: 'overrides', page: ['replace', 'mocks', 'breakpoints'].includes(tab) ? tab : 'active' };
    case 'cookies':
      return { area: 'project', page: 'session', ...(tab ? { tab } : {}) };
    case 'api':
      return API_TABS[tab ?? 'values'] ?? { area: 'explore', page: 'values' };
    case 'tech':
      return { area: 'explore', page: 'tech' };
    case 'settings':
      return { area: 'project', page: tab && SETTINGS_SECTIONS.has(tab) ? tab : 'proxy' };
  }
}

/** The old screen name closest to a route, for code that still asks which "view" is showing. */
export function routeToLegacy(r: Route): LegacyView {
  switch (r.area) {
    case 'traffic':
      return r.page === 'browser' ? 'browser' : r.page === 'timeline' ? 'timeline' : r.page === 'connections' ? 'streams' : 'history';
    case 'explore':
      return r.page === 'tech' ? 'tech' : 'api';
    case 'replay':
      return r.page === 'editors' ? 'replay' : 'api';
    case 'overrides':
      return r.page === 'hooks' ? 'scripts' : 'rules';
    case 'project':
      return r.page === 'scope' ? 'rules' : r.page === 'session' ? 'cookies' : 'settings';
    case 'advanced':
      return r.page as LegacyView;
  }
}

const LEGACY = new Set<string>(['browser', 'history', 'timeline', 'replay', 'race', 'h3', 'rules', 'codecs', 'cookies', 'streams', 'scripts', 'api', 'tech', 'settings']);

/**
 * Read a route written as "area/page[/tab]", or an old "view[/tab]" name.
 * Returns null for anything it does not know, so a stale link cannot land on a
 * blank screen.
 */
export function parseRoute(s: string): Route | null {
  const [a, p, t] = s.replace(/^#?\/?/, '').split('/');
  if (!a) return null;
  const area = AREAS.find((x) => x.id === a);
  if (area) {
    if (!p) return defaultRoute(area.id);
    if (!area.pages.some((x) => x.id === p)) return null;
    return { area: area.id, page: p, ...(t ? { tab: t } : {}) };
  }
  if (LEGACY.has(a)) return legacyRoute(a as LegacyView, p);
  return null;
}

export const routeKey = (r: Route) => `${r.area}/${r.page}${r.tab ? `/${r.tab}` : ''}`;

export const sameRoute = (a: Route, b: Route) => a.area === b.area && a.page === b.page && (a.tab ?? '') === (b.tab ?? '');
