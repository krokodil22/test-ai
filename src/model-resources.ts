import type { ModelInfo } from './config';

const digest = async (data: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
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
    const data = await response.arrayBuffer();
    if (data.byteLength !== file.bytes || await digest(data) !== file.sha256) throw new CacheAuditError(`SHA-256 кеша не совпадает: ${file.path}. Удалите скачанную модель и загрузите её снова.`);
    checkedBytes += data.byteLength; checkedFiles++;
    progress(checkedFiles, info.files.length);
  }
  return { valid: true as const, checkedFiles, checkedBytes, completedAt: new Date().toISOString() };
}
export type CacheAudit = Awaited<ReturnType<typeof auditModelCache>>;
async function bounded(response: Response, limit: number, progress: (bytes: number) => void) {
  if (!response.body) throw Error('Пустой ответ при загрузке модели.');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error('Размер ресурса модели превышает манифест.');
      parts.push(value); progress(size);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const buffer = new Uint8Array(size);
  let offset = 0; for (const part of parts) { buffer.set(part, offset); offset += part.byteLength; }
  return buffer.buffer;
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
    const payload = await bounded(response, Math.max(file.bytes, weight), bytes => progress(Math.min(1, (done + Math.min(1, bytes / Math.max(file.bytes, weight)) * weight) / total), `Модель: загрузка и проверка файла ${index + 1} из ${info.files.length}…`));
    const magic = new Uint8Array(payload, 0, Math.min(3, payload.byteLength));
    const isGzip = !!file.download && !cached && magic[0] === 0x1f && magic[1] === 0x8b && magic[2] === 8;
    if (isGzip && (payload.byteLength !== file.download!.bytes || await digest(payload) !== file.download!.sha256)) throw Error('Ошибка SHA256 архива модели.');
    // A browser may already decode Content-Encoding:gzip. Always verify the
    // original tensor bytes, regardless of the host's encoding policy.
    const data = isGzip ? await bounded(new Response(new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'))), file.bytes, () => {}) : payload;
    if (data.byteLength !== file.bytes || await digest(data) !== file.sha256) { await cache.delete(url); throw Error('Ошибка SHA256: ресурс модели повреждён.'); }
    await cache.put(url, new Response(data, { headers: { 'Content-Type': file.path.endsWith('.wasm') ? 'application/wasm' : file.path.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'X-Tetrikanets-SHA256': file.sha256 } }));
    done += weight;
    progress(done / total, `Модель: проверено файлов ${index + 1} из ${info.files.length}`);
  }
}
