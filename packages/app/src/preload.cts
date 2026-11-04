// Sandboxed preload: exposes only how to reach the core and the theme switch.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('siq', {
  getConnection: (): Promise<{ url: string; token: string }> => ipcRenderer.invoke('siq:getConnection'),
  setTheme: (theme: 'system' | 'light' | 'dark'): Promise<void> => ipcRenderer.invoke('siq:setTheme', theme),
  platform: process.platform,
  browser: {
    create: (url: string) => ipcRenderer.invoke('siq:browser:create', url),
    close: (id: number) => ipcRenderer.invoke('siq:browser:close', id),
    activate: (id: number) => ipcRenderer.invoke('siq:browser:activate', id),
    navigate: (id: number, url: string) => ipcRenderer.invoke('siq:browser:navigate', id, url),
    back: (id: number) => ipcRenderer.invoke('siq:browser:back', id),
    forward: (id: number) => ipcRenderer.invoke('siq:browser:forward', id),
    reload: (id: number) => ipcRenderer.invoke('siq:browser:reload', id),
    devtools: (id: number) => ipcRenderer.invoke('siq:browser:devtools', id),
    setBounds: (rect: unknown) => ipcRenderer.invoke('siq:browser:setBounds', rect),
    list: () => ipcRenderer.invoke('siq:browser:list'),
    onTab: (fn: (tab: unknown) => void) => {
      const listener = (_e: unknown, tab: unknown) => fn(tab);
      ipcRenderer.on('siq:browser:tab', listener);
      return () => ipcRenderer.removeListener('siq:browser:tab', listener);
    },
  },
});
