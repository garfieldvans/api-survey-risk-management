import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `dist/` berisi file *.test.js hasil compile tsc (artefak `pnpm build`).
    // File itu CommonJS dan gagal import vitest — kecualikan supaya `pnpm test`
    // hanya menjalankan test sumber di src/.
    exclude: ['**/node_modules/**', '**/dist/**', 'scripts/**', '**/.e2e-tmp/**'],
  },
});
