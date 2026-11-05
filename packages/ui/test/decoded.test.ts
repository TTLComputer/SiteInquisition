import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { DIST, startHarness, type Harness } from './harness';

// Decoding a selected region in place, in read-only views and in editors.
const SHOTS = process.env.SIQ_SCREENSHOTS;
const ready = findChromium() !== null && existsSync(join(DIST, 'index.html'));

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const JWT = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"nick","role":"tester"}').toString('base64url')}.c2lnbmF0dXJl`;

describe.skipIf(!ready)('Decoded regions in the renderer', () => {
  let h: Harness;
  let browser: Browser;
  let page: Page;

  const shot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const nav = (name: string) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name, exact: false }).first().click();
  /** Select the first place `needle` appears inside a decodable zone, the way a mouse drag would. */
  const select = (zone: string, needle: string) =>
    page.evaluate(
      ([z, n]) => {
        const doc = (globalThis as any).document;
        const root = doc.querySelector(`[aria-label="${z}"]`);
        if (!root) return false;
        const walker = doc.createTreeWalker(root, 4);
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
          const i = (t.textContent as string).indexOf(n);
          if (i < 0) continue;
          const r = doc.createRange();
          r.setStart(t, i);
          r.setEnd(t, i + n.length);
          const s = (globalThis as any).getSelection();
          s.removeAllRanges();
          s.addRange(r);
          doc.dispatchEvent(new (globalThis as any).MouseEvent('mouseup', { bubbles: true }));
          return true;
        }
        return false;
      },
      [zone, needle],
    );
  /** Click on the first place `needle` appears inside a zone, as a person would. */
  const clickText = async (zone: string, needle: string) => {
    const at = await page.evaluate(
      ([z, n]) => {
        const doc = (globalThis as any).document;
        const walker = doc.createTreeWalker(doc.querySelector(`[aria-label="${z}"]`), 4);
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
          const i = (t.textContent as string).indexOf(n);
          if (i < 0) continue;
          const r = doc.createRange();
          r.setStart(t, i);
          r.setEnd(t, i + n.length);
          const b = r.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }
        return null;
      },
      [zone, needle],
    );
    await page.mouse.click(at!.x, at!.y);
  };
  /** Put the caret (or a selection) in a textarea. */
  const caret = (label: string, needle: string, offset = 1, length = 0) =>
    page.evaluate(
      ([l, n, o, len]) => {
        const ta = (globalThis as any).document.querySelector(`textarea[aria-label="${l}"]`);
        const i = (ta.value as string).indexOf(n as string) + (o as number);
        ta.focus();
        ta.setSelectionRange(i, i + (len as number));
        return i;
      },
      [label, needle, offset, length],
    );

  beforeAll(async () => {
    h = await startHarness();
    await h.send('/api/blob');
    await h.send('/api/me', 'GET', undefined, { authorization: `Bearer ${JWT}` });
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
  });

  it('decodes a selected value in the Inspector in place, in its own style', async () => {
    await page.locator('.row', { hasText: '/api/blob' }).first().click();
    const blob = b64({ secret: 'inner-value', level: 3 });
    await expect.poll(() => page.getByLabel('Response body', { exact: true }).textContent()).toContain(blob);
    expect(await select('Response body', blob)).toBe(true);
    const chip = page.getByRole('toolbar', { name: 'Decode selection' });
    // The chip says what it found before you click.
    await expect.poll(() => chip.getByRole('button', { name: /^Decode/ }).first().textContent()).toContain('base64 › json');
    await shot('decode-chip');
    await chip.getByRole('button', { name: /^Decode/ }).first().click();
    const region = page.getByLabel('Response body', { exact: true }).locator('.decoded');
    await expect.poll(() => region.textContent()).toContain('"secret": "inner-value"');
    expect(await page.getByLabel('Response body', { exact: true }).textContent()).not.toContain(blob);
    // Heavier type marks it as decoded.
    expect(await region.evaluate((el) => (globalThis as any).getComputedStyle(el).fontWeight)).toBe('600');
    await shot('decode-inline-inspector');

    // Shown again when you come back to the exchange.
    await page.locator('.row', { hasText: '/api/cart' }).first().click();
    await page.locator('.row', { hasText: '/api/blob' }).first().click();
    await expect.poll(() => page.getByLabel('Response body', { exact: true }).locator('.decoded').count()).toBe(1);
  });

  it('saves a decoded field so it is decoded every time, and can stop', async () => {
    await clickText('Response body', 'inner-value');
    const menu = page.getByRole('menu', { name: 'Decoded region' });
    await menu.waitFor();
    await shot('decode-region-menu');
    await menu.getByRole('menuitem', { name: 'Always decode' }).click();
    await expect.poll(() => h.core.tools.fieldCodecs.list().map((r) => [r.field, r.chain.join('>'), r.host, r.side])).toEqual([['$.blob', 'base64>json', '127.0.0.1', 'response']]);
    await expect.poll(() => page.getByLabel('Response body', { exact: true }).locator('.decoded.by-rule').count()).toBe(1);
    await expect.poll(() => page.locator('.toast').count(), { timeout: 6000 }).toBe(0);

    await clickText('Response body', 'inner-value');
    await page.getByRole('menu', { name: 'Decoded region' }).getByRole('menuitem', { name: 'Stop always decoding' }).click();
    await expect.poll(() => h.core.tools.fieldCodecs.list().length).toBe(0);
    await expect.poll(() => page.locator('.toast').count(), { timeout: 6000 }).toBe(0);

    // "Show encoded" puts the value back as it was.
    await clickText('Response body', 'inner-value');
    await page.getByRole('menu', { name: 'Decoded region' }).getByRole('menuitem', { name: 'Show encoded' }).click();
    await expect.poll(() => page.getByLabel('Response body', { exact: true }).locator('.decoded').count()).toBe(0);
    expect(await page.getByLabel('Response body', { exact: true }).textContent()).toContain(b64({ secret: 'inner-value', level: 3 }));
  });

  it('decodes a header value with Ctrl D', async () => {
    await page.locator('.row', { hasText: '/api/me' }).first().click();
    await expect.poll(() => page.getByLabel('Request headers', { exact: true }).textContent()).toContain(JWT);
    await select('Request headers', JWT);
    await page.keyboard.press('Control+d');
    await expect.poll(() => page.getByLabel('Request headers', { exact: true }).locator('.decoded').textContent()).toContain('"role": "tester"');
    // Ctrl D on a selection decodes in place; it did not open Codecs.
    expect(await page.locator('.tab-host:not([style*="none"]) [aria-label="Codec input"]').count()).toBe(0);
  });

  it('decodes in the Replay editor and encodes again on send, tokens included', async () => {
    const body = JSON.stringify({ blob: b64({ secret: 'sent-value', n: 1 }), keep: 'as-is' });
    await h.send('/api/blob-echo', 'POST', body);
    await nav('History');
    await page.locator('.row', { hasText: '/api/blob-echo' }).first().click();
    await page.keyboard.press('Control+r');
    const tab = page.locator('.tab-host').last();
    const editor = tab.getByLabel('Raw request');
    await expect.poll(() => editor.inputValue()).toContain('"keep":"as-is"');
    // Caret anywhere in the value: Ctrl D takes the whole string.
    await caret('Raw request', b64({ secret: 'sent-value', n: 1 }), 5);
    await page.keyboard.press('Control+d');
    await expect.poll(() => editor.inputValue()).toContain('"secret": "sent-value"');
    await expect.poll(() => tab.locator('.region-backdrop .decoded').count()).toBe(1);
    await caret('Raw request', '"sent-value"', 2);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => tab.getByRole('toolbar', { name: 'Decoded region' }).textContent()).toContain('base64 › json');
    await shot('decode-inline-replay');

    await editor.fill((await editor.inputValue()).replace('sent-value', 'id-{{counter:1..1}}'));
    await tab.getByRole('button', { name: /^Send/ }).first().click();
    await expect.poll(() => h.core.store.search('path:/api/blob-echo').some((e) => e.replayOf && e.state === 'complete')).toBe(true);
    const sent = h.core.store.search('path:/api/blob-echo').find((e) => e.replayOf)!;
    const wire = JSON.parse(new TextDecoder().decode(h.core.store.getBody(sent.id, 'request', true)!)) as { blob: string; keep: string };
    expect(JSON.parse(Buffer.from(wire.blob, 'base64').toString())).toEqual({ secret: 'id-1', n: 1 });
    expect(wire.keep).toBe('as-is');
  });

  it('decodes part of a WebSocket message in WS Replay and sends it encoded', async () => {
    const token = b64({ user: 'nick', room: 'lobby' });
    const { exchangeId } = await h.core.tools.ws.connect({ url: `ws://127.0.0.1:${h.upstreamPort}/auth`, headers: [] });
    h.core.tools.ws.send(exchangeId, Buffer.from(JSON.stringify({ type: 'auth', token })), 'text');
    await new Promise((r) => setTimeout(r, 300));
    h.core.tools.ws.close(exchangeId);
    await nav('History');
    await page.locator('.row', { hasText: '/auth' }).first().click();
    await page.getByLabel('Inspector').getByRole('button', { name: 'Send to Replay' }).click();
    await expect.poll(() => page.getByLabel('Message 1').inputValue()).toContain(token);
    await caret('Message 1', token, 3);
    await page.keyboard.press('Control+d');
    await expect.poll(() => page.getByLabel('Message 1').inputValue()).toContain('"user": "nick"');
    await page.getByLabel('Message 1').fill((await page.getByLabel('Message 1').inputValue()).replace('"nick"', '"ada"'));
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const run = () => h.core.store.search(`replayof:${exchangeId}`)[0];
    await expect.poll(() => !!run(), { timeout: 10_000 }).toBe(true);
    const sentText = () =>
      h.core.store
        .getStreamMessages(h.core.store.getStreamForExchange(run()!.id)?.id ?? '')
        .filter((m) => m.direction === 'client' && m.opcode === 'text')
        .map((m) => Buffer.from(m.payload).toString());
    await expect.poll(() => sentText().length, { timeout: 10_000 }).toBeGreaterThan(0);
    const msg = JSON.parse(sentText()[0]!) as { type: string; token: string };
    expect(JSON.parse(Buffer.from(msg.token, 'base64').toString())).toEqual({ user: 'ada', room: 'lobby' });
  });

  it('decodes in the breakpoint editor and forwards the edit encoded', async () => {
    h.core.tools.setBreakpoints([{ phase: 'request', pathPrefix: '/api/hold' }]);
    const blob = b64({ qty: 1, sku: 'A-1' });
    const status = h.send('/api/hold', 'POST', JSON.stringify({ blob }));
    await expect.poll(() => page.getByTestId('paused-chip').count()).toBe(1);
    await page.getByTestId('paused-chip').click();
    const msg = page.getByLabel('Paused message');
    await expect.poll(() => msg.inputValue()).toContain(blob);
    await caret('Paused message', blob, 4);
    await page.keyboard.press('Control+d');
    await expect.poll(() => msg.inputValue()).toContain('"qty": 1');
    await shot('decode-inline-breakpoint');
    await msg.fill((await msg.inputValue()).replace('"qty": 1', '"qty": 5'));
    await page.getByLabel('Paused traffic').getByRole('button', { name: 'Forward', exact: true }).click();
    expect(await status).toBe(200);
    const [ex] = h.core.store.search('path:/api/hold');
    const echoed = JSON.parse((JSON.parse(Buffer.from(h.core.store.getBody(ex!.id, 'response', true)!).toString()) as { echo: string }).echo) as { blob: string };
    expect(JSON.parse(Buffer.from(echoed.blob, 'base64').toString())).toEqual({ qty: 5, sku: 'A-1' });
    h.core.tools.setBreakpoints([]);
  });

  it('decodes in a Race request and races it encoded', async () => {
    const blob = b64({ coupon: 'SAVE10' });
    await h.send('/api/race-me', 'POST', JSON.stringify({ blob }));
    await nav('History');
    await page.locator('.row', { hasText: '/api/race-me' }).first().click();
    await page.locator('body').click({ position: { x: 700, y: 20 } });
    await page.keyboard.press('Control+Shift+R');
    await expect.poll(() => page.locator('.race-item').count()).toBe(1);
    await page.locator('.race-item').getByRole('button', { name: 'Edit' }).click();
    await caret('Raw request 1', blob, 4);
    await page.keyboard.press('Control+d');
    const ed = page.getByLabel('Raw request 1');
    await expect.poll(() => ed.inputValue()).toContain('"coupon": "SAVE10"');
    await ed.fill((await ed.inputValue()).replace('SAVE10', 'SAVE99'));
    await page.locator('.race .btn.primary').click();
    await expect.poll(() => h.core.store.search('path:/api/race-me').filter((e) => e.replayOf).length, { timeout: 15_000 }).toBe(1);
    const sent = h.core.store.search('path:/api/race-me').find((e) => e.replayOf)!;
    const body = JSON.parse(new TextDecoder().decode(h.core.store.getBody(sent.id, 'request', true)!)) as { blob: string };
    expect(JSON.parse(Buffer.from(body.blob, 'base64').toString())).toEqual({ coupon: 'SAVE99' });
  });

  it('decodes in the Streams composer and sends the message encoded', async () => {
    const { exchangeId } = await h.core.tools.ws.connect({ url: `ws://127.0.0.1:${h.upstreamPort}/compose`, headers: [] });
    await nav('Streams');
    await page.locator('.streams .saved-view', { hasText: '/compose' }).click();
    const token = b64({ user: 'nick' });
    const pl = page.getByLabel('Message payload');
    await pl.fill(`{"token":"${token}"}`);
    await caret('Message payload', token, 3);
    await page.getByLabel('Composer').getByRole('button', { name: 'Decode', exact: true }).click();
    await expect.poll(() => pl.inputValue()).toContain('"user": "nick"');
    await pl.fill((await pl.inputValue()).replace('"nick"', '"ada"'));
    await page.getByRole('button', { name: 'Send frame' }).click();
    const sentToken = b64({ user: 'ada' });
    await expect.poll(() => page.locator('.streams .msg-table').textContent()).toContain(`echo {"token":"${sentToken}"}`);
    await shot('decode-inline-streams');
    h.core.tools.ws.close(exchangeId);
  });
});
