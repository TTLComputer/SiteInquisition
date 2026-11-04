import { BrowserWindow, ipcMain, session, WebContentsView, type Session } from 'electron';
import { readFileSync } from 'node:fs';

/**
 * The built-in browser: Chromium tabs drawn inside the app window, each a
 * WebContentsView in one shared session that sends all traffic through the
 * core's browser listener and trusts the project CA (and only for that).
 */
export interface BrowserSetup {
  window: BrowserWindow;
  proxyPort: number;
  caCertPath: string;
  /** Hosts sent straight to the browser listener so Chromium can use QUIC (it never does through a proxy). */
  http3Hosts?: string[];
}

interface Tab {
  id: number;
  view: WebContentsView;
  error?: string;
}

const normalizePem = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

let configured: Session | undefined;

async function browserSession(proxyPort: number, caCertPath: string, http3Hosts: string[] = []): Promise<Session> {
  if (configured) return configured;
  const ses = session.fromPartition('persist:siq-browser');
  // "<-loopback>" makes Chromium proxy localhost too, which is where most unfinished apps live.
  await ses.setProxy({ proxyRules: `http=127.0.0.1:${proxyPort};https=127.0.0.1:${proxyPort}`, proxyBypassRules: ['<-loopback>', ...http3Hosts].join(';') });
  const ca = normalizePem(readFileSync(caCertPath, 'utf8'));
  ses.setCertificateVerifyProc((req, callback) => {
    // Accept leaf certificates our CA issued (that is the interception); everything else gets Chromium's own verdict.
    let issuer = req.certificate.issuerCert;
    while (issuer) {
      if (normalizePem(issuer.data) === ca) return callback(0);
      issuer = issuer.issuerCert;
    }
    callback(-3);
  });
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'));
  configured = ses;
  return ses;
}

export function setupBrowser(ready: Promise<BrowserSetup>) {
  const tabs = new Map<number, Tab>();
  let activeId: number | null = null;
  let bounds: { x: number; y: number; width: number; height: number } | null = null;
  let nextId = 1;

  const state = (t: Tab) => {
    const wc = t.view.webContents;
    return {
      id: t.id,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      error: t.error,
    };
  };

  const send = async (msg: unknown) => {
    const { window } = await ready;
    if (!window.isDestroyed()) window.webContents.send('siq:browser:tab', msg);
  };

  const layout = async () => {
    await ready;
    for (const t of tabs.values()) {
      const visible = t.id === activeId && bounds !== null && bounds.width > 0 && bounds.height > 0;
      t.view.setVisible(visible);
      if (visible) t.view.setBounds(bounds!);
    }
  };

  const get = (id: number) => {
    const t = tabs.get(id);
    if (!t) throw new Error(`no browser tab ${id}`);
    return t;
  };

  const createTab = async (url: string): Promise<number> => {
    const { window, proxyPort, caCertPath, http3Hosts } = await ready;
    const ses = await browserSession(proxyPort, caCertPath, http3Hosts);
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const tab: Tab = { id: nextId++, view };
    tabs.set(tab.id, tab);
    window.contentView.addChildView(view);
    const wc = view.webContents;
    const update = () => void send(state(tab));
    wc.on('did-start-loading', () => ((tab.error = undefined), update()));
    wc.on('did-stop-loading', update);
    wc.on('did-navigate', update);
    wc.on('did-navigate-in-page', update);
    wc.on('page-title-updated', update);
    wc.on('did-fail-load', (_ev, code, desc, failedUrl, isMain) => {
      if (!isMain || code === -3) return; // -3 is an aborted load, e.g. a new navigation
      tab.error = `Could not load ${failedUrl}: ${desc} (${code})`;
      update();
    });
    // Pop-ups open as new tabs in the same proxied session.
    wc.setWindowOpenHandler(({ url: target }) => {
      void (async () => {
        await createTab(target);
      })();
      return { action: 'deny' };
    });
    activeId = tab.id;
    await layout();
    update();
    if (url && url !== 'about:blank') void wc.loadURL(url).catch(() => undefined);
    return tab.id;
  };
  ipcMain.handle('siq:browser:create', (_e, url: string) => createTab(url));

  ipcMain.handle('siq:browser:close', async (_e, id: number) => {
    const t = get(id);
    const { window } = await ready;
    window.contentView.removeChildView(t.view);
    t.view.webContents.close();
    tabs.delete(id);
    if (activeId === id) activeId = [...tabs.keys()].pop() ?? null;
    await layout();
    void send({ id, closed: true });
  });
  ipcMain.handle('siq:browser:activate', async (_e, id: number) => {
    get(id);
    activeId = id;
    await layout();
  });
  ipcMain.handle('siq:browser:navigate', (_e, id: number, url: string) => {
    void get(id).view.webContents.loadURL(url).catch(() => undefined);
  });
  ipcMain.handle('siq:browser:back', (_e, id: number) => get(id).view.webContents.navigationHistory.goBack());
  ipcMain.handle('siq:browser:forward', (_e, id: number) => get(id).view.webContents.navigationHistory.goForward());
  ipcMain.handle('siq:browser:reload', (_e, id: number) => get(id).view.webContents.reload());
  ipcMain.handle('siq:browser:devtools', (_e, id: number) => get(id).view.webContents.openDevTools({ mode: 'detach' }));
  ipcMain.handle('siq:browser:setBounds', async (_e, rect: typeof bounds) => {
    bounds = rect;
    await layout();
  });
  ipcMain.handle('siq:browser:list', () => [...tabs.values()].map(state));
}
