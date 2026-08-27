import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'scripts/__tests__/**/*.test.mjs'],
    // Keeps every test process off the developer's real `$HOME`. See the file
    // for the S2 incident that made it necessary.
    setupFiles: ['src/__tests__/setup/hermeticHome.ts'],
  },
});
