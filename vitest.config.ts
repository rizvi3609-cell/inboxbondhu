import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/__tests__/**/*.test.ts'],
    hookTimeout: 300_000, // first run downloads a mongod binary
    testTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }, // one shared replica set per run
    // Mongoose keeps one global model registry; per-file module isolation would
    // give each test file different class identities for plugins/errors.
    isolate: false,
  },
})
