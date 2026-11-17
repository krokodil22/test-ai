import { test, expect } from '@playwright/test';
import * as XLSX from '@e965/xlsx';
import { readFile } from 'node:fs/promises';

function fixture(sheets = 1) {
  const book = XLSX.utils.book_new();
  const rows = [Array.from({ length: 18 }, (_, i) => i === 0 ? 'Город' : i === 17 ? 'Выручка' : `Поле ${i}`),
    ...Array.from({ length: 1000 }, (_, i) => Array.from({ length: 18 }, (_, c) => c === 0 ? i === 999 ? 'Конец' : i % 2 ? 'Казань' : 'Москва' : i + 1))];
  for (let i = 0; i < sheets; i++) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), `Лист ${i + 1}`);
  return { name: 'full.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }) };
}
async function upload(page: import('@playwright/test').Page, sheets = 1) {
  await page.goto('./');
  await page.locator('#chat-file').setInputFiles(fixture(sheets));
  await expect(page.locator('#workbook-coverage')).toContainText('1000 строк, 18 столбцов');
  await expect(page.locator('#workbook-open')).toBeEnabled();
}
test('reads all rows, late columns and the fourth sheet, calculates locally, then reloads all data', async ({ page, context }) => {
  const requests: import('@playwright/test').Request[] = [];
  context.on('request', request => requests.push(request));
  await upload(page, 4);
  await expect(page.locator('#workbook-coverage')).toContainText('4 листов');
  await page.locator('#workbook-open').click();
  await page.locator('#table-sheet').selectOption('3');
  await expect(page.locator('#workbook-coverage')).toContainText('Лист 4');
  await expect(page.locator('#table-run')).toBeEnabled();
  await page.locator('#table-operation').selectOption('stats');
  await page.locator('#table-column').selectOption('17');
  await page.locator('#table-run').click();
  await expect(page.locator('#table-grid tbody tr td').nth(3)).toHaveText('500500');
  await expect(page.locator('#table-result-summary')).toContainText('все 1000 строк');
  await page.locator('#table-operation').selectOption('search');
  await page.locator('#table-value').fill('Конец');
  await page.locator('#table-run').click();
  await expect(page.locator('#table-result-summary')).toContainText('Найдено: 1');
  await expect(page.locator('#table-grid tbody td').last()).toHaveText('1000');
  await page.locator('#table-close').click();
  await page.reload();
  await expect(page.locator('#workbook-coverage')).toContainText('Лист 4');
  await expect(page.locator('#workbook-open')).toBeEnabled();
  await page.locator('#workbook-open').click();
  await page.locator('#table-operation').selectOption('rows');
  await page.locator('#table-run').click();
  await expect(page.locator('#table-page')).toContainText('из 50');
  await page.locator('#table-next').click();
  await expect(page.locator('#table-page')).toContainText('Страница 2');
  await expect(page.locator('#table-grid tbody tr').first().locator('td').last()).toHaveText('21');
  for (const request of requests) {
    expect(request.method()).toBe('GET'); expect(request.postData()).toBeNull();
    expect(new URL(request.url()).origin).toBe('http://127.0.0.1:5174');
    expect(request.url()).not.toContain('full.xlsx');
    expect(request.url()).not.toContain('/models/');
  }
});
test('filters all rows, exports more than one page, computes conditional sums and groups all source rows', async ({ page }) => {
  await upload(page); await page.locator('#workbook-open').click();
  await page.locator('#table-operation').selectOption('filter');
  await page.locator('#table-column').selectOption('17');
  await page.locator('#table-operator').selectOption('gte');
  await page.locator('#table-value').fill('150');
  await page.locator('#table-run').click();
  await expect(page.locator('#table-result-summary')).toContainText('851 строк');
  const downloaded = page.waitForEvent('download');
  await page.locator('#table-download-xlsx').click();
  const file = await downloaded;
  const exported = XLSX.read(await readFile((await file.path())!), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json<unknown[]>(exported.Sheets['Таблица'], { header: 1 });
  expect(rows).toHaveLength(852); expect(rows[0][17]).toBe('Выручка'); expect(rows.at(-1)![17]).toBe(1000);
  await page.locator('#table-operation').selectOption('stats');
  await page.locator('#table-condition-enabled').check();
  await page.locator('#table-condition-column').selectOption('0');
  await page.locator('#table-condition-operator').selectOption('eq');
  await page.locator('#table-condition-value').fill('Москва');
  await page.locator('#table-run').click();
  await expect(page.locator('#table-grid tbody tr td').nth(3)).toHaveText('250000');
  await expect(page.locator('#table-result-summary')).toContainText('Отобрано 500');
  await page.locator('#table-condition-enabled').uncheck();
  await page.locator('#table-operation').selectOption('group');
  await page.locator('#table-group').selectOption('0');
  await page.locator('#table-aggregate').selectOption('sum');
  await page.locator('#table-run').click();
  await expect(page.locator('#table-grid tbody')).toContainText('249500');
  await expect(page.locator('#table-grid tbody')).toContainText('Конец');
  await page.locator('#table-record').click();
  await expect(page.locator('.message-assistant')).toContainText('все 1000 строк');
  await page.reload();
  await page.getByRole('button', { name: 'Полный результат расчёта', exact: true }).click();
  await expect(page.locator('#table-grid tbody')).toContainText('249500');
});
test('deletes full persisted table data independently of the model and does not restore it after reload', async ({ page }) => {
  await upload(page);
  await page.locator('#settings-open').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-history').click();
  await expect(page.locator('#toast')).toContainText('и таблицы удалены');
  const count = await page.evaluate(async () => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('tetrikanets:workbooks:v1');
    request.onsuccess = () => { const db = request.result; const get = db.transaction('workbooks').objectStore('workbooks').getAll(); get.onsuccess = () => { resolve(get.result.filter(record => record.id !== '__epoch__').length); db.close(); }; get.onerror = () => reject(get.error); };
    request.onerror = () => reject(request.error);
  }));
  expect(count).toBe(0);
  const stale = await page.evaluate(async () => {
    const path = new URL('src/workbook-store.ts', document.baseURI).href;
    const storage = await import(/* @vite-ignore */ path);
    const epoch = await storage.workbookEpoch();
    await storage.deleteWorkbook();
    try { await storage.saveWorkbook({ schema: 1, id: 'stale-upload', name: 'old.xlsx', size: 1, sheets: [] }, epoch); return false; }
    catch (error) { return String(error).includes('история была удалена'); }
  });
  expect(stale).toBe(true);
  await page.reload(); await expect(page.locator('#workbook-bar')).toBeHidden();
});
