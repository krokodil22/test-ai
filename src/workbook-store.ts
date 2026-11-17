import type { WorkbookData } from './files';
const DATABASE = 'tetrikanets:workbooks:v1';
const STORE = 'workbooks';
const EPOCH = '__epoch__';
async function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Не удалось открыть хранилище таблиц. Разрешите хранение данных сайта в браузере.'));
    request.onblocked = () => reject(new Error('Хранилище таблиц занято другой вкладкой. Закройте её и повторите.'));
  });
}
async function read<T>(id: string): Promise<T | undefined> {
  const db = await open();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(new Error('Не удалось прочитать сохранённую таблицу.'));
  }); } finally { db.close(); }
}
export async function workbookEpoch(): Promise<number> { return (await read<{ value: number }>(EPOCH))?.value || 0; }
export async function loadWorkbook(id: string): Promise<WorkbookData> {
  const value = await read<WorkbookData>(id);
  if (!value || value.schema !== 1 || !Array.isArray(value.sheets)) throw new Error('Таблица удалена или недоступна в этом браузере. Загрузите исходный файл снова.');
  return value;
}
export async function saveWorkbook(value: WorkbookData, epoch: number): Promise<void> {
  const db = await open();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let changed = false;
    const request = store.get(EPOCH);
    request.onsuccess = () => {
      if ((request.result?.value || 0) !== epoch) { changed = true; tx.abort(); }
      else store.put(value);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new Error(changed ? 'Загрузка отменена: история была удалена в другой вкладке.' : 'Браузер не сохранил таблицу. Освободите место или разрешите хранение данных сайта.'));
  }); } finally { db.close(); }
}
export async function deleteWorkbook(id?: string): Promise<void> {
  const db = await open();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    if (id) store.delete(id);
    else {
      const request = store.get(EPOCH);
      request.onsuccess = () => { const value = (request.result?.value || 0) + 1; store.clear(); store.put({ id: EPOCH, value }); };
    }
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new Error('Не удалось удалить сохранённые таблицы. Повторите очистку.'));
  }); } finally { db.close(); }
}
