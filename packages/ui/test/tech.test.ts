import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { DIST, startHarness, type Harness } from './harness';

// Technology detection, corrections and CSRF bindings, driven through the renderer.
const SHOTS = process.env.SIQ_SCREENSHOTS;
const ready = findChromium() !== null && existsSync(join(DIST, 'index.html'));

describe.skipIf(!ready)('technologies in the renderer', () => {
  let h: Harness;
  let browser: Browser;
  let page: Page;

  const shot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const names = () => page.locator('[data-testid=tech-row] .tech-line > b').allTextContents();
  const row = async (name: string) => page.getByTestId('tech-row').nth((await names()).indexOf(name));
  const nav = (name: string) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name, exact: false }).first().click();

  beforeAll(async () => {
    h = await startHarness();
    await h.send('/account');
    await h.send('/search?q=lamp');
    await h.send("/search?q=lamp'%20OR%201=1");
    await h.send('/api/save', 'POST', JSON.stringify({ name: 'ada' }), { 'x-csrftoken': 'tok-abcdef123456', cookie: 'csrftoken=tok-abcdef123456; AWSALB=lb-sticky-1' });
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e));
    await page.goto(h.pageUrl);
    await page.locator('.row', { hasText: '/api/save' }).waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });

  it('shows what the host runs on and lets the user correct it', async () => {
    await page.locator('.row', { hasText: '/api/save' }).click();
    await page.getByRole('tab', { name: 'Tech and CSRF' }).click();
    await expect.poll(names).toEqual(expect.arrayContaining(['Django', 'Python', 'AWS load balancer (ALB/ELB)', 'AWS']));
    const django = await row('Django');
    expect(await django.textContent()).toContain('cookie csrftoken');

    await django.getByRole('button', { name: 'Not this' }).click();
    await expect.poll(names).not.toContain('Django');
    expect(h.core.tools.tech.overrides()).toEqual([expect.objectContaining({ tech: 'django', action: 'reject' })]);
    await page.getByRole('button', { name: 'Django ✕' }).click();
    await expect.poll(names).toContain('Django');

    await page.getByLabel('Missed something?').selectOption('nextjs');
    await page.getByRole('button', { name: 'Pin', exact: true }).click();
    await expect.poll(names).toContain('Next.js');
    expect(await (await row('Next.js')).textContent()).toContain('pinned by you');
  });

  it('keeps a CSRF token fresh from one click', async () => {
    const row = page.getByTestId('csrf-row').filter({ hasText: 'X-CSRFToken' });
    await row.waitFor();
    expect(await row.textContent()).toContain('cookie csrftoken');
    await shot('tech');
    await row.getByRole('button', { name: 'Keep fresh on replay' }).click();
    await expect.poll(() => row.textContent()).toContain('kept fresh as');
    const [b] = h.core.tools.tech.csrfBindings();
    expect(b).toEqual(expect.objectContaining({ source: { from: 'cookie', name: 'csrftoken' }, sinks: [{ in: 'header', name: 'x-csrftoken' }] }));
  });

  it('hides platform cookies in the jar until asked', async () => {
    await nav('Cookies');
    await page.getByTestId('cookie-row').filter({ hasText: 'csrftoken' }).waitFor();
    expect(await page.getByTestId('cookie-row').filter({ hasText: 'AWSALB' }).count()).toBe(0);
    await page.getByLabel(/Show platform cookies/).check();
    await expect.poll(() => page.getByTestId('cookie-row').filter({ hasText: 'AWSALB' }).textContent()).toContain('platform: AWS load balancer');
  });

  it('flags a request whose response leaks a SQL error, and names the cause', async () => {
    await nav('History');
    await page.getByRole('button', { name: 'Server errors', exact: true }).click();
    const row = page.locator('.row', { hasText: '/search' });
    await expect.poll(() => row.count()).toBe(1);
    expect(await row.locator('.err-tag').textContent()).toBe('sql');
    await row.click();
    await page.getByRole('tab', { name: 'Request and response' }).click();
    const finding = page.getByTestId('error-finding');
    await expect.poll(() => finding.textContent()).toContain('MySQL syntax error');
    expect(await finding.textContent()).toContain("likely caused by the query parameter q = lamp' OR 1=1");
    await shot('errors');
    await page.getByRole('button', { name: 'All', exact: true }).click();
  });

  it('lists corrections and bindings in Settings', async () => {
    await nav('Settings');
    await page.getByRole('tab', { name: 'Technologies' }).click();
    await expect.poll(() => page.locator('.settings-block').first().textContent()).toContain('Next.js');
    expect(await page.locator('.settings-block').nth(1).textContent()).toContain('{{var:csrf.127.0.0.1}}');
    const groups = await page.getByTestId('sig-group').locator('summary b').allTextContents();
    expect(groups.slice(0, 4)).toEqual(['Amazon Web Services', 'Google Cloud', 'Microsoft Azure', 'Cloudflare']);
    expect(groups).toContain('Server frameworks');
    const aws = page.getByTestId('sig-group').first();
    await aws.locator('summary').click();
    expect((await aws.locator('label').allTextContents())[0]).toMatch(/^AWS/);
    // Groups list in order, so the first "Turn all off" is the AWS one.
    await page.getByRole('button', { name: 'Turn all off', exact: true }).first().click();
    await expect.poll(() => [...h.core.tools.tech.disabled()].sort()).toEqual(h.core.tools.tech.builtIn().filter((s) => s.vendor === 'Amazon Web Services').map((s) => s.id).sort());
    await page.getByRole('button', { name: 'Turn all on', exact: true }).click();
    await expect.poll(() => h.core.tools.tech.disabled().length).toBe(0);
    await shot('tech-settings');
  });
});
