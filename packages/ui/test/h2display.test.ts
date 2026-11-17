// How HTTP/2 and HTTP/3 requests read in the Inspector and open in Replay.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { exchangeCurl } from '@siteinquisition/core';
import { httpLabel, isFramedHttp, parseRawRequest, syncPseudo, toRawRequest } from '../src/format';
import { DIST, navTo, startHarness, type Harness } from './harness';

describe('HTTP version labels and pseudo-headers', () => {
  it('names HTTP/2 and HTTP/3 as people write them', () => {
    expect(httpLabel('2.0')).toBe('HTTP/2');
    expect(httpLabel('2')).toBe('HTTP/2');
    expect(httpLabel('3')).toBe('HTTP/3');
    expect(httpLabel('1.1')).toBe('HTTP/1.1');
    expect(httpLabel('HTTP/2.0')).toBe('HTTP/2');
    expect(httpLabel('MQTT/5.0')).toBe('MQTT/5.0');
    expect(isFramedHttp('2.0')).toBe(true);
    expect(isFramedHttp('3')).toBe(true);
    expect(isFramedHttp('1.1')).toBe(false);
  });

  it('keeps pseudo-headers in the raw request, and parses them back', () => {
    const raw = toRawRequest('GET', 'https://h2.test/a.js', [[':method', 'GET'], [':authority', 'h2.test'], [':path', '/a.js'], ['accept', '*/*']], '', '2.0');
    expect(raw).toBe('GET https://h2.test/a.js HTTP/2\n:method: GET\n:authority: h2.test\n:path: /a.js\naccept: */*\n\n');
    const parsed = parseRawRequest(raw.replace(':authority: h2.test', ':authority: other.test'));
    expect(parsed.headers).toEqual([[':method', 'GET'], [':authority', 'other.test'], [':path', '/a.js'], ['accept', '*/*']]);
    expect(parsed.url).toBe('https://h2.test/a.js');
    expect(parsed.version).toBe('2');
    expect(toRawRequest('GET', 'https://h2.test/', [], '')).toBe('GET https://h2.test/ HTTP/1.1\n\n\n');
  });

  it('carries a request line edit into the pseudo-headers that still matched it', () => {
    const before = 'GET https://h2.test/a?x=1 HTTP/2\n:method: GET\n:scheme: https\n:authority: other.test\n:path: /a?x=1\naccept: */*\n\nbody';
    const after = syncPseudo(before, before.replace('GET https://h2.test/a?x=1', 'POST https://h2.test/b'));
    // :authority was set apart from the URL on purpose, so it stays.
    expect(after).toBe('POST https://h2.test/b HTTP/2\n:method: POST\n:scheme: https\n:authority: other.test\n:path: /b\naccept: */*\n\nbody');
    // Edits elsewhere leave everything as typed.
    const typed = before.replace(':path: /a?x=1', ':path: /typed');
    expect(syncPseudo(before, typed)).toBe(typed);
  });
});

const SHOTS = process.env.SIQ_SCREENSHOTS;
const ready = findChromium() !== null && existsSync(join(DIST, 'index.html'));

describe.skipIf(!ready)('HTTP/2 exchanges in the renderer', () => {
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
    const host = `127.0.0.1:${h.upstreamPort}`;
    // As the proxy records a browser's HTTP/2 request: node calls the version "2.0", and the pseudo-headers come first.
    const ex = h.core.store.addRequest({
      source: 'proxy',
      startedAt: Date.now(),
      method: 'GET',
      url: `https://${host}/989.fa2243d6c6142af9.js`,
      httpVersion: '2.0',
      headers: [
        [':method', 'GET'],
        [':authority', host],
        [':scheme', 'https'],
        [':path', '/989.fa2243d6c6142af9.js'],
        ['sec-ch-ua-platform', '"Windows"'],
        ['accept', '*/*'],
      ],
    });
    h.core.store.completeResponse(ex.id, { status: 200, headers: [['content-type', 'text/javascript']], body: Buffer.from('console.log(1)') });
    // A Replay send over HTTP/2 stores only the ordinary headers.
    const rep = h.core.store.addRequest({ source: 'replay', startedAt: Date.now(), method: 'POST', url: `https://${host}/h2-replayed?x=1`, httpVersion: '2', headers: [['content-type', 'application/json']], body: Buffer.from('{}') });
    h.core.store.completeResponse(rep.id, { status: 201, headers: [], body: Buffer.from('{}') });
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e));
    await page.goto(h.pageUrl);
    await navTo(page, 'History');
    await page.locator('.row', { hasText: '989.fa2243d6c6142af9.js' }).waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });

  const sideText = (n: number) => page.locator('.inspector .two-col section').nth(n).locator('pre.raw').textContent();

  it('shows pseudo-headers in place of a made-up request line', async () => {
    await page.locator('.row', { hasText: '989.fa2243d6c6142af9.js' }).first().click();
    await expect.poll(() => sideText(0)).toContain(':method: GET');
    const req = (await sideText(0))!;
    expect(req.startsWith(':method: GET\n')).toBe(true);
    expect(req).not.toContain('HTTP/2.0');
    expect(req).not.toMatch(/^GET \//m);
    expect(req.indexOf(':path:')).toBeLessThan(req.indexOf('sec-ch-ua-platform'));
    expect(await page.getByTestId('request-protocol').textContent()).toBe('HTTP/2');
    // The response has :status, not "HTTP/2.0 200".
    expect((await sideText(1))!.startsWith(':status: 200\ncontent-type: text/javascript')).toBe(true);
    // Pseudo-header names are styled as protocol fields, and explained on request.
    expect(await page.locator('.inspector pre.raw .hk.pseudo').count()).toBe(5);
    await page.getByRole('button', { name: 'What is :method?' }).click();
    await expect.poll(() => page.getByTestId('pseudo-note').textContent()).toContain('HTTP/2 has no request line');
    await shot('h2-inspector');
    // Timings says HTTP/2 too.
    await page.getByRole('tab', { name: 'Timings' }).click();
    await expect.poll(() => page.locator('.inspector dl.kv').textContent()).toContain('HTTP/2');
    expect(await page.locator('.inspector dl.kv').textContent()).not.toContain('2.0');
    await page.getByRole('tab', { name: 'Request and response' }).click();
  });

  it('fills in pseudo-headers for HTTP/2 sends that did not keep them', async () => {
    await page.locator('.row', { hasText: '/h2-replayed' }).first().click();
    await expect.poll(() => sideText(0)).toContain(':path: /h2-replayed?x=1');
    expect((await sideText(0))!.startsWith(':method: POST\n:scheme: https\n:authority: 127.0.0.1:')).toBe(true);
    expect((await sideText(1))!.startsWith(':status: 201')).toBe(true);
  });

  it('opens in Replay with its pseudo-headers, on HTTP/2, and keeps them in step with the URL', async () => {
    await page.locator('.row', { hasText: '989.fa2243d6c6142af9.js' }).first().click();
    await page.keyboard.press('Control+r');
    const editor = page.getByLabel('Raw request').last();
    await expect.poll(() => editor.inputValue()).toContain('sec-ch-ua-platform');
    const raw = await editor.inputValue();
    expect(raw.split('\n')[0]).toMatch(/^GET https:\/\/127\.0\.0\.1:\d+\/989\.fa2243d6c6142af9\.js HTTP\/2$/);
    expect(raw).toContain('\n:path: /989.fa2243d6c6142af9.js\n');
    expect(parseRawRequest(raw).headers.slice(0, 4).map(([k]) => k)).toEqual([':method', ':authority', ':scheme', ':path']);
    expect(await page.getByLabel('Protocol').last().inputValue()).toBe('h2');
    // Editing the URL updates :path.
    await editor.fill(raw.replace('/989.fa2243d6c6142af9.js HTTP/2', '/other.js HTTP/2'));
    await expect.poll(() => editor.inputValue()).toContain('\n:path: /other.js\n');
    // HTTP/1.1 says it will not send them.
    await page.getByLabel('Protocol').last().selectOption('h1');
    await expect.poll(() => page.getByTestId('pseudo-h1-hint').count()).toBe(1);
    await page.getByLabel('Protocol').last().selectOption('h2');
    await shot('h2-replay');
  });

  it('copies as curl without pseudo-headers', async () => {
    const id = h.core.store.search('989.fa2243d6c6142af9').at(0)!.id;
    const curl = exchangeCurl(h.core.store, id);
    expect(curl).not.toContain(':method');
    expect(curl).not.toContain(':authority');
    expect(curl).toContain('sec-ch-ua-platform');
  });
});
