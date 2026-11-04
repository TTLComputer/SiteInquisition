// Sandboxed preload: exposes only how to reach the core and the theme switch.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('siq', {
  getConnection: (): Promise<{ url: string; token: string }> => ipcRenderer.invoke('siq:getConnection'),
  setTheme: (theme: 'system' | 'light' | 'dark'): Promise<void> => ipcRenderer.invoke('siq:setTheme', theme),
  platform: process.platform,
});
