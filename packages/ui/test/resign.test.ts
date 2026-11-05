import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { parseJwt, verifyJwt } from '@siteinquisition/core';
import { DIST, startHarness, type Harness } from './harness';

// Re-signing and evergreen tokens, driven through the built renderer against a real core.
const SHOTS = process.env.SIQ_SCREENSHOTS;
const ready = findChromium() !== null && existsSync(join(DIST, 'index.html'));

const SAMPLE_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJ1c2VyIiwiZXhwIjoxMDAwMDAwMDAwfQ.aEY4GxRUw9ooq-gjjPRkfKJo7s6Jgm0-_MlUIFWq2B8';

describe.skipIf(!ready)('re-signing and evergreen tokens in the renderer', () => {
  let h: Harness;
  let browser: Browser;
  let page: Page;

  const shot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  };
  const nav = (name: string) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name, exact: false }).first().click();

  beforeAll(async () => {
    h = await startHarness();
    // A stored HMAC key to sign with, and a captured JWT cookie to re-sign.
    h.core.tools.keys.setSecret('app', 'secret');
    await h.send('/api/jwt-cookie');
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e));
    await page.goto(h.pageUrl);
    await page.locator('.vlist .row').first().waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });

  it('re-signs and keeps a JWT evergreen from the Codecs workbench', async () => {
    await nav('Codecs');
    await page.getByLabel('Codec input').fill(SAMPLE_JWT);
    await page.getByRole('button', { name: 'Re-sign…' }).click();
    await page.getByLabel('Signing key').selectOption('app');
    await page.getByRole('button', { name: 'Re-sign once' }).click();
    // The one-off output is a fresh, valid token.
    await expect.poll(async () => /^eyJ/.test(await page.getByLabel('Re-signed value').inputValue())).toBe(true);
    await shot('codecs-resign');

    await page.getByLabel('Evergreen token name').fill('admin-jwt');
    await page.getByRole('button', { name: 'Keep evergreen' }).click();
    await expect.poll(() => page.getByText('{{sign:admin-jwt}}').count()).toBeGreaterThan(0);

    // The core mints a fresh, unexpired token that verifies with the bound key.
    const minted = await h.core.tools.evergreen.resolve('admin-jwt');
    expect(parseJwt(minted).expired).toBe(false);
    expect(verifyJwt(minted, { kind: 'hmac', secret: 'secret' })).toBe(true);
  });

  it('lists the evergreen token under Cookies › Signed tokens', async () => {
    await nav('Cookies');
    await page.getByRole('tab', { name: 'Signed tokens' }).click();
    const row = page.getByTestId('evergreen-row');
    await expect.poll(() => row.count()).toBe(1);
    expect(await row.textContent()).toContain('{{sign:admin-jwt}}');
    expect(await row.textContent()).toContain('app');
    await shot('signed-tokens');
  });

  it('offers a Re-sign button on a JWT cookie in the jar', async () => {
    await page.getByRole('tab', { name: 'Cookie jar' }).click();
    const jwtRow = page.locator('[data-testid=cookie-row][data-name=auth]');
    await jwtRow.waitFor();
    await jwtRow.getByRole('button', { name: 'Re-sign', exact: true }).click();
    // The shared panel opens and recognizes it as a JWT.
    await expect.poll(() => page.getByLabel('Payload to re-sign').count()).toBe(1);
    await shot('cookie-resign');
  });
});
