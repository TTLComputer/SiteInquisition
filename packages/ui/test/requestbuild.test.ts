import { existsSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { DIST, navTo, startHarness, type Harness } from './harness';

// Building requests: curl import, structured params and headers with nested decoding, multipart with files, OAuth.
const SHOTS = process.env.SIQ_SCREENSHOTS;
const ready = findChromium() !== null && existsSync(join(DIST, 'index.html'));

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe.skipIf(!ready)('Request building in Replay', () => {
  let h: Harness;
  let browser: Browser;
  let page: Page;
  let oauth: Server;
  let oauthBase: string;

  const shot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const tab = () => page.locator('.tab-host:not([style*="none"])');
  const view = (name: string) => tab().getByRole('tab', { name: new RegExp(`^${name}`) }).click();
  const rawValue = async () => {
    await view('Raw');
    return tab().getByLabel('Raw request', { exact: true }).inputValue();
  };
  /** What a file chooser would do: put a file in the hidden input and fire change. */
  const chooseFile = (name: string, bytes: number[], type: string) =>
    page.evaluate(
      ([n, b, t]) => {
        const doc = (globalThis as any).document;
        const input = [...doc.querySelectorAll('input[type=file]')].find((x: any) => x.offsetParent === null && x.closest('.tab-host')?.style.display !== 'none');
        const dt = new (globalThis as any).DataTransfer();
        dt.items.add(new (globalThis as any).File([new Uint8Array(b as number[])], n, { type: t }));
        input.files = dt.files;
        input.dispatchEvent(new (globalThis as any).Event('change', { bubbles: true }));
      },
      [name, bytes, type] as [string, number[], string],
    );

  beforeAll(async () => {
    h = await startHarness();
    oauth = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const f = new URLSearchParams(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(f.get('grant_type') === 'client_credentials' ? { access_token: 'tok-from-ui', token_type: 'Bearer', expires_in: 600, scope: f.get('scope') } : { error: 'unsupported_grant_type' }));
      });
    });
    await new Promise<void>((r) => oauth.listen(0, '127.0.0.1', () => r()));
    oauthBase = `http://127.0.0.1:${(oauth.address() as AddressInfo).port}`;
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e));
    await page.goto(h.pageUrl);
    await page.locator('.row').first().waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    await h?.close();
    await new Promise<void>((r) => oauth?.close(() => r()));
  });

  it('opens a curl command in a new Replay tab, asks for its file, and sends the upload', async () => {
    const data = encodeURIComponent(b64(JSON.stringify({ user: 'nick', prefs: encodeURIComponent(JSON.stringify({ theme: 'dark' })) })));
    const meta = b64('team=qa&level=3');
    const cmd = `curl 'http://127.0.0.1:${h.upstreamPort}/api/upload?data=${data}&x=1' \\
  -H 'X-Meta: ${meta}' \\
  -H 'Cookie: session=abc; cart=42' \\
  -F 'title=hello there' \\
  -F 'pic=@/home/me/pic.png' \\
  --compressed -k`;
    await navTo(page, 'Replay');
    await page.getByRole('button', { name: 'New request', exact: true }).click();
    await page.getByLabel('curl command for the new request', { exact: true }).fill(cmd);
    await page.getByRole('dialog', { name: 'New request' }).getByRole('button', { name: 'Open in Replay' }).click();
    await expect.poll(() => tab().getByLabel('Curl import', { exact: true }).textContent()).toContain('/home/me/pic.png');
    // Ignore TLS errors came over from -k.
    expect(await tab().getByRole('checkbox', { name: 'Ignore TLS errors' }).isChecked()).toBe(true);

    // Params: the base64 JSON parameter opens, with the url-encoded JSON inside it opened too.
    await view('Params');
    const chip = tab().getByRole('button', { name: /Decoded Parameter data/ });
    // The query value is url-decoded already, so the layers are what is left under it.
    await expect.poll(() => chip.textContent()).toBe('base64 › json');
    await chip.click();
    const json = tab().getByLabel('Parameter data as JSON', { exact: true });
    await expect.poll(() => json.inputValue()).toContain('"theme": "dark"');
    await shot('builder-params');
    await json.fill(JSON.stringify({ user: 'nick', prefs: { theme: 'light' } }, null, 2));
    await expect.poll(async () => {
      const v = await tab().getByLabel('Parameter data', { exact: true }).inputValue();
      try {
        const outer = JSON.parse(Buffer.from(v, 'base64').toString()) as { prefs: string };
        return JSON.parse(decodeURIComponent(outer.prefs)).theme as string;
      } catch {
        return null;
      }
    }).toBe('light');
    // The untouched parameter stays exactly as written.
    expect(await rawValue()).toContain('&x=1 HTTP/1.1');

    // Headers: a base64 header of form fields opens as rows; the Cookie header splits into cookies.
    await view('Headers');
    await tab().getByRole('button', { name: /Decoded Header X-Meta/ }).click();
    await expect.poll(() => tab().getByLabel('Header X-Meta field level', { exact: true }).inputValue()).toBe('3');
    await tab().getByLabel('Header X-Meta field level', { exact: true }).fill('4');
    await expect.poll(() => tab().getByLabel('Header X-Meta', { exact: true }).inputValue()).toBe(b64('team=qa&level=4'));
    await tab().getByLabel('Cookie cart', { exact: true }).fill('43');
    await expect.poll(() => tab().getByLabel('Header Cookie', { exact: true }).inputValue()).toBe('session=abc; cart=43');
    await shot('builder-headers');

    // Body: the multipart parts, and the file the command reads.
    await view('Body');
    await expect.poll(() => tab().getByLabel('Part name 1', { exact: true }).inputValue()).toBe('title');
    await tab().getByRole('button', { name: 'Attach /home/me/pic.png' }).click();
    await chooseFile('pic.png', [0x89, 0x50, 0x4e, 0x47, 0, 255, 10, 13], 'image/png');
    await expect.poll(() => tab().getByLabel('Attached files', { exact: true }).textContent()).toContain('8 B');
    await shot('builder-multipart');

    await tab().getByRole('button', { name: /^Send/ }).first().click();
    await expect.poll(() => h.core.store.search('path:/api/upload').some((e) => e.state === 'complete')).toBe(true);
    const sent = h.core.store.search('path:/api/upload')[0]!;
    const ex = h.core.store.getExchange(sent.id)!;
    expect(ex.requestHeaders.find(([k]) => k === 'X-Meta')![1]).toBe(b64('team=qa&level=4'));
    const body = Buffer.from(h.core.store.getBody(sent.id, 'request', true)!);
    expect(body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 10, 13]))).toBe(true);
    expect(body.toString('latin1')).toContain('\r\nContent-Disposition: form-data; name="title"\r\n\r\nhello there\r\n');
  });

  it('pasting curl into the raw editor imports it, with undo', async () => {
    await navTo(page, 'Replay');
    await page.getByRole('button', { name: 'New request', exact: true }).click();
    await page.getByRole('dialog', { name: 'New request' }).getByRole('button', { name: 'Blank request' }).click();
    const editor = tab().getByLabel('Raw request', { exact: true });
    await expect.poll(() => editor.inputValue()).toContain('GET https://example.com/');
    await editor.focus();
    await page.evaluate((cmd) => {
      const ta = (globalThis as any).document.activeElement;
      const dt = new (globalThis as any).DataTransfer();
      dt.setData('text/plain', cmd);
      ta.dispatchEvent(new (globalThis as any).ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, `curl -X PATCH https://api.test/items/7 -u nick:secret --json '{"done":true}'`);
    await expect.poll(() => editor.inputValue()).toContain('PATCH https://api.test/items/7 HTTP/1.1');
    expect(await editor.inputValue()).toContain(`Authorization: Basic ${b64('nick:secret')}`);
    await view('Auth');
    await expect.poll(() => tab().getByLabel('Basic auth password', { exact: true }).inputValue()).toBe('secret');
    await tab().getByRole('button', { name: 'Undo' }).click();
    await view('Raw');
    await expect.poll(() => tab().getByLabel('Raw request', { exact: true }).inputValue()).toContain('GET https://example.com/');
  });

  it('sets up an OAuth profile in Auth, gets a token, and sends it as {{oauth:name}}', async () => {
    await navTo(page, 'Replay');
    await page.getByRole('button', { name: 'New request', exact: true }).click();
    await page.getByLabel('curl command for the new request', { exact: true }).fill(`curl http://127.0.0.1:${h.upstreamPort}/api/secure`);
    await page.getByRole('dialog', { name: 'New request' }).getByRole('button', { name: 'Open in Replay' }).click();
    await view('Auth');
    await tab().getByRole('button', { name: 'OAuth 2.0' }).click();
    await tab().getByLabel('OAuth Name', { exact: true }).fill('svc');
    await tab().getByLabel('OAuth Grant', { exact: true }).selectOption('client_credentials');
    await tab().getByLabel('OAuth Token URL', { exact: true }).fill(`${oauthBase}/token`);
    await tab().getByLabel('OAuth Client ID', { exact: true }).fill('cli');
    await tab().getByLabel('OAuth Scope', { exact: true }).fill('read');
    await tab().getByRole('button', { name: 'Save profile' }).click();
    await expect.poll(() => tab().getByLabel('OAuth profile', { exact: true }).inputValue()).toBe('svc');
    await tab().getByRole('button', { name: 'Get token' }).click();
    await expect.poll(() => tab().getByLabel('OAuth token', { exact: true }).textContent()).toContain('scope read');
    await shot('builder-oauth');
    expect(await rawValue()).toContain('Authorization: Bearer {{oauth:svc}}');
    await tab().getByRole('button', { name: /^Send/ }).first().click();
    await expect.poll(() => h.core.store.search('path:/api/secure').some((e) => e.state === 'complete')).toBe(true);
    const ex = h.core.store.getExchange(h.core.store.search('path:/api/secure')[0]!.id)!;
    expect(ex.requestHeaders.find(([k]) => k.toLowerCase() === 'authorization')![1]).toBe('Bearer tok-from-ui');
  });
});
