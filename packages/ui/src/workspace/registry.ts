import { bodyText, breakOn, mockFromExchange } from '../actions';
import { toRawRequest } from '../format';
import type { ExchangeSummary } from '../api';
import type { useApp } from '../state';
import { AREAS } from './navigation';
import { replayLabel } from './documents';

/**
 * One list of things you can do, so the row menu, the command search and
 * other toolbars offer the same actions with the same names and shortcuts.
 * An action that does not apply to the selection says why instead of
 * disappearing.
 */

type App = ReturnType<typeof useApp>;

/** What an action works on. */
export type Selection = Pick<ExchangeSummary, 'id' | 'method' | 'path' | 'host' | 'url' | 'scheme' | 'isWebSocket'>;

export interface ExchangeAction {
  id: string;
  label: string;
  shortcut?: string;
  group: 'replay' | 'decode' | 'override' | 'explore' | 'copy';
  /** True when it applies; otherwise the reason it does not. */
  when?(row: Selection, app: App): true | string;
  run(row: Selection, app: App): unknown;
}

const isStream = (r: Selection) => !!r.isWebSocket || r.scheme.startsWith('mqtt');
const httpOnly = (r: Selection): true | string => (isStream(r) ? 'Not for WebSocket or MQTT connections' : true);

export const EXCHANGE_ACTIONS: ExchangeAction[] = [
  { id: 'replay', label: 'Send to Replay', shortcut: 'Ctrl R', group: 'replay', run: (r, a) => a.openReplay(r) },
  { id: 'replay-fresh', label: 'Send to Replay with fresh cookies', group: 'replay', run: (r, a) => a.openReplay(r, { refreshCookies: true }) },
  {
    id: 'resend',
    label: 'Resend now',
    shortcut: 'Ctrl Shift Enter',
    group: 'replay',
    when: httpOnly,
    run: (r, a) => a.resendNow(r.id),
  },
  {
    id: 'race',
    label: 'Send to Race',
    shortcut: 'Ctrl Shift R',
    group: 'replay',
    when: httpOnly,
    run: async (r, a) => {
      const ex = await a.client.get(r.id);
      const body = ex.reqBodySize ? await bodyText(a.client, r.id, 'request').catch(() => '') : '';
      a.sendToRace([{ label: replayLabel(r.path), raw: toRawRequest(ex.method, ex.url, ex.requestHeaders, body), replayOf: r.id }]);
    },
  },
  { id: 'stream', label: 'Open in Live connections', group: 'replay', when: (r) => (isStream(r) ? true : 'Only for WebSocket and MQTT connections'), run: (r, a) => a.openStream(r.id) },
  {
    id: 'decode-response',
    label: 'Decode response body',
    shortcut: 'Ctrl D',
    group: 'decode',
    run: async (r, a) => a.sendToCodecs(await bodyText(a.client, r.id, 'response'), `${r.method} ${replayLabel(r.path)} response`),
  },
  { id: 'decode-request', label: 'Decode request body', group: 'decode', run: async (r, a) => a.sendToCodecs(await bodyText(a.client, r.id, 'request'), `${r.method} ${replayLabel(r.path)} request`) },
  {
    id: 'mock',
    label: 'Mock this response',
    group: 'override',
    when: httpOnly,
    run: async (r, a) => {
      const name = await mockFromExchange(a.client, await a.client.get(r.id));
      a.notify(`Mock "${name}" added. Edit it in Overrides, Mocks.`);
    },
  },
  {
    id: 'break',
    label: 'Break on this endpoint',
    group: 'override',
    run: async (r, a) => {
      await breakOn(a.client, r);
      a.notify('Breakpoint added: the next matching request will pause.');
    },
  },
  {
    id: 'compare',
    label: 'Compare with the marked request',
    group: 'explore',
    when: (r, a) => (!a.compareMark ? 'Mark a request to compare first' : a.compareMark === r.id ? 'This is the marked request' : true),
    run: (r, a) => a.openComparison(a.compareMark!, r.id),
  },
  {
    id: 'mark',
    label: 'Mark to compare',
    group: 'explore',
    run: (r, a) => {
      a.setCompareMark(r.id);
      a.notify('Marked. Right-click another request and choose Compare with the marked request.');
    },
  },
  {
    id: 'flow',
    label: 'Add to flow',
    group: 'explore',
    run: (r, a) => {
      if (a.flowPicks.includes(r.id)) return a.notify('Already picked for the flow');
      a.setFlowPicks([...a.flowPicks, r.id]);
      a.notify(`${a.flowPicks.length + 1} picked. Make the flow in Replay, Flows.`);
    },
  },
  { id: 'auth', label: 'Try as other users (auth matrix)', group: 'explore', when: httpOnly, run: (r, a) => a.sendToApi('auth', [r.id]) },
  { id: 'negative', label: 'Run negative tests', group: 'explore', when: httpOnly, run: (r, a) => a.sendToApi('negative', [r.id]) },
  {
    id: 'timeline',
    label: 'Show in Timeline',
    group: 'explore',
    run: (r, a) => {
      a.select(r.id);
      a.navigate('traffic/timeline');
    },
  },
  { id: 'copy-url', label: 'Copy URL', group: 'copy', run: (r, a) => navigator.clipboard.writeText(r.url).then(() => a.notify('URL copied')) },
  { id: 'copy-curl', label: 'Copy as curl', group: 'copy', run: async (r, a) => navigator.clipboard.writeText(await a.client.curl(r.id)).then(() => a.notify('Copied as curl')) },
];

export const exchangeAction = (id: string) => EXCHANGE_ACTIONS.find((x) => x.id === id)!;

export const availability = (act: ExchangeAction, row: Selection | null, app: App): true | string => (row ? (act.when ? act.when(row, app) : true) : 'Select an exchange in Traffic first');

/** A command in the command search: an exchange action, or a place to go. */
export interface Command {
  key: string;
  label: string;
  detail?: string;
  shortcut?: string;
  /** Why it cannot run now, if it cannot. */
  disabled?: string;
  run(): unknown;
}

export function commands(app: App, row: Selection | null): Command[] {
  const go: Command[] = AREAS.flatMap((a) =>
    a.pages.map((p) => ({ key: `go:${a.id}/${p.id}`, label: `Go to ${a.label}, ${p.label}`, detail: p.hint, run: () => app.navigate({ area: a.id, page: p.id }) })),
  );
  const acts: Command[] = EXCHANGE_ACTIONS.map((x) => {
    const ok = availability(x, row, app);
    return {
      key: `do:${x.id}`,
      label: x.label,
      detail: row ? `${row.method} ${row.path}` : undefined,
      shortcut: x.shortcut,
      ...(ok === true ? {} : { disabled: ok }),
      run: () => row && x.run(row, app),
    };
  });
  const back: Command[] = [
    { key: 'nav:back', label: 'Back', shortcut: 'Alt Left', ...(app.canBack ? {} : { disabled: 'Nowhere to go back to' }), run: app.goBack },
    { key: 'nav:forward', label: 'Forward', shortcut: 'Alt Right', ...(app.canForward ? {} : { disabled: 'Nowhere to go forward to' }), run: app.goForward },
  ];
  return [...acts, ...go, ...back];
}

/** Commands whose words all appear in the label or detail, best first. */
export function matchCommands(list: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  const scored = list
    .map((c) => {
      const hay = `${c.label} ${c.detail ?? ''}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      const label = c.label.toLowerCase();
      const score = (label.startsWith(words[0]!) ? 0 : 10) + (words.every((w) => label.includes(w)) ? 0 : 5) + (c.disabled ? 20 : 0);
      return { c, score };
    })
    .filter((x): x is { c: Command; score: number } => x !== null);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.c);
}
