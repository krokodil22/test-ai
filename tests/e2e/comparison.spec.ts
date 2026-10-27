import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import source from '../../scripts/model-source.json' with { type: 'json' };

test.beforeEach(async ({ context }) => {
  const files = [
    { path: 'model.wasm', scope: 'webllm/wasm', body: 'fixture-wasm' },
    { path: 'resolve/main/mlc-chat-config.json', scope: 'webllm/config', body: '{}' },
    { path: 'resolve/main/ndarray-cache.json', scope: 'webllm/model', body: '{}' },
    { path: 'resolve/main/tokenizer.json', scope: 'webllm/model', body: '{}' },
  ];
  const info = { schema: 1, modelId: source.modelId, revision: source.revision, downloadBytes: source.downloadBytes, files: files.map(({ path, scope, body }) => ({ path, scope, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') })) };
  await context.route('**/models/**', async route => {
    const path = route.request().url();
    const body = path.endsWith('/model-info.json') ? JSON.stringify(info) : files.find(file => path.endsWith('/' + file.path))?.body;
    await route.fulfill({ status: body === undefined ? 404 : 200, body: body || '', contentType: 'application/octet-stream' });
  });
});

test('compares through the real worker protocol, exports labeled test results, preserves history and keeps requests local', async ({ page, context }) => {
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  context.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
  await page.goto('compare.html?mode=translation');
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
  expect(report.modelId).toBe(source.modelId);
  expect(report.settings.answer.extra_body.enable_thinking).toBe(false);
  expect(report.settings.translation.input.extra_body.enable_thinking).toBe(false);
  for (const id of ['result-direct', 'result-input', 'result-english']) await expect(page.locator('#' + id)).not.toContainText('<think>');
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
  await page.goto('compare.html?mode=translation');
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
  await page.goto('compare.html?mode=translation');
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
  await page.goto('compare.html?mode=translation');
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
  await page.goto('compare.html?mode=translation');
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
  await expect(page.locator('h1')).toContainText('Помогают ли рассуждения');
  await expect(page.locator('#comparison-load')).toContainText('из кеша');
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled();
  expect(modelRequests).toBe(loadedRequests);
  expect(context.pages()).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/comparison-mobile.png', fullPage: true });
});

test('compares thinking modes in Russian without fetching a translator and exports separated reasoning and settings', async ({ page, context }) => {
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  context.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
  await page.goto('compare.html');
  await expect(page.locator('#comparison-load')).toBeEnabled();
  expect(requests.filter(request => request.url.includes('/models/'))).toHaveLength(0);
  await page.evaluate(() => localStorage.setItem('ryadom:chats:v1', '{"existing":"history"}'));
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled();
  await page.locator('#comparison-prompt').fill('Личный вопрос СЕКРЕТ-315');
  await page.locator('#comparison-run').click();
  await expect(page.locator('#comparison-prompt')).toBeDisabled();
  await expect(page.locator('#comparison-export')).toBeEnabled();
  await expect(page.locator('#result-direct')).toContainText('Здравствуйте');
  await expect(page.locator('#result-thinking')).toHaveText('Тестовый итоговый ответ с рассуждениями.');
  await expect(page.locator('#step-thinking')).toHaveAttribute('data-state', 'complete');
  await expect(page.locator('#result-thinking')).not.toContainText('Сначала проверю');
  await expect(page.locator('#result-thinking')).not.toContainText('<think>');
  await page.locator('summary').click();
  await expect(page.locator('#result-reasoning')).toContainText('Сначала проверю условие');
  await expect(page.locator('#reasoning-status')).toContainText('Рассуждения завершены');
  const download = page.waitForEvent('download');
  await page.locator('#comparison-export').click();
  const file = await download;
  const report = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(report.mode).toBe('thinking'); expect(report.testing).toBe(true);
  expect(report.settings.answer.extra_body.enable_thinking).toBe(false);
  expect(report.settings.answer.maxTokens).toBe(512);
  expect(report.settings.thinking.extra_body.enable_thinking).toBe(true);
  expect(report.settings.thinking.maxTokens).toBe(2048);
  expect(report.settings.thinking.budgetIncludesReasoningAndAnswer).toBe(true);
  expect(report.settings.thinking.temperature).toBe(report.settings.answer.temperature);
  expect(report.settings.thinking.top_p).toBe(report.settings.answer.top_p);
  expect(report.settings.translation).toBeUndefined();
  expect(report.reports[0].result.stages.map((stage: { stage: string }) => stage.stage)).toEqual(['direct', 'thinking']);
  const thinking = report.reports[0].result.stages[1];
  expect(thinking.thinking.status).toBe('complete');
  expect(thinking.text).not.toContain('Сначала проверю');
  expect(thinking.thinking.text).toContain('Сначала проверю');
  expect(thinking.generatedTokens).toBe(80);
  expect(thinking.firstAnswerSeconds).toBeGreaterThan(0);
  expect(thinking.firstAnswerSeconds).toBeLessThanOrEqual(thinking.seconds);
  expect(await page.evaluate(() => localStorage.getItem('ryadom:chats:v1'))).toBe('{"existing":"history"}');
  expect(requests.filter(request => /\/translations\/|ort-wasm|translator\.worker/.test(request.url))).toHaveLength(0);
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe('http://127.0.0.1:5174');
    expect(request.method).toBe('GET'); expect(request.body).toBeNull();
    expect(request.url).not.toContain('СЕКРЕТ');
  }
  // Repeat the complete pair on the same engine; a leaked stream lock hangs here.
  await page.locator('#comparison-run').click();
  await expect(page.locator('#comparison-export')).toBeEnabled();
  await expect(page.locator('#result-thinking')).toHaveText('Тестовый итоговый ответ с рассуждениями.');
  await page.screenshot({ path: 'test-results/thinking-comparison-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/thinking-comparison-mobile.png', fullPage: true });
});

test('stops during reasoning and can compare again without a stuck engine lock', async ({ page }) => {
  await page.goto('compare.html');
  await expect(page.locator('#comparison-load')).toBeEnabled();
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled();
  await page.locator('#comparison-prompt').fill('Короткий вопрос [slow-thinking]');
  await page.locator('#comparison-run').click();
  await expect(page.locator('#status-thinking')).toContainText('Думает');
  await expect(page.locator('#result-thinking')).toBeEmpty();
  await page.locator('#comparison-stop').click();
  await expect(page.locator('#comparison-stop')).toBeHidden();
  await expect(page.locator('#comparison-notice')).toContainText('остановлена');
  await expect(page.locator('#comparison-export')).toBeDisabled();
  await page.locator('#comparison-prompt').fill('Обычный вопрос');
  await page.locator('#comparison-run').click();
  await expect(page.locator('#comparison-export')).toBeEnabled();
});

for (const [marker, warning] of [
  ['thinking-unfinished', 'рассуждения не завершены'],
  ['thinking-empty-answer', 'итогового ответа нет'],
  ['thinking-missing', 'блок рассуждений не получен'],
]) test(`labels ${marker} honestly and retains it in exported results`, async ({ page }) => {
  const leaked: string[] = [];
  page.on('request', request => { if (request.url().includes('invalid.test')) leaked.push(request.url()); });
  await page.goto('compare.html');
  await expect(page.locator('#comparison-load')).toBeEnabled();
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled();
  await page.locator('#comparison-prompt').fill(`Рассказ [${marker}]`);
  await page.locator('#comparison-run').click();
  await expect(page.locator('#comparison-export')).toBeEnabled();
  await expect(page.locator('#comparison-notice')).toContainText(warning);
  await expect(page.locator('#step-thinking')).toHaveAttribute('data-state', 'warning');
  if (marker !== 'thinking-missing') {
    await expect(page.locator('#result-thinking')).toHaveText('Итоговый ответ не получен.');
    await expect(page.locator('#result-thinking')).not.toContainText('План');
  }
  const download = page.waitForEvent('download');
  await page.locator('#comparison-export').click();
  const file = await download;
  const report = JSON.parse(await readFile((await file.path())!, 'utf8'));
  const stage = report.reports[0].result.stages[1];
  expect(stage.thinking.status).toBe(marker === 'thinking-unfinished' ? 'unfinished' : marker === 'thinking-missing' ? 'missing' : 'complete');
  expect(leaked).toHaveLength(0);
  await expect(page.locator('#result-reasoning img')).toHaveCount(0);
});
