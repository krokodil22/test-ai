import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import source from '../../scripts/model-source.json' with { type: 'json' };
test('identical production files work in the domain root and repository subpath', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  for (const path of ['/', '/test-ai/']) {
    await page.goto(path);
    await expect(page.locator('h1')).toContainText('вашей мысли');
    await expect(page.locator('#compatibility')).not.toContainText('Проверяем');
    await page.locator('#settings-open').click();
    await expect(page.locator('#resource-location')).toHaveText(`http://127.0.0.1:4173${path}models/${source.directory}/`);
    await page.locator('#settings-close').click();
    await page.goto(path + 'compare.html');
    await expect(page.locator('h1')).toContainText('Мешает ли штраф за повторы');
    await expect(page.locator('#model-status')).not.toContainText('Проверяем');
    await expect(page.locator('#comparison-test-engine')).toHaveCount(0);
  }
  expect(failures).toEqual([]);
});
test('REAL MODEL: exports a direct versus English-bridge experiment for human review', async ({ page }) => {
  test.skip(!existsSync(`dist/models/${source.directory}/model-info.json`), 'Verified model resources are not built.');
  await page.goto('/compare.html?mode=translation');
  await expect(page.locator('#model-status')).not.toContainText('Проверяем');
  test.skip(await page.locator('#comparison-load').isDisabled(), 'A compatible WebGPU adapter with shader-f16 is unavailable.');
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled({ timeout: 600000 });
  await page.locator('#comparison-run').click();
  await expect(page.locator('#comparison-stop')).toBeVisible();
  await expect(page.locator('#comparison-stop')).toBeHidden({ timeout: 600000 });
  await expect(page.locator('#comparison-export')).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.locator('#comparison-export').click();
  const file = await download;
  await test.info().attach('real-model-comparison', { path: (await file.path())!, contentType: 'application/json' });
  // This produces real outputs and timings; there is no automatic claim that
  // either story is better. Read the artifact to assess translation fidelity.
});
test('REAL MODEL: exports Russian answers with thinking enabled and disabled for human review', async ({ page }) => {
  test.skip(!existsSync(`dist/models/${source.directory}/model-info.json`), 'Verified model resources are not built.');
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('/compare.html?mode=thinking');
  await expect(page.locator('#model-status')).not.toContainText('Проверяем');
  test.skip(await page.locator('#comparison-load').isDisabled(), 'A compatible WebGPU adapter with shader-f16 is unavailable.');
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled({ timeout: 600000 });
  await page.locator('#comparison-run').click();
  await expect(page.locator('#comparison-stop')).toBeVisible();
  await expect(page.locator('#comparison-stop')).toBeHidden({ timeout: 600000 });
  await expect(page.locator('#comparison-export')).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.locator('#comparison-export').click();
  const file = await download;
  const path = (await file.path())!;
  await test.info().attach('real-model-thinking-comparison', { path, contentType: 'application/json' });
  const report = JSON.parse(await readFile(path, 'utf8'));
  expect(report.testing).toBe(false);
  expect(report.settings.thinking.extra_body.enable_thinking).toBe(true);
  expect(report.reports[0].result.stages.map((stage: { stage: string }) => stage.stage)).toEqual(['direct', 'thinking']);
  expect(requests.filter(url => url.includes('/translations/'))).toHaveLength(0);
  // This captures actual quality and truncation for human review, never a
  // mocked quality claim or a requirement that reasoning must improve it.
});
test('REAL MODEL: exports Russian answers with and without a repetition penalty', async ({ page }) => {
  test.skip(!existsSync(`dist/models/${source.directory}/model-info.json`), 'Verified model resources are not built.');
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('/compare.html');
  await expect(page.locator('#model-status')).not.toContainText('Проверяем');
  test.skip(await page.locator('#comparison-load').isDisabled(), 'A compatible WebGPU adapter with shader-f16 is unavailable.');
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled({ timeout: 600000 });
  await page.locator('#comparison-run').click();
  await expect(page.locator('#comparison-stop')).toBeVisible();
  await expect(page.locator('#comparison-stop')).toBeHidden({ timeout: 600000 });
  await expect(page.locator('#comparison-export')).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.locator('#comparison-export').click();
  const file = await download;
  const path = (await file.path())!;
  await test.info().attach('real-model-penalty-comparison', { path, contentType: 'application/json' });
  const report = JSON.parse(await readFile(path, 'utf8'));
  expect(report.testing).toBe(false);
  expect(report.mode).toBe('penalty');
  expect(report.reports[0].result.stages.map((stage: { effectiveRepetitionPenalty: number }) => stage.effectiveRepetitionPenalty)).toEqual([1.1, 1]);
  expect(requests.filter(url => url.includes('/translations/'))).toHaveLength(0);
  // Inspect the attached answers for language, meaning and repetition. No
  // automatic quality claim is made, including when an answer hits its limit.
});
test('production page checks real WebGPU before making model requests', async ({ page }) => {
  const modelRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/models/')) modelRequests.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('#compatibility')).not.toContainText('Проверяем');
  expect(modelRequests).toHaveLength(0);
  const gpu = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    return { webgpu: !!navigator.gpu, adapter: !!adapter, f16: !!adapter?.features.has('shader-f16') };
  });
  console.log('Actual browser capabilities:', JSON.stringify(gpu));
  if (!gpu.adapter || !gpu.f16) await expect(page.locator('#load-model')).toBeDisabled();
  await page.screenshot({ path: 'test-results/production-webgpu-check.png', fullPage: true });
});
test('REAL MODEL: first load, chat, stop, cache reload, independent cleanup and network audit', async ({ page }) => {
  test.skip(!existsSync(`dist/models/${source.directory}/model-info.json`), 'Full verified model resources are not built. Run npm run model:download and npm run build before this test.');
  await page.goto('/');
  await expect(page.locator('#compatibility')).not.toContainText('Проверяем');
  test.skip(await page.locator('#load-model').isDisabled(), 'A compatible WebGPU adapter with shader-f16 is unavailable in this browser.');
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  page.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
  await page.locator('#load-model').click();
  await expect(page.locator('#engine-status')).toContainText('Готов к разговору', { timeout: 600000 });
  await page.locator('#prompt').fill('Ответь на русском: как называется столица Франции?');
  await page.locator('#send').click();
  await expect(page.locator('#stop')).toBeHidden({ timeout: 180000 });
  await expect(page.locator('.message-assistant')).toContainText(/Париж/i);
  // Small language regressions on the actual model, never a mock substitute.
  for (const [prompt, expected] of [
    ['Исправь грамматическую ошибку в предложении: «Они идёт домой». Ответь только исправленным предложением.', /Они идут домой/i],
    ['Переведи на русский: Good morning. Ответь только переводом.', /Доброе утро/i],
  ] as const) {
    await page.locator('#new-chat').click();
    await page.locator('#prompt').fill(prompt);
    await page.locator('#send').click();
    await expect(page.locator('#stop')).toBeHidden({ timeout: 180000 });
    await expect(page.locator('.message-assistant')).toContainText(expected);
  }
  await page.locator('#new-chat').click();
  await page.locator('#prompt').fill('Придумай короткий поучительный рассказ про свинку, которая не умела плавать');
  await page.locator('#send').click();
  await expect(page.locator('#stop')).toBeHidden({ timeout: 180000 });
  const story = await page.locator('.message-assistant .message-content').innerText();
  await test.info().attach('russian-story', { body: story, contentType: 'text/plain' });
  expect(story.length).toBeGreaterThan(180);
  expect(story).toMatch(/свин|порос/iu);
  // Regress the reported "вдруг, вдруг, вдруг" loop without fixing a single
  // golden story. The attached full text still needs human quality review.
  expect(story).not.toMatch(/(\p{L}{3,})[,\s]+\1[,\s]+\1/iu);
  await page.locator('#prompt').fill('Расскажи подробно об истории Франции.');
  await page.locator('#send').click();
  await expect(page.locator('.message-assistant').last().locator('.message-content')).not.toHaveText('', { timeout: 120000 });
  await page.locator('#stop').click();
  await expect(page.locator('#stop')).toBeHidden();
  const before = requests.length;
  await page.reload();
  await page.locator('#quick-start').click();
  await expect(page.locator('#engine-status')).toContainText('Готов к разговору', { timeout: 180000 });
  expect(requests.slice(before).filter(request => request.url.includes('/models/'))).toHaveLength(0);
  for (const request of requests) { expect(request.method).toBe('GET'); expect(request.body).toBeNull(); expect(request.url).not.toContain('Франции'); }
  await page.locator('#settings-open').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-model').click();
  await expect(page.locator('#cache-status')).toContainText('не сохранена');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-history').click();
  expect(await page.evaluate(() => localStorage.getItem('ryadom:chats:v1'))).toBeNull();
});
