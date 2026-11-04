import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { H3Server, leafIssuer, readRuntimeInfo } from '@siteinquisition/core';
import { DIST, startHarness, type Harness } from './harness';

// The power tools, driven through the built renderer against a real core.
const SHOTS = process.env.SIQ_SCREENSHOTS;
const ready = findChromium() !== null && existsSync(join(DIST, 'index.html'));

describe.skipIf(!ready)('power tools in the renderer', () => {
  let h: Harness;
  let browser: Browser;
  let page: Page;

  const shot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const nav = (name: string) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name, exact: false }).first().click();

  beforeAll(async () => {
    h = await startHarness();
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

  it('decodes the selected response with Ctrl D and edits it with JSONPath', async () => {
    await page.locator('.row', { hasText: '/api/apply-coupon' }).click();
    await page.locator('body').click({ position: { x: 700, y: 20 } }); // drop focus from inputs
    await page.keyboard.press('Control+d');
    const input = page.getByLabel('Codec input');
    await expect.poll(() => input.inputValue()).toContain('apply-coupon');
    await expect.poll(() => page.getByLabel('Codec chain').locator('.chain-step').allTextContents()).toEqual(['json']);
    await expect.poll(() => page.getByLabel('JSON tree').textContent()).toContain('method');
    await page.getByLabel('JSON tree').getByRole('button', { name: 'method', exact: true }).click();
    expect(await page.getByLabel('JSONPath').inputValue()).toBe('$.method');
    await page.getByLabel('Bulk value').fill('"PUT"');
    await page.getByRole('button', { name: 'Apply to all' }).click();
    await page.getByRole('button', { name: 'Encode', exact: true }).click();
    await expect.poll(() => page.getByLabel('Encoded result').textContent()).toContain('"method":"PUT"');
    await page.getByLabel('Find', { exact: true }).fill('coupon');
    await expect.poll(() => page.getByTestId('replace-count').textContent()).toBe('1 match');
    await shot('codecs');
  });

  it('previews tokens in replay and sends one request per counter value', async () => {
    await nav('History');
    await page.locator('.row', { hasText: '/api/cart' }).first().click();
    await page.keyboard.press('Control+r');
    const editor = page.getByLabel('Raw request');
    await expect.poll(() => editor.inputValue()).toContain('/api/cart');
    await editor.fill((await editor.inputValue()).replace('/api/cart', '/api/cart?page={{counter:1..3}}'));
    await expect.poll(() => page.getByTestId('token-preview').textContent()).toContain('3 sends, first is');
    expect(await page.getByTestId('token-preview').textContent()).toContain('page=1');
    await page.getByLabel('Fresh cookies').check();
    await shot('replay-tokens');
    await page.getByRole('button', { name: 'Send 3' }).click();
    await expect.poll(() => page.locator('.toast').textContent()).toContain('Sent 3 of 3');
    const sent = h.core.store.search('source:replay path:/api/cart?page=');
    expect(sent.map((e) => e.path).sort()).toEqual(['/api/cart?page=1', '/api/cart?page=2', '/api/cart?page=3']);
    expect(sent[0]!.tags).toEqual(expect.arrayContaining(['cookies from jar']));
  });

  it('shows endpoint coverage with parameters, and links back to the calls', async () => {
    await page.getByRole('tab', { name: 'History' }).click();
    await page.getByRole('group', { name: 'History mode' }).getByRole('button', { name: 'Coverage' }).click();
    const table = page.locator('.coverage-table');
    await expect.poll(() => table.textContent()).toContain('/api/apply-coupon');
    const post = table.locator('tr', { hasText: '/api/apply-coupon' });
    expect(await post.textContent()).toContain('cart, code');
    expect(await table.locator('tr', { hasText: '/api/cart' }).first().textContent()).toContain('?page');
    await shot('coverage');
    await post.getByRole('button', { name: 'Calls' }).click();
    await expect.poll(() => page.locator('#filter-input').inputValue()).toContain('method:POST path:/api/apply-coupon');
    await expect.poll(() => page.locator('.vlist .row').count()).toBe(1);
    await page.locator('#filter-input').fill('');
  });

  it('adds a match and replace rule, tests it on the selected exchange, and applies it live', async () => {
    await page.locator('.row', { hasText: '/api/cart' }).first().click();
    await nav('Rules');
    await page.getByRole('tab', { name: 'Match and replace' }).click();
    await page.getByRole('button', { name: 'Add rule' }).click();
    const card = page.locator('.rule-card').first();
    await card.getByLabel('Rule name').fill('tag-requests');
    await card.getByLabel('Header').fill('X-Tested');
    await card.getByLabel('Replace with').fill('yes');
    await card.getByRole('button', { name: 'Test on selected' }).click();
    await expect.poll(() => card.locator('.rule-test').textContent()).toContain('1 change');
    expect(await card.locator('.diff-add').first().textContent()).toContain('X-Tested: yes');
    await shot('rules-replace');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => h.core.tools.replaceRules().length).toBe(1);
    await h.send('/api/ruled');
    await expect.poll(() => h.core.store.search('path:/api/ruled')[0]?.tags ?? []).toContain('rule:tag-requests');
    h.core.tools.setReplaceRules([]);
  });

  it('pauses at a breakpoint, shows it in the title bar, and forwards an edit', async () => {
    h.core.tools.setBreakpoints([{ phase: 'request', pathPrefix: '/api/hold' }]);
    const status = h.send('/api/hold', 'POST', '{"qty":1}');
    await expect.poll(() => page.getByTestId('paused-chip').count()).toBe(1);
    await nav('History');
    await page.getByTestId('paused-chip').click();
    const msg = page.getByLabel('Paused message');
    await expect.poll(() => msg.inputValue()).toContain('"qty":1');
    await msg.fill((await msg.inputValue()).replace('"qty":1', '"qty":5'));
    await shot('breakpoint');
    await page.getByLabel('Paused traffic').getByRole('button', { name: 'Forward', exact: true }).click();
    expect(await status).toBe(200);
    await expect.poll(() => page.getByTestId('paused-chip').count()).toBe(0);
    const [ex] = h.core.store.search('path:/api/hold');
    expect(Buffer.from(h.core.store.getBody(ex!.id, 'response', true)!).toString()).toContain('qty\\":5');
    h.core.tools.setBreakpoints([]);
  });

  it('asks before an agent writes, from a chip in the title bar', async () => {
    const info = readRuntimeInfo(h.core.projectDir)!;
    const [ex] = h.core.store.search('path:/api/cart');
    const call = fetch(`http://127.0.0.1:${info.apiPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'tag_exchange', arguments: { id: ex!.id, tags: ['checked-by-agent'] } } }),
    }).then((r) => r.json());
    await expect.poll(() => page.getByTestId('approval-chip').count()).toBe(1);
    await page.getByTestId('approval-chip').click();
    await shot('mcp-approval');
    await page.getByRole('button', { name: 'Approve once' }).click();
    expect(((await call) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    expect(h.core.store.getSummary(ex!.id)!.tags).toEqual(['checked-by-agent']);
    await expect.poll(() => page.getByTestId('approval-chip').count()).toBe(0);
  });

  it('races the selected request ten times over', async () => {
    await nav('History');
    await page.locator('.row', { hasText: '/api/apply-coupon' }).first().click();
    await page.locator('body').click({ position: { x: 700, y: 20 } });
    await page.keyboard.press('Control+Shift+R');
    await expect.poll(() => page.locator('.race-item').count()).toBe(1);
    await page.getByRole('button', { name: '×10' }).click();
    await page.locator('.race .btn.primary').click();
    await expect.poll(() => page.getByLabel('Race results').locator('tbody tr').count(), { timeout: 15_000 }).toBe(10);
    await shot('race');
    expect(await page.getByLabel('Race results').textContent()).toContain('all 200');
  });

  it('runs an HTTP/3 stream plan with the single-datagram gate', async () => {
    // An HTTP/3 server on the upstream's port number (UDP), so captured URLs work as https.
    const issuer = leafIssuer(h.core.ca);
    const leaf = issuer.issue('127.0.0.1');
    const arrivals: number[] = [];
    const h3 = new H3Server({ cert: leaf.cert, key: leaf.key }, async (req) => {
      await req.body();
      arrivals.push(performance.now());
      req.respond(200, [['content-type', 'application/json']], '{"ok":true}');
    });
    await h3.listen(h.upstreamPort, '127.0.0.1');
    try {
      await nav('History');
      await page.locator('.row', { hasText: '/api/apply-coupon' }).first().click();
      await nav('HTTP/3');
      await page.getByRole('button', { name: 'Add selected request' }).click();
      await expect.poll(() => page.locator('.h3-item').count()).toBe(1);
      await page.getByRole('button', { name: '×10' }).click();
      await page.getByRole('group', { name: 'Presets' }).getByRole('button', { name: 'Single-datagram race' }).click();
      await page.locator('.h3lab .replay-bar').getByText('Ignore TLS errors').click();
      await page.locator('.h3lab .btn.primary').click();
      const results = page.getByLabel('HTTP/3 results');
      await expect.poll(() => results.locator('tbody tr').count(), { timeout: 15_000 }).toBe(10);
      expect(await results.textContent()).toContain('all 200');
      expect(await results.textContent()).toContain('gate released in 1 datagram');
      expect(Math.max(...arrivals) - Math.min(...arrivals)).toBeLessThan(50);
      await results.getByRole('button', { name: /Packet log/ }).click();
      await shot('h3lab');
    } finally {
      await h3.close();
    }
  });

  it('opens a WebSocket replay connection and sends a frame from the composer', async () => {
    const { exchangeId } = await h.core.tools.ws.connect({ url: `ws://127.0.0.1:${h.upstreamPort}/live`, headers: [] });
    await nav('Streams');
    await page.locator('.streams .saved-view').first().click();
    await page.getByLabel('Message payload').fill('hello');
    await page.getByRole('button', { name: 'Send frame' }).click();
    await expect.poll(() => page.locator('.msg-table').textContent()).toContain('echo hello');
    await shot('streams');
    h.core.tools.ws.close(exchangeId);
  });

  it('builds a fragmented frame plan, edits a frame and sends it', async () => {
    const { exchangeId } = await h.core.tools.ws.connect({ url: `ws://127.0.0.1:${h.upstreamPort}/frames`, headers: [] });
    await nav('Streams');
    await page.locator('.streams .saved-view', { hasText: '/frames' }).click();
    await page.getByRole('group', { name: 'Composer mode' }).getByRole('button', { name: 'Frames' }).click();
    await page.getByLabel('Message payload').fill('abcdef');
    await page.getByLabel('Frame preset').selectOption('fragment');
    await page.getByRole('button', { name: 'Build frames' }).click();
    const rows = page.locator('.frame-table tbody tr');
    await expect.poll(() => rows.count()).toBe(3);
    expect(await page.getByLabel('Opcode of step 2').inputValue()).toBe('continuation');
    expect(await page.getByLabel('FIN of step 3').isChecked()).toBe(true);
    // A ping in the middle of the message is legal; the server still reassembles it.
    await page.getByRole('button', { name: 'Add ping' }).click();
    await page.getByLabel('Move step 4 up').click();
    await page.getByLabel('Move step 3 up').click();
    await page.getByRole('button', { name: 'Send 4 steps' }).click();
    await expect.poll(() => page.locator('.msg-table:not(.frame-table)').textContent(), { timeout: 10_000 }).toContain('echo abcdef');
    await shot('frames');
    const sent = h.core.store.getStreamMessages(h.core.store.getStreamForExchange(exchangeId)!.id).filter((m) => m.direction === 'client');
    expect(sent.map((m) => m.opcode)).toEqual(['text', 'ping', 'continuation', 'continuation']);
    h.core.tools.ws.close(exchangeId);
  });

  it('runs a line in the scripts console', async () => {
    await nav('Scripts');
    const input = page.getByLabel('Console input');
    await input.fill("siq.search('path:/api/', 50).length > 3");
    await input.press('Enter');
    await expect.poll(() => page.locator('.console-log').textContent()).toContain('true');
    await shot('scripts');
  });
});
