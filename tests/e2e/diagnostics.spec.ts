import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import source from '../../scripts/model-source.json' with { type: 'json' };
test.beforeEach(async ({ context }) => { await context.addInitScript(() => { if (!localStorage.getItem('tetrikanets:memory-mode:v1')) localStorage.setItem('tetrikanets:memory-mode:v1', 'standard'); }); });
import profile from '../../src/diagnostic-cases.json' with { type: 'json' };
import { referenceFixture } from '../fixtures/reference';
test.beforeEach(async ({ context }) => {
  const files = [{ path: 'model.wasm', scope: 'webllm/wasm' }, { path: 'resolve/main/mlc-chat-config.json', scope: 'webllm/config' }, { path: `resolve/main/${source.cacheManifest}`, scope: 'webllm/model' }, { path: 'resolve/main/tokenizer.json', scope: 'webllm/model' }].map(file => ({ ...file, bytes: 2, sha256: createHash('sha256').update('{}').digest('hex') }));
  const info = { schema: 1, modelId: source.modelId, revision: source.revision, downloadBytes: source.downloadBytes, files };
  await context.route('**/models/**', route => route.fulfill({ body: route.request().url().endsWith('model-info.json') ? JSON.stringify(info) : '{}', contentType: 'application/json' }));
  await context.route('**/diagnostics/model-reference.json', route => route.fulfill({ body: JSON.stringify(referenceFixture), contentType: 'application/json' }));
});
async function load(page: import('@playwright/test').Page) {
  await page.goto('diagnostics.html');
  await expect(page.locator('#diagnostic-load')).toBeEnabled();
  await page.locator('#diagnostic-load').click();
  await expect(page.locator('#diagnostic-run')).toBeEnabled();
}
async function exportReport(page: import('@playwright/test').Page) {
  const download = page.waitForEvent('download');
  await page.locator('#diagnostic-export').click();
  const file = await download;
  return JSON.parse(await readFile((await file.path())!, 'utf8'));
}
test('audits the cache, runs all six cases through the real worker, exports hardware/reference, preserves history and network privacy', async ({ page, context }) => {
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  context.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
  await page.goto('diagnostics.html');
  await expect(page.locator('#diagnostic-load')).toBeEnabled();
  expect(requests.filter(request => request.url.includes('/models/'))).toHaveLength(0);
  await page.evaluate(() => localStorage.setItem('ryadom:chats:v1', '{"secret":"UNCHANGED-284"}'));
  await page.locator('#diagnostic-load').click();
  await expect(page.locator('#diagnostic-run')).toBeEnabled();
  const loaded = requests.length;
  await page.locator('#diagnostic-run').click();
  await expect(page.locator('#diagnostic-run')).toBeDisabled();
  await expect(page.locator('#diagnostic-export')).toBeEnabled();
  await expect(page.locator('#diagnostic-audit')).toContainText('SHA-256 совпал: 4 файлов');
  for (const item of profile.cases) {
    await expect(page.locator('#output-' + item.id)).not.toContainText('<think>');
    await expect(page.locator('#reference-' + item.id)).toContainText('TEST CPU REFERENCE');
  }
  const report = await exportReport(page);
  expect(report.kind).toBe('browser-diagnostics'); expect(report.complete).toBe(true); expect(report.testing).toBe(true);
  expect(report.results).toHaveLength(6);
  expect(report.cacheAudit).toMatchObject({ valid: true, checkedFiles: 4, checkedBytes: 8 });
  expect(report.environment.gpu.adapter.vendor).toBe('TEST ONLY');
  expect(report.environment.gpu.device.limits.maxStorageBufferBindingSize).toBe(155582464);
  expect(report.environment.browser.userAgent).toContain('Chrome');
  expect(report.reference.engine).toBe(referenceFixture.engine);
  expect(report.settings.temperature).toBe(0); expect(report.settings.enableThinking).toBe(false);
  expect(report.settings.systemPrompt).toBe(profile.systemPrompt);
  expect(report.results.map((result: { prompt: string }) => result.prompt)).toEqual(profile.cases.map(item => item.prompt));
  expect(await page.evaluate(() => localStorage.getItem('ryadom:chats:v1'))).toBe('{"secret":"UNCHANGED-284"}');
  await page.locator('#diagnostic-run').click();
  await expect(page.locator('#diagnostic-export')).toBeEnabled();
  expect(requests.slice(loaded).filter(request => request.url.includes('/models/'))).toHaveLength(0);
  expect((await exportReport(page)).results).toHaveLength(6);
  expect(requests.filter(request => /\/translations\/|ort-wasm|translator\.worker/.test(request.url))).toHaveLength(0);
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe('http://127.0.0.1:5174'); expect(request.method).toBe('GET'); expect(request.body).toBeNull();
    expect(request.url).not.toContain('UNCHANGED');
  }
  await page.screenshot({ path: 'test-results/diagnostics-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/diagnostics-mobile.png', fullPage: true });
});
test('stops the suite, exports it as incomplete and runs again without a stuck model lock', async ({ page }) => {
  await load(page); await page.locator('#diagnostic-run').click();
  await expect(page.locator('#diagnostic-stop')).toBeVisible();
  await page.locator('#diagnostic-stop').click();
  await expect(page.locator('#diagnostic-export')).toBeEnabled();
  const report = await exportReport(page);
  expect(report.complete).toBe(false); expect(report.stopped).toBe(true);
  await page.locator('#diagnostic-run').click();
  await expect(page.locator('#diagnostic-export')).toBeEnabled();
  expect((await exportReport(page)).complete).toBe(true);
});
test('rejects poisoned cached bytes despite their correct verification marker and exports the failure', async ({ page }) => {
  await load(page);
  await page.evaluate(async () => {
    const cache = await caches.open('webllm/model');
    for (const key of await cache.keys()) if (key.url.endsWith('tensor-cache.json')) {
      const response = await cache.match(key);
      await cache.put(key, new Response('corrupted', { headers: response!.headers }));
    }
  });
  await page.locator('#diagnostic-run').click();
  await expect(page.locator('#diagnostic-export')).toBeEnabled();
  const report = await exportReport(page);
  expect(report.complete).toBe(false); expect(report.results).toHaveLength(0); expect(report.cacheAudit.valid).toBe(false);
  expect(report.error).toBeTruthy();
});
test('exports browser capability errors without downloading weights and still shows the CPU reference', async ({ page, context }) => {
  const modelRequests: string[] = [];
  context.on('request', request => { if (request.url().includes('/models/')) modelRequests.push(request.url()); });
  await page.addInitScript(() => { (window as unknown as { __gpuFailure: string }).__gpuFailure = 'WebGPU недоступен'; });
  await page.goto('diagnostics.html');
  await expect(page.locator('#diagnostic-status')).toContainText('недоступен');
  await expect(page.locator('#reference-arithmetic-ru')).toContainText('TEST CPU REFERENCE');
  const report = await exportReport(page);
  expect(report.complete).toBe(false); expect(report.error).toContain('WebGPU'); expect(modelRequests).toHaveLength(0);
});
test('keeps diagnostics usable with a missing or mismatched reference', async ({ page, context }) => {
  await context.route('**/diagnostics/model-reference.json', route => route.fulfill({ body: JSON.stringify({ ...referenceFixture, protocol: 'wrong' }), contentType: 'application/json' }));
  await load(page);
  await expect(page.locator('#diagnostic-reference-status')).toContainText('несовместим');
  await page.locator('#diagnostic-run').click(); await expect(page.locator('#diagnostic-export')).toBeEnabled();
  const report = await exportReport(page); expect(report.complete).toBe(true); expect(report.reference.status).toBe('unavailable');
});
test('opens from chat settings in the same tab', async ({ page, context }) => {
  await page.goto('./'); await page.locator('#settings-open').click(); await page.locator('#diagnostics-open').click();
  await expect(page).toHaveURL(/\/test-ai\/diagnostics\.html$/);
  await expect(page.locator('h1')).toContainText('Как работает ваша модель'); expect(context.pages()).toHaveLength(1);
});
