import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base './' so the built files load from file:// inside Electron.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
