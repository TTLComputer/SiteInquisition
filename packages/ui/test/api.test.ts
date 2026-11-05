import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { DIST, startHarness, type Harness } from './harness';

// API understanding in the renderer: values, tag references, flows, API files.
const SHOTS = process.env.SIQ_SCREENSHOTS;
const ready = findChromium() !== null && existsSync(join(DIST, 'index.html'));

const OPENAPI = (port: number) => `openapi: 3.0.3
info: { title: Shop, version: "2" }
servers:
  - url: http://127.0.0.1:${port}
paths:
  /api/cart:
    get:
      summary: The cart
      responses: { '200': { description: ok } }
  /api/refunds:
    post:
      summary: Refund an order
      responses: { '200': { description: ok } }
  /api/orders/{orderId}:
    get:
      summary: One order
      parameters:
        - { name: orderId, in: path, required: true, schema: { type: string } }
      responses: { '200': { description: ok } }
`;

describe.skipIf(!ready)('API understanding in the renderer', () => {
  let h: Harness;
  let browser: Browser;
  let page: Page;
  let base: string;

  const shot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const nav = (name: string) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name, exact: false }).first().click();

  beforeAll(async () => {
    h = await startHarness();
    base = `http://127.0.0.1:${h.upstreamPort}`;
    // Recorded shop traffic with real ids in it.
    const entry = (method: string, path: string, res: unknown, at: string) => ({
      startedDateTime: at,
      time: 5,
      request: { method, url: `${base}${path}`, httpVersion: 'HTTP/1.1', headers: [] },
      response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }], content: { text: JSON.stringify(res) } },
    });
    h.core.tools.importHar(
      JSON.stringify({
        log: {
          entries: [
            entry('GET', '/api/products', { items: [{ sku: 'AB-100' }, { sku: 'AB-200' }] }, '2026-11-04T10:00:00Z'),
            entry('POST', '/api/orders', { order: { number: 'PO-7781' } }, '2026-11-04T10:00:01Z'),
            entry('GET', '/api/orders/PO-7781', { number: 'PO-7781', status: 'open' }, '2026-11-04T10:00:02Z'),
          ],
        },
      }),
    );
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e));
    await page.goto(h.pageUrl);
    await page.locator('.vlist .row').nth(4).waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });

  it('lists values handed out by the API and copies a token for one', async () => {
    await nav('API');
    const table = page.locator('.values-table');
    await expect.poll(() => table.textContent()).toContain('$.items[*].sku');
    const row = table.locator('tr', { hasText: '$.items[*].sku' });
    expect(await row.textContent()).toContain('AB-200');
    await row.getByRole('button', { name: 'Copy token' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('{{pick:GET /api/products $.items[*].sku}}');
    await shot('api-values');
  });

  it('traces a value back to the response that handed it out', async () => {
    await page.getByLabel('Value to trace').fill('PO-7781');
    await page.getByRole('button', { name: 'Trace', exact: true }).click();
    const list = page.getByLabel('Value origins');
    await expect.poll(() => list.textContent()).toContain('$.order.number');
    expect(await list.textContent()).toContain('/api/orders');
  });

  it('moves a reference tag from the History menu and resolves {{$tag.field}} in Replay', async () => {
    await nav('History');
    await page.locator('.row', { hasText: '/api/orders/PO-7781' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Set reference tag \(create or move\)/ }).click();
    await page.getByLabel('Reference tag').fill('order');
    await expect.poll(() => page.getByTestId('tag-hint').textContent()).toContain('Creates "order"');
    await page.getByRole('button', { name: 'Create tag' }).click();
    await expect.poll(() => h.core.store.search('tag:order').length).toBe(1);
    // An existing name moves the tag instead, and the menu says so.
    await page.locator('.row', { hasText: '/api/cart' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Set reference tag/ }).click();
    await page.getByLabel('Reference tag').fill('order');
    await expect.poll(() => page.getByTestId('tag-hint').textContent()).toContain('moves to this one');
    await expect.poll(() => page.getByRole('button', { name: 'Move here' }).count()).toBe(1);
    await page.keyboard.press('Escape');
    await page.locator('.row', { hasText: '/api/cart' }).first().click();
    await page.keyboard.press('Control+r');
    const editor = page.getByLabel('Raw request');
    await expect.poll(() => editor.inputValue()).toContain('/api/cart');
    await editor.fill((await editor.inputValue()).replace('/api/cart', '/api/cart?po={{$order.number}}&st={{$order.status|upper}}'));
    await expect.poll(() => page.getByTestId('token-preview').textContent()).toContain('po=PO-7781&st=OPEN');
    await shot('api-tag-reference');
  });

  it('builds and runs a flow, and a request uses it with {{flow:...}}', async () => {
    await nav('API');
    await page.getByRole('tab', { name: /Flows/ }).click();
    await page.getByRole('button', { name: 'New flow' }).click();
    await page.getByLabel('Flow name').fill('make-order');
    await page.getByLabel('Step 1 request').fill(`POST ${base}/api/orders\nContent-Type: application/json\n\n{"sku":"{{pick:/api/products $.items[*].sku:last}}"}`);
    await page.getByRole('button', { name: 'Add variable' }).click();
    await page.getByLabel('Step 1 variable 1', { exact: true }).fill('echoed');
    await page.getByLabel('Step 1 variable 1 source').fill('echo');
    await page.getByLabel('Step 1 expected status').fill('2xx');
    await page.getByRole('button', { name: 'Script step' }).click();
    await page.getByLabel('Step 2 script').fill('vars.sku = JSON.parse(vars.echoed).sku');
    await page.getByRole('button', { name: 'Save and run' }).click();
    const result = page.getByLabel('Flow result');
    await expect.poll(() => result.textContent()).toContain('Flow ran');
    expect(await result.textContent()).toContain('sku = AB-200');
    await shot('api-flow');
    const r = await h.core.tools.sender.send({ method: 'GET', url: `${base}/api/x?sku={{flow:make-order.sku}}`, headers: [] });
    expect(r.path).toBe('/api/x?sku=AB-200');
  });

  it('makes a flow from requests picked in History', async () => {
    await nav('History');
    for (const path of ['/api/cart', '/api/apply-coupon']) {
      await page.locator('.row', { hasText: path }).first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: /Add to flow/ }).click();
    }
    await nav('API');
    await page.getByRole('tab', { name: /Flows/ }).click();
    await page.getByRole('button', { name: /Make flow from 2 picked/ }).click();
    await expect.poll(() => page.locator('.flow-step').count()).toBe(2);
    expect(await page.getByLabel('Step 2 request').inputValue()).toContain('/api/apply-coupon');
  });

  it('imports an OpenAPI file, shows documented but never called endpoints, and opens one in Replay', async () => {
    await page.getByRole('tab', { name: 'API files' }).click();
    await page.getByLabel('Spec text').fill(OPENAPI(h.upstreamPort));
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect.poll(() => page.locator('.spec-card').textContent()).toContain('/api/orders/{orderId}');
    await shot('api-files');
    await nav('History');
    await page.getByRole('group', { name: 'History mode' }).getByRole('button', { name: 'Coverage' }).click();
    const never = page.getByLabel('Documented but never called');
    await expect.poll(() => never.textContent()).toContain('/api/refunds');
    expect(await never.textContent()).not.toContain('/api/orders/{orderId}');
    expect(await page.locator('.coverage-table').textContent()).toContain('undocumented');
    await shot('coverage-docs');
    // Opening a documented endpoint fills its path parameter with a real order number from History.
    await nav('API');
    await page.getByRole('tab', { name: 'API files' }).click();
    await page.locator('.spec-card tr', { hasText: '/api/orders/{orderId}' }).getByRole('button', { name: 'Send to Replay' }).click();
    const editor = page.getByLabel('Raw request').last();
    await expect.poll(() => editor.inputValue()).toContain(`${base}/api/orders/PO-7781`);
  });
});
