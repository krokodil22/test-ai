import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';

test('REAL CPU MODEL: sentence meaning, negation, paragraphs, cache, stop, deletion and network privacy', async ({ page, context }) => {
  test.skip(!existsSync('dist/translations/opus-mt-en-ru/translation-info.json'), 'Run npm run translator:download and npm run build for the actual CPU model test.');
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  context.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
  await page.goto('/test-ai/translate.html');
  await expect(page.locator('#translation-load')).toBeEnabled();
  await expect(page.locator('#translation-test-engine')).toHaveCount(0);
  expect(requests.filter(request => request.url.includes('/translations/'))).toHaveLength(0);
  await page.locator('#translation-load').click();
  await expect(page.locator('#translation-run')).toBeEnabled({ timeout: 180000 });
  const source = 'The pig could not swim. With her expertise in aquatic survival techniques, Meryl managed to use the bank of the pond to pull the pig back onto dry land safely.\n\nThe farmer did not sell his three sheep.';
  await page.locator('#translation-file').setInputFiles({ name: 'comparison.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ reports: [{ result: { stages: [{ stage: 'english-answer', text: source }] } }] })) });
  await expect(page.locator('#translation-source')).toHaveValue(source);
  await expect(page.locator('#translation-notice')).toContainText('локально');
  await page.locator('#translation-run').click();
  await expect(page.locator('#translation-export')).toBeEnabled({ timeout: 120000 });
  const text = await page.locator('#translation-result').innerText();
  expect(text).toMatch(/свинья не умела плавать/iu);
  expect(text).toMatch(/вытащить свинью на сухую землю/iu);
  expect(text).toMatch(/не продал своих тр[её]х овец/iu);
  expect(text).toContain('\n\n');
  expect(text).not.toMatch(/на дно|пиглох|teaches us/iu);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/translator-mobile.png', fullPage: true });
  await test.info().attach('real-opus-translation', { body: text, contentType: 'text/plain' });
  const download = page.waitForEvent('download'); await page.locator('#translation-export').click();
  await test.info().attach('real-opus-report', { path: (await (await download).path())!, contentType: 'application/json' });
  const before = requests.length;
  await page.reload();
  await expect(page.locator('#translation-load')).toHaveText('Запустить из кеша');
  await page.locator('#translation-load').click();
  await expect(page.locator('#translation-run')).toBeEnabled({ timeout: 120000 });
  expect(requests.slice(before).filter(request => request.url.includes('/translations/'))).toHaveLength(0);
  await page.locator('#translation-source').fill('The pig could not swim. '.repeat(100));
  await page.locator('#translation-run').click();
  await expect(page.locator('#translation-status')).toContainText('Переведено предложений');
  await page.locator('#translation-stop').click();
  await expect(page.locator('#translation-stop')).toBeHidden({ timeout: 10000 });
  await expect(page.locator('#translation-export')).toBeDisabled();
  await expect(page.locator('#translation-run')).toBeEnabled();
  await page.locator('#translation-source').fill('The pig could not swim.');
  await page.locator('#translation-run').click();
  await expect(page.locator('#translation-result')).toContainText('Свинья не умела плавать', { timeout: 30000 });
  await page.evaluate(async () => {
    localStorage.setItem('translator-history-sentinel', 'preserve');
    await (await caches.open('webllm/model')).put('/keep-qwen-resource', new Response('keep'));
  });
  await page.locator('#translation-delete').click();
  await expect(page.locator('#translation-status')).toContainText('удалён');
  expect(await page.evaluate(() => localStorage.getItem('translator-history-sentinel'))).toBe('preserve');
  expect(await page.evaluate(async () => !!await (await caches.open('webllm/model')).match('/keep-qwen-resource'))).toBe(true);
  expect(await page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('tetrikanets/opus-en-ru/')))).toHaveLength(0);
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe('http://127.0.0.1:4173');
    expect(request.method).toBe('GET'); expect(request.body).toBeNull();
    expect(request.url).not.toContain('The%20pig');
  }
});

test('REAL CPU LOADER: rejects a wrong model revision before downloading weights', async ({ page }) => {
  await page.route('**/translation-info.json', route => route.fulfill({ json: { schema: 1, modelId: 'Xenova/opus-mt-en-ru', revision: 'wrong', transformers: '3.8.1', files: [] } }));
  const weights: string[] = [];
  page.on('request', request => { if (request.url().endsWith('.gz')) weights.push(request.url()); });
  await page.goto('/translate.html');
  await expect(page.locator('#translation-load')).toBeEnabled();
  await page.locator('#translation-load').click();
  await expect(page.locator('#translation-notice')).toContainText('Манифест переводчика');
  expect(weights).toHaveLength(0);
});

test('REAL CPU MODEL: supports browser-decoded Content-Encoding gzip and reuses that cache', async ({ page, context }) => {
  test.skip(!existsSync('dist/translations/opus-mt-en-ru/translation-info.json'), 'Translator resources are required.');
  await context.setExtraHTTPHeaders({ 'X-Test-Decode-Gzip': '1' });
  await page.goto('/translate.html');
  await page.locator('#translation-load').click();
  await expect(page.locator('#translation-run')).toBeEnabled({ timeout: 180000 });
  await page.locator('#translation-source').fill('The pig could not swim.');
  await page.locator('#translation-run').click();
  await expect(page.locator('#translation-result')).toContainText('Свинья не умела плавать', { timeout: 30000 });
  await page.reload();
  await expect(page.locator('#translation-load')).toHaveText('Запустить из кеша');
  const resources: string[] = [];
  page.on('request', request => { if (request.url().includes('/translations/')) resources.push(request.url()); });
  await page.locator('#translation-load').click();
  await expect(page.locator('#translation-run')).toBeEnabled({ timeout: 120000 });
  expect(resources).toHaveLength(0);
});

test('REAL CPU LOADER: rejects a damaged compressed runtime and leaves no poisoned cache', async ({ page }) => {
  test.skip(!existsSync('dist/translations/opus-mt-en-ru/translation-info.json'), 'Translator resources are required.');
  await page.route('**/runtime.wasm.gz', route => route.fulfill({ body: 'damaged-runtime', contentType: 'application/octet-stream' }));
  await page.goto('/translate.html');
  await expect(page.locator('#translation-load')).toBeEnabled();
  await page.locator('#translation-load').click();
  await expect(page.locator('#translation-notice')).toContainText('SHA256');
  expect(await page.evaluate(async () => {
    for (const name of await caches.keys()) if (name.startsWith('tetrikanets/opus-en-ru/')) {
      if ((await (await caches.open(name)).keys()).some(request => request.url.endsWith('/runtime.wasm.gz'))) return true;
    }
    return false;
  })).toBe(false);
});
