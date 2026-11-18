import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Postgres container start-up dominates the first test of the DB suites.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
