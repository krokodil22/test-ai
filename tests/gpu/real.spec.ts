import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
test('identical production files work in the domain root and repository subpath', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  for (const path of ['/', '/test-ai/']) {
    await page.goto(path);
    await expect(page.locator('h1')).toContainText('вашей мысли');
    await expect(page.locator('#compatibility')).not.toContainText('Проверяем');
    await page.locator('#settings-open').click();
    await expect(page.locator('#resource-location')).toHaveText(`http://127.0.0.1:4173${path}models/qwen2.5-1.5b/`);
    await page.locator('#settings-close').click();
  }
  expect(failures).toEqual([]);
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
  test.skip(!existsSync('dist/models/qwen2.5-1.5b/model-info.json'), 'Full verified model resources are not built. Run npm run model:download and npm run build before this test.');
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
