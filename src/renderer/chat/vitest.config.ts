import { defineConfig } from 'vitest/config';

// Renderer-only tests must not rebuild shared Electron/Node native binaries.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/renderer/chat/**/*.test.{ts,tsx}'],
  },
});
