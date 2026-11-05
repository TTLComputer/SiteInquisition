import { existsSync, mkdirSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { DIST, startHarness, type Harness } from './harness';

// The approved API extras in the renderer: contract strip, compare, auth matrix,
// negative tests, resources, glossary, endpoint notes, GraphQL, exports.
const SHOTS = process.env.SIQ_SCREENSHOTS;
const ready = findChromium() !== null && existsSync(join(DIST, 'index.html'));

const OPENAPI = (port: number) => `openapi: 3.0.3
info: { title: Shop, version: "2" }
servers:
  - url: http://127.0.0.1:${port}
paths:
  /api/orders/{id}:
    get:
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [id, status]
                properties:
                  id: { type: integer }
                  status: { type: string, enum: [OPEN, PAID] }
`;

const T = (name: string, kind = 'SCALAR') => ({ kind, name, ofType: null });
const NN = (t: unknown) => ({ kind: 'NON_NULL', name: null, ofType: t });
const SCHEMA = {
  queryType: { name: 'Query' },
  mutationType: null,
  subscriptionType: null,
  types: [
    { kind: 'OBJECT', name: 'Query', fields: [{ name: 'order', args: [{ name: 'id', type: NN(T('ID')) }], type: T('Order', 'OBJECT') }] },
    { kind: 'OBJECT', name: 'Order', fields: [{ name: 'id', args: [], type: NN(T('ID')) }, { name: 'total', args: [], type: T('Float') }] },
    { kind: 'SCALAR', name: 'ID' },
  ],
};

/** A beta server with introspection on, and pre-prod with it off. */
async function startGraphql() {
  const json = (res: ServerResponse, status: number, v: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const q = (JSON.parse(body || '{}') as { query?: string }).query ?? '';
      if (/__schema/.test(q)) return req.url === '/beta/graphql' ? json(res, 200, { data: { __schema: SCHEMA } }) : json(res, 400, { errors: [{ message: 'introspection is disabled' }] });
      return json(res, 200, { data: { order: { id: '1' } } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe.skipIf(!ready)('API extras in the renderer', () => {
  let h: Harness;
  let gql: Awaited<ReturnType<typeof startGraphql>>;
  let browser: Browser;
  let page: Page;
  let base: string;

  const shot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const nav = (name: string) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name, exact: false }).first().click();
  const apiTab = async (name: string | RegExp) => {
    await nav('API');
    await page.getByRole('tablist', { name: 'API' }).getByRole('tab', { name }).click();
  };
  /** The row for "METHOD path" (a method cell and the path). */
  const row = (method: string, path: string) => page.locator('.row', { hasText: path }).filter({ hasText: `${method}127.0.0.1` }).first();
  const menu = async (method: string, path: string, item: string | RegExp) => {
    await nav('History');
    await row(method, path).click({ button: 'right' });
    await page.getByRole('menuitem', { name: item }).click();
  };

  beforeAll(async () => {
    h = await startHarness();
    gql = await startGraphql();
    base = `http://127.0.0.1:${h.upstreamPort}`;
    const entry = (method: string, path: string, status: number, res: unknown, at: string, body?: unknown) => ({
      startedDateTime: at,
      time: 5,
      request: { method, url: `${base}${path}`, httpVersion: 'HTTP/1.1', headers: [{ name: 'Authorization', value: 'Bearer alice' }, ...(body ? [{ name: 'Content-Type', value: 'application/json' }] : [])], ...(body ? { postData: { mimeType: 'application/json', text: JSON.stringify(body) } } : {}) },
      response: { status, headers: [{ name: 'content-type', value: 'application/json' }], content: { text: JSON.stringify(res) } },
    });
    h.core.tools.importHar(
      JSON.stringify({
        log: {
          entries: [
            entry('GET', '/api/orders', 200, [{ id: 7701, status: 'OPEN' }], '2026-11-04T10:00:00Z'),
            entry('POST', '/api/orders', 201, { id: 7702, status: 'OPEN' }, '2026-11-04T10:00:01Z', { sku: 'AB-100', qty: 2 }),
            entry('GET', '/api/orders/7701', 200, { id: 7701, status: 'OPEN', total: 10 }, '2026-11-04T10:00:02Z'),
            entry('GET', '/api/orders/7702', 200, { id: 7702, status: 'shipped', total: 25 }, '2026-11-04T10:00:03Z'),
            entry('DELETE', '/api/orders/7702', 204, {}, '2026-11-04T10:00:04Z'),
          ],
        },
      }),
    );
    h.core.tools.importSpec(OPENAPI(h.upstreamPort), 'Shop');
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e));
    page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));
    await page.goto(h.pageUrl);
    await page.locator('.vlist .row').nth(4).waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    await gql?.close();
    await h?.close();
  });

  it('shows contract issues in the Inspector and copies a request as curl', async () => {
    await row('GET', '/api/orders/7702').click();
    const strip = page.getByLabel('API description');
    await expect.poll(() => strip.textContent()).toContain('1 contract issue');
    await strip.getByRole('button', { name: 'Show' }).click();
    expect(await strip.textContent()).toContain('$.status');
    await shot('extras-contract');
    await page.getByRole('button', { name: 'curl', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`curl '${base}/api/orders/7702'`);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("-H 'Authorization: Bearer alice'");
  });

  it('keeps notes on an endpoint and shows them on every call to it', async () => {
    await page.getByRole('tab', { name: 'Notes and tags' }).click();
    await page.getByLabel('Endpoint tags').fill('needs auth');
    await page.getByLabel('Endpoint notes').fill('Owners only. Status is upper case.');
    await page.getByRole('button', { name: 'Save endpoint notes' }).click();
    await row('GET', '/api/orders/7701').click();
    await page.getByRole('tab', { name: 'Request and response' }).click();
    await expect.poll(() => page.getByLabel('API description').textContent()).toContain('Owners only');
  });

  it('runs the contract check over recorded traffic', async () => {
    await apiTab('API files');
    const card = page.getByLabel('Contract check');
    await card.getByRole('button', { name: 'Check traffic' }).click();
    await expect.poll(() => card.textContent()).toContain('GET /api/orders/{id}');
    expect(await card.textContent()).toContain('"shipped"');
  });

  it('compares two exchanges marked from History', async () => {
    await menu('GET', '/api/orders/7701', 'Mark to compare');
    await menu('GET', '/api/orders/7702', 'Compare with the marked request');
    const res = page.getByLabel('Response differences');
    await expect.poll(() => res.textContent()).toContain('$.status');
    expect(await res.textContent()).toContain('"shipped"');
    await shot('extras-compare');
  });

  it('tries a request as other identities and flags the same data coming back', async () => {
    await menu('GET', '/api/orders/7701', /Try as other users/);
    const ids = page.getByLabel('Identities');
    await expect.poll(() => page.getByLabel('Identity 1 name').inputValue()).toBe('no auth');
    await ids.getByRole('button', { name: 'Add identity' }).click();
    await page.getByLabel('Identity 2 name').fill('bob');
    await page.getByLabel('Identity 2 headers').fill('Authorization: Bearer bob');
    await ids.getByRole('button', { name: 'Save identities' }).click();
    await expect.poll(() => h.core.tools.identities().length).toBe(2);
    const matrix = page.getByLabel('Auth matrix', { exact: true });
    await matrix.getByRole('button', { name: /Run for 1 request/ }).click();
    await expect.poll(() => matrix.locator('table').textContent()).toContain('bob');
    expect(await matrix.locator('thead').textContent()).toContain('no auth');
    // The test upstream answers everyone with 200 JSON.
    expect(await matrix.locator('tbody').textContent()).toContain('200');
    await shot('extras-auth-matrix');
  });

  it('runs negative tests on one request', async () => {
    await menu('POST', '/api/orders', 'Run negative tests');
    const card = page.getByLabel('Negative tests', { exact: true });
    await expect.poll(() => card.textContent()).toContain('POST /api/orders');
    await card.getByRole('button', { name: 'Run negative tests' }).click();
    await expect.poll(() => card.textContent(), { timeout: 15_000 }).toContain('cases:');
    expect(await card.textContent()).toContain('$.qty');
    await shot('extras-negative');
  });

  it('maps what has been done to each resource', async () => {
    await apiTab('Resources');
    const grid = page.getByLabel('Resource lifecycle');
    await expect.poll(() => grid.textContent()).toContain('/api/orders');
    const row = grid.locator('tr', { hasText: '/api/orders' }).first();
    expect(await row.getByRole('button', { name: /^create \/api\/orders/ }).textContent()).toContain('201');
    expect(await row.getByRole('button', { name: /^delete \/api\/orders/ }).textContent()).toContain('204');
    await shot('extras-resources');
  });

  it('builds a glossary of fields', async () => {
    await apiTab('Glossary');
    const table = page.getByLabel('Field glossary');
    await expect.poll(() => table.textContent()).toContain('status');
    expect(await table.locator('tr', { hasText: /^status/ }).first().textContent()).toContain('OPEN');
  });

  it('pulls a GraphQL schema from beta and opens an operation against pre-prod', async () => {
    const g = `http://127.0.0.1:${gql.port}`;
    await apiTab('GraphQL');
    await page.getByLabel('Test against').fill(`${g}/graphql`);
    await page.getByLabel('Its headers').fill('Authorization: Bearer preprod');
    await page.getByLabel('Schema from', { exact: true }).fill(`${g}/beta/graphql`);
    await page.getByRole('button', { name: 'Get schema' }).click();
    const card = page.locator('.spec-card').first();
    await expect.poll(() => card.textContent()).toContain('schema from');
    expect(await card.textContent()).toContain('order');
    await shot('extras-graphql');
    await card.locator('tr', { hasText: 'order' }).getByRole('button', { name: 'Send to Replay' }).click();
    const editor = page.getByLabel('Raw request').last();
    await expect.poll(() => editor.inputValue()).toContain(`POST ${g}/graphql`);
    expect(await editor.inputValue()).toContain('Authorization: Bearer preprod');
  });

  it('exports History as HAR and a flow as a test script', async () => {
    await nav('History');
    await page.getByRole('button', { name: 'Export HAR' }).click();
    await expect.poll(() => page.getByRole('status').textContent()).toMatch(/Exported \d+ requests as HAR/);
    h.core.tools.saveFlow({ name: 'list-orders', steps: [{ kind: 'request', method: 'GET', url: `${base}/api/orders`, headers: [], expect: '2xx', extract: [{ name: 'order_id', from: '$.path' }] }] } as never);
    await apiTab(/Flows/);
    await page.locator('.saved-view', { hasText: 'list-orders' }).click();
    await page.getByRole('button', { name: 'Make test' }).click();
    await expect.poll(() => h.core.tools.scriptList().some((s) => s.name === 'test list-orders')).toBe(true);
  });
});
