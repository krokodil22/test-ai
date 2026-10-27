import { defineConfig } from '@playwright/test';
import config from './playwright.config';
import source from './scripts/model-source.json' with { type: 'json' };
export default defineConfig({
  ...config,
  testMatch: 'storage.spec.ts',
  testIgnore: [],
  workers: 1,
  fullyParallel: false,
  outputDir: './test-results/cors',
  use: { ...config.use, baseURL: 'http://127.0.0.1:5175/test-ai/' },
  webServer: [{
    command: `E2E_MOCK=1 VITE_BASE_PATH=/test-ai/ VITE_MODEL_BASE_URL=http://127.0.0.1:5176/models/${source.directory}/ npm run dev -- --host 127.0.0.1 --port 5175 --strictPort`,
    url: 'http://127.0.0.1:5175/test-ai/',
    reuseExistingServer: false,
  }, {
    command: 'node tests/fixtures/model-server.mjs',
    url: 'http://127.0.0.1:5176/health',
    reuseExistingServer: false,
  }],
});
