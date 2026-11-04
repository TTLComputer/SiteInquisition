import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Connection } from './cdp.js';
import { engine, type Matcher, type Op, type Step } from './engine.js';
import { keyDef, MODIFIERS, type KeyDef } from './keys.js';

/**
 * A small browser driver for the UI tests: launches Chromium, talks to it
 * over the DevTools protocol on a pipe, and offers the slice of the
 * Playwright page and locator API those tests use (getByRole, getByLabel,
 * fill, click, press and so on), with the same auto-waiting and strict
 * single-element rules for actions.
 */

const ENGINE = engine.toString();
const DEFAULT_TIMEOUT = 15_000;

// ---------------------------------------------------------------- launching

const isExe = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const globDirs = (base: string, prefix: string, rest: string[]): string[] => {
  try {
    return readdirSync(base)
      .filter((d) => d.startsWith(prefix))
      .sort()
      .reverse()
      .flatMap((d) => rest.map((r) => join(base, d, r)));
  } catch {
    return [];
  }
};

/**
 * Finds a Chromium or Chrome to drive: $SIQ_CHROMIUM or $CHROME_PATH first,
 * then the usual names on PATH, then browsers other tools have downloaded.
 */
export function findChromium(): string | null {
  for (const env of [process.env.SIQ_CHROMIUM, process.env.CHROME_PATH]) if (env && isExe(env)) return env;
  const names = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'chrome'];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const n of names) if (isExe(join(dir, n))) return join(dir, n);
  }
  const downloaded = [
    ...globDirs('/opt/pw-browsers', 'chromium-', ['chrome-linux64/chrome', 'chrome-linux/chrome']),
    ...globDirs(join(homedir(), '.cache', 'ms-playwright'), 'chromium-', ['chrome-linux64/chrome', 'chrome-linux/chrome']),
    '/snap/bin/chromium',
  ];
  return downloaded.find(isExe) ?? null;
}

export interface LaunchOptions {
  executablePath?: string;
  /** Defaults to true. */
  headless?: boolean;
  args?: string[];
}

export async function launch(opts: LaunchOptions = {}): Promise<Browser> {
  const exe = opts.executablePath ?? findChromium();
  if (!exe) throw new Error('No Chromium found. Install Chromium or Chrome, or set SIQ_CHROMIUM to its path.');
  const profile = mkdtempSync(join(tmpdir(), 'siq-chromium-'));
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--mute-audio',
    ...(opts.headless === false ? [] : ['--headless', '--hide-scrollbars']),
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ...(opts.args ?? []),
  ];
  const conn = new Connection(exe, args);
  try {
    await conn.send('Browser.getVersion');
  } catch (e) {
    rmSync(profile, { recursive: true, force: true });
    throw e;
  }
  return new Browser(conn, profile);
}

// ---------------------------------------------------------------- browser and contexts

export interface ContextOptions {
  viewport?: { width: number; height: number } | null;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  deviceScaleFactor?: number;
}

const PERMISSIONS: Record<string, string> = {
  'clipboard-read': 'clipboardReadWrite',
  'clipboard-write': 'clipboardSanitizedWrite',
  geolocation: 'geolocation',
  notifications: 'notifications',
  camera: 'videoCapture',
  microphone: 'audioCapture',
};

export class Browser {
  private contexts = new Set<BrowserContext>();
  constructor(
    readonly conn: Connection,
    private profile: string,
  ) {}

  async newContext(opts: ContextOptions = {}): Promise<BrowserContext> {
    const { browserContextId } = await this.conn.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true });
    const ctx = new BrowserContext(this, browserContextId, opts);
    this.contexts.add(ctx);
    return ctx;
  }

  /** A page in a context of its own, closed with the page. */
  async newPage(opts: ContextOptions = {}): Promise<Page> {
    const ctx = await this.newContext(opts);
    const page = await ctx.newPage();
    page.ownsContext = true;
    return page;
  }

  async close(): Promise<void> {
    if (this.conn.proc.exitCode === null && this.conn.proc.signalCode === null) {
      this.conn.send('Browser.close').catch(() => {});
      const exited = await Promise.race([this.conn.exited.then(() => true), sleep(5000).then(() => false)]);
      if (!exited) {
        this.conn.proc.kill('SIGKILL');
        await this.conn.exited;
      }
    }
    rmSync(this.profile, { recursive: true, force: true });
  }
}

export class BrowserContext {
  constructor(
    readonly browser: Browser,
    readonly id: string,
    private opts: ContextOptions,
  ) {}

  async grantPermissions(permissions: string[], opts: { origin?: string } = {}): Promise<void> {
    const mapped = permissions.map((p) => {
      const m = PERMISSIONS[p];
      if (!m) throw new Error(`Unknown permission: ${p}`);
      return m;
    });
    await this.browser.conn.send('Browser.grantPermissions', { permissions: mapped, origin: opts.origin, browserContextId: this.id });
  }

  async newPage(): Promise<Page> {
    const conn = this.browser.conn;
    const { targetId } = await conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId: this.id });
    const { sessionId } = await conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.init(this.opts);
    return page;
  }

  async close(): Promise<void> {
    await this.browser.conn.send('Target.disposeBrowserContext', { browserContextId: this.id }).catch(() => {});
  }
}

// ---------------------------------------------------------------- locators

export type TextMatch = string | RegExp;
const matcher = (m: TextMatch): Matcher => (typeof m === 'string' ? m : { re: m.source, flags: m.flags });
const show = (m: TextMatch) => (typeof m === 'string' ? JSON.stringify(m) : String(m));

class StrictError extends Error {}

/** The query methods shared by pages and locators. */
abstract class Scope {
  protected abstract readonly page_: Page;
  protected abstract readonly steps: Step[];
  protected abstract readonly desc: string;

  protected child(step: Step, desc: string): Locator {
    return new Locator(this.page_, [...this.steps, step], this.desc ? `${this.desc}.${desc}` : desc);
  }

  locator(selector: string, opts: { hasText?: TextMatch } = {}): Locator {
    const step: Step = { kind: 'css', selector, ...(opts.hasText !== undefined ? { hasText: matcher(opts.hasText) } : {}) };
    return this.child(step, `locator(${JSON.stringify(selector)}${opts.hasText !== undefined ? `, { hasText: ${show(opts.hasText)} }` : ''})`);
  }

  getByRole(role: string, opts: { name?: TextMatch; exact?: boolean; checked?: boolean } = {}): Locator {
    const step: Step = { kind: 'role', role, ...(opts.name !== undefined ? { name: matcher(opts.name) } : {}), ...(opts.exact ? { exact: true } : {}), ...(opts.checked !== undefined ? { checked: opts.checked } : {}) };
    return this.child(step, `getByRole(${JSON.stringify(role)}${opts.name !== undefined ? `, { name: ${show(opts.name)}${opts.exact ? ', exact: true' : ''} }` : ''})`);
  }

  getByLabel(text: TextMatch, opts: { exact?: boolean } = {}): Locator {
    return this.child({ kind: 'label', text: matcher(text), ...(opts.exact ? { exact: true } : {}) }, `getByLabel(${show(text)})`);
  }

  getByText(text: TextMatch, opts: { exact?: boolean } = {}): Locator {
    return this.child({ kind: 'text', text: matcher(text), ...(opts.exact ? { exact: true } : {}) }, `getByText(${show(text)})`);
  }

  getByTestId(id: string): Locator {
    return this.child({ kind: 'testid', id }, `getByTestId(${JSON.stringify(id)})`);
  }
}

type Result<T> = { value: T } | { retry: string } | { strict: number } | { error: string };

export class Locator extends Scope {
  constructor(
    protected readonly page_: Page,
    protected readonly steps: Step[],
    protected readonly desc: string,
  ) {
    super();
  }

  override toString(): string {
    return this.desc;
  }

  first(): Locator {
    return this.child({ kind: 'nth', index: 0 }, 'first()');
  }
  last(): Locator {
    return this.child({ kind: 'nth', index: -1 }, 'last()');
  }
  nth(index: number): Locator {
    return this.child({ kind: 'nth', index }, `nth(${index})`);
  }
  filter(opts: { hasText?: TextMatch; hasNotText?: TextMatch }): Locator {
    const step: Step = { kind: 'filter', ...(opts.hasText !== undefined ? { hasText: matcher(opts.hasText) } : {}), ...(opts.hasNotText !== undefined ? { hasNotText: matcher(opts.hasNotText) } : {}) };
    return this.child(step, `filter(${opts.hasText !== undefined ? show(opts.hasText) : `not ${show(opts.hasNotText!)}`})`);
  }

  /** Runs op once; no waiting. */
  private run<T>(op: Op): Promise<T> {
    return this.page_.run<T>(this.steps, op);
  }

  /** Runs a single-element op until it succeeds, a strict violation, or the timeout. */
  private async until<T>(op: Op, what: string, timeout = this.page_.defaultTimeout): Promise<T> {
    const deadline = Date.now() + timeout;
    const waits = [0, 20, 50, 100, 100, 250];
    let last = 'no element matches';
    for (let i = 0; ; i++) {
      let r: Result<T> | undefined;
      try {
        r = await this.run<Result<T>>(op);
      } catch (e) {
        if (!/context|Cannot find|Target closed|navigat/i.test(String(e))) throw e;
        last = String((e as Error).message);
      }
      if (r) {
        if ('value' in r) return r.value;
        if ('strict' in r) throw new StrictError(`${what}: strict mode violation, ${this.desc} matches ${r.strict} elements`);
        if ('error' in r) throw new Error(`${what} ${this.desc}: ${r.error}`);
        last = r.retry;
      }
      if (Date.now() >= deadline) throw new Error(`${what} timed out after ${timeout} ms waiting for ${this.desc}: ${last}`);
      await sleep(waits[Math.min(i, waits.length - 1)]!);
    }
  }

  count(): Promise<number> {
    return this.run<number>({ op: 'count' });
  }
  allTextContents(): Promise<string[]> {
    return this.run<string[]>({ op: 'texts' });
  }
  async all(): Promise<Locator[]> {
    const n = await this.count();
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }
  isVisible(): Promise<boolean> {
    return this.run<boolean>({ op: 'visible' });
  }
  textContent(opts: { timeout?: number } = {}): Promise<string> {
    return this.until<string>({ op: 'text' }, 'textContent', opts.timeout);
  }
  inputValue(opts: { timeout?: number } = {}): Promise<string> {
    return this.until<string>({ op: 'value' }, 'inputValue', opts.timeout);
  }
  isChecked(opts: { timeout?: number } = {}): Promise<boolean> {
    return this.until<boolean>({ op: 'checked' }, 'isChecked', opts.timeout);
  }
  boundingBox(opts: { timeout?: number } = {}): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return this.until({ op: 'box' }, 'boundingBox', opts.timeout);
  }
  evaluate<R, A = undefined>(fn: (el: any, arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    return this.until<R>({ op: 'eval', fn: fn.toString(), arg }, 'evaluate');
  }

  async waitFor(opts: { state?: 'attached' | 'visible' | 'hidden' | 'detached'; timeout?: number } = {}): Promise<void> {
    const state = opts.state ?? 'visible';
    const timeout = opts.timeout ?? this.page_.defaultTimeout;
    const deadline = Date.now() + timeout;
    for (;;) {
      const n = await this.count().catch(() => -1);
      const vis = n === 1 ? await this.isVisible().catch(() => false) : false;
      if (n > 1 && state !== 'detached') throw new StrictError(`waitFor: strict mode violation, ${this.desc} matches ${n} elements`);
      if (state === 'attached' && n === 1) return;
      if (state === 'visible' && vis) return;
      if (state === 'hidden' && !vis && n >= 0) return;
      if (state === 'detached' && n === 0) return;
      if (Date.now() >= deadline) throw new Error(`waitFor(${state}) timed out after ${timeout} ms for ${this.desc}`);
      await sleep(50);
    }
  }

  async focus(): Promise<void> {
    await this.until({ op: 'focus' }, 'focus');
  }

  async click(opts: { button?: 'left' | 'right' | 'middle'; position?: { x: number; y: number }; clickCount?: number; force?: boolean; timeout?: number } = {}): Promise<void> {
    const deadline = Date.now() + (opts.timeout ?? this.page_.defaultTimeout);
    for (;;) {
      const pt = await this.until<{ x: number; y: number }>({ op: 'target', position: opts.position, force: opts.force }, 'click', Math.max(0, deadline - Date.now()));
      await this.page_.mouse.move(pt.x, pt.y);
      // Something may have moved over the target between finding it and the move.
      const hit = opts.force ? { ok: true } : await this.run<{ ok?: boolean }>({ op: 'hit', x: pt.x, y: pt.y }).catch(() => ({ ok: false }));
      if (hit.ok) {
        await this.page_.mouse.click(pt.x, pt.y, { button: opts.button, clickCount: opts.clickCount });
        return;
      }
      if (Date.now() >= deadline) throw new Error(`click timed out: ${this.desc} is covered by another element`);
      await sleep(50);
    }
  }

  dblclick(opts: { button?: 'left' | 'right' | 'middle' } = {}): Promise<void> {
    return this.click({ ...opts, clickCount: 2 });
  }

  async fill(value: string): Promise<void> {
    await this.until({ op: 'focus', select: true }, 'fill');
    if (value) await this.page_.keyboard.insertText(value);
    else await this.page_.keyboard.press('Delete');
  }

  async press(key: string): Promise<void> {
    await this.focus();
    await this.page_.keyboard.press(key);
  }

  async pressSequentially(text: string): Promise<void> {
    await this.focus();
    await this.page_.keyboard.type(text);
  }

  async setChecked(checked: boolean): Promise<void> {
    if ((await this.isChecked()) === checked) return;
    await this.click();
    if ((await this.run<{ value?: boolean }>({ op: 'lastChecked' })).value !== checked) throw new Error(`${checked ? 'check' : 'uncheck'}: clicking ${this.desc} did not change its state`);
  }
  check(): Promise<void> {
    return this.setChecked(true);
  }
  uncheck(): Promise<void> {
    return this.setChecked(false);
  }

  selectOption(values: string | string[]): Promise<string[]> {
    return this.until<string[]>({ op: 'select', values: Array.isArray(values) ? values : [values] }, 'selectOption');
  }
}

// ---------------------------------------------------------------- input

const BUTTONS = { left: 1, right: 2, middle: 4 } as const;
type Button = keyof typeof BUTTONS;

export class Mouse {
  private x = 0;
  private y = 0;
  private pressed = new Set<Button>();
  constructor(private page: Page) {}

  private buttons() {
    let b = 0;
    for (const p of this.pressed) b |= BUTTONS[p];
    return b;
  }

  async move(x: number, y: number, opts: { steps?: number } = {}): Promise<void> {
    const steps = Math.max(1, opts.steps ?? 1);
    const fx = this.x;
    const fy = this.y;
    for (let i = 1; i <= steps; i++) {
      this.x = fx + ((x - fx) * i) / steps;
      this.y = fy + ((y - fy) * i) / steps;
      const button = [...this.pressed][0] ?? 'none';
      await this.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: this.x, y: this.y, button, buttons: this.buttons(), modifiers: this.page.keyboard.modifiers() });
    }
  }

  async down(opts: { button?: Button; clickCount?: number } = {}): Promise<void> {
    const button = opts.button ?? 'left';
    this.pressed.add(button);
    await this.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: this.x, y: this.y, button, buttons: this.buttons(), clickCount: opts.clickCount ?? 1, modifiers: this.page.keyboard.modifiers() });
  }

  async up(opts: { button?: Button; clickCount?: number } = {}): Promise<void> {
    const button = opts.button ?? 'left';
    this.pressed.delete(button);
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: this.x, y: this.y, button, buttons: this.buttons(), clickCount: opts.clickCount ?? 1, modifiers: this.page.keyboard.modifiers() });
  }

  async click(x: number, y: number, opts: { button?: Button; clickCount?: number } = {}): Promise<void> {
    await this.move(x, y);
    const count = opts.clickCount ?? 1;
    for (let i = 1; i <= count; i++) {
      await this.down({ button: opts.button, clickCount: i });
      await this.up({ button: opts.button, clickCount: i });
    }
  }
}

export class Keyboard {
  private held = new Set<string>();
  constructor(private page: Page) {}

  modifiers(): number {
    let m = 0;
    for (const k of this.held) m |= MODIFIERS[k] ?? 0;
    return m;
  }

  private async dispatch(type: 'keyDown' | 'keyUp', def: KeyDef) {
    // Like a real keyboard, Ctrl, Alt or Meta chords type no text.
    const chord = [...this.held].some((k) => k === 'Control' || k === 'Alt' || k === 'Meta');
    const text = type === 'keyDown' && !chord ? def.text : undefined;
    await this.page.send('Input.dispatchKeyEvent', {
      type: type === 'keyDown' ? (text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
      modifiers: this.modifiers(),
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      ...(text ? { text, unmodifiedText: text } : {}),
      ...(def.location ? { location: def.location } : {}),
    });
  }

  async down(key: string): Promise<void> {
    const def = keyDef(key);
    if (key in MODIFIERS) this.held.add(key);
    await this.dispatch('keyDown', def);
  }

  async up(key: string): Promise<void> {
    const def = keyDef(key);
    if (key in MODIFIERS) this.held.delete(key);
    await this.dispatch('keyUp', def);
  }

  /** Presses a key or a chord such as "Control+Shift+R". */
  async press(combo: string): Promise<void> {
    const parts = combo === '+' ? ['+'] : combo.split(/\+(?!$)/);
    const key = parts.pop()!;
    for (const m of parts) await this.down(m);
    await this.down(key);
    await this.up(key);
    for (const m of parts.reverse()) await this.up(m);
  }

  async type(text: string): Promise<void> {
    for (const ch of text) {
      let known = true;
      try {
        keyDef(ch);
      } catch {
        known = false;
      }
      if (known) await this.press(ch);
      else await this.insertText(ch);
    }
  }

  async insertText(text: string): Promise<void> {
    await this.page.send('Input.insertText', { text });
  }
}

// ---------------------------------------------------------------- pages

type PageEvents = { pageerror: (e: Error) => void; console: (msg: { type: string; text: string }) => void };

export class Page extends Scope {
  protected readonly page_ = this;
  protected readonly steps: Step[] = [];
  protected readonly desc = '';
  readonly keyboard = new Keyboard(this);
  readonly mouse = new Mouse(this);
  defaultTimeout = DEFAULT_TIMEOUT;
  ownsContext = false;
  private listeners: { [K in keyof PageEvents]: Set<PageEvents[K]> } = { pageerror: new Set(), console: new Set() };

  constructor(
    readonly context: BrowserContext,
    readonly targetId: string,
    readonly sessionId: string,
  ) {
    super();
  }

  private get conn() {
    return this.context.browser.conn;
  }

  send<T = any>(method: string, params: object = {}): Promise<T> {
    return this.conn.send<T>(method, params, this.sessionId);
  }

  async init(opts: ContextOptions) {
    this.conn.on('Runtime.exceptionThrown', (p: { exceptionDetails: { text: string; exception?: { description?: string } } }) => {
      const d = p.exceptionDetails;
      const err = new Error(d.exception?.description ?? d.text);
      for (const l of this.listeners.pageerror) l(err);
    }, this.sessionId);
    this.conn.on('Runtime.consoleAPICalled', (p: { type: string; args: Array<{ value?: unknown; description?: string }> }) => {
      const text = p.args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ''))).join(' ');
      for (const l of this.listeners.console) l({ type: p.type, text });
    }, this.sessionId);
    await Promise.all([
      this.send('Page.enable'),
      this.send('Runtime.enable'),
      this.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
      opts.viewport !== null ? this.setViewportSize(opts.viewport ?? { width: 1280, height: 720 }, opts.deviceScaleFactor) : null,
      opts.colorScheme ? this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: opts.colorScheme }] }) : null,
    ]);
  }

  on<K extends keyof PageEvents>(event: K, listener: PageEvents[K]): this {
    this.listeners[event].add(listener);
    return this;
  }
  off<K extends keyof PageEvents>(event: K, listener: PageEvents[K]): this {
    this.listeners[event].delete(listener);
    return this;
  }

  setDefaultTimeout(ms: number) {
    this.defaultTimeout = ms;
  }

  async setViewportSize(size: { width: number; height: number }, deviceScaleFactor = 1): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor, mobile: false });
  }

  async goto(url: string, opts: { timeout?: number } = {}): Promise<void> {
    const loaded = this.conn.once('Page.loadEventFired', this.sessionId);
    const r = await this.send<{ errorText?: string }>('Page.navigate', { url });
    if (r.errorText) throw new Error(`goto ${url}: ${r.errorText}`);
    const timeout = opts.timeout ?? 30_000;
    const ok = await Promise.race([loaded.then(() => true), sleep(timeout).then(() => false)]);
    if (!ok) throw new Error(`goto ${url}: no load event after ${timeout} ms`);
  }

  async url(): Promise<string> {
    return this.evaluate(() => (globalThis as any).location.href as string);
  }

  /** Runs fn in the page and returns its (JSON-serialisable) result. */
  async evaluate<R, A = undefined>(fn: ((arg: A) => R | Promise<R>) | string, arg?: A): Promise<R> {
    const expression = typeof fn === 'string' ? fn : `(${fn.toString()})(${JSON.stringify(arg)})`;
    return this.evalExpression<R>(expression);
  }

  private async evalExpression<R>(expression: string): Promise<R> {
    const r = await this.send<{ result: { value?: R }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as R;
  }

  /** @internal Resolves locator steps in the page and runs one operation. */
  run<T>(steps: Step[], op: Op): Promise<T> {
    return this.evalExpression<T>(`(${ENGINE})(${JSON.stringify(steps)}, ${JSON.stringify(op)})`);
  }

  async screenshot(opts: { path?: string } = {}): Promise<Buffer> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(data, 'base64');
    if (opts.path) {
      mkdirSync(dirname(opts.path), { recursive: true });
      writeFileSync(opts.path, buf);
    }
    return buf;
  }

  async close(): Promise<void> {
    await this.conn.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
    if (this.ownsContext) await this.context.close();
  }
}
