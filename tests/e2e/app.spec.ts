import { test, expect } from '@playwright/test';
import type { Page, BrowserContext, Request } from '@playwright/test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import * as XLSX from '@e965/xlsx';
import { readFile } from 'node:fs/promises';
import source from '../../scripts/model-source.json' with { type: 'json' };
test.beforeEach(async ({ context }) => { await context.addInitScript(() => { if (!localStorage.getItem('tetrikanets:memory-mode:v1')) localStorage.setItem('tetrikanets:memory-mode:v1', 'standard'); }); });
import lowMemory from '../fixtures/low-memory-runtime.json' with { type: 'json' };
const modelId = source.modelId;
const files = [
  { path: 'model.wasm', scope: 'webllm/wasm', body: 'wasm-test-fixture' },
  { path: 'resolve/main/mlc-chat-config.json', scope: 'webllm/config', body: '{}' },
  { path: `resolve/main/${source.cacheManifest}`, scope: 'webllm/model', body: '{"records":[]}' },
  { path: 'resolve/main/tokenizer.json', scope: 'webllm/model', body: '{}' },
  { path: 'resolve/main/params_shard_0.bin', scope: 'webllm/model', body: 'fixture-weights' },
];
async function resources(context: BrowserContext, options: { fail?: boolean; corrupt?: boolean; external?: boolean } = {}) {
  const resourceFiles = files.map(file => ({ ...file }));
  if (options.external) resourceFiles[2].body = JSON.stringify({ externalURL: 'https://unconfigured.example/leak' });
  const info = {
    schema: 1, modelId, revision: source.revision, downloadBytes: source.downloadBytes,
    files: resourceFiles.map(({ path, scope, body }) => ({ path, scope, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), ...(path.endsWith('.bin') ? { download: { encoding: 'gzip', path: path + '.gz', bytes: gzipSync(body).length, sha256: createHash('sha256').update(gzipSync(body)).digest('hex') } } : {}) })),
  };
  const requests: Request[] = [];
  context.on('request', request => requests.push(request));
  await context.route('**/models/**', async route => {
    if (options.fail) { await route.fulfill({ status: 503, body: 'Unavailable' }); return; }
    const url = route.request().url();
    const file = resourceFiles.find(file => url.endsWith('/' + file.path + (file.path.endsWith('.bin') ? '.gz' : '')));
    const body = url.endsWith('/model-info.json') ? JSON.stringify(info) : options.corrupt && file?.path === 'model.wasm' ? 'broken' : file?.path.endsWith('.bin') ? gzipSync(file.body) : file?.body;
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
test('reads an actual XLSX locally, sends its preview to inference and preserves the fragment in history', async ({ page, context }) => {
  const requests = await resources(context);
  await start(page);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Адрес', 'Продажи'], ['Арбат', 125]]), 'Данные');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  await page.locator('#chat-file').setInputFiles({ name: 'clients.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
  await expect(page.locator('#file-status')).toContainText('помещаются');
  await page.locator('#file-details summary').click();
  await expect(page.locator('#file-text')).toContainText('Арбат');
  await page.locator('#prompt').fill('[file-echo] Опиши данные.');
  await page.locator('#send').click();
  await expect(page.locator('#file-preview')).toBeHidden();
  await expect(page.locator('#stop')).toBeHidden();
  await expect(page.locator('.message-assistant')).toContainText('движок получил данные файла: Арбат, 125');
  await page.reload();
  await page.locator('.message-attachment summary').click();
  await expect(page.locator('.message-attachment pre')).toContainText('125');
  for (const request of requests) {
    expect(new URL(request.url()).origin).toBe('http://127.0.0.1:5174');
    expect(request.method()).toBe('GET');
    expect(request.postData()).toBeNull();
    expect(request.url()).not.toContain('clients.xlsx');
    expect(request.url()).not.toContain('Арбат');
  }
});
test('creates downloadable Excel and CSV files from a completed answer, including after reload', async ({ page, context }) => {
  await resources(context); await start(page);
  await page.locator('#excel-output').check();
  await page.locator('#prompt').fill('Составь таблицу товаров с ценами.');
  await page.locator('#send').click();
  await expect(page.locator('#stop')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Скачать Excel' })).toHaveCount(0);
  await expect(page.locator('#stop')).toBeHidden();
  const xlsxDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать Excel', exact: true }).click();
  const xlsx = await xlsxDownload;
  expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);
  const book = XLSX.read(await readFile((await xlsx.path())!), { type: 'buffer' });
  expect(XLSX.utils.sheet_to_json(book.Sheets['Таблица'], { header: 1 })).toEqual([['Товар', 'Цена'], ['Книга', 250], ['Тетрадь', 80]]);
  await page.reload();
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  const csv = await csvDownload;
  expect(await readFile((await csv.path())!, 'utf8')).toContain('"Книга";"250"');
});
test('does not export an incomplete table restored after a browser crash or a length-limited answer', async ({ page, context }) => {
  await resources(context);
  await page.addInitScript(() => {
    if (localStorage.getItem('ryadom:chats:v1')) return;
    localStorage.setItem('ryadom:chats:v1', JSON.stringify({ activeId: 'crash', conversations: [{ id: 'crash', title: 'Незавершённая таблица', createdAt: 1, messages: [
      { id: 'q', role: 'user', content: 'Создай таблицу', outputFormat: 'xlsx' },
      { id: 'a', role: 'assistant', content: '| A | B |\n| --- | --- |\n| 1 | 2 |', status: 'incomplete' },
    ] }] }));
  });
  await page.goto('./');
  await expect(page.locator('.message-assistant .message-meta')).toContainText('не завершён');
  await expect(page.getByRole('button', { name: 'Скачать Excel' })).toHaveCount(0);
  await page.locator('#quick-start').click();
  await expect(page.locator('#engine-status')).toContainText('Готов к разговору');
  await page.locator('#new-chat').click();
  await page.locator('#excel-output').check();
  await page.locator('#prompt').fill('[length] Создай таблицу.');
  await page.locator('#send').click();
  await expect(page.locator('#stop')).toBeHidden();
  await expect(page.locator('.message-assistant .message-meta')).toContainText('предел ответа');
  await expect(page.getByRole('button', { name: 'Скачать Excel' })).toHaveCount(0);
});
test('shows context truncation, rejects invalid uploads, removes drafts and clears stored file data', async ({ page, context }) => {
  await resources(context); await start(page);
  await page.locator('#chat-file').setInputFiles({ name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.from('Данные строки.\n'.repeat(1000)) });
  await expect(page.locator('#file-status')).toContainText('только показанный фрагмент');
  await page.locator('#remove-file').click();
  await expect(page.locator('#file-preview')).toBeHidden();
  await page.locator('#chat-file').setInputFiles({ name: 'test.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not pdf') });
  await expect(page.locator('#notice')).toContainText('Поддерживаются');
  await expect(page.locator('#file-preview')).toBeHidden();
  await page.locator('#chat-file').setInputFiles({ name: 'broken.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('not xlsx') });
  await expect(page.locator('#notice')).toContainText('не файл .xlsx');
  await page.locator('#chat-file').setInputFiles({ name: 'secret.txt', mimeType: 'text/plain', buffer: Buffer.from('Тестовые личные данные 5678') });
  await expect(page.locator('#file-status')).toContainText('помещаются');
  await page.locator('#send').click();
  await expect(page.locator('#stop')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('ryadom:chats:v1'))).toContain('5678');
  await page.locator('#settings-open').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-history').click();
  expect(await page.evaluate(() => localStorage.getItem('ryadom:chats:v1'))).toBeNull();
  expect(await page.evaluate(async () => (await caches.keys()).includes('webllm/model'))).toBe(true);
});
test('allows one model across tabs and releases its GPU lease without deleting the cache or history', async ({ page, context }) => {
  const requests = await resources(context);
  await start(page);
  await page.locator('#prompt').fill('Переписка должна остаться');
  await page.locator('#send').click();
  await expect(page.locator('#stop')).toBeHidden();
  const other = await context.newPage();
  await other.goto('./');
  await expect(other.locator('#quick-start')).toBeVisible();
  const before = requests.filter(request => request.url().includes('/models/')).length;
  await other.locator('#quick-start').click();
  await expect(other.locator('#notice')).toContainText('другой вкладке');
  await expect(page.locator('#engine-status')).toContainText('Готов к разговору');
  expect(requests.filter(request => request.url().includes('/models/')).length).toBe(before);
  await page.locator('#settings-open').click();
  await page.locator('#unload-model').click();
  await expect(page.locator('#cache-status')).toContainText('сохранены');
  await expect(page.locator('.message-user')).toContainText('Переписка должна остаться');
  await other.locator('#quick-start').click();
  await expect(other.locator('#engine-status')).toContainText('Готов к разговору');
  expect(requests.filter(request => request.url().includes('/models/')).length).toBe(before);
  await other.close();
  await page.locator('#settings-close').click();
  await page.locator('#quick-start').click();
  await expect(page.locator('#engine-status')).toContainText('Готов к разговору');
  // Leaving a loaded page also releases the worker and its lock.
  await page.goto('about:blank');
  await page.goto('./compare.html?mode=penalty');
  await expect(page.locator('#comparison-load')).toBeEnabled();
  await page.locator('#comparison-load').click();
  await expect(page.locator('#comparison-run')).toBeEnabled();
});
test('switches to the economy runtime, preserves and reuses the existing weights, then returns to standard', async ({ page, context }) => {
  const requests = await resources(context);
  await context.route('**/' + lowMemory.path, route => route.fulfill({ body: 'fixture-low-memory-wasm', contentType: 'application/wasm' }));
  await start(page);
  const before = requests.filter(request => request.url().includes('/models/')).length;
  await page.locator('#settings-open').click();
  const modes = page.getByRole('combobox', { name: 'Режим памяти' });
  await expect(modes).toBeDisabled();
  await page.locator('#unload-model').click();
  await expect(modes).toBeEnabled();
  await modes.selectOption('economy');
  await page.locator('#settings-start').click();
  await expect(page.locator('#engine-status')).toContainText('Экономичный режим');
  expect(requests.filter(request => request.url().includes('/models/')).length).toBe(before + 1);
  expect(requests.filter(request => request.url().endsWith('/' + lowMemory.path))).toHaveLength(1);
  await page.reload();
  await page.locator('#load-model').click();
  await expect(page.locator('#engine-status')).toContainText('Экономичный режим');
  expect(requests.filter(request => request.url().includes('/models/')).length).toBe(before + 1);
  await page.locator('#settings-open').click();
  await page.locator('#unload-model').click();
  await modes.selectOption('standard');
  await page.locator('#settings-start').click();
  await expect(page.locator('#engine-status')).toContainText('Готов к разговору');
  await expect(page.locator('#engine-status')).not.toContainText('Экономичный');
  expect(requests.filter(request => request.url().includes('/models/')).length).toBe(before + 1);
  await page.locator('#settings-open').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-model').click();
  await expect(page.locator('#cache-status')).toContainText('не сохранена');
  expect(await page.evaluate(async path => !!await (await caches.open('webllm/wasm')).match(new URL('models/' + path, location.href).href), source.directory + '/' + lowMemory.path)).toBe(false);
});
test('rejects a damaged economy runtime without silently falling back or losing cached weights', async ({ page, context }) => {
  await resources(context);
  await context.route('**/' + lowMemory.path, route => route.fulfill({ body: 'damaged-runtime' }));
  await page.addInitScript(() => localStorage.setItem('tetrikanets:memory-mode:v1', 'economy'));
  await page.goto('./');
  await expect(page.locator('#load-model')).toBeEnabled();
  await page.locator('#load-model').click();
  await expect(page.locator('#notice')).toContainText('библиотеку экономичного режима');
  await expect(page.locator('#engine-status')).toContainText('не запущена');
  await page.locator('#settings-open').click();
  await expect(page.locator('#cache-status')).toContainText('сохранены');
});
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
  await expect(page.locator('.message-assistant .message-content')).not.toContainText('<think>');
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

for (const location of ['legacy-directory', 'legacy-1.5-directory', 'same-url', 'stale-revision'] as const) {
  test(`upgrades ${location} cache without mixing model weights or deleting history`, async ({ page, context }) => {
    const requests = await resources(context);
    await page.addInitScript(() => {
      if (!localStorage.getItem('ryadom:chats:v1')) localStorage.setItem('ryadom:chats:v1', JSON.stringify({ activeId: 'retained', conversations: [{ id: 'retained', title: 'Старый чат', createdAt: 1, messages: [{ id: 'user-old', role: 'user', content: 'Сохранённый вопрос' }, { id: 'answer-old', role: 'assistant', content: 'Сохранённый ответ' }] }] }));
    });
    await page.goto('./');
    await expect(page.locator('#load-model')).toBeEnabled();
    await page.evaluate(async ({ location, modelId, directory }) => {
      const base = new URL(`models/${directory}/`, document.baseURI).href;
      const oldBase = location === 'legacy-directory' ? base.replace(directory, 'qwen2.5-0.5b') : location === 'legacy-1.5-directory' ? base.replace(directory, 'qwen2.5-1.5b') : base;
      const metadata = await caches.open('ryadom/metadata-v1');
      await metadata.put(oldBase + 'model-info.json', new Response(JSON.stringify({ schema: 1, modelId: location === 'stale-revision' ? modelId : location === 'legacy-1.5-directory' ? 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC' : 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', revision: 'old', downloadBytes: 10, files: [] })));
      await (await caches.open('webllm/wasm')).put(oldBase + 'model.wasm', new Response('OLD incompatible WASM'));
      await (await caches.open('webllm/model')).put(oldBase + 'resolve/main/old-weights.bin', new Response('OLD weights'));
      await (await caches.open('webllm/model')).put(new URL('/another-app/keep.bin', document.baseURI).href, new Response('unrelated'));
      await (await caches.open('tetrikanets/opus-en-ru/retained')).put(new URL('/translations/keep.bin', document.baseURI).href, new Response('keep translator'));
    }, { location, modelId, directory: source.directory });
    await page.reload();
    await expect(page.locator('#quick-start')).toBeVisible();
    await page.locator('#quick-start').click();
    await expect(page.locator('#engine-status')).toContainText('Готов к разговору');
    await expect(page.locator('.message-user')).toContainText('Сохранённый вопрос');
    expect(requests.filter(request => request.url().includes('/models/'))).toHaveLength(6);
    const cacheState = await page.evaluate(async (directory) => {
      const keys = (await (await caches.open('webllm/model')).keys()).map(request => request.url);
      const metadata = await (await (await caches.open('ryadom/metadata-v1')).match(new URL(`models/${directory}/model-info.json`, document.baseURI).href))!.json();
      return { keys, modelId: metadata.modelId, translatorRetained: !!await (await caches.open('tetrikanets/opus-en-ru/retained')).match(new URL('/translations/keep.bin', document.baseURI).href) };
    }, source.directory);
    expect(cacheState.modelId).toBe(modelId);
    expect(cacheState.translatorRetained).toBe(true);
    expect(cacheState.keys.some(key => key.includes('qwen2.5-0.5b'))).toBe(location === 'legacy-directory');
    expect(cacheState.keys.some(key => key.includes('qwen2.5-1.5b'))).toBe(false);
    if (location !== 'legacy-directory') expect(cacheState.keys.some(key => key.includes('old-weights'))).toBe(false);
    expect(cacheState.keys.some(key => key.includes('/another-app/keep.bin'))).toBe(true);
  });
}
