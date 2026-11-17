import { validateFile, safeDownloadName } from './files';
import type { FileRequest, FileResult, Attachment, DataTable, WorkbookRef, TableQuery, TableResult, WorkbookInfo } from './files';

/** One short-lived worker per task; timeout/cancel also releases parser memory. */
export function runFileTask(request: FileRequest, signal?: AbortSignal): Promise<Exclude<FileResult, { type: 'error' }>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Отменено', 'AbortError')); return; }
    const worker = new Worker(new URL('./files.worker.ts', import.meta.url), { type: 'module', name: 'tetrikanets-files' });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); worker.terminate(); };
    const cancel = () => { cleanup(); reject(new DOMException('Отменено', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Обработка файла заняла слишком много времени. Выберите меньший файл.')); }, 20000);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }: MessageEvent<FileResult>) => { cleanup(); data.type === 'error' ? reject(new Error(data.message)) : resolve(data); };
    worker.onerror = event => { event.preventDefault(); cleanup(); reject(new Error('Не удалось обработать файл. Возможно, он повреждён или устройству не хватает памяти.')); };
    worker.onmessageerror = () => { cleanup(); reject(new Error('Не удалось прочитать результат обработки файла.')); };
    worker.postMessage(request);
  });
}
export async function readAttachment(file: File, signal?: AbortSignal): Promise<Attachment> {
  validateFile(file);
  const result = await runFileTask({ type: 'read', file }, signal);
  if (result.type !== 'read') throw new Error('Не удалось прочитать файл.');
  return result.attachment;
}
export async function downloadTable(table: DataTable, format: 'xlsx' | 'csv', name: string) {
  const result = await runFileTask({ type: 'export', table, format });
  if (result.type !== 'export') throw new Error('Не удалось создать файл.');
  downloadBytes(result.bytes, result.mime, name, format);
}
function downloadBytes(bytes: Uint8Array, mime: string, name: string, format: string) {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${safeDownloadName(name)}.${format}`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export async function getWorkbookInfo(ref: WorkbookRef, signal?: AbortSignal): Promise<WorkbookInfo> {
  const result = await runFileTask({ type: 'workbook-info', ref }, signal);
  if (result.type !== 'workbook-info') throw new Error('Не удалось прочитать сведения о таблице.');
  return result.info;
}
export async function queryTable(ref: WorkbookRef, query?: TableQuery, question?: string, page?: number, signal?: AbortSignal): Promise<TableResult> {
  const result = await runFileTask({ type: 'query', ref, query, question, page }, signal);
  if (result.type !== 'query') throw new Error('Не удалось выполнить операцию с таблицей.');
  return result.result;
}
export async function downloadQuery(ref: WorkbookRef, query: TableQuery, format: 'xlsx' | 'csv', name: string, signal?: AbortSignal) {
  const result = await runFileTask({ type: 'export-query', ref, query, format }, signal);
  if (result.type !== 'export') throw new Error('Не удалось скачать результат.');
  downloadBytes(result.bytes, result.mime, name, format);
}
