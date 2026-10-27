import { defineConfig } from '@playwright/test';
import config from './playwright.config';
export default defineConfig({
  ...config,
  testDir: './tests/archive',
  testIgnore: [],
  workers: 1,
  outputDir: './test-results/archive',
  use: { ...config.use, baseURL: 'http://127.0.0.1:5177/test-ai/' },
  webServer: {
    command: 'E2E_MOCK=1 VITE_BASE_PATH=/test-ai/ VITE_MODEL_DELIVERY=archive VITE_MODEL_ARCHIVE_URL=https://releases.example/model.tar npm run dev -- --host 127.0.0.1 --port 5177 --strictPort',
    url: 'http://127.0.0.1:5177/test-ai/',
    reuseExistingServer: false,
  },
});
