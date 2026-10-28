import { test, expect } from '@playwright/test';
import type { BrowserContext, Request } from '@playwright/test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import main from '../../scripts/model-source.json' with { type: 'json' };
import light from '../../scripts/light-model-source.json' with { type: 'json' };
import economy from '../fixtures/low-memory-runtime.json' with { type: 'json' };
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function resources(context: BrowserContext, failLight = false) {
  const requests: Request[] = [];
  context.on('request', request => requests.push(request));
  await context.route('**/models/**', async route => {
    const url = route.request().url();
    const model = url.includes('/' + light.directory + '/') ? light : main;
    if (url.endsWith('/' + economy.path)) { await route.fulfill({ body: 'fixture-low-memory-wasm' }); return; }
    const files = [
      { path: 'model.wasm', scope: 'webllm/wasm', body: model.modelId + '-runtime' },
      { path: 'resolve/main/mlc-chat-config.json', scope: 'webllm/config', body: '{}' },
      { path: 'resolve/main/tensor-cache.json', scope: 'webllm/model', body: '{"records":[]}' },
      { path: 'resolve/main/tokenizer.json', scope: 'webllm/model', body: '{}' },
      { path: 'resolve/main/params_shard_0.bin', scope: 'webllm/model', body: model.modelId + '-weights' },
    ];
    const info = { schema: 1, modelId: model.modelId, revision: model.revision, downloadBytes: model.downloadBytes, files: files.map(file => ({ path: file.path, scope: file.scope, bytes: Buffer.byteLength(file.body), sha256: sha(file.body), ...(file.path.endsWith('.bin') ? { download: { path: file.path + '.gz', bytes: gzipSync(file.body).length, sha256: sha(gzipSync(file.body)), encoding: 'gzip' } } : {}) })) };
    if (failLight && model === light && url.endsWith('.gz')) { await route.fulfill({ status: 503, body: 'unavailable' }); return; }
    const file = files.find(file => url.endsWith('/' + file.path + (file.path.endsWith('.bin') ? '.gz' : '')));
    const body = url.endsWith('/model-info.json') ? JSON.stringify(info) : file ? file.path.endsWith('.bin') ? gzipSync(file.body) : file.body : undefined;
    await route.fulfill({ status: body === undefined ? 404 : 200, body: body || '', contentType: 'application/octet-stream' });
  });
  return requests;
}
const modelRequests = (requests: Request[]) => requests.filter(request => request.url().includes('/models/'));

test('defaults to 4B economy, switches both ways without re-downloading or losing chat, and deletes only the selected cache', async ({ page, context }) => {
  const requests = await resources(context);
  await page.goto('./');
  await expect(page.locator('#load-model')).toBeEnabled();
  await page.locator('#settings-open').click();
  await expect(page.getByRole('combobox', { name: 'Модель', exact: true })).toHaveValue(main.directory);
  await expect(page.getByRole('combobox', { name: 'Режим памяти' })).toHaveValue('economy');
  expect(modelRequests(requests)).toHaveLength(0);
  await page.locator('#settings-start').click();
  await expect(page.locator('#engine-status')).toContainText('Экономичный режим');
  await page.locator('#prompt').fill('Личная переписка СЕКРЕТ-853'); await page.locator('#send').click();
  await expect(page.locator('#stop')).toBeHidden();
  const before = modelRequests(requests).length;
  await page.locator('#settings-open').click();
  await page.locator('#model-select').selectOption(light.directory);
  await expect(page.locator('#model-select')).toBeEnabled();
  await expect(page.locator('.model-label')).toHaveText(light.displayName);
  await expect(page.locator('#engine-status')).toContainText('не запущена');
  await expect(page.getByRole('combobox', { name: 'Режим памяти' })).toBeHidden();
  expect(modelRequests(requests)).toHaveLength(before);
  await page.locator('#settings-start').click();
  await expect(page.locator('#engine-status')).toContainText('Готов к разговору');
  await expect(page.locator('.message-user')).toContainText('СЕКРЕТ-853');
  await expect(page.locator('#prompt')).toHaveAttribute('maxlength', '600');
  await page.locator('#prompt').fill('Ещё короткий вопрос'); await page.locator('#send').click();
  await expect(page.locator('#stop')).toBeHidden();
  const bothLoaded = modelRequests(requests).length;
  await page.locator('#settings-open').click(); await page.locator('#model-select').selectOption(main.directory);
  await expect(page.locator('#settings-start')).toBeVisible();
  await page.locator('#settings-start').click(); await expect(page.locator('#engine-status')).toContainText('Экономичный режим');
  expect(modelRequests(requests)).toHaveLength(bothLoaded);
  await page.locator('#settings-open').click(); await page.locator('#model-select').selectOption(light.directory);
  await expect(page.locator('#settings-start')).toBeVisible();
  await page.reload();
  await expect(page.locator('.model-label')).toHaveText(light.displayName);
  await expect(page.locator('#quick-start')).toContainText('из кеша');
  await page.locator('#quick-start').click(); await expect(page.locator('#engine-status')).toContainText('Готов к разговору');
  expect(modelRequests(requests)).toHaveLength(bothLoaded);
  await page.locator('#settings-open').click(); page.once('dialog', dialog => dialog.accept()); await page.locator('#delete-model').click();
  await expect(page.locator('#cache-status')).toContainText('не сохранена');
  const retained = await page.evaluate(async ({ big, small }) => {
    const metadata = await caches.open('ryadom/metadata-v1');
    const root = new URL('models/', document.baseURI);
    return { big: !!await metadata.match(new URL(big + '/model-info.json', root)), small: !!await metadata.match(new URL(small + '/model-info.json', root)), history: localStorage.getItem('ryadom:chats:v1') };
  }, { big: main.directory, small: light.directory });
  expect(retained.big).toBe(true); expect(retained.small).toBe(false); expect(retained.history).toContain('СЕКРЕТ-853');
  for (const request of modelRequests(requests)) { expect(request.method()).toBe('GET'); expect(request.postData()).toBeNull(); expect(request.url()).not.toContain('СЕКРЕТ'); expect(new URL(request.url()).origin).toBe('http://127.0.0.1:5174'); }
});

test('blocks model changes during generation and preserves the big cache after a failed light download', async ({ page, context }) => {
  await resources(context, true); await page.goto('./');
  await page.locator('#load-model').click(); await expect(page.locator('#engine-status')).toContainText('Готов к разговору');
  await page.locator('#prompt').fill('Вопрос [slow]'); await page.locator('#send').click();
  await page.locator('#settings-open').click(); await expect(page.locator('#model-select')).toBeDisabled();
  await page.locator('#settings-close').click(); await page.locator('#stop').click(); await expect(page.locator('#stop')).toBeHidden();
  await page.locator('#settings-open').click(); await page.locator('#model-select').selectOption(light.directory);
  await expect(page.locator('#settings-start')).toBeVisible(); await page.locator('#settings-start').click();
  await expect(page.locator('#notice')).toContainText('загрузить ресурсы');
  await expect(page.locator('.model-label')).toHaveText(light.displayName);
  await page.locator('#settings-open').click(); await page.locator('#model-select').selectOption(main.directory);
  await expect(page.locator('#cache-status')).toContainText('сохранены');
});

test('light diagnostics uses its own model without a Qwen3 thinking prefix or an unrelated CPU reference', async ({ page, context }) => {
  await resources(context);
  await page.addInitScript(key => localStorage.setItem('tetrikanets:model:v1', key), light.directory);
  await page.goto('./diagnostics.html'); await expect(page.locator('#diagnostic-load')).toBeEnabled();
  await page.locator('#diagnostic-load').click(); await expect(page.locator('#diagnostic-run')).toBeEnabled();
  await page.locator('#diagnostic-run').click(); await expect(page.locator('#diagnostic-export')).toBeEnabled();
  const download = page.waitForEvent('download'); await page.locator('#diagnostic-export').click();
  const report = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(report.modelId).toBe(light.modelId); expect(report.complete).toBe(true); expect(report.results).toHaveLength(6);
  expect(report.runtime).toMatchObject({ memoryMode: 'standard', contextTokens: 2048, maxBatchSize: 1, prefillChunkSize: 256 });
  expect(report.reference.status).toBe('unavailable');
});

test('light penalty comparison uses its own limits and thinking is unavailable before any download', async ({ page, context }) => {
  const requests = await resources(context);
  await page.addInitScript(key => localStorage.setItem('tetrikanets:model:v1', key), light.directory);
  await page.goto('./compare.html?mode=thinking');
  await expect(page.locator('#comparison-notice')).toContainText('рассуждений недоступен');
  await expect(page.locator('#comparison-load')).toBeDisabled();
  expect(modelRequests(requests)).toHaveLength(0);
  await page.goto('./compare.html?mode=penalty');
  await page.locator('#comparison-load').click(); await expect(page.locator('#comparison-run')).toBeEnabled();
  await page.locator('#comparison-prompt').fill('Короткая инструкция'); await page.locator('#comparison-run').click();
  await expect(page.locator('#comparison-export')).toBeEnabled();
  const download = page.waitForEvent('download'); await page.locator('#comparison-export').click();
  const report = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(report.modelId).toBe(light.modelId); expect(report.settings.answer.maxTokens).toBe(256);
  expect(report.settings.answer.extra_body).toBeUndefined(); expect(report.reports).toHaveLength(1);
});
