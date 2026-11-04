import { app, BrowserWindow, ipcMain, nativeTheme, shell, utilityProcess, type UtilityProcess } from 'electron';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

interface Ready {
  proxyPort: number;
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
    core!.postMessage({ type: 'start', ...opts });
  });
}

function rendererIndex(): string {
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
  if (process.env.SIQ_SMOKE_SCREENSHOT) await smoke(win, process.env.SIQ_SMOKE_SCREENSHOT);
  return win;
}

/** CI and local smoke test: wait until the renderer is connected to the core, save a screenshot, quit. */
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
  const image = await win.webContents.capturePage();
  writeFileSync(path, image.toPNG());
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
    await createWindow();
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
