import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { connectWebSocket } from '@siteinquisition/core';
import { tunnel } from '../../core/test/proxy-client';
import { DIST, navTo, startHarness, type Harness } from './harness';

// Explore API sections, clicking through to traffic, the site map tree, WebSocket APIs and the body editor's size.
const SHOTS = process.env.SIQ_SCREENSHOTS;
const ready = findChromium() !== null && existsSync(join(DIST, 'index.html'));

describe.skipIf(!ready)('exploring endpoints, the site map and WebSocket APIs', () => {
  let h: Harness;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  const shot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const filter = () => page.locator('#filter-input').inputValue();

  beforeAll(async () => {
    h = await startHarness();
    await h.send('/api/v1/users/7');
    await h.send('/api/v1/users/8');
    await h.send('/api/v1/orders');
    await h.send('/static/app.js');
    await h.send('/static/site.css');
    // A WebSocket API through the proxy: Socket.IO style events and a JSON "type" protocol.
    const { ws } = await connectWebSocket(`ws://127.0.0.1:${h.upstreamPort}/live/socket`, { createConnection: () => tunnel(`http://127.0.0.1:${h.proxyPort}`, '127.0.0.1', h.upstreamPort) });
    const echoes: string[] = [];
    ws.on('message', (d) => echoes.push(d.toString()));
    ws.send('{"type":"subscribe","channel":"prices"}');
    ws.send('{"type":"subscribe","channel":"news"}');
    ws.send('{"type":"unsubscribe","channel":"news"}');
    await expect.poll(() => echoes.length).toBe(3);
    ws.close(1000);
    browser = await launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(h.pageUrl);
    await page.locator('.vlist .row').first().waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });

  it('shows the site map as a tree that opens folder by folder and filters by any level', async () => {
    const map = page.getByRole('complementary', { name: 'Site map' });
    await map.getByRole('button', { name: /127\.0\.0\.1/ }).first().click();
    const node = (p: string) => map.locator(`[data-testid=site-node][data-path="${p}"]`);
    await expect.poll(() => node('/api').count()).toBe(1);
    expect(await node('/api/v1').count()).toBe(0);
    await map.getByRole('button', { name: 'Expand /api' }).click();
    await map.getByRole('button', { name: 'Expand /api/v1' }).click();
    await map.getByRole('button', { name: 'Expand /api/v1/users' }).click();
    await expect.poll(() => node('/api/v1/users/7').count()).toBe(1);
    expect(await node('/api/v1/users').textContent()).toContain('2');
    await map.getByRole('button', { name: 'Expand /live' }).click();
    expect(await node('/live/socket').textContent()).toContain('ws');
    await node('/api/v1').click();
    await expect.poll(filter).toContain('path:/api/v1');
    await expect.poll(() => page.locator('.vlist .row').count()).toBe(3);
    await shot('sitemap-tree');
    await node('/api/v1').click();
    await expect.poll(filter).not.toContain('path:');
    await page.locator('#filter-input').fill('');
  });

  it('lists files apart from API endpoints, and a row click shows its calls', async () => {
    await navTo(page, 'Explore API', 'Endpoints');
    const apis = page.getByRole('table', { name: 'API endpoints' });
    await expect.poll(() => apis.textContent()).toContain('/api/v1/orders');
    expect(await apis.textContent()).not.toContain('/static/app.js');
    const files = page.locator('details.coverage-files');
    expect(await files.locator('summary').textContent()).toMatch(/Files \(\d+\)/);
    await files.locator('summary').click();
    expect(await files.textContent()).toContain('/static/site.css');
    await shot('endpoints-sections');
    await apis.locator('tr', { hasText: '/api/v1/orders' }).locator('td', { hasText: '/api/v1/orders' }).first().click();
    await expect.poll(filter).toContain('method:GET path:/api/v1/orders');
    await expect.poll(() => page.locator('.vlist .row').count()).toBe(1);
    await page.locator('#filter-input').fill('');
  });

  it('maps WebSocket APIs with the kinds of message in each direction', async () => {
    await navTo(page, 'Explore API', 'WebSocket APIs');
    const ep = page.getByTestId('ws-endpoint');
    await expect.poll(() => ep.count()).toBe(1);
    expect(await ep.textContent()).toContain('/live/socket');
    expect(await ep.getByTestId('ws-protocol').textContent()).toContain('JSON');
    const kinds = ep.getByTestId('ws-kind');
    const texts = await kinds.allTextContents();
    expect(texts.some((t) => t.includes('type=subscribe') && t.includes('2'))).toBe(true);
    expect(texts.some((t) => t.includes('type=unsubscribe'))).toBe(true);
    expect(texts.some((t) => t.includes('echo'))).toBe(true); // the server's replies
    await shot('ws-api');
    await kinds.filter({ hasText: 'type=subscribe' }).first().click();
    await expect.poll(() => page.getByRole('tablist', { name: 'Traffic' }).locator('[aria-selected=true]').textContent()).toContain('Live connections');
    expect(errors).toEqual([]);
  });

  it('gives the replay body editor the room the pane has', async () => {
    await navTo(page, 'Traffic', 'Requests');
    await page.locator('#filter-input').fill('');
    await page.locator('.row', { hasText: '/api/apply-coupon' }).first().click();
    await page.keyboard.press('Control+r');
    const tab = page.locator('.tab-host:not([style*="none"])');
    await expect.poll(() => tab.getByLabel('Raw request').inputValue()).toContain('SAVE10');
    await tab.getByRole('tab', { name: /^Body/ }).click();
    const box = tab.getByLabel('Body', { exact: true });
    await expect.poll(() => box.inputValue()).toContain('SAVE10');
    const height = await box.evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
    expect(height).toBeGreaterThan(300);
    await shot('replay-body');
  });

  it('opens a connection older than the newest 200 straight from WebSocket APIs', async () => {
    const st = h.core.store;
    const ids: string[] = [];
    st.tx(() => {
      for (let n = 0; n < 205; n++) {
        const e = st.addRequest({ source: 'proxy', startedAt: Date.now(), method: 'GET', url: `http://127.0.0.1:${h.upstreamPort}/bulk/${n}`, httpVersion: '1.1', headers: [], isWebSocket: true });
        st.completeResponse(e.id, { status: 101, headers: [] });
        ids.push(e.id);
      }
      const s = st.openStream('websocket', ids[0]!);
      st.addStreamMessage({ streamId: s, direction: 'server', opcode: 'text', at: Date.now(), payload: Buffer.from('{"type":"oldest"}') });
    });
    await navTo(page, 'Explore API', 'WebSocket APIs');
    const kind = page.getByTestId('ws-kind').filter({ hasText: 'type=oldest' });
    await expect.poll(() => kind.count()).toBe(1);
    await kind.click();
    await expect.poll(() => page.locator('.streams .replay-bar .panel-title').textContent()).toContain('/bulk/0');
    await expect.poll(() => page.locator('.streams .msg-table').textContent()).toContain('oldest');
  });
});
