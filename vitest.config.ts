import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@siteinquisition\/codecs\/jsonpath$/, replacement: fileURLToPath(new URL('./packages/codecs/src/jsonpath.ts', import.meta.url)) },
      { find: /^@siteinquisition\/codecs$/, replacement: src('codecs') },
      { find: /^@siteinquisition\/core$/, replacement: src('core') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
