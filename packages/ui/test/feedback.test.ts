import { existsSync, mkdirSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { placeMenu } from '../src/components/placement';
import { generateSelfSigned } from '../../core/src/x509';
import { DIST, navTo, startHarness, type Harness } from './harness';

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
  const nav = (name: string, sub?: string) => navTo(page, name, sub);
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
    await nav('Explore API', 'Fields');
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
    await nav('Explore API', 'Fields');
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
    // The field reads decoded in place, marked as a decoded region.
    await expect.poll(() => page.locator('.inspector .decoded.by-rule').first().textContent()).toContain('inner-value');
    await shot('field-codecs-inspector');

    // Replay opens a request body with the field decoded and encodes it again on send.
    const b64 = Buffer.from(JSON.stringify({ secret: 'sent-value' })).toString('base64');
    await h.send('/api/blob-echo', 'POST', JSON.stringify({ blob: b64 }));
    await page.locator('.row', { hasText: '/api/blob-echo' }).first().click();
    await page.keyboard.press('Control+r');
    const tab = page.locator('.tab-host').last();
    const editor = tab.getByLabel('Raw request');
    await expect.poll(() => editor.inputValue()).toContain('"secret": "sent-value"');
    await expect.poll(() => tab.locator('.region-backdrop .decoded').first().textContent()).toContain('sent-value');
    await editor.fill((await editor.inputValue()).replace('sent-value', 'edited-value'));
    await tab.getByRole('button', { name: /^Send$/ }).first().click();
    await expect.poll(() => h.core.store.search('path:/api/blob-echo').some((e) => e.replayOf && e.state === 'complete')).toBe(true);
    const sent = h.core.store.search('path:/api/blob-echo').find((e) => e.replayOf)!;
    const body = JSON.parse(new TextDecoder().decode(h.core.store.getBody(sent.id, 'request', true)!)) as { blob: string };
    expect(JSON.parse(Buffer.from(body.blob, 'base64').toString())).toEqual({ secret: 'edited-value' });
  });

  it('decodes a nested value all the way down in Codecs and writes edits back to Replay as you type', async () => {
    // Url-encoded base64 JSON, with a JSON string field inside it.
    const value = 'eyJkZXNjcmlwdGlvbiI6InR1cmR1Y2tlbiBwYXlsb2FkIiwiaW5uZXJfZGF0YSI6IntcIm1lYXRcIjogXCJ0dXJrZXlcIiwgXCJzdHVmZmluZ1wiOiBcImR1Y2sgYW5kIGNoaWNrZW5cIn0ifQ%3D%3D';
    await h.send('/api/turducken', 'POST', value);
    await nav('History');
    await page.locator('.row', { hasText: '/api/turducken' }).first().click();
    await page.keyboard.press('Control+r');
    const tab = page.locator('.tab-host').last();
    await expect.poll(() => tab.getByLabel('Raw request').inputValue()).toContain(value);
    await tab.getByRole('button', { name: 'Open in Decode' }).click();

    await expect.poll(() => page.getByLabel('Codec chain').locator('.chain-step').allTextContents()).toEqual(['url›', 'base64›', 'json']);
    await expect.poll(() => page.getByTestId('nested-field').allTextContents()).toEqual([expect.stringContaining('$.inner_data')]);
    const editor = page.getByLabel('Decoded value');
    await expect.poll(() => editor.inputValue()).toContain('"meat": "turkey"');
    // Untouched, the result is the input as it was.
    expect(await page.getByLabel('Encoded result').textContent()).toBe(value);
    await shot('codecs-nested');

    await editor.fill((await editor.inputValue()).replace('turkey', 'tofu'));
    const decode = (t: string) => {
      const outer = JSON.parse(Buffer.from(decodeURIComponent(t), 'base64').toString()) as { inner_data: string };
      return JSON.parse(outer.inner_data) as { meat: string };
    };
    await expect.poll(async () => decode((await page.getByLabel('Encoded result').textContent())!).meat).toBe('tofu');
    const result = (await page.getByLabel('Encoded result').textContent())!;
    // No put back step: Replay already has it.
    await expect.poll(() => tab.getByLabel('Raw request').inputValue()).toContain(result);
    expect(await tab.getByLabel('Raw request').inputValue()).not.toContain(value);
    await page.getByRole('button', { name: /^Back to Replay/ }).click();
    await expect.poll(() => tab.evaluate((el) => (el as HTMLElement).style.display)).toBe('flex');
  });

  it('shows every nested layer in the chain, and can keep one encoded', async () => {
    // Three turduckens deep: JSON strings and base64 of JSON, inside url-encoded base64 JSON.
    const value = 'eyJkZXNjcmlwdGlvbiI6InR1cmR1Y2tlbiBwYXlsb2FkIiwiaW5uZXJfZGF0YSI6IntcIm1lYXRcIjpcInR1cmtleVwiLFwic3R1ZmZpbmdcIjpcImV5SmtaWE5qY21sd2RHbHZiaUk2SW5SMWNtUjFZMnRsYmlCd1lYbHNiMkZrTWlJc0ltbHVibVZ5WDJSaGRHRWlPaUo3WENKdFpXRjBYQ0k2WENKa2RXTnJYQ0lzWENKemRIVm1abWx1WjF3aU9sd2laWGxLYTFwWVRtcGpiV3gzWkVkc2RtSnBTVFpKYmxJeFkyMVNNVmt5ZEd4aWFVSjNXVmhzYzJJeVJtdE5lVWx6U1cxc2RXSnRWbmxZTWxKb1pFZEZhVTlwU2pkWVEwcDBXbGRHTUZoRFNUWllRMHBxWVVkc2FtRXlWblZZUTBseldFTktlbVJJVm0xYWJXeDFXakYzYVU5c2QybFlRMG81U1c0d1BWd2lmU0o5XCJ9In0%3D';
    await nav('Codecs');
    await page.getByRole('button', { name: 'Clear' }).click();
    await page.getByLabel('Codec input').fill(value);
    await page.getByRole('button', { name: 'Detect layers' }).click();
    await expect.poll(() => page.getByLabel('Codec chain').locator('.chain-step').allTextContents()).toEqual(['url›', 'base64›', 'json']);
    const layers = page.getByTestId('nested-field');
    await expect.poll(() => layers.count()).toBe(5);
    const rows = await layers.allTextContents();
    // Each layer reads as the part of the path below its parent, with the full path on hover.
    expect(rows[0]).toContain('$.inner_data');
    expect(rows[1]).toContain('.stuffing');
    expect(rows[1]).toContain('base64');
    expect(await layers.nth(4).locator('.nested-path').evaluate((el) => el.getAttribute('title'))).toBe('$.inner_data.stuffing.inner_data.stuffing.inner_data');
    await expect.poll(() => page.getByLabel('Decoded value').inputValue()).toContain('"meat": "chicken"');
    await shot('codecs-nested-chain');
    // Keeping the second layer encoded folds away everything inside it, and the result is still the input.
    await layers.nth(1).getByRole('button', { name: 'keep encoded' }).click();
    await expect.poll(() => layers.count()).toBe(1);
    expect(await page.getByLabel('Decoded value').inputValue()).not.toContain('chicken');
    expect(await page.getByLabel('Encoded result').textContent()).toBe(value);
  });

  it('builds a body search, then highlights and scrolls to the match in a large request', async () => {
    const filler = Array.from({ length: 600 }, (_, i) => `line ${i} of filler text`).join('\n');
    await h.send('/api/search-big', 'POST', `${filler}\nthe NEEDLE-4242 is here\n${filler}`);
    await nav('History');
    await page.getByRole('button', { name: /Build search/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Build a search' });
    await dialog.waitFor();
    await dialog.getByLabel('Condition 1 where').selectOption('reqbody');
    await dialog.getByLabel('Condition 1 value').fill('needle-42');
    await expect.poll(() => page.getByTestId('qb-text').textContent()).toBe('reqbody:needle-42');
    await expect.poll(() => page.getByTestId('qb-count').textContent()).toBe('1 request matches');
    expect(await inViewport('.query-builder')).toBe(true);
    await shot('query-builder');
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
    expect(await page.locator('#filter-input').inputValue()).toBe('reqbody:needle-42');
    await expect.poll(() => page.locator('.row').count()).toBe(1);

    await page.locator('.row').first().click();
    const bar = page.getByTestId('hit-bar');
    await expect.poll(() => bar.textContent()).toContain('Match 1 of 1');
    // Only the request body is marked, though the response echoes the same text.
    expect(await page.locator('.inspector mark.hit').count()).toBe(1);
    expect(await page.locator('.inspector mark.hit.current').textContent()).toBe('NEEDLE-42');
    await expect.poll(() => inViewport('.inspector mark.hit.current')).toBe(true);
    await shot('search-highlight');

    // Plain text looks everywhere, and Next steps through each place.
    await page.locator('#filter-input').fill('needle-4242');
    await page.locator('#filter-input').press('Enter');
    await page.locator('.row').first().click();
    await expect.poll(() => bar.textContent()).toContain('of 2');
    await bar.getByRole('button', { name: 'Next match' }).click();
    await expect.poll(() => bar.textContent()).toContain('Match 2 of 2');
    await expect.poll(() => inViewport('.inspector mark.hit.current')).toBe(true);
    await page.locator('#filter-input').fill('');
    await page.locator('#filter-input').press('Enter');
  });

  it('searches JSON fields by JSONPath, inside an encoded payload, with Replay tokens for values', async () => {
    const payload = Buffer.from(JSON.stringify({ some_value: 'gravy-42', user: 'nick' })).toString('base64');
    await h.send('/api/event', 'POST', JSON.stringify({ payload }));
    const ev = h.core.store.search('path:/api/event')[0]!;
    h.core.store.tagExchange(ev.id, ['evt']);
    h.core.tools.vars.set('wanted', 'gravy-42');
    await nav('History');
    const filter = page.locator('#filter-input');
    await filter.fill("reqjson:\"$.payload['some_value']={{var:wanted}}\"");
    await filter.press('Enter');
    await expect.poll(() => page.locator('.row').allTextContents()).toEqual([expect.stringContaining('/api/event')]);
    // A bare path, and a tag reference: {{$evt.payload}} is the payload this request sent.
    await filter.fill('$.payload.user=nick');
    await filter.press('Enter');
    await expect.poll(() => page.locator('.row').count()).toBe(1);
    await filter.fill('reqbody:{{$evt.payload}}');
    await filter.press('Enter');
    await expect.poll(() => page.locator('.row').count()).toBe(1);

    // The builder offers JSON fields, and reads a bare path back as one.
    await filter.fill("$.payload['some_value']=gravy-42");
    await page.getByRole('button', { name: /Build search/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Build a search' });
    expect(await dialog.getByLabel('Condition 1 where').inputValue()).toBe('json');
    await expect.poll(() => page.getByTestId('qb-count').textContent()).toBe('1 request matches');
    await dialog.getByLabel('Condition 1 where').selectOption('resjson');
    await expect.poll(() => page.getByTestId('qb-count').textContent()).toBe('0 requests match');
    await shot('query-builder-json');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await filter.fill('');
    await filter.press('Enter');
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
