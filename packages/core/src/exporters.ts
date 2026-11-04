import { bytesToString, looksLikeText } from '@siteinquisition/codecs';
import type { ApiFlow } from './flows.js';
import type { CaptureStore, Exchange, HeaderList } from './store.js';
import { VERSION } from './version.js';

/**
 * Getting things out: a request as a curl command, exchanges as HAR 1.2,
 * a flow or a set of requests as a Postman v2.1 collection, and a flow as a
 * script test suite that checks every step.
 */

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const HOP = new Set(['content-length', 'host', 'connection', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'accept-encoding']);

export function toCurl(req: { method: string; url: string; headers: HeaderList; body?: string | null }, opts: { insecure?: boolean } = {}): string {
  const parts = [`curl${req.method !== 'GET' || req.body ? ` -X ${req.method}` : ''} ${shq(req.url)}`];
  for (const [k, v] of req.headers) if (!HOP.has(k.toLowerCase()) && !k.startsWith(':')) parts.push(`-H ${shq(`${k}: ${v}`)}`);
  if (req.body) parts.push(`--data-raw ${shq(req.body)}`);
  if (opts.insecure) parts.push('-k');
  parts.push('--compressed');
  return parts.join(' \\\n  ');
}

const textBody = (store: CaptureStore, id: string, side: 'request' | 'response'): { text?: string; base64?: string; size: number } => {
  const b = store.getBody(id, side, true);
  if (!b?.length) return { size: 0 };
  return looksLikeText(b) ? { text: bytesToString(b), size: b.length } : { base64: Buffer.from(b).toString('base64'), size: b.length };
};

export function exchangeCurl(store: CaptureStore, id: string): string {
  const ex = store.getExchange(id);
  if (!ex) throw new Error('no such exchange');
  const body = textBody(store, id, 'request');
  return toCurl({ method: ex.method, url: ex.url, headers: ex.requestHeaders, body: body.text ?? (body.base64 ? `<${body.size} binary bytes>` : null) });
}

const harHeaders = (h: HeaderList | null) => (h ?? []).map(([name, value]) => ({ name, value }));
const harQuery = (url: string) => [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));

export function exportHar(store: CaptureStore, ids: string[]): Record<string, unknown> {
  const entries = ids
    .map((id) => store.getExchange(id))
    .filter((e): e is Exchange => !!e && !e.isWebSocket)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((ex) => {
      const req = textBody(store, ex.id, 'request');
      const res = textBody(store, ex.id, 'response');
      const ct = (h: HeaderList | null) => h?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
      return {
        startedDateTime: new Date(ex.startedAt).toISOString(),
        time: ex.durationMs ?? 0,
        request: {
          method: ex.method,
          url: ex.url,
          httpVersion: `HTTP/${ex.httpVersion}`,
          headers: harHeaders(ex.requestHeaders),
          queryString: harQuery(ex.url),
          cookies: [],
          headersSize: -1,
          bodySize: req.size,
          ...(req.size ? { postData: { mimeType: ct(ex.requestHeaders), text: req.text ?? req.base64 ?? '' } } : {}),
        },
        response: {
          status: ex.status ?? 0,
          statusText: ex.statusMessage ?? '',
          httpVersion: `HTTP/${ex.httpVersion}`,
          headers: harHeaders(ex.responseHeaders),
          cookies: [],
          content: { size: res.size, mimeType: ct(ex.responseHeaders), ...(res.text !== undefined ? { text: res.text } : res.base64 ? { text: res.base64, encoding: 'base64' } : {}) },
          redirectURL: ex.responseHeaders?.find(([k]) => k.toLowerCase() === 'location')?.[1] ?? '',
          headersSize: -1,
          bodySize: res.size,
        },
        cache: {},
        timings: { send: 0, wait: ex.timings.responseHeaders ?? ex.durationMs ?? 0, receive: 0 },
        ...(ex.notes ? { comment: ex.notes } : {}),
      };
    });
  return { log: { version: '1.2', creator: { name: 'SiteInquisition', version: VERSION }, entries } };
}

/** {{var:x}} → {{x}}; other SiteInquisition tokens map to Postman dynamic variables where one exists. */
function toPostmanTokens(s: string): string {
  return s
    .replace(/\{\{\s*var:([\w.-]+)\s*\}\}/g, '{{$1}}')
    .replace(/\{\{\s*uuid\s*\}\}/g, '{{$guid}}')
    .replace(/\{\{\s*now:unix\s*\}\}/g, '{{$timestamp}}')
    .replace(/\{\{\s*now\s*\}\}/g, '{{$isoTimestamp}}');
}

type PmItem = Record<string, unknown>;

function pmRequest(name: string, method: string, url: string, headers: HeaderList, body?: string): PmItem {
  return {
    name,
    request: {
      method,
      header: headers.filter(([k]) => !HOP.has(k.toLowerCase()) && !k.startsWith(':')).map(([key, value]) => ({ key, value: toPostmanTokens(value) })),
      url: { raw: toPostmanTokens(url) },
      ...(body ? { body: { mode: 'raw', raw: toPostmanTokens(body) } } : {}),
    },
  };
}

const collection = (name: string, item: PmItem[], extra: Record<string, unknown> = {}) => ({
  info: { name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', _postman_id: `${Date.now()}` },
  item,
  ...extra,
});

export function exchangesToPostman(store: CaptureStore, ids: string[], name = 'SiteInquisition export'): Record<string, unknown> {
  const items = ids
    .map((id) => store.getExchange(id))
    .filter((e): e is Exchange => !!e)
    .map((ex) => pmRequest(`${ex.method} ${ex.path.split('?')[0]}`, ex.method, ex.url, ex.requestHeaders, textBody(store, ex.id, 'request').text));
  return collection(name, items);
}

/** A flow as a Postman collection: steps in order, with a test script that saves each extracted variable. */
export function flowToPostman(flow: ApiFlow): Record<string, unknown> {
  const items: PmItem[] = [];
  for (const s of flow.steps) {
    if (s.kind !== 'request') continue;
    const item = pmRequest(s.name || `${s.method} ${s.url}`, s.method!, s.url!, s.headers ?? [], s.body);
    const lines: string[] = [];
    if (s.expect) lines.push(`pm.test('status ${s.expect}', () => pm.expect(String(pm.response.code)).to.match(/^${s.expect.split(',').map((e) => e.trim().replace(/x/gi, '\\d')).join('|')}$/));`);
    for (const e of s.extract ?? []) {
      if (e.from.startsWith('$.')) lines.push(`pm.collectionVariables.set('${e.name}', String(${e.from.replace(/^\$/, 'pm.response.json()')}));`);
      else if (/^header\./i.test(e.from)) lines.push(`pm.collectionVariables.set('${e.name}', pm.response.headers.get('${e.from.slice(7)}'));`);
      else if (/^[\w]+$/.test(e.from)) lines.push(`pm.collectionVariables.set('${e.name}', String(JSON.stringify(pm.response.json()).match(/"${e.from}":\\s*"?([^",}]*)/)?.[1] ?? ''));`);
    }
    if (lines.length) item.event = [{ listen: 'test', script: { type: 'text/javascript', exec: lines } }];
    items.push(item);
  }
  const vars = [...new Set(flow.steps.flatMap((s) => (s.extract ?? []).map((e) => e.name)))].map((key) => ({ key, value: '' }));
  return collection(flow.name, items, { variable: [...Object.entries(flow.inputs ?? {}).map(([key, value]) => ({ key, value })), ...vars], ...(flow.description ? { description: flow.description } : {}) });
}

const js = (v: unknown) => JSON.stringify(v);

/** A test-suite script that runs a flow and checks each step: status, and that every variable came back. */
export function flowToTest(flow: ApiFlow): string {
  const lines = [
    `// Generated from flow "${flow.name}". Run it after each deploy: Scripts, Run.`,
    `test(${js(`${flow.name} runs end to end`)}, async () => {`,
    `  const r = await siq.flows.result(${js(flow.name)});`,
    `  expect(r.error ?? 'ok').toBe('ok');`,
  ];
  flow.steps.forEach((s, i) => {
    const label = s.name || (s.kind === 'script' ? `script ${i + 1}` : `${s.method} ${s.url}`);
    lines.push(`  // step ${i + 1}: ${label.replace(/\n/g, ' ')}`);
    if (s.kind === 'request' && s.expect) {
      const re = `^(${s.expect.split(',').map((e) => e.trim().replace(/x/gi, '\\d')).join('|')})$`;
      lines.push(`  expect(String(r.steps[${i}]?.status)).toMatch(${js(re)});`);
    }
    for (const e of s.extract ?? []) lines.push(`  expect(r.vars[${js(e.name)}] ?? '').toBeTruthy();`);
  });
  lines.push('});');
  // A second run should give fresh values for anything the server generates.
  const generated = flow.steps.flatMap((s) => (s.extract ?? []).filter((e) => /(id|number|no|ref|code)$/i.test(e.name)).map((e) => e.name));
  if (generated.length) {
    lines.push('', `test(${js(`${flow.name} gives fresh values each run`)}, async () => {`, `  const a = await siq.flows.run(${js(flow.name)});`, `  const b = await siq.flows.run(${js(flow.name)});`);
    for (const g of generated.slice(0, 3)) lines.push(`  expect(a[${js(g)}] === b[${js(g)}]).toBe(false);`);
    lines.push('});');
  }
  return lines.join('\n');
}
