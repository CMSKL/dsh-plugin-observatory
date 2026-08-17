import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 100,
        lines: 95,
      },
    },
  },
})
