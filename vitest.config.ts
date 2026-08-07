import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Native modules must match Node's ABI, and `npx vitest` bypasses the
    // pretest hook that would otherwise guarantee that.
    globalSetup: ['./scripts/vitest-global-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      include: ['src/main/**/*.ts'],
      exclude: ['src/main/main.ts', 'src/main/preload.ts'],
    },
  },
});
