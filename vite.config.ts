import { defineConfig } from 'vitest/config';

// Dev server, static dist/ build (no server logic), and Vitest (unit + property, Node env).
export default defineConfig({
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
    // Task 19.8: the game and the model-lab dev page (also served by the preview build Playwright uses).
    rollupOptions: {
      input: { main: 'index.html', modelLab: 'model-lab.html' },
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/property/**/*.test.ts'],
    environment: 'node',
  },
});
