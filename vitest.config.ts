import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest runs the pure core in a Node environment (no jsdom): the tested modules
 * are framework-agnostic and pull in no DOM/React at runtime. The `@` alias
 * mirrors the tsconfig path mapping without an extra resolver plugin.
 *
 * Coverage (`npm run test:coverage`) is scoped to the layers this environment
 * can exercise — the pure core, the store, the run controller, the server
 * modules, and the route handler. React components, hooks, and pages are left
 * out on purpose: they need a DOM environment, and reporting them as 0% would
 * only dilute the signal the thresholds guard. The thresholds sit a few points
 * under the measured values, so they catch a real drop without failing on noise.
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
    coverage: {
      provider: 'v8',
      include: ['src/{utils,store,services,server,config,types}/**', 'src/app/api/**'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary', 'html'],
      thresholds: {
        statements: 88,
        lines: 88,
        functions: 85,
        branches: 80,
      },
    },
  },
});
