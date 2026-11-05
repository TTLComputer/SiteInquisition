import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { findChromium, launch, type Browser, type Page } from '@siteinquisition/devkit/browser';
import { connectWebSocket } from '@siteinquisition/core';
import { tunnel } from '../../core/test/proxy-client';
import { DIST, startHarness, type Harness } from './harness';

// WebSocket replay, driven through the built renderer against a real core.
const SHOTS = process.env.SIQ_SCREENSHOTS;
const ready = findChromium() !== null && existsSync(join(DIST, 'index.html'));

describe.skipIf(!ready)('WebSocket replay in the renderer', () => {
  let h: Harness;
  let browser: Browser;
  let page: Page;
  let captured: string;

  const shot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const nav = (name: string) => page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name, exact: false }).first().click();
  const texts = (id: string, dir: 'client' | 'server') =>
    h.core.store
      .getStreamMessages(h.core.store.getStreamForExchange(id)!.id)
      .filter((m) => m.direction === dir && m.opcode === 'text')
      .map((m) => Buffer.from(m.payload).toString());

  beforeAll(async () => {
    h = await startHarness();
    // A connection to replay: two messages and their echoes.
    const { exchangeId } = await h.core.tools.ws.connect({ url: `ws://127.0.0.1:${h.upstreamPort}/chat`, headers: [['X-Room', 'lobby']] });
    captured = exchangeId;
    for (const m of ['hello', '42["chat",{"text":"hi"}]']) {
      h.core.tools.ws.send(exchangeId, Buffer.from(m), 'text');
      await expect.poll(() => texts(exchangeId, 'server').some((t) => t === `echo ${m}`)).toBe(true);
    }
    h.core.tools.ws.close(exchangeId);
    await expect.poll(() => h.core.tools.ws.isOpen(exchangeId)).toBe(false);
    browser = await launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e));
    await page.goto(h.pageUrl);
    await page.locator('.vlist .row').nth(4).waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    await h?.close();
  });

  it('opens a WebSocket in its own Replay editor from Send to Replay', async () => {
    await page.locator('.row', { hasText: '/chat' }).first().click();
    await page.getByLabel('Inspector').getByRole('button', { name: 'Send to Replay' }).click();
    await expect.poll(() => page.getByRole('tablist', { name: 'Workspace' }).textContent()).toContain('WS');
    await expect.poll(() => page.getByLabel('Handshake').inputValue()).toContain('X-Room: lobby');
    expect(await page.getByLabel('Handshake').inputValue()).toMatch(/^GET ws:\/\/127\.0\.0\.1:\d+\/chat/);
    const steps = page.getByLabel('Steps');
    // Steps are labelled by number: 1 send, 2 wait, 3 send.
    await expect.poll(() => page.getByLabel('Message 3').inputValue()).toBe('42["chat",{"text":"hi"}]');
    // Waits for the server were written in, and the Socket.IO frame is recognised.
    expect(await steps.textContent()).toContain('Wait for the server');
    expect(await steps.locator('.badge', { hasText: 'chat' }).count()).toBeGreaterThan(0);
  });

  it('edits a message with a token, runs it on a new connection and shows the step results', async () => {
    h.core.tools.vars.set('who', 'nick');
    // The captured close is the last step; leave it out so the connection stays open.
    await page.getByLabel('Step 4').getByLabel('Run this step').uncheck();
    const msg = page.getByLabel('Message 1');
    await msg.fill('hello {{var:who}}');
    await expect.poll(() => page.getByTestId('token-preview').textContent()).toContain('hello nick');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(() => page.locator('.msg-table').textContent(), { timeout: 10_000 }).toContain('echo hello nick');
    await expect.poll(() => page.getByTestId('run-status').textContent()).toBe('all steps ran');
    await expect.poll(() => page.getByTestId('step-status').allTextContents()).toEqual(['done', 'done', 'done', 'skipped']);
    const run = h.core.store.search(`replayof:${captured}`)[0]!;
    expect(texts(run.id, 'client')).toEqual(['hello nick', '42["chat",{"text":"hi"}]']);
    await shot('ws-replay');
  });

  it('keeps the connection open to send more, and steps between runs', async () => {
    await page.getByLabel('Message to send now').fill('more {{var:who}}');
    await page.getByLabel('Message to send now').press('Control+Enter');
    await expect.poll(() => page.locator('.msg-table').textContent(), { timeout: 10_000 }).toContain('echo more nick');
    await page.getByRole('group', { name: 'Sends' }).getByRole('button', { name: 'Original' }).click();
    await expect.poll(async () => { const t = await page.locator('.msg-table').textContent(); return t.includes('echo hello') && !t.includes('nick'); }).toBe(true);
    await page.getByLabel('Next send').click();
    await page.getByLabel('Diff with original').check();
    await expect.poll(() => page.getByLabel('Diff of server messages with the original').textContent()).toContain('+ echo hello nick');
    await shot('ws-replay-diff');
    await page.getByLabel('Diff with original').uncheck();
  });

  it('adds wait, close and frame steps and runs them in order', async () => {
    await page.getByRole('group', { name: 'Add a step' }).getByRole('button', { name: 'Wait' }).click();
    const n = await page.locator('.ws-step').count();
    await page.getByLabel('Match').last().fill('echo 42');
    await page.getByRole('group', { name: 'Add a step' }).getByRole('button', { name: 'Message' }).click();
    await page.getByLabel(`Message ${n + 1}`).fill('bye');
    await page.getByLabel('Send as').last().selectOption('fragment');
    await page.getByRole('group', { name: 'Add a step' }).getByRole('button', { name: 'Close' }).click();
    await page.getByLabel('Close code').last().fill('4001');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(() => h.core.store.search(`replayof:${captured}`).length).toBe(2);
    await expect.poll(() => page.getByRole('group', { name: 'Sends' }).textContent()).toContain('run 2 of 2');
    await expect.poll(() => page.getByTestId('run-status').textContent(), { timeout: 10_000 }).toBe('all steps ran');
    const last = h.core.store.search(`replayof:${captured}`).sort((a, b) => (a.id < b.id ? 1 : -1))[0]!;
    const msgs = h.core.store.getStreamMessages(h.core.store.getStreamForExchange(last.id)!.id).filter((m) => m.direction === 'client');
    expect(msgs.map((m) => m.opcode)).toEqual(['text', 'text', 'text', 'continuation', 'continuation', 'close']);
    expect(msgs[msgs.length - 1]!.meta).toMatchObject({ code: 4001 });
  });

  it('sets a WebSocket message breakpoint from the Replay tab', async () => {
    await page.getByRole('button', { name: 'Break on messages' }).click();
    await expect.poll(async () => (await h.core.tools.breakpoints()).some((b) => b.phase === 'messages' && b.pathPrefix === '/chat')).toBe(true);
    await nav('Rules');
    await page.getByRole('tab', { name: 'Breakpoints' }).click();
    await expect.poll(() => page.getByLabel('Pause on').first().inputValue()).toBe('messages');
    expect(await page.getByLabel('Messages from').first().inputValue()).toBe('both');
    await shot('ws-breakpoint');
  });

  it('edits a paused live message in the breakpoint queue before it goes on', async () => {
    // The breakpoint from the last test covers /chat; narrow it to client messages containing "secret".
    h.core.tools.setBreakpoints([{ phase: 'messages', host: '127.0.0.1', pathPrefix: '/chat', direction: 'client', match: 'secret' }]);
    const got: string[] = [];
    const { ws } = await connectWebSocket(`ws://127.0.0.1:${h.upstreamPort}/chat`, { createConnection: () => tunnel(`http://127.0.0.1:${h.proxyPort}`, '127.0.0.1', h.upstreamPort) });
    ws.on('message', (d) => got.push(d.toString()));
    ws.send('my secret');
    await expect.poll(() => page.getByTestId('paused-chip').count()).toBe(1);
    const queue = page.getByLabel('Paused traffic');
    await expect.poll(() => queue.textContent()).toContain('client message');
    await expect.poll(() => page.getByLabel('Paused message').inputValue()).toBe('my secret');
    await page.getByLabel('Paused message').fill('my edited secret');
    await shot('ws-paused');
    await queue.getByRole('button', { name: 'Forward', exact: true }).click();
    await expect.poll(() => got).toContain('echo my edited secret');
    ws.close(1000);
  });
});
