import { asText } from './format';
import type { CoreClient, ExchangeDetail, ExchangeSummary } from './api';

/** Shared "do this with an exchange" actions, so every screen offers the same ones. */

export async function bodyText(client: CoreClient, id: string, side: 'request' | 'response'): Promise<string> {
  const b = await client.body(id, side, true);
  const t = asText(b);
  if (t === null) throw new Error(`The ${side} body is binary (${b.length} bytes); decode it from a text form such as base64.`);
  return t;
}

export async function mockFromExchange(client: CoreClient, ex: ExchangeDetail): Promise<string> {
  const body = ex.state === 'pending' ? '' : ((await client.body(ex.id, 'response', true).then(asText)) ?? '');
  const { mocks } = await client.rules();
  const name = `${ex.method} ${ex.path.split('?')[0]}`.slice(0, 60);
  const headers = (ex.responseHeaders ?? []).filter(([k]) => !['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'date'].includes(k.toLowerCase()));
  await client.setMocks([...mocks, { name, enabled: true, host: ex.host, method: ex.method, pathPrefix: ex.path.split('?')[0], status: ex.status ?? 200, headers, body }]);
  return name;
}

export async function breakOn(client: CoreClient, ex: Pick<ExchangeSummary, 'host' | 'method' | 'path'>, phase: 'request' | 'response' | 'both' = 'request'): Promise<void> {
  const { breakpoints } = await client.rules();
  await client.setBreakpoints([...breakpoints, { enabled: true, phase, host: ex.host, method: ex.method, pathPrefix: ex.path.split('?')[0] }]);
}

/** Pause WebSocket messages on connections like this one (Rules, Breakpoints). */
export async function breakOnMessages(client: CoreClient, ex: Pick<ExchangeSummary, 'host' | 'path'>, direction: 'client' | 'server' | 'both' = 'both', match = ''): Promise<void> {
  const { breakpoints } = await client.rules();
  await client.setBreakpoints([...breakpoints, { enabled: true, phase: 'messages', host: ex.host, pathPrefix: ex.path.split('?')[0], direction, ...(match ? { match } : {}) }]);
}

/** The literal part of a path template before its first placeholder, for a path: filter. */
export const templatePrefix = (t: string) => {
  const i = t.indexOf('{');
  return i === -1 ? t : t.slice(0, i);
};
