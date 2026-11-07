import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { DIST, navTo, startHarness, type Harness } from './harness';
import { AREAS } from '../src/workspace/navigation';

// Product coherence: four work areas, Project settings and Advanced tools, and the overrides list.
const SHOTS = process.env.SIQ_SCREENSHOTS;
const ready = findChromium() !== null && existsSync(join(DIST, 'index.html'));

describe.skipIf(!ready)('work areas in the renderer', () => {
  let h: Harness;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  const shot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const selectedTab = (area: string) => page.getByRole('tablist', { name: area }).locator('[aria-selected=true]').textContent();

  beforeAll(async () => {
    h = await startHarness();
    h.core.tools.setMocks([{ name: 'Checkout payment failure', enabled: true, host: '127.0.0.1', method: 'POST', path: '/api/pay', status: 402, headers: [], body: '{"error":"card declined"}' }]);
    h.core.tools.setBreakpoints([{ enabled: false, phase: 'request', host: '127.0.0.1', path: '/api/cart' }]);
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

  it('shows four work areas, with Project settings and Advanced tools in the footer', async () => {
    const nav = page.getByRole('navigation', { name: 'Work areas' });
    const labels = (await nav.locator('.nav-item').allTextContents()).map((t) => t.replace(/\s*[\d,.]+[kM]?(\s.*)?$/, '').trim());
    expect(labels).toEqual(['Traffic', 'Explore API', 'Replay', 'Overrides', 'Project settings', 'Advanced tools']);
    expect(await nav.locator('.nav-footer .nav-item').count()).toBe(2);
    await shot('work-areas');
  });

  it('reaches every page without errors, and navigation changes no override', async () => {
    const before = JSON.stringify([h.core.tools.mocks(), h.core.tools.breakpoints(), h.core.tools.replaceRules()]);
    for (const area of AREAS)
      for (const p of area.pages) {
        await navTo(page, area.label, p.label);
        await expect.poll(() => selectedTab(area.label)).toContain(p.label);
        await expect.poll(async () => ((await page.locator('main').textContent()) ?? '').length, `${area.label} > ${p.label}`).toBeGreaterThan(p.label.length);
      }
    expect(errors).toEqual([]);
    expect(JSON.stringify([h.core.tools.mocks(), h.core.tools.breakpoints(), h.core.tools.replaceRules()])).toBe(before);
  });

  it('returns to the page last used in an area', async () => {
    await navTo(page, 'Explore API', 'GraphQL');
    await navTo(page, 'Traffic', 'Requests');
    await page.getByRole('navigation', { name: 'Work areas' }).getByRole('button', { name: 'Explore API' }).click();
    await expect.poll(() => selectedTab('Explore API')).toContain('GraphQL');
    // Clicking the area you are in goes to its first page.
    await page.getByRole('navigation', { name: 'Work areas' }).getByRole('button', { name: 'Explore API' }).click();
    await expect.poll(() => selectedTab('Explore API')).toContain('Endpoints');
  });

  it('opens the capture scope from the title bar and the first-run hint', async () => {
    await navTo(page, 'Traffic', 'Requests');
    await page.getByRole('button', { name: /^Scope:/ }).click();
    await expect.poll(() => selectedTab('Project settings')).toContain('Capture scope');
    await expect.poll(() => page.getByTestId('scope-rule').count()).toBe(1);
  });

  it('finds variables and login macros under Session and authentication', async () => {
    await navTo(page, 'Project settings', 'Session and authentication');
    const tabs = page.getByRole('tablist', { name: 'Session and authentication' });
    expect(await tabs.getByRole('tab').allTextContents()).toEqual(['Cookie jar', 'Variables', 'Profiles', 'Setup and login', 'Signed tokens', 'AWS SigV4']);
    await tabs.getByRole('tab', { name: 'Variables' }).click();
    await expect.poll(() => page.getByLabel('New variable name').count()).toBe(1);
  });

  it('lists every override in one place, and turns one off without touching the others', async () => {
    await navTo(page, 'Overrides', 'Active');
    const rows = page.getByTestId('override-row');
    await expect.poll(() => rows.count()).toBe(2);
    expect(await page.getByTestId('override-summary').textContent()).toContain('2 configured, 1 on');
    expect(await rows.first().textContent()).toContain('Checkout payment failure');
    await shot('overrides-active');
    await page.getByRole('switch', { name: /Turn off Mock Checkout payment failure/ }).click();
    await expect.poll(() => h.core.tools.mocks()[0]!.enabled).toBe(false);
    expect(h.core.tools.breakpoints()[0]!.enabled).toBe(false);
    await expect.poll(() => page.getByTestId('override-summary').textContent()).toContain('2 configured, 0 on');
    // Edit goes to the page that owns that kind of override.
    await rows.first().getByRole('button', { name: 'Edit' }).click();
    await expect.poll(() => selectedTab('Overrides')).toContain('Mocks');
  });

  it('shows only hooks under Live hooks and every script in the Script console', async () => {
    await h.core.tools.setScripts([
      { name: 'stamp', kind: 'hook', code: 'export function onRequest(r) { return r; }', enabled: false },
      { name: 'smoke-tests', kind: 'test', code: 'test("ok", () => {});' },
    ]);
    await navTo(page, 'Overrides', 'Live hooks');
    await expect.poll(() => page.getByLabel('Scripts').textContent()).toContain('stamp');
    expect(await page.getByLabel('Scripts').textContent()).not.toContain('smoke-tests');
    await navTo(page, 'Advanced tools', 'Script console');
    await expect.poll(() => page.getByLabel('Scripts').textContent()).toContain('smoke-tests');
  });

  it('keeps Ctrl K as the traffic filter', async () => {
    await navTo(page, 'Advanced tools', 'Decode');
    await page.keyboard.press('Control+k');
    await expect.poll(() => selectedTab('Traffic')).toContain('Requests');
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('filter-input');
  });

  it('goes back and forward through places visited', async () => {
    await navTo(page, 'Explore API', 'Values');
    await page.getByRole('tablist', { name: 'Explore API' }).getByRole('tab', { name: 'Fields' }).click();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect.poll(() => selectedTab('Explore API')).toContain('Values');
    await page.getByRole('button', { name: 'Forward' }).click();
    await expect.poll(() => selectedTab('Explore API')).toContain('Fields');
  });

  it('finds actions and pages in command search, and says why one cannot run', async () => {
    await navTo(page, 'Traffic', 'Requests');
    await page.locator('.row', { hasText: '/api/cart' }).first().click();
    await page.keyboard.press('Control+Shift+P');
    const box = page.getByRole('dialog', { name: 'Command search' });
    await box.getByLabel('Search commands').fill('compare marked');
    const opt = box.getByRole('option', { name: /Compare with the marked request/ });
    // The selected exchange loads after the box opens.
    await expect.poll(() => opt.textContent()).toContain('Mark a request to compare first');
    expect(await opt.evaluate((el) => el.getAttribute('aria-disabled'))).toBe('true');
    await box.getByLabel('Search commands').fill('go endpoints');
    await page.keyboard.press('Enter');
    await expect.poll(() => selectedTab('Explore API')).toContain('Endpoints');
    expect(await page.getByRole('dialog', { name: 'Command search' }).count()).toBe(0);
  });

  it('opens a comparison as a document beside the replay editors', async () => {
    await navTo(page, 'Traffic', 'Requests');
    await page.locator('.row', { hasText: '/api/cart' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Mark to compare' }).click();
    await page.locator('.row', { hasText: '/api/apply-coupon' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Compare with the marked request' }).click();
    await expect.poll(() => selectedTab('Replay')).toContain('Open editors');
    await expect.poll(() => page.getByRole('tablist', { name: 'Open editors' }).textContent()).toContain('Compare:');
    await expect.poll(() => page.locator('.tab-host:not([style*="none"])').getByLabel('Compare').textContent()).toContain('/api/apply-coupon');
    await page.getByRole('button', { name: /Close replay Compare/ }).click();
  });

  it('keeps each editor dirty on its own, and brings drafts back after a restart without sending', async () => {
    await navTo(page, 'Traffic', 'Requests');
    await page.locator('.row', { hasText: '/api/apply-coupon' }).first().click();
    await page.keyboard.press('Control+r');
    const editor = () => page.locator('.tab-host:not([style*="none"])').getByLabel('Raw request');
    await expect.poll(() => editor().inputValue()).toContain('SAVE10');
    await editor().fill((await editor().inputValue()).replace('SAVE10', 'RECOVERME'));
    await navTo(page, 'Traffic', 'Requests');
    await page.locator('.row', { hasText: '/api/cart' }).first().click();
    await page.keyboard.press('Control+r');
    await expect.poll(() => editor().inputValue()).toContain('/api/cart');
    await editor().fill((await editor().inputValue()).replace('/api/cart', '/api/cart?edited=1'));
    const tabs = page.getByRole('tablist', { name: 'Open editors' });
    await expect.poll(() => tabs.locator('.dirty-dot').count()).toBe(2);
    // Discarding one leaves the other one's edits and mark alone.
    await page.getByRole('button', { name: 'Close replay cart' }).click();
    await page.getByRole('dialog', { name: /Close cart/ }).getByRole('button', { name: 'Discard and close' }).click();
    await expect.poll(() => tabs.locator('.dirty-dot').count()).toBe(1);
    await expect.poll(() => editor().inputValue()).toContain('RECOVERME');
    await expect.poll(() => page.getByTestId('workspace-status').textContent()).toContain('Drafts saved');
    await expect.poll(() => (h.core.workspace.get()?.docs as Array<{ recovered?: { raw: string } }> | undefined)?.some((d) => d.recovered?.raw.includes('RECOVERME'))).toBe(true);
    const sent = h.core.store.search('source:replay').length;

    // Restart the renderer: the draft is back, marked edited, and nothing was sent.
    await page.goto(h.pageUrl);
    await navTo(page, 'Replay', 'Open editors');
    await expect.poll(() => editor().inputValue()).toContain('RECOVERME');
    await expect.poll(() => page.getByTestId('workspace-status').textContent()).toContain('restored from last session');
    await expect.poll(() => tabs.locator('.dirty-dot').count()).toBe(1);
    expect(h.core.store.search('source:replay').length).toBe(sent);
    await shot('recovered-draft');
  });

  it('keeps a draft whose recorded exchange is gone, and says so', async () => {
    const id = h.core.store.search('path:/api/apply-coupon')[0]!.id;
    h.core.store.deleteExchanges([id]);
    await page.goto(h.pageUrl);
    await navTo(page, 'Replay', 'Open editors');
    const host = page.locator('.tab-host:not([style*="none"])');
    await expect.poll(() => host.getByTestId('missing-source').count()).toBe(1);
    expect(await host.getByLabel('Raw request').inputValue()).toContain('RECOVERME');
  });

  it('decodes inside the replay editor and stops writing if the request changed under it', async () => {
    await h.send('/api/blob-echo', 'POST', JSON.stringify({ blob: Buffer.from('{"inner":"value-1"}').toString('base64') }));
    await navTo(page, 'Traffic', 'Requests');
    await page.locator('.row', { hasText: '/api/blob-echo' }).first().click();
    await page.keyboard.press('Control+r');
    const host = page.locator('.tab-host:not([style*="none"])');
    const raw = host.getByLabel('Raw request');
    await expect.poll(() => raw.inputValue()).toContain('blob');
    await raw.evaluate((el) => {
      const t = el as HTMLTextAreaElement;
      const at = t.value.indexOf('eyJ');
      t.setSelectionRange(at, t.value.indexOf('"', at));
      return true;
    });
    await host.getByRole('button', { name: 'Open in Decode' }).click();
    const dec = host.getByLabel('Decoder');
    await expect.poll(() => dec.getByLabel('Decoded value').inputValue()).toContain('value-1');
    await dec.getByLabel('Decoded value').fill('{"inner":"value-2"}');
    await expect.poll(() => raw.inputValue()).toContain(Buffer.from('{"inner":"value-2"}').toString('base64'));
    // Someone edits that part of the request by hand: the decoder must not write over it.
    await raw.fill((await raw.inputValue()).replace(Buffer.from('{"inner":"value-2"}').toString('base64'), 'HANDEDITED'));
    await dec.getByLabel('Decoded value').fill('{"inner":"value-3"}');
    await expect.poll(() => page.locator('.toast').textContent()).toContain('stopped writing');
    expect(await raw.inputValue()).toContain('HANDEDITED');
    expect(await raw.inputValue()).not.toContain(Buffer.from('{"inner":"value-3"}').toString('base64'));
  });
  it('explains what changed an exchange, and suspends every override from one switch without turning any off', async () => {
    h.core.tools.setMocks(h.core.tools.mocks().map((m) => ({ ...m, enabled: true })));
    expect(await h.send('/api/pay', 'POST', '{}')).toBe(402);
    await navTo(page, 'Traffic', 'Requests');
    await page.locator('.row', { hasText: '/api/pay' }).first().click();
    const insp = page.getByLabel('Inspector', { exact: true });
    await insp.getByRole('tab', { name: 'What changed it' }).click();
    await expect.poll(() => insp.getByTestId('transform').textContent()).toContain('Checkout payment failure');
    expect(await insp.getByTestId('transform').textContent()).toContain('No upstream server response');
    await page.locator('.row', { hasText: '/api/cart' }).first().click();
    await insp.getByRole('tab', { name: 'What changed it' }).click();
    await expect.poll(() => insp.getByTestId('no-transforms').textContent()).toContain('No override matched');

    await navTo(page, 'Overrides', 'Active');
    await page.getByRole('switch', { name: 'Suspend all overrides' }).click();
    await expect.poll(() => h.core.tools.overrides.suspended).toBe(true);
    await expect.poll(() => page.getByTestId('overrides-suspended-chip').count()).toBe(1);
    expect(h.core.tools.mocks()[0]!.enabled).toBe(true);
    expect(await h.send('/api/pay', 'POST', '{}')).toBe(200);
    await shot('overrides-suspended');
    await page.getByRole('switch', { name: 'Resume all overrides' }).click();
    await expect.poll(() => page.getByTestId('overrides-suspended-chip').count()).toBe(0);
    expect(await h.send('/api/pay', 'POST', '{}')).toBe(402);
  });

  it('turns a group of overrides on and off together', async () => {
    h.core.tools.setMocks(h.core.tools.mocks().map((m) => ({ ...m, enabled: false })));
    await navTo(page, 'Overrides', 'Active');
    await expect.poll(() => page.getByTestId('override-summary').textContent()).toMatch(/configured, 0 on/);
    await page.getByRole('checkbox', { name: /Pick Mock Checkout payment failure/ }).check();
    await page.getByRole('checkbox', { name: /Pick Breakpoint/ }).check();
    await page.getByLabel('New group name').fill('Checkout outage');
    await page.getByRole('button', { name: /Group 2 picked/ }).click();
    const group = page.getByTestId('override-group');
    await expect.poll(() => group.textContent()).toContain('all off');
    await group.getByRole('button', { name: 'Turn on' }).click();
    await expect.poll(() => [h.core.tools.mocks()[0]!.enabled, h.core.tools.breakpoints()[0]!.enabled]).toEqual([true, true]);
    await expect.poll(() => group.textContent()).toContain('all on');
    await group.getByRole('button', { name: 'Turn off' }).click();
    await expect.poll(() => [h.core.tools.mocks()[0]!.enabled, h.core.tools.breakpoints()[0]!.enabled]).toEqual([false, false]);
  });

  it('opens an endpoint as a document with its calls, contract state and related overrides', async () => {
    await navTo(page, 'Explore API', 'Endpoints');
    await page.locator('.coverage-table tr', { hasText: '/api/cart' }).first().getByRole('button', { name: 'Details' }).click();
    await expect.poll(() => page.getByRole('tablist', { name: 'Open editors' }).textContent()).toContain('Endpoint:');
    const doc = page.locator('.tab-host:not([style*="none"])').getByTestId('endpoint-doc');
    await expect.poll(() => doc.getByTestId('endpoint-observed').textContent()).toContain('calls');
    expect(await doc.textContent()).toContain('No documented operation');
    await doc.getByRole('tab', { name: /Related work/ }).click();
    await expect.poll(() => doc.getByTestId('endpoint-related-item').textContent()).toContain('Pause request');
    await doc.getByRole('tab', { name: 'Traffic' }).click();
    await expect.poll(() => doc.getByTestId('endpoint-call').count()).toBeGreaterThan(0);
    await shot('endpoint');
    // The same document opens from a request's menu.
    await navTo(page, 'Traffic', 'Requests');
    await page.locator('.row', { hasText: '/api/cart' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Explore endpoint' }).click();
    await expect.poll(() => selectedTab('Replay')).toContain('Open editors');
    expect((await page.getByRole('tablist', { name: 'Open editors' }).textContent())!.match(/Endpoint:/g)).toHaveLength(1);
  });
  it('saves a request as a reproduction, reruns it with checks and a session profile, and keeps the revision each run used', async () => {
    await navTo(page, 'Traffic', 'Requests');
    await page.locator('.row', { hasText: '/api/cart' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Save as reproduction' }).click();
    await expect.poll(() => page.locator('.toast').textContent()).toContain('Saved as');
    await navTo(page, 'Replay', 'Saved');
    const detail = page.getByTestId('repro-detail');
    await expect.poll(() => page.getByTestId('repro-item').count()).toBe(1);
    await detail.getByLabel('Check kind').selectOption('json');
    await detail.getByLabel('Check JSONPath').fill('$.method');
    await detail.getByLabel('Check value').fill('GET');
    await detail.getByRole('button', { name: 'Add check' }).click();
    await expect.poll(() => detail.getByTestId('repro-check').count()).toBe(1);
    await detail.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(() => detail.getByTestId('repro-run').evaluate((el) => el.getAttribute('data-state') ?? '')).toBe('passed');

    // Edit it in the editor: the save is a new revision of the same reproduction.
    await detail.getByRole('button', { name: 'Open in editor' }).click();
    const editor = page.locator('.tab-host:not([style*="none"])').getByLabel('Raw request');
    await expect.poll(() => editor.inputValue()).toContain('/api/cart');
    await editor.fill((await editor.inputValue()).replace('/api/cart', '/api/cart?c={{var:code}}'));
    await page.locator('.tab-host:not([style*="none"])').getByRole('button', { name: 'Save (rev 3)' }).click();
    await expect.poll(() => page.locator('.toast').textContent()).toContain('revision 3');

    // A session profile supplies the value, and the summary says where it came from before running.
    await navTo(page, 'Project settings', 'Session and authentication');
    await page.getByRole('tablist', { name: 'Session and authentication' }).getByRole('tab', { name: 'Profiles' }).click();
    await page.getByRole('button', { name: 'Add profile' }).click();
    await page.getByLabel('Profile name').fill('staging');
    await page.getByLabel('Profile values').fill('code=PROFILE');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => h.core.tools.repros.profiles().map((p) => p.name)).toEqual(['staging']);
    await navTo(page, 'Replay', 'Saved');
    await detail.getByLabel('Session profile').selectOption('staging');
    await expect.poll(() => detail.getByTestId('repro-session').textContent()).toContain('Profile staging');
    await expect.poll(() => detail.getByTestId('repro-input').textContent()).toContain('profile');
    await detail.getByLabel('Check kind').selectOption('body');
    await detail.getByLabel('Check value').fill('PROFILE');
    await detail.getByRole('button', { name: 'Add check' }).click();
    await expect.poll(() => detail.getByTestId('repro-check').count()).toBe(2);
    await detail.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(() => detail.getByTestId('repro-run').count()).toBe(2);
    expect(await detail.getByTestId('repro-run').first().evaluate((el) => el.getAttribute('data-state') ?? '')).toBe('passed');
    expect(await detail.getByTestId('repro-run').nth(1).textContent()).toContain('(older)');
    expect(h.core.tools.repros.runs().map((r) => [r.revision, r.profile ?? null])).toEqual([
      [2, null],
      [4, 'staging'],
    ]);
    await shot('saved-reproductions');
  });
});
