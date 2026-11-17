import { validateFile, safeDownloadName } from './files';
import type { FileRequest, FileResult, Attachment, DataTable } from './files';

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
  const url = URL.createObjectURL(new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: result.mime }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${safeDownloadName(name)}.${format}`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
