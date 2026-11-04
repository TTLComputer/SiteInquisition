import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { DIST, startHarness, type Harness } from './harness';

// Drives the built renderer in Chromium against a real core. Needs `pnpm build`
// first and a Chromium or Chrome (see findChromium); skipped when either is missing.
const SHOTS = process.env.SIQ_SCREENSHOTS;
const ready = findChromium() !== null && existsSync(join(DIST, 'index.html'));

describe.skipIf(!ready)('renderer against a real core', () => {
  let h: Harness;
  let browser: Browser;
  let page: Page;

  const shot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };

  beforeAll(async () => {
    h = await startHarness();
    browser = await launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    page.on('pageerror', (e) => console.error('page error:', e));
    await page.goto(h.pageUrl);
  });

  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });

  it('lists recorded traffic with status and a replay pill on every row', async () => {
    const rows = page.locator('.vlist .row');
    await expect.poll(() => rows.count()).toBe(5); // the proxy records the 302 itself; the client did not follow it
    await expect.poll(() => page.locator('.row', { hasText: '/broken' }).locator('.s-5').textContent()).toBe('500');
    expect(await page.locator('.row', { hasText: '/old' }).locator('.s-3').textContent()).toBe('302');
    expect(await page.locator('.row .pill').count()).toBe(5);
    await shot('history');
  });

  it('filters with chips and search syntax', async () => {
    const chips = page.getByRole('group', { name: 'Quick filters' });
    await chips.getByRole('button', { name: 'Errors', exact: true }).click();
    await expect.poll(() => page.locator('.vlist .row').count()).toBe(1);
    await page.locator('#filter-input').fill('method:POST');
    await expect.poll(() => page.locator('.vlist .row').first().textContent()).toContain('/api/apply-coupon');
    expect(await page.locator('.vlist .row').count()).toBe(1);
    await chips.getByRole('button', { name: 'All', exact: true }).click();
    await expect.poll(() => page.locator('.vlist .row').count()).toBe(5);
  });

  it('follows live traffic', async () => {
    await h.send('/api/live');
    await expect.poll(() => page.locator('.row', { hasText: '/api/live' }).count()).toBe(1);
  });

  it('inspects an exchange', async () => {
    await page.locator('.row', { hasText: '/api/apply-coupon' }).click();
    const insp = page.getByLabel('Inspector', { exact: true });
    await expect.poll(() => insp.locator('pre.raw').first().textContent()).toContain('"code": "SAVE10"');
    expect(await insp.locator('pre.raw').nth(1).textContent()).toContain('HTTP/1.1 200');
    await shot('inspector');
  });

  it('sends to replay, edits, sends and diffs', async () => {
    await page.keyboard.press('Control+r');
    const editor = page.getByLabel('Raw request');
    await expect.poll(() => editor.inputValue()).toContain('SAVE10');
    expect(await page.getByRole('tab', { name: /apply-coupon/ }).count()).toBe(1);
    await editor.fill((await editor.inputValue()).replace('SAVE10', 'SAVE99'));
    await editor.press('Control+Enter');
    await expect.poll(() => page.getByText('send 1 of 1').count()).toBe(1);
    await expect.poll(() => page.locator('.replay pre.raw').textContent()).toContain('SAVE99');
    await page.getByLabel('Diff with original').check();
    await expect.poll(() => page.locator('.replay .diff-add').count()).toBeGreaterThan(0);
    await shot('replay');
    // The send is recorded as a replay of the original.
    const replays = await h.core.store.search('source:replay');
    expect(replays).toHaveLength(1);
    expect(replays[0]!.replayOf).toBeTruthy();
  });

  it('keeps replay edits when switching tabs and closes tabs', async () => {
    await page.getByRole('tab', { name: 'History' }).click();
    await page.getByRole('tab', { name: /apply-coupon/ }).click();
    expect(await page.getByLabel('Raw request').inputValue()).toContain('SAVE99');
    await page.getByRole('button', { name: /Close replay/ }).click();
    expect(await page.getByRole('tab', { name: /apply-coupon/ }).count()).toBe(0);
  });

  it('resends from the row menu without opening the editor', async () => {
    await page.getByRole('group', { name: 'Quick filters' }).getByRole('button', { name: 'All', exact: true }).click();
    await page.locator('.row', { hasText: '/api/cart' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Resend now/ }).click();
    await expect.poll(() => page.locator('.toast').textContent()).toContain('Resent: 200');
    expect(await h.core.store.search('source:replay')).toHaveLength(2);
  });

  it('adds a seen host to the scope', async () => {
    await page.getByRole('button', { name: 'Rules' }).click();
    await expect.poll(() => page.getByTestId('scope-rule').count()).toBe(1);
    await expect.poll(() => page.getByTestId('seen-host').count()).toBeGreaterThan(0);
    await shot('rules');
    const host = (await page.getByTestId('seen-host').first().locator('.mono').first().textContent())!;
    await page.getByTestId('seen-host').first().getByRole('button', { name: /Add/ }).click();
    await expect.poll(() => h.core.scope.get().rules.some((r) => r.host === host)).toBe(true);
    await expect.poll(() => page.getByTestId('scope-rule').count()).toBe(2);
  });

  it('draws the timeline and turns a dragged range into a History filter', async () => {
    await page.getByRole('button', { name: 'Timeline' }).click();
    await expect.poll(() => page.getByTestId('tl-lane').count()).toBeGreaterThan(0);
    expect(await page.locator('.tl-bar').count()).toBeGreaterThanOrEqual(5);
    await page.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'Flow' }).click();
    await expect.poll(() => page.getByTestId('tl-lane').count()).toBeGreaterThan(1);
    await shot('timeline');
    const box = (await page.locator('.tl-lanes').boundingBox())!;
    await page.mouse.move(box.x + 240, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 5, box.y + 10, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => page.locator('#filter-input').inputValue()).toMatch(/since:\d+ until:\d+/);
    await page.getByRole('group', { name: 'Quick filters' }).getByRole('button', { name: 'All', exact: true }).click();
  });

  it('shows the cookie jar with decoded hints and links to the response that set it', async () => {
    await page.getByRole('button', { name: 'Cookies' }).click();
    await expect.poll(() => page.getByTestId('cookie-row').count()).toBe(2);
    const session = page.getByTestId('cookie-row').filter({ hasText: 'session' });
    expect(await session.textContent()).toContain('base64 › json');
    expect(await session.textContent()).toContain('HttpOnly');
    await shot('cookies');
    await session.locator('.pill').click();
    await expect.poll(() => page.getByLabel('Inspector', { exact: true }).textContent()).toContain('/api/cart');
  });

  it('explains the built-in browser outside the desktop app', async () => {
    await page.getByRole('button', { name: 'Browser' }).click();
    expect(await page.getByText('The built-in browser runs in the desktop app').count()).toBe(1);
  });

  it('shows settings and switches theme', async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect.poll(() => page.getByText(`127.0.0.1:${h.proxyPort}`).count()).toBeGreaterThan(0);
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.getByRole('radio', { name: 'Light' }).click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await page.getByRole('button', { name: 'History' }).click();
    await shot('history-light');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.getByRole('radio', { name: 'Follow system' }).click();
  });
});
