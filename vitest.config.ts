import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest runs the pure core in a Node environment (no jsdom): the tested modules
 * are framework-agnostic and pull in no DOM/React at runtime. The `@` alias
 * mirrors the tsconfig path mapping without an extra resolver plugin.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
