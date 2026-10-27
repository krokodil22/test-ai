import type { ModelInfo } from './config';
import { sha256 } from '@noble/hashes/sha2.js';

export class CacheAuditError extends Error {}

// Explicit diagnostic audit: rehash cached bytes instead of trusting the
// verified-entry marker used for fast normal startup. Never fetch missing data.
export async function auditModelCache(base: string, info: ModelInfo, progress: (checked: number, total: number) => void, stopped: () => boolean) {
  let checkedBytes = 0;
  let checkedFiles = 0;
  for (const file of info.files) {
    if (stopped()) throw Error('Проверка кеша остановлена.');
    const cache = await caches.open(file.scope);
    const response = await cache.match(new URL(file.path, base).href);
    if (!response) throw new CacheAuditError(`В кеше отсутствует ${file.path}. Перезапустите модель.`);
    // Auditing must not allocate a whole 318 MB embedding shard on top of an
    // already loaded model. Hash the cached response with bounded streaming.
    const hash = sha256.create();
    let size = 0;
    const invalid = () => new CacheAuditError(`SHA-256 кеша не совпадает: ${file.path}. Удалите скачанную модель и загрузите её снова.`);
    if (!response.body) throw invalid();
    const reader = response.body.getReader();
    try {
      while (true) {
        if (stopped()) throw Error('Проверка кеша остановлена.');
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > file.bytes) throw invalid();
        hash.update(chunk.value);
      }
      if (size !== file.bytes || Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('') !== file.sha256) throw invalid();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    checkedBytes += size; checkedFiles++;
    progress(checkedFiles, info.files.length);
  }
  return { valid: true as const, checkedFiles, checkedBytes, completedAt: new Date().toISOString() };
}
export type CacheAudit = Awaited<ReturnType<typeof auditModelCache>>;
async function peekBody(response: Response) {
  if (!response.body) throw Error('Пустой ответ при загрузке модели.');
  const reader = response.body.getReader();
  const prefix: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (bytes < 3) { const item = await reader.read(); if (item.done) break; prefix.push(item.value); bytes += item.value.length; }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const magic = new Uint8Array(3);
  let copied = 0;
  for (const chunk of prefix) { const part = chunk.subarray(0, 3 - copied); magic.set(part, copied); copied += part.length; if (copied === 3) break; }
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) { for (const chunk of prefix) controller.enqueue(chunk); },
    async pull(controller) { try { const item = await reader.read(); if (item.done) controller.close(); else controller.enqueue(item.value); } catch (error) { controller.error(error); } },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { body, gzip: magic[0] === 0x1f && magic[1] === 0x8b && magic[2] === 8 };
}

// WebLLM reads its standard, uncompressed cache URLs. Populate those entries
// ourselves so static hosts can serve smaller .bin.gz files without redirects
// or custom response headers. Only one shard is expanded in memory at a time.
export async function prepareModelCache(base: string, info: ModelInfo, fetchResource: typeof fetch, progress: (value: number, text: string) => void) {
  const total = info.files.reduce((sum, file) => sum + (file.download?.bytes || file.bytes), 0);
  let done = 0;
  for (const [index, file] of info.files.entries()) {
    const url = new URL(file.path, base).href;
    const cache = await caches.open(file.scope);
    const weight = file.download?.bytes || file.bytes;
    const cached = await cache.match(url);
    if (cached?.headers.get('X-Tetrikanets-SHA256') === file.sha256) { done += weight; progress(done / total, 'Модель: чтение проверенного кеша…'); continue; }
    const path = file.download?.path || file.path;
    const address = new URL(path, base).href;
    if (!address.startsWith(base) || new URL(address).origin !== new URL(base).origin) throw Error('Запрещён адрес ресурса модели.');
    const response = cached || await fetchResource(address, { method: 'GET', mode: 'cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    if (!response.ok) throw Error(`HTTP ${response.status}: ресурс модели недоступен.`);
    const peeked = await peekBody(response);
    const isGzip = !!file.download && !cached && peeked.gzip;
    let integrityError: Error | undefined;
    function verifier(bytes: number, expected: string, packed: boolean) {
      const hash = sha256.create(); let size = 0;
      const invalid = () => { integrityError = Error(packed ? 'Ошибка SHA256 архива модели.' : 'Ошибка SHA256: ресурс модели повреждён.'); return integrityError; };
      return new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > bytes) throw invalid();
          hash.update(chunk); controller.enqueue(chunk);
          if (packed || !isGzip) progress(Math.min(1, (done + size / bytes * weight) / total), `Модель: загрузка и проверка файла ${index + 1} из ${info.files.length}…`);
        },
        flush() { if (size !== bytes || Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('') !== expected) throw invalid(); },
      });
    }
    // Verify packed bytes before completing gzip, then verify decoded bytes
    // before Cache commits. No weight shard is buffered whole in JavaScript.
    // Hosts that already decode Content-Encoding:gzip use the plain branch.
    const plain = isGzip ? peeked.body.pipeThrough(verifier(file.download!.bytes, file.download!.sha256, true)).pipeThrough(new DecompressionStream('gzip')) : peeked.body;
    const verified = plain.pipeThrough(verifier(file.bytes, file.sha256, false));
    try {
      // Cache commits only after the stream and both integrity checks finish.
      await cache.put(url, new Response(verified, { headers: { 'Content-Type': file.path.endsWith('.wasm') ? 'application/wasm' : file.path.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'X-Tetrikanets-SHA256': file.sha256 } }));
    } catch (error) {
      if (integrityError) { await cache.delete(url); throw integrityError; }
      if (error instanceof Error && /quota/i.test(error.name)) throw error;
      throw new Error('Браузер не смог сохранить файлы модели в кеше. Освободите место и откройте сайт в обычном окне Chrome. Уже сохранённые файлы будут использованы при повторном запуске.', { cause: error });
    }
    done += weight;
    progress(done / total, `Модель: проверено файлов ${index + 1} из ${info.files.length}`);
  }
}
