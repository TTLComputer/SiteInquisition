import { describe, expect, it } from '@siteinquisition/devkit/test';
import { AREAS, legacyRoute, parseRoute, routeToLegacy, type LegacyView } from '../src/workspace/navigation';

// The route adapter: old screen names keep working after the move to work areas.
describe('work area routes', () => {
  const LEGACY: LegacyView[] = ['browser', 'history', 'timeline', 'replay', 'race', 'h3', 'rules', 'codecs', 'cookies', 'streams', 'scripts', 'api', 'tech', 'settings'];

  it('resolves every old screen to a page that exists', () => {
    for (const v of LEGACY) {
      const r = legacyRoute(v);
      const area = AREAS.find((a) => a.id === r.area);
      expect(area, v).toBeTruthy();
      expect(area!.pages.some((p) => p.id === r.page), `${v} -> ${r.area}/${r.page}`).toBe(true);
    }
  });

  it('sends old tabs to the page that now owns them', () => {
    expect(legacyRoute('rules', 'scope')).toEqual({ area: 'project', page: 'scope' });
    expect(legacyRoute('rules', 'breakpoints')).toEqual({ area: 'overrides', page: 'breakpoints' });
    expect(legacyRoute('rules', 'mocks')).toEqual({ area: 'overrides', page: 'mocks' });
    expect(legacyRoute('cookies', 'vars')).toEqual({ area: 'project', page: 'session', tab: 'vars' });
    expect(legacyRoute('api', 'flows')).toEqual({ area: 'replay', page: 'flows' });
    expect(legacyRoute('api', 'compare')).toEqual({ area: 'replay', page: 'compare' });
    expect(legacyRoute('api', 'probes')).toEqual({ area: 'replay', page: 'probes' });
    expect(legacyRoute('api', 'glossary')).toEqual({ area: 'explore', page: 'fields' });
    expect(legacyRoute('api', 'specs')).toEqual({ area: 'explore', page: 'specs' });
    expect(legacyRoute('history', 'coverage')).toEqual({ area: 'explore', page: 'endpoints' });
    expect(legacyRoute('settings', 'servers')).toEqual({ area: 'project', page: 'servers' });
    expect(legacyRoute('settings', 'nonsense')).toEqual({ area: 'project', page: 'proxy' });
    expect(legacyRoute('scripts')).toEqual({ area: 'advanced', page: 'scripts' });
  });

  it('parses new and old route strings, and refuses unknown ones', () => {
    expect(parseRoute('overrides/mocks')).toEqual({ area: 'overrides', page: 'mocks' });
    expect(parseRoute('#/project/session/aws')).toEqual({ area: 'project', page: 'session', tab: 'aws' });
    expect(parseRoute('explore')).toEqual({ area: 'explore', page: 'endpoints' });
    expect(parseRoute('rules/breakpoints')).toEqual({ area: 'overrides', page: 'breakpoints' });
    expect(parseRoute('history')).toEqual({ area: 'traffic', page: 'requests' });
    expect(parseRoute('explore/nope')).toBeNull();
    expect(parseRoute('nowhere')).toBeNull();
    expect(parseRoute('')).toBeNull();
  });

  it('names a legacy view for every page, and it maps back to the same area', () => {
    for (const a of AREAS)
      for (const p of a.pages) {
        const v = routeToLegacy({ area: a.id, page: p.id });
        expect(LEGACY).toContain(v);
      }
    expect(routeToLegacy({ area: 'traffic', page: 'connections' })).toBe('streams');
    expect(routeToLegacy({ area: 'project', page: 'scope' })).toBe('rules');
  });

  it('keeps page labels unique within an area so tabs are unambiguous', () => {
    for (const a of AREAS) expect(new Set(a.pages.map((p) => p.label)).size).toBe(a.pages.length);
    expect(new Set(AREAS.map((a) => a.label)).size).toBe(AREAS.length);
  });
});

import { RouteHistory, buildSnapshot, restoreSnapshot } from '../src/workspace/documents';
import { matchCommands } from '../src/workspace/registry';

describe('workspace documents', () => {
  const http = { id: 'replay-1', exchangeId: '1', kind: 'http' as const, label: 'cart', method: 'GET' };
  it('folds current drafts into the snapshot and reads them back', () => {
    const drafts = new Map([['replay-1', { kind: 'http' as const, raw: 'GET /x', regions: [], options: {} }]]);
    const snap = buildSnapshot({ area: 'replay', page: 'editors' }, 'replay-1', [http, { id: 'compare-a-b', kind: 'compare', label: 'Compare', method: 'DIFF', a: 'a', b: 'b' }], drafts);
    const back = restoreSnapshot(JSON.parse(JSON.stringify(snap)))!;
    expect(back.docs).toHaveLength(2);
    expect((back.docs[0] as typeof http & { recovered: { raw: string } }).recovered.raw).toBe('GET /x');
    expect(back.activeDoc).toBe('replay-1');
    expect(back.route).toEqual({ area: 'replay', page: 'editors' });
  });
  it('drops damaged documents and unknown versions instead of half restoring', () => {
    expect(restoreSnapshot({ version: 2, docs: [http] })).toBeNull();
    expect(restoreSnapshot(null)).toBeNull();
    const r = restoreSnapshot({ version: 1, route: { area: 'nowhere', page: 'x' }, activeDoc: 'gone', docs: [http, { id: 'x' }, { ...http }, { id: 'f', kind: 'flow', label: 'f' }] })!;
    expect(r.docs.map((d) => d.id)).toEqual(['replay-1']);
    expect(r.dropped).toBe(3);
    expect(r.route).toBeNull();
    expect(r.activeDoc).toBe('replay-1');
  });
  it('goes back and forward, and forgets forward after a new move', () => {
    const h = new RouteHistory();
    const a = { area: 'traffic' as const, page: 'requests' };
    const b = { area: 'explore' as const, page: 'values' };
    const c = { area: 'overrides' as const, page: 'mocks' };
    h.push(a);
    expect(h.goBack(b)).toEqual(a);
    expect(h.goForward(a)).toEqual(b);
    h.push(b);
    h.goBack(c);
    h.push(a);
    expect(h.canForward).toBe(false);
  });
  it('matches commands by every word, enabled ones first', () => {
    const list = [
      { key: '1', label: 'Mock this response', disabled: 'no', run: () => 0 },
      { key: '2', label: 'Go to Overrides, Mocks', run: () => 0 },
      { key: '3', label: 'Send to Replay', run: () => 0 },
    ];
    expect(matchCommands(list, 'mock').map((c) => c.key)).toEqual(['2', '1']);
    expect(matchCommands(list, 'send replay').map((c) => c.key)).toEqual(['3']);
    expect(matchCommands(list, '')).toHaveLength(3);
  });
});
