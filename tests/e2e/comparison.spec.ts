import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ context }) => {
  const files = [
    { path: 'model.wasm', scope: 'webllm/wasm', body: 'fixture-wasm' },
    { path: 'resolve/main/mlc-chat-config.json', scope: 'webllm/config', body: '{}' },
    { path: 'resolve/main/ndarray-cache.json', scope: 'webllm/model', body: '{}' },
    { path: 'resolve/main/tokenizer.json', scope: 'webllm/model', body: '{}' },
  ];
  const info = { schema: 1, modelId: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', revision: '9bd564b064631febf14deadcac492efb761d60c3', downloadBytes: 879804433, files: files.map(({ path, scope, body }) => ({ path, scope, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') })) };
  await context.route('**/models/**', async route => {
    const path = route.request().url();
    const body = path.endsWith('/model-info.json') ? JSON.stringify(info) : files.find(file => path.endsWith('/' + file.path))?.body;
    await route.fulfill({ status: body === undefined ? 404 : 200, body: body || '', contentType: 'application/octet-stream' });
  });
});

test('compares through the real worker protocol, exports labeled test results, preserves history and keeps requests local', async ({ page, context }) => {
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  context.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
  await page.goto('compare.html');
  await expect(page.locator('#comparison-load')).toBeEnabled();
  expect(requests.filter(request => request.url.includes('/models/'))).toHaveLength(0);
  await page.evaluate(() => localStorage.setItem('ryadom:chats:v1', '{"existing":"history"}'));
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled();
  await page.locator('#comparison-prompt').fill('Личный тест СЕКРЕТ-963');
  await page.locator('#comparison-run').click();
  await expect(page.locator('#comparison-stop')).toBeVisible();
  await expect(page.locator('#comparison-prompt')).toBeDisabled();
  await expect(page.locator('#comparison-stop')).toBeHidden();
  await expect(page.locator('#result-translated')).toContainText('Тестовый русский перевод');
  await expect(page.locator('#result-direct')).toContainText('Здравствуйте');
  await expect(page.locator('#step-translate-output')).toHaveAttribute('data-state', 'complete');
  await page.locator('summary').click();
  await expect(page.locator('#result-input')).toContainText('TEST_ENGLISH_QUESTION');
  await expect(page.locator('#result-english')).toContainText('TEST_ENGLISH_ANSWER');
  await expect(page.locator('#comparison-test-engine')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#comparison-export').click();
  const file = await downloadPromise;
  const report = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(report.testing).toBe(true);
  expect(report.settings.translation.protocol).toBe('qwen-ru-en-opus-en-ru-v1');
  expect(report.settings.translation.output.modelId).toBe('Xenova/opus-mt-en-ru');
  expect(report.settings.translation.input.temperature).toBe(0);
  expect(report.settings.translation.input.effectiveRepetitionPenalty).toBe(1);
  expect(report.reports[0].result.stages).toHaveLength(4);
  expect(report.reports[0].result.prompt).toBe('Личный тест СЕКРЕТ-963');
  expect(await page.evaluate(() => localStorage.getItem('ryadom:chats:v1'))).toBe('{"existing":"history"}');
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe('http://127.0.0.1:5174');
    expect(request.method).toBe('GET'); expect(request.body).toBeNull();
    expect(request.url).not.toContain('СЕКРЕТ');
  }
});

test('stops the translation stage and can start another comparison without a stuck engine lock', async ({ page }) => {
  await page.goto('compare.html');
  await expect(page.locator('#comparison-load')).toBeEnabled();
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled();
  await page.locator('#comparison-prompt').fill('Придумай рассказ [slow]');
  await page.locator('#comparison-run').click();
  await expect(page.locator('#step-translate-input')).toHaveAttribute('data-state', 'running');
  await page.locator('#comparison-stop').click();
  await expect(page.locator('#comparison-stop')).toBeHidden();
  await expect(page.locator('#comparison-notice')).toContainText('остановлена');
  await expect(page.locator('#comparison-export')).toBeDisabled();
  await page.locator('#comparison-prompt').fill('Обычный вопрос');
  await page.locator('#comparison-run').click();
  await expect(page.locator('#comparison-export')).toBeEnabled();
});

test('reports an empty translation as incomplete and allows retry', async ({ page }) => {
  await page.goto('compare.html');
  await expect(page.locator('#comparison-load')).toBeEnabled();
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled();
  await page.locator('#comparison-prompt').fill('Вопрос [translation-empty]');
  await page.locator('#comparison-run').click();
  await expect(page.locator('#comparison-notice')).toContainText('пустой текст');
  await expect(page.locator('#comparison-export')).toBeDisabled();
  await expect(page.locator('#step-english-answer')).toHaveAttribute('data-state', 'pending');
  await expect(page.locator('#comparison-run')).toBeEnabled();
});

test('stops the separate CPU worker during the final translation and can compare again', async ({ page }) => {
  await page.goto('compare.html');
  await expect(page.locator('#comparison-load')).toBeEnabled();
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled();
  await page.locator('#comparison-prompt').fill('Вопрос [slow-opus]');
  await page.locator('#comparison-run').click();
  await expect(page.locator('#step-translate-output')).toHaveAttribute('data-state', 'running');
  await page.locator('#comparison-stop').click();
  await expect(page.locator('#comparison-stop')).toBeHidden();
  await expect(page.locator('#comparison-export')).toBeDisabled();
  await page.locator('#comparison-prompt').fill('Ещё вопрос');
  await page.locator('#comparison-run').click();
  await expect(page.locator('#comparison-export')).toBeEnabled();
});

test('does not continue when the input translator invents a story', async ({ page }) => {
  await page.goto('compare.html');
  await expect(page.locator('#comparison-load')).toBeEnabled();
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled();
  await page.locator('#comparison-prompt').fill('Придумай рассказ [translation-drift]');
  await page.locator('#comparison-run').click();
  await expect(page.locator('#comparison-notice')).toContainText('Длина перевода');
  await expect(page.locator('#comparison-export')).toBeDisabled();
  await expect(page.locator('#step-english-answer')).toHaveAttribute('data-state', 'pending');
  await expect(page.locator('#comparison-run')).toBeEnabled();
});

test('opens from chat settings in the same tab, reuses its cache and fits a narrow screen', async ({ page, context }) => {
  let modelRequests = 0;
  context.on('request', request => { if (request.url().includes('/models/')) modelRequests++; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await expect(page.locator('#load-model')).toBeEnabled();
  await page.locator('#load-model').click();
  await expect(page.locator('#engine-status')).toContainText('Готов к разговору');
  const loadedRequests = modelRequests;
  await page.locator('#menu-toggle').click();
  await page.locator('#settings-open').click();
  await page.locator('#comparison-open').click();
  await expect(page).toHaveURL(/\/test-ai\/compare\.html$/);
  await expect(page.locator('h1')).toContainText('Помогает ли перевод');
  await expect(page.locator('#comparison-load')).toContainText('из кеша');
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled();
  expect(modelRequests).toBe(loadedRequests);
  expect(context.pages()).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/comparison-mobile.png', fullPage: true });
});
