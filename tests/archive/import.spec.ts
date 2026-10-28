import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import source from '../../scripts/model-source.json' with { type: 'json' };
test.beforeEach(async ({ context }) => { await context.addInitScript(() => localStorage.setItem('tetrikanets:memory-mode:v1', 'standard')); });
// @ts-expect-error Node-only publishing helper is intentionally plain JS.
import { tarHeader } from '../../scripts/create-model-archive.mjs';

const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const files = [
  { path: 'model.wasm', scope: 'webllm/wasm', body: Buffer.from('wasm fixture') },
  { path: 'resolve/main/mlc-chat-config.json', scope: 'webllm/config', body: Buffer.from('{}') },
  { path: `resolve/main/${source.cacheManifest}`, scope: 'webllm/model', body: Buffer.from('{"records":[]}') },
  { path: 'resolve/main/tokenizer.json', scope: 'webllm/model', body: Buffer.from('{}') },
  { path: 'resolve/main/params_shard_0.bin', scope: 'webllm/model', body: Buffer.from('local weights fixture') },
];
const info = { schema: 1, modelId: source.modelId, revision: source.revision, downloadBytes: 1000, files: files.map(({ path, scope, body }) => ({ path, scope, bytes: body.length, sha256: hash(body), ...(path.endsWith('.bin') ? { download: { encoding: 'gzip', path: path + '.gz', bytes: gzipSync(body).length, sha256: hash(gzipSync(body)) } } : {}) })) };
function archive() {
  const entries = [{ path: 'model-info.json', body: Buffer.from(JSON.stringify(info)) }, { path: 'LICENSE', body: Buffer.from('Fixture license') }, ...files.map(file => file.path.endsWith('.bin') ? { path: file.path + '.gz', body: gzipSync(file.body) } : file)];
  return Buffer.concat([...entries.flatMap(({ path, body }) => [tarHeader(path, body.length), body, Buffer.alloc((512 - body.length % 512) % 512)]), Buffer.alloc(1024)]);
}
for (const [url, load, ready] of [['./', '#load-model', '#engine-status'], ['compare.html', '#comparison-load', '#model-status'], ['diagnostics.html', '#diagnostic-load', '#diagnostic-status']]) {
  test(`imports an archive through the real Worker and reuses cache: ${url}`, async ({ page, context }) => {
    const requests: string[] = [];
    context.on('request', request => { if (request.url().includes('/models/')) requests.push(request.url()); expect(request.method()).toBe('GET'); expect(request.postData()).toBeNull(); });
    await context.route('**/models/**', route => route.fulfill({ status: route.request().url().endsWith('/model-info.json') ? 200 : 503, contentType: 'application/json', body: JSON.stringify(info) }));
    await page.goto(url);
    await expect(page.locator('.model-delivery')).toBeVisible(); await expect(page.locator(load)).toBeDisabled();
    expect(requests).toHaveLength(0);
    await page.getByLabel('Архив модели .tar').setInputFiles({ name: 'model.tar', mimeType: 'application/x-tar', buffer: archive() });
    await page.locator(load).click(); await expect(page.locator(ready)).toContainText(/Готов|готова/);
    expect(requests).toHaveLength(1); // Only the trusted local manifest, no weight GETs.
    await page.reload(); await page.locator(load).click(); await expect(page.locator(ready)).toContainText(/Готов|готова/);
    expect(requests).toHaveLength(1); await expect(page.locator('.model-delivery')).toBeHidden();
  });
}
test('rejects a corrupt archive without downloading weights or writing chat data', async ({ page, context }) => {
  await context.route('**/models/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(info) }));
  await page.goto('./');
  await page.getByLabel('Архив модели .tar').setInputFiles({ name: 'broken.tar', mimeType: 'application/x-tar', buffer: Buffer.alloc(2000) });
  await page.locator('#load-model').click(); await expect(page.locator('#notice')).toContainText('Архив модели');
  expect(await page.evaluate(() => localStorage.getItem('ryadom:chats:v1'))).toBeNull();
});
