import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** The dev server needs inline scripts (React refresh) and its own WebSocket; the built app keeps the strict policy. */
const devCsp = (): Plugin => ({
  name: 'siq-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''),
});

// base './' so the built files load from file:// inside Electron.
export default defineConfig({
  base: './',
  plugins: [react(), devCsp()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
