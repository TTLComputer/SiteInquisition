import { app, BrowserWindow, ipcMain, nativeTheme, shell, utilityProcess, type UtilityProcess } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { setupBrowser } from './browser.js';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

interface Ready {
  proxyPort: number;
  browserProxyPort: number;
  caCertPath: string;
  apiPort: number;
  token: string;
}

/** Command line: --project DIR, --port N, --lan. SIQ_PROJECT also sets the project folder. */
function options() {
  const argv = process.argv;
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const port = value('--port');
  return {
    projectDir: resolve(value('--project') ?? process.env.SIQ_PROJECT ?? join(app.getPath('userData'), 'projects', 'default')),
    proxyPort: port ? Number(port) : undefined,
    allowLan: argv.includes('--lan'),
  };
}

/** Hosts the built-in browser should reach over HTTP/3 (project browser.json, or SIQ_BROWSER_H3_HOSTS). */
function http3Hosts(projectDir: string): string[] {
  const env = process.env.SIQ_BROWSER_H3_HOSTS;
  if (env !== undefined) return env.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  try {
    const v = JSON.parse(readFileSync(join(projectDir, 'browser.json'), 'utf8')) as { http3Hosts?: unknown };
    return Array.isArray(v.http3Hosts) ? v.http3Hosts.filter((h): h is string => typeof h === 'string' && /^[a-z0-9.-]+$/.test(h)) : [];
  } catch {
    return [];
  }
}

/** A port number free for both TCP and UDP, so the browser listener can take QUIC and TLS on one port. */
async function freeDualPort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise<number>((res, rej) => {
      const s = createServer();
      s.once('error', rej);
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => res(p));
      });
    });
    const udpFree = await new Promise<boolean>((res) => {
      const u = createSocket('udp4');
      u.once('error', () => res(false));
      u.bind(port, '127.0.0.1', () => u.close(() => res(true)));
    });
    if (udpFree) return port;
  }
  throw new Error('no free port for the browser listener');
}

/**
 * Chromium only uses QUIC for a host when it connects directly, so for each
 * HTTP/3 host the browser maps host:443 to the browser listener (which takes
 * QUIC on UDP and TLS on TCP), forces QUIC for that origin, and skips the
 * proxy (see browser.ts). These switches must be set before the app is ready.
 */
const browserH3 = await (async () => {
  const hosts = http3Hosts(options().projectDir);
  if (!hosts.length) return { hosts, port: undefined };
  const port = await freeDualPort();
  app.commandLine.appendSwitch('enable-quic');
  app.commandLine.appendSwitch('host-resolver-rules', hosts.flatMap((h) => [`MAP ${h}:443 127.0.0.1:${port}`, `MAP ${h}:80 127.0.0.1:${port}`]).join(','));
  app.commandLine.appendSwitch('origin-to-force-quic-on', hosts.map((h) => `${h}:443`).join(','));
  return { hosts, port };
})();

// Headless smoke runs (xvfb) have no GPU; software rendering keeps page capture reliable.
if (process.env.SIQ_SMOKE_SCREENSHOT) app.disableHardwareAcceleration();

let core: UtilityProcess | undefined;
let ready: Promise<Ready> | undefined;

function startCore(): Promise<Ready> {
  const opts = options();
  core = utilityProcess.fork(join(here, 'core-host.js'), [], { serviceName: 'SiteInquisition core', stdio: 'inherit' });
  return new Promise<Ready>((resolvePromise, reject) => {
    core!.on('message', (msg: { type: string } & Partial<Ready> & { message?: string }) => {
      if (msg.type === 'ready') resolvePromise(msg as Ready);
      if (msg.type === 'error') reject(new Error(msg.message));
    });
    core!.once('exit', (code) => reject(new Error(`core exited with code ${code}`)));
    core!.postMessage({ type: 'start', ...opts, browserPort: browserH3.port });
  });
}

function rendererIndex(): string {
  // A packaged app carries the renderer next to its main process (see devkit/src/package).
  const packaged = join(app.getAppPath(), 'renderer', 'index.html');
  if (app.isPackaged || existsSync(packaged)) return packaged;
  const uiDir = dirname(require.resolve('@siteinquisition/ui/package.json'));
  return join(uiDir, 'dist', 'index.html');
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: 'SiteInquisition',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0E1014' : '#F6F7F9',
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.setMenuBarVisibility(false);
  // The renderer is a local page; links open in the real browser, never in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  await win.loadURL(pathToFileURL(rendererIndex()).href);
  return win;
}

/** CI and local smoke test: wait until the renderer is connected to the core, save a screenshot, quit. */
async function capture(win: BrowserWindow, path: string) {
  for (let i = 0; ; i++) {
    try {
      writeFileSync(path, (await win.webContents.capturePage()).toPNG());
      return;
    } catch (err) {
      if (i >= 5) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function smoke(win: BrowserWindow, path: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const ok = await win.webContents.executeJavaScript(`!!document.querySelector('[data-testid="listener"]') && !document.querySelector('.connection-lost') && /127\\.0\\.0\\.1:\\d+/.test(document.querySelector('[data-testid="listener"]').textContent)`);
    if (ok) break;
    if (Date.now() > deadline) {
      console.error('smoke: renderer never connected to the core');
      app.exit(1);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 500));
  await capture(win, path);
  // Scripts run in their own process; check one runs, and that the sandbox holds, in this build.
  const rpc = (method: string, params: unknown) =>
    win.webContents.executeJavaScript(`(async () => {
      const c = await window.siq.getConnection();
      const ws = new WebSocket(c.url + '?token=' + c.token);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }));
      const m = await new Promise((r) => (ws.onmessage = (e) => r(JSON.parse(e.data))));
      ws.close();
      return m;
    })()`) as Promise<{ result?: { ok: boolean; value?: string; error?: string }; error?: { message: string } }>;
  const plain = await rpc('scripts.run', { code: '6 * 7' });
  if (plain.result?.value !== '42') {
    console.error(`smoke: a script did not run: ${JSON.stringify(plain)}`);
    app.exit(1);
    return;
  }
  const escape = await rpc('scripts.run', { code: "console.log.constructor('return process')().getBuiltinModule('node:child_process').execSync('id').toString()" });
  if (escape.result?.ok !== false || !/restricted/.test(escape.result.error ?? '')) {
    console.error(`smoke: the script sandbox did not hold: ${JSON.stringify(escape)}`);
    app.exit(1);
    return;
  }
  console.log('smoke: scripts ok (sandboxed)');
  // Optionally drive the built-in browser too: open the Browser view, load a URL, and wait for it to be recorded.
  const target = process.env.SIQ_SMOKE_BROWSER_URL;
  if (target) {
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim().startsWith('Browser')).click()`);
    await new Promise((r) => setTimeout(r, 800));
    await win.webContents.executeJavaScript(`(async () => { const ts = await window.siq.browser.list(); await window.siq.browser.navigate(ts[0].id, ${JSON.stringify(target)}); })()`);
    const until = Date.now() + 15_000;
    for (;;) {
      const n = await win.webContents.executeJavaScript(`document.querySelectorAll('[data-testid="feed-row"]').length`);
      if (n > 0) break;
      if (Date.now() > until) {
        console.error('smoke: browser traffic never showed up in the feed');
        app.exit(1);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 800));
    await capture(win, path.replace(/\.png$/, '-browser.png'));
    console.log('smoke: browser ok');
  }
  console.log(`smoke: ok, screenshot at ${path}`);
  app.quit();
}

ipcMain.handle('siq:getConnection', async () => {
  const r = await ready!;
  return { url: `ws://127.0.0.1:${r.apiPort}`, token: r.token };
});

ipcMain.handle('siq:setTheme', (_e, theme: unknown) => {
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    ready = startCore();
    ready.catch((err: Error) => {
      console.error(`SiteInquisition core failed to start: ${err.message}`);
      app.exit(1);
    });
    let resolveWindow!: (w: BrowserWindow) => void;
    const windowReady = new Promise<BrowserWindow>((r) => (resolveWindow = r));
    setupBrowser(Promise.all([ready, windowReady]).then(([r, window]) => ({ window, proxyPort: r.browserProxyPort, caCertPath: r.caCertPath, http3Hosts: browserH3.hosts })));
    const win = await createWindow();
    resolveWindow(win);
    if (process.env.SIQ_SMOKE_SCREENSHOT) {
      await smoke(win, process.env.SIQ_SMOKE_SCREENSHOT).catch((err: Error) => {
        console.error(`smoke: ${err.message}`);
        app.exit(1);
      });
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());

  // Let the core flush the database and close its listeners before exiting.
  let closing = false;
  app.on('will-quit', (e) => {
    if (closing || !core) return;
    closing = true;
    e.preventDefault();
    const done = () => app.exit(0);
    core.once('exit', done);
    core.postMessage({ type: 'close' });
    setTimeout(done, 3000);
  });
}
