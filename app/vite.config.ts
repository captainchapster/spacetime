import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Where the site is served from: '/' locally, '/spacetime/' on GitHub Pages.
  base: process.env.BASE_PATH ?? '/',
  build: {
    rollupOptions: {
      input: {
        sandbox: resolve(import.meta.dirname, 'index.html'),
        flight: resolve(import.meta.dirname, 'flight.html'),
      },
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
