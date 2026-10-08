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
  test: {
    include: ['test/**/*.test.ts'],
    // Several tests integrate thousands of orbital steps; shared CI machines can take a few
    // times longer than a desktop, well past the 5 s default.
    testTimeout: 60_000,
  },
});
