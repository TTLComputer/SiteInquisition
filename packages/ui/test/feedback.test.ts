import { existsSync, mkdirSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { placeMenu } from '../src/components/placement';
import { generateSelfSigned } from '../../core/src/x509';
import { DIST, startHarness, type Harness } from './harness';

describe('placeMenu', () => {
  const vp = { width: 800, height: 600 };
  it('opens below a button when it fits, lined up with its edge', () => {
    const btn = new DOMRectLike(600, 100, 100, 30);
    const p = placeMenu({ width: 300, height: 200 }, btn, vp, { align: 'end' });
    expect(p).toMatchObject({ left: 400, top: 134, above: false });
  });
  it('flips above near the bottom, and slides back on screen from the left edge', () => {
    // An "insert token" button that wrapped to the start of the next row, near the bottom.
    const btn = new DOMRectLike(4, 540, 120, 30);
    const p = placeMenu({ width: 380, height: 420 }, btn, vp, { align: 'end' });
    expect(p.above).toBe(true);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + 380).toBeLessThanOrEqual(vp.width - 8);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
  it('scrolls when it fits on neither side, and never gets wider than the window', () => {
    const p = placeMenu({ width: 2000, height: 2000 }, { x: 790, y: 300 }, vp);
    expect(p.maxWidth).toBe(784);
    expect(p.left).toBe(8);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(vp.height);
  });
});

/** A DOMRect stand-in: the placement code only reads its box. */
class DOMRectLike {
  constructor(
    readonly left: number,
    readonly top: number,
    readonly width: number,
    readonly height: number,
  ) {}
  get right() {
    return this.left + this.width;
  }
  get bottom() {
    return this.top + this.height;
  }
  get x() {
    return this.left;
  }
  get y() {
    return this.top;
  }
  toJSON() {
    return this;
  }
}

const SHOTS = process.env.SIQ_SCREENSHOTS;
const ready = findChromium() !== null && existsSync(join(DIST, 'index.html'));

describe.skipIf(!ready)('UI feedback fixes in the renderer', () => {
  let h: Harness;
  let browser: Browser;
  let page: Page;
  let tlsServer: Server;
  let tlsPort: number;

  const shot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const nav = (name: string) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name, exact: false }).first().click();
  const inViewport = async (selector: string) => {
    const box = (await page.locator(selector).boundingBox())!;
    const vp = await page.evaluate(() => ({ width: (globalThis as any).innerWidth as number, height: (globalThis as any).innerHeight as number }));
    return box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width && box.y + box.height <= vp.height;
  };

  beforeAll(async () => {
    h = await startHarness();
    for (const p of ['/api/orders/1', '/api/orders/2', '/api/users/1', '/api/stock']) await h.send(p);
    await h.send('/app');
    await h.send('/api/blob');
    const self = generateSelfSigned('dev.local');
    tlsServer = createHttpsServer({ key: self.key, cert: self.cert }, (_q, r) => r.end('ok'));
    tlsPort = await new Promise<number>((r) => tlsServer.listen(0, '127.0.0.1', () => r((tlsServer.address() as AddressInfo).port)));
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e));
    await page.goto(h.pageUrl);
    await page.locator('.row', { hasText: '/api/blob' }).waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    await h?.close();
    tlsServer?.closeAllConnections();
    await new Promise((r) => tlsServer?.close(r));
  });

  it('glossary entries expand and lead to the requests behind them', async () => {
    await nav('API');
    await page.getByRole('tab', { name: 'Glossary' }).click();
    const row = page.locator('[data-testid=glossary-row][data-field=path]');
    await row.waitFor();
    const more = row.getByRole('button', { name: /^\+\d+ more$/ });
    const hidden = Number(/\d+/.exec((await more.textContent())!)![0]);
    expect(hidden).toBeGreaterThan(0);
    await more.click();
    await expect.poll(() => row.locator('.glossary-where > div').count()).toBe(hidden + 2);
    await shot('glossary-expanded');
    // A place opens its newest request.
    await row.getByRole('button', { name: /GET \/api\/stock \$\.path/ }).click();
    await expect.poll(() => page.locator('.inspector').textContent()).toContain('/api/stock');
    // The count opens every request that carried the field, as a History search.
    await nav('API');
    await page.getByRole('tab', { name: 'Glossary' }).click();
    await page.locator('[data-testid=glossary-row][data-field=path]').getByRole('button', { name: /distinct/ }).click();
    await expect.poll(() => page.locator('#filter-input').inputValue()).toMatch(/^id:/);
    await expect.poll(() => page.locator('.row').count()).toBeGreaterThanOrEqual(5);
    await page.locator('#filter-input').fill('');
    await page.keyboard.press('Enter');
  });

  it('shows technologies across all traffic, and page CSRF tokens', async () => {
    h.core.tools.tech.override('127.0.0.1', 'nginx', 'pin');
    await nav('Tech');
    const rows = page.getByTestId('tech-overview-row');
    await expect.poll(() => rows.filter({ hasText: 'nginx' }).count()).toBe(1);
    const nginx = rows.filter({ hasText: 'nginx' });
    await nginx.getByRole('button', { name: /nginx/ }).click();
    await expect.poll(() => nginx.textContent()).toContain('127.0.0.1');
    const token = page.getByTestId('page-token-row').filter({ hasText: 'csrf-token' });
    await token.waitFor();
    expect(await token.textContent()).toContain('meta-token-');
    await shot('tech-overview');
    await token.getByRole('button', { name: 'Keep fresh on replay' }).click();
    await expect.poll(() => token.textContent()).toContain('kept fresh as');
    expect(h.core.tools.tech.csrfBindings().some((b) => b.source.from === 'meta' && b.source.name === 'csrf-token')).toBe(true);
  });

  it('keeps the token menu on screen when its button wraps to the left', async () => {
    await page.setViewportSize({ width: 760, height: 640 });
    await nav('History');
    await page.locator('.row', { hasText: '/api/cart' }).first().click();
    await page.keyboard.press('Control+r');
    await page.getByRole('button', { name: /Insert token/ }).click();
    const menu = '.token-menu';
    await page.locator(menu).waitFor();
    expect(await inViewport(menu)).toBe(true);
    await shot('token-menu-narrow');
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
    // A right-click near the bottom right corner opens the row menu up and to the left.
    await nav('History');
    const rowBox = (await page.locator('.row').first().boundingBox())!;
    await page.locator('.row').first().click({ button: 'right', position: { x: Math.min(rowBox.width, 760 - rowBox.x) - 30, y: rowBox.height / 2 } });
    await page.locator('.context-menu[role=menu]').waitFor();
    expect(await inViewport('.context-menu[role=menu]')).toBe(true);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  it('shows saved field codecs decoded in the Inspector and Replay', async () => {
    await nav('Codecs');
    await page.getByRole('button', { name: 'Add field codec' }).click();
    await page.getByLabel('Field JSONPath').fill('$.blob');
    await page.getByLabel('Field codec chain').fill('base64>json');
    await page.getByLabel('Field codec host').fill('127.0.0.1');
    await page.getByTestId('field-codec-form').getByRole('button', { name: 'Add' }).click();
    await expect.poll(() => h.core.tools.fieldCodecs.list().length).toBe(1);
    await expect.poll(() => page.getByTestId('field-codec-row').count()).toBe(1);

    await nav('History');
    await page.locator('.row', { hasText: '/api/blob' }).first().click();
    const view = page.getByRole('group', { name: 'Response body view' });
    await expect.poll(() => view.getByRole('button', { name: 'Decoded fields' }).evaluate((el) => el.getAttribute('aria-pressed'))).toBe('true');
    await expect.poll(() => page.locator('.inspector').textContent()).toContain('inner-value');
    await shot('field-codecs-inspector');

    // Replay opens a request body with the field decoded and encodes it again on send.
    const b64 = Buffer.from(JSON.stringify({ secret: 'sent-value' })).toString('base64');
    await h.send('/api/blob-echo', 'POST', JSON.stringify({ blob: b64 }));
    await page.locator('.row', { hasText: '/api/blob-echo' }).first().click();
    await page.keyboard.press('Control+r');
    const tab = page.locator('.tab-host').last();
    const editor = tab.getByLabel('Raw request');
    await expect.poll(() => editor.inputValue()).toContain('"secret": "sent-value"');
    expect(await tab.getByLabel('Encode fields with').inputValue()).toBe('$.blob = base64>json');
    await editor.fill((await editor.inputValue()).replace('sent-value', 'edited-value'));
    await tab.getByRole('button', { name: /^Send$/ }).first().click();
    await expect.poll(() => h.core.store.search('path:/api/blob-echo').some((e) => e.replayOf && e.state === 'complete')).toBe(true);
    const sent = h.core.store.search('path:/api/blob-echo').find((e) => e.replayOf)!;
    const body = JSON.parse(new TextDecoder().decode(h.core.store.getBody(sent.id, 'request', true)!)) as { blob: string };
    expect(JSON.parse(Buffer.from(body.blob, 'base64').toString())).toEqual({ secret: 'edited-value' });
  });

  it('trusts a self-signed dev server certificate from Settings', async () => {
    await nav('Settings');
    await page.getByRole('tab', { name: 'Server certificates' }).click();
    await page.getByLabel('Server to fetch the certificate from').fill(`127.0.0.1:${tlsPort}`);
    await page.getByRole('button', { name: 'Fetch certificate' }).click();
    const card = page.getByTestId('peer-cert');
    await card.waitFor();
    expect(await card.textContent()).toContain('self-signed');
    await shot('server-certificates');
    await card.getByRole('button', { name: 'Trust this certificate' }).click();
    await expect.poll(() => page.getByTestId('trusted-cert').count()).toBe(1);
    expect(h.core.upstreamTls.get().trusted[0]!.subject).toContain('dev.local');
    const res = await h.core.tools.sender.send({ method: 'GET', url: `https://127.0.0.1:${tlsPort}/`, headers: [] }, {});
    expect(res.status).toBe(200);

    await page.getByRole('radio', { name: 'Except listed hosts' }).click();
    await page.getByLabel('Hosts that skip certificate checks').fill('*.dev.local\n10.0.0.*');
    await page.getByRole('button', { name: 'Save hosts' }).click();
    await expect.poll(() => h.core.upstreamTls.get().hosts).toEqual(['*.dev.local', '10.0.0.*']);
    expect(h.core.upstreamTls.get().mode).toBe('hosts');
  });
});
