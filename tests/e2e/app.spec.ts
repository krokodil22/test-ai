import { test, expect } from '@playwright/test';
import type { Page, BrowserContext, Request } from '@playwright/test';
import { createHash } from 'node:crypto';
const modelId = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';
const files = [
  { path: 'model.wasm', scope: 'webllm/wasm', body: 'wasm-test-fixture' },
  { path: 'resolve/main/mlc-chat-config.json', scope: 'webllm/config', body: '{}' },
  { path: 'resolve/main/ndarray-cache.json', scope: 'webllm/model', body: '{"records":[]}' },
  { path: 'resolve/main/tokenizer.json', scope: 'webllm/model', body: '{}' },
  { path: 'resolve/main/params_shard_0.bin', scope: 'webllm/model', body: 'fixture-weights' },
];
async function resources(context: BrowserContext, options: { fail?: boolean; corrupt?: boolean; external?: boolean } = {}) {
  const resourceFiles = files.map(file => ({ ...file }));
  if (options.external) resourceFiles[2].body = JSON.stringify({ externalURL: 'https://unconfigured.example/leak' });
  const info = {
    schema: 1, modelId, revision: 'test-fixture', downloadBytes: 400000000,
    files: resourceFiles.map(({ path, scope, body }) => ({ path, scope, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') })),
  };
  const requests: Request[] = [];
  context.on('request', request => requests.push(request));
  await context.route('**/models/**', async route => {
    if (options.fail) { await route.fulfill({ status: 503, body: 'Unavailable' }); return; }
    const url = route.request().url();
    const file = resourceFiles.find(file => url.endsWith('/' + file.path));
    const body = url.endsWith('/model-info.json') ? JSON.stringify(info) : options.corrupt && file?.path === 'model.wasm' ? 'broken' : file?.body;
    await route.fulfill({ status: body === undefined ? 404 : 200, contentType: url.endsWith('.json') ? 'application/json' : 'application/octet-stream', body: body || '' });
  });
  return requests;
}
async function start(page: Page) {
  await page.goto('./');
  await expect(page.locator('#load-model')).toBeEnabled();
  await page.locator('#load-model').click();
  await expect(page.locator('#engine-status')).toContainText('Готов к разговору');
}
test('first run, streaming dialog, keyboard, Markdown, copy, local history and network privacy', async ({ page, context }) => {
  const requests = await resources(context);
  await page.goto('./');
  await expect(page.locator('#load-model')).toBeEnabled();
  expect(requests.filter(request => request.url().includes('/models/'))).toHaveLength(0);
  await page.screenshot({ path: 'test-results/welcome-desktop.png', fullPage: true });
  await page.locator('#load-model').click();
  await expect(page.locator('#load-progress')).toBeVisible();
  await expect(page.locator('#engine-status')).toContainText('Готов к разговору');
  const prompt = 'Личный текст ДРАКОН-724: помоги мне разобраться.';
  await page.locator('#prompt').fill(prompt);
  await page.locator('#prompt').press('Shift+Enter');
  await expect(page.locator('#prompt')).toHaveValue(prompt + '\n');
  await page.locator('#prompt').press('Enter');
  await expect(page.locator('#stop')).toBeVisible();
  await expect(page.locator('#new-chat')).toBeDisabled();
  await expect(page.locator('.message-assistant .message-content')).toContainText('Здравствуйте');
  await expect(page.locator('#stop')).toBeHidden();
  await expect(page.locator('.message-assistant strong')).toContainText('Здравствуйте');
  await expect(page.locator('pre code')).toContainText('console.log');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('.copy-code').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('console.log');
  await page.screenshot({ path: 'test-results/chat-desktop.png', fullPage: true });
  expect(requests.filter(request => request.url().includes('/models/'))).toHaveLength(6);
  for (const request of requests) {
    expect(new URL(request.url()).origin).toBe('http://127.0.0.1:5174');
    expect(request.method()).toBe('GET');
    expect(request.url()).not.toContain('ДРАКОН');
    expect(request.postData()).toBeNull();
  }
  await page.reload();
  await expect(page.locator('.message-user')).toContainText(prompt);
  await expect(page.locator('#quick-start')).toBeVisible();
});
test('reuses every cached resource after reload and deletes model independently of history', async ({ page, context }) => {
  const requests = await resources(context);
  await start(page);
  await page.locator('#prompt').fill('Сохрани эту переписку');
  await page.locator('#send').click();
  await expect(page.locator('#stop')).toBeHidden();
  const before = requests.filter(request => request.url().includes('/models/')).length;
  await page.reload();
  await expect(page.locator('#quick-start')).toContainText('из кеша');
  await page.locator('#quick-start').click();
  await expect(page.locator('#engine-status')).toContainText('Готов к разговору');
  await expect(page.locator('.message-user')).toContainText('Сохрани эту переписку');
  expect(requests.filter(request => request.url().includes('/models/')).length).toBe(before);
  await page.locator('#settings-open').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-model').click();
  await expect(page.locator('#cache-status')).toContainText('не сохранена');
  expect(await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).length))).reduce((a,b) => a+b,0))).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('ryadom:chats:v1'))).toContain('Сохрани эту переписку');
});
test('stops two successive generations, new chat preserves previous chat, clears history separately', async ({ page, context }) => {
  await resources(context); await start(page);
  for (let i = 0; i < 2; i++) {
    await page.locator('#prompt').fill('Ответь подробно ' + i);
    await page.locator('#send').click();
    await expect(page.locator('.message-assistant').last().locator('.message-content')).toContainText('Здравствуйте');
    await page.locator('#stop').click();
    await expect(page.locator('#stop')).toBeHidden();
    await expect(page.locator('.message-meta').last()).toContainText('Ответ остановлен');
  }
  await page.locator('#new-chat').click();
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('.chat-item')).toHaveCount(1);
  await page.locator('#settings-open').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-history').click();
  expect(await page.evaluate(() => localStorage.getItem('ryadom:chats:v1'))).toBeNull();
  await expect(page.locator('#cache-status')).toContainText('сохранены');
});
test('unsupported adapter prevents model requests', async ({ page, context }) => {
  const requests = await resources(context);
  await page.addInitScript(() => { (globalThis as unknown as {__gpuFailure: string}).__gpuFailure = 'WebGPU: графический адаптер недоступен'; });
  await page.goto('./');
  await expect(page.locator('#compatibility')).toContainText('адаптер недоступен');
  await expect(page.locator('#load-model')).toBeDisabled();
  expect(requests.filter(request => request.url().includes('/models/'))).toHaveLength(0);
});
for (const kind of ['download', 'integrity', 'unconfigured destination'] as const) {
  test(`handles ${kind} error without external requests`, async ({ page, context }) => {
    const requests = await resources(context, { fail: kind === 'download', corrupt: kind === 'integrity', external: kind === 'unconfigured destination' });
    await page.goto('./');
    await expect(page.locator('#load-model')).toBeEnabled();
    await page.locator('#load-model').click();
    await expect(page.locator('#notice')).toBeVisible();
    await expect(page.locator('#engine-status')).toContainText('не запущена');
    expect(requests.some(request => request.url().includes('unconfigured.example'))).toBe(false);
    await expect(page.locator('#load-model')).toBeEnabled();
  });
}
for (const [trigger, message] of [['[oom]', 'Не хватает'], ['[lost]', 'GPU потеряно']] as const) {
  test(`handles ${trigger} and keeps history`, async ({ page, context }) => {
    await resources(context); await start(page);
    await page.locator('#prompt').fill(trigger);
    await page.locator('#send').click();
    await expect(page.locator('#notice')).toContainText(message);
    await expect(page.locator('#stop')).toBeHidden();
    await expect(page.locator('.message-user')).toContainText(trigger);
    await expect(page.locator('#quick-start')).toBeVisible();
  });
}
test('untrusted Markdown and HTML cannot execute or load remote images', async ({ page, context }) => {
  const requests = await resources(context);
  const payload = '<img src="https://evil.example/private" onerror="alert(1)">\n\n![tracking](https://evil.example/pixel)\n\n[опасная ссылка](javascript:alert(2))';
  await page.addInitScript(({ payload }) => {
    localStorage.setItem('ryadom:chats:v1', JSON.stringify({ activeId: 'x', conversations: [{ id: 'x', title: '<script>bad</script>', createdAt: 1, messages: [{ id: 'm', role: 'assistant', content: payload }] }] }));
  }, { payload });
  await page.goto('./');
  await expect(page.locator('.message-content')).toContainText('<img');
  await expect(page.locator('.message-content img, .message-content a, .message-content script')).toHaveCount(0);
  expect(requests.some(request => request.url().includes('evil.example'))).toBe(false);
});
test('mobile layout fits screen, sidebar and settings remain usable', async ({ page, context }) => {
  await resources(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await expect(page.locator('#load-model')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/welcome-mobile.png', fullPage: true });
  await page.locator('#menu-toggle').click();
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings')).toBeVisible();
  await page.locator('#settings-close').click();
  await expect(page.locator('#settings')).toBeHidden();
});
test('history deletion propagates to other tabs and is not restored by an old tab', async ({ page, context }) => {
  await resources(context); await start(page);
  await page.locator('#prompt').fill('Личная переписка');
  await page.locator('#send').click();
  await expect(page.locator('#stop')).toBeHidden();
  const second = await context.newPage();
  await second.goto('./');
  await expect(second.locator('.message-user')).toContainText('Личная переписка');
  await page.locator('#settings-open').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-history').click();
  await expect(second.locator('#welcome')).toBeVisible();
  await second.close();
  expect(await page.evaluate(() => localStorage.getItem('ryadom:chats:v1'))).not.toContain('Личная переписка');
});
