import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // image.ts needs a real canvas; it is exercised by the example app, not by unit tests.
      exclude: ['src/image.ts', 'src/index.ts'],
    },
  },
})
