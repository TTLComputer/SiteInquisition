import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { createHmac } from 'node:crypto';
import { DIST, startHarness, type Harness } from './harness';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function hs256(payload: object, secret: string): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

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
    const token = hs256({ sub: 'u1', role: 'user', iss: 'acme' }, 'secret');
    await h.send('/api/me', 'GET', undefined, { authorization: `Bearer ${token}` });
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

  it('decodes a JWT, flags the risks and re-signs an edited payload', async () => {
    await nav('History');
    await page.locator('.row', { hasText: '/api/me' }).click();
    await page.getByRole('tab', { name: 'Tech and CSRF' }).click();
    const jwt = page.locator('.jwt-panel');
    await jwt.waitFor();
    expect(await jwt.textContent()).toContain('sub: u1');
    expect(await jwt.textContent()).toMatch(/symmetric/);
    await jwt.getByRole('button', { name: 'Edit and re-sign' }).click();
    const payload = page.getByLabel('JWT payload');
    await payload.fill(JSON.stringify({ sub: 'u1', role: 'admin', iss: 'acme' }, null, 2));
    await page.getByLabel('Signing secret').fill('secret');
    await page.getByRole('button', { name: 'Test secret' }).click();
    await expect.poll(() => page.locator('.toast').textContent()).toMatch(/forgeable/);
    await page.getByRole('button', { name: 'Re-sign with secret' }).click();
    const out = page.getByLabel('Re-signed token');
    await expect.poll(() => out.inputValue()).toMatch(/^eyJ/);
    // The new token really verifies and carries the edited claim.
    const resigned = await out.inputValue();
    expect(JSON.parse(Buffer.from(resigned.split('.')[1]!, 'base64url').toString()).role).toBe('admin');
    expect(createHmac('sha256', 'secret').update(resigned.split('.').slice(0, 2).join('.')).digest('base64url')).toBe(resigned.split('.')[2]);
    await shot('jwt');
  });

  it('holds a signing key for the session in Settings', async () => {
    await nav('Settings');
    await page.getByRole('tab', { name: 'Signing keys' }).click();
    await page.getByLabel('Key name').fill('team-hmac');
    await page.getByLabel('HMAC secret').fill('s3cr3t');
    await page.getByRole('button', { name: 'Add key' }).click();
    await expect.poll(() => h.core.tools.keys.names()).toContain('team-hmac');
    await page.getByRole('tab', { name: 'Technologies' }).click();
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
