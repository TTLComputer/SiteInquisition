#!/usr/bin/env node
/**
 * End-to-end smoke test of the desktop app: start it (under a virtual display,
 * xvfb-run, on Linux) with a fresh project and data folder, wait for the window to
 * connect to the core, run a script and check its sandbox, load a page in the
 * built-in browser and check it was recorded.
 *
 *   node scripts/smoke.mjs                 # the dev build (pnpm build)
 *   node scripts/smoke.mjs release/linux-unpacked/siteinquisition   # a package
 *   node scripts/smoke.mjs release/win-unpacked/SiteInquisition.exe  # a Windows package
 */
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.argv[2] ? resolve(process.argv[2]) : null;
const tmp = mkdtempSync(join(tmpdir(), 'siq-smoke-'));
const project = join(tmp, 'project');
const data = join(tmp, 'data');
const shot = join(process.env.SIQ_SMOKE_OUT ?? tmp, 'smoke.png');

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>smoke</title><h1>SiteInquisition smoke page</h1>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// The browser feed shows recorded traffic, so put the test page in scope first.
const win = process.platform === 'win32';
const siq = binary ? [join(dirname(binary), 'bin', win ? 'siq.cmd' : 'siq')] : [process.execPath, join(root, 'packages', 'cli', 'dist', 'main.js')];
const env = { ...process.env, SIQ_DATA_DIR: data };
// A .cmd file only runs through cmd.exe, which gets one command line.
const scopeArgs = [...siq.slice(1), 'scope', 'add', '127.0.0.1', '-p', project];
const scope = win && binary
  ? spawnSync([siq[0], ...scopeArgs].map((a) => `"${a}"`).join(' '), { env, encoding: 'utf8', shell: true })
  : spawnSync(siq[0], scopeArgs, { env, encoding: 'utf8' });
if (scope.status !== 0) {
  console.error(`smoke: could not set the scope: ${scope.stderr || scope.stdout}`);
  process.exit(1);
}

const electron = binary ?? (win ? join(root, 'packages', 'app', 'node_modules', 'electron', 'dist', 'electron.exe') : join(root, 'packages', 'app', 'node_modules', '.bin', 'electron'));
if (!existsSync(electron)) {
  console.error(`smoke: no app binary at ${electron}`);
  process.exit(1);
}
const appArgs = binary ? [] : [join(root, 'packages', 'app')];
// Containers often run as root, where Chromium needs --no-sandbox.
const extra = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
const args = [...appArgs, ...extra, '--project', project];
const child = spawn(win ? electron : 'xvfb-run', win ? args : ['-a', electron, ...args], {
  env: { ...env, SIQ_SMOKE_SCREENSHOT: shot, SIQ_SMOKE_BROWSER_URL: `http://127.0.0.1:${port}/` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
const code = await new Promise((r) => child.on('exit', (c) => r(c)));
clearTimeout(timer);
server.close();
const lines = log.split(/\r?\n/).filter((l) => l.startsWith('smoke:'));
console.log(lines.join('\n'));
const ok = code === 0 && lines.some((l) => l.includes('scripts ok')) && lines.some((l) => l.includes('browser ok'));
if (!ok) {
  console.error(`smoke: FAILED (exit ${code})\n${log.slice(-4000)}`);
  process.exit(1);
}
if (!process.env.SIQ_SMOKE_OUT) rmSync(tmp, { recursive: true, force: true });
console.log('smoke: passed');
