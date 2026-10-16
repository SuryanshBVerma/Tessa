import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'Context/**'],
    // Integration tests start real MCP servers and the TypeScript compiler; 5 s is too tight
    // on a loaded machine.
    testTimeout: 30_000,
  },
});
