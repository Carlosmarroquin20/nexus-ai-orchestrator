import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest runs the pure core in a Node environment (no jsdom): the tested modules
 * are framework-agnostic and pull in no DOM/React at runtime. The `@` alias
 * mirrors the tsconfig path mapping without an extra resolver plugin.
 *
 * Coverage (`npm run test:coverage`) is scoped to the layers this environment
 * can exercise — the pure core, the store, the run controller, the server
 * modules, the route handler, and the command-line runner's pure modules.
 * React components, hooks, and pages are left out on purpose: they need a DOM
 * environment, and reporting them as 0% would only dilute the signal the
 * thresholds guard. The thresholds sit a few points
 * under the measured values, so they catch a real drop without failing on noise.
 * They are calibrated for the AST-based V8 remapping used since Vitest 4, which
 * counts statements and branches differently from earlier versions.
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
      include: [
        'src/{utils,store,services,server,config,types,cli}/**',
        'src/app/api/**',
        'src/proxy.ts',
      ],
      // The runner's entry point is its I/O shell; the logic it wires is covered.
      exclude: ['src/**/*.test.ts', 'src/cli/eval.ts'],
      reporter: ['text-summary', 'html'],
      thresholds: {
        statements: 85,
        lines: 88,
        functions: 82,
        branches: 74,
      },
    },
  },
});
