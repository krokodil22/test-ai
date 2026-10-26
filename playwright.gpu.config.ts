import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
export default defineConfig({
  testDir: './tests/gpu',
  outputDir: './test-results/gpu',
  workers: 1,
  timeout: 15 * 60 * 1000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      args: ['--no-sandbox', '--disable-dev-shm-usage', ...(process.env.GPU_SOFTWARE === '1' ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'] : [])],
    },
  },
  webServer: {
    command: 'node tests/fixtures/static-server.mjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});
