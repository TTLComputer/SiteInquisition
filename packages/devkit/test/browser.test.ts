import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';

const HTML = `<!doctype html><html><body>
<nav aria-label="Views"><button>History <span>5</span></button><button aria-label="Close tab">×</button></nav>
<label><input type="checkbox" id="cb"> Diff with original</label>
<div aria-label="Raw request"></div>
<label for="name">Your name</label><input id="name">
<textarea aria-label="Body"></textarea>
<select aria-label="Preset"><option value="one">One</option><option value="frag">Fragment</option></select>
<ul><li class="row" data-testid="r">alpha <b>/api/cart</b></li><li class="row" data-testid="r">beta <b>/api/other</b></li></ul>
<div role="radio" aria-checked="false" tabindex="0" onclick="this.setAttribute('aria-checked','true')">Light</div>
<button style="display:none">Hidden</button>
<button id="late" disabled>Later</button>
<div id="pad" style="width:300px;height:80px;background:#ccc"></div>
<p id="log"></p>
<script>
  const log = (s) => (document.getElementById('log').textContent += s + ';');
  document.getElementById('name').addEventListener('input', (e) => log('input:' + e.target.value));
  document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.length === 1) e.preventDefault(), log('key:' + (e.shiftKey ? 'shift+' : '') + e.key); });
  document.addEventListener('contextmenu', (e) => { e.preventDefault(); log('menu'); });
  document.querySelector('select').addEventListener('change', (e) => log('change:' + e.target.value));
  const pad = document.getElementById('pad');
  pad.addEventListener('pointerdown', (e) => log('down:' + Math.round(e.offsetX)));
  pad.addEventListener('pointerup', (e) => log('up:' + Math.round(e.offsetX)));
  setTimeout(() => (document.getElementById('late').disabled = false), 200);
  document.getElementById('late').addEventListener('click', () => log('late'));
</script>
</body></html>`;

describe.skipIf(findChromium() === null)('in-house browser driver', () => {
  let browser: Browser;
  let page: Page;
  const errors: Error[] = [];
  const log = () => page.locator('#log').textContent();

  beforeAll(async () => {
    browser = await launch();
    page = await browser.newPage({ viewport: { width: 800, height: 600 }, colorScheme: 'dark' });
    page.on('pageerror', (e) => errors.push(e));
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
    // Chromium's first start on a busy CI runner can take longer than the default 20 s.
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('finds elements by role, name, label, text and test id', async () => {
    expect(await page.getByRole('button').count()).toBe(3); // the hidden one is not in the tree
    expect(await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'history' }).count()).toBe(1);
    expect(await page.getByRole('button', { name: 'History', exact: true }).count()).toBe(0); // its name is "History 5"
    expect(await page.getByRole('button', { name: /^Close/ }).textContent()).toBe('×');
    expect(await page.getByRole('checkbox', { name: 'Diff with original' }).count()).toBe(1);
    expect(await page.getByLabel('Your name').evaluate((el) => el.id)).toBe('name');
    expect(await page.getByLabel('Raw request', { exact: true }).count()).toBe(1);
    expect(await page.getByText('/api/cart').evaluate((el) => el.localName)).toBe('b');
    expect(await page.getByTestId('r').count()).toBe(2);
    expect(await page.locator('.row', { hasText: '/API/OTHER' }).locator('b').textContent()).toBe('/api/other');
    expect(await page.getByTestId('r').filter({ hasText: 'alpha' }).count()).toBe(1);
    expect(await page.locator('.row').allTextContents()).toEqual(['alpha /api/cart', 'beta /api/other']);
    expect(await page.locator('.row').nth(1).textContent()).toContain('beta');
    expect(await page.locator('.row').last().textContent()).toContain('beta');
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
  });

  it('refuses to act on more than one element', async () => {
    await expect(page.locator('.row').click()).rejects.toThrow(/strict mode violation.*matches 2/);
  });

  it('waits for an element to become enabled, and times out with the reason', async () => {
    await page.getByRole('button', { name: 'Later' }).click();
    await expect.poll(log).toContain('late');
    await expect(page.locator('#missing').textContent({ timeout: 200 })).rejects.toThrow(/timed out.*#missing/);
  });

  it('fills inputs, checks boxes, picks options', async () => {
    await page.getByLabel('Your name').fill('nick');
    expect(await page.getByLabel('Your name').inputValue()).toBe('nick');
    expect(await log()).toContain('input:nick');
    await page.getByLabel('Your name').fill('');
    expect(await page.getByLabel('Your name').inputValue()).toBe('');
    await page.getByLabel('Body').fill('line 1\nline 2');
    expect(await page.getByLabel('Body').inputValue()).toBe('line 1\nline 2');
    await page.getByLabel('Diff with original').check();
    expect(await page.getByLabel('Diff with original').isChecked()).toBe(true);
    await page.getByRole('radio', { name: 'Light' }).click();
    expect(await page.getByRole('radio', { name: 'Light' }).isChecked()).toBe(true);
    expect(await page.getByLabel('Preset').selectOption('Fragment')).toEqual(['frag']);
    expect(await log()).toContain('change:frag');
  });

  // The page cancels the chords: ones it lets through reach the browser, and Ctrl Shift R reloads.
  it('sends key chords and mouse buttons', async () => {
    await page.getByLabel('Body').press('Control+Shift+R');
    await page.keyboard.press('Control+d');
    expect(await log()).toContain('key:shift+R;key:d;');
    expect(await page.getByLabel('Body').inputValue()).toBe('line 1\nline 2'); // chords type nothing
    await page.getByTestId('r').first().click({ button: 'right' });
    expect(await log()).toContain('menu');
    const box = (await page.locator('#pad').boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 250, box.y + 10, { steps: 4 });
    await page.mouse.up();
    expect(await log()).toContain('down:10;up:250;');
  });

  it('takes screenshots and reports page errors', async () => {
    const png = await page.screenshot();
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    await page.evaluate(() => void setTimeout(() => { throw new Error('kaboom'); }));
    await expect.poll(() => errors.map((e) => e.message).join()).toContain('kaboom');
  });
});
