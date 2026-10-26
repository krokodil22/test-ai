import { env, pipeline, InterruptableStoppingCriteria, StoppingCriteriaList } from '@huggingface/transformers';
import type { TranslationPipeline, Tensor } from '@huggingface/transformers';
import ortModuleUrl from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import { TRANSLATOR, TRANSLATOR_CACHE, TRANSLATOR_METADATA_CACHE } from './translation-config';
import { translationParts } from './translation-text';

let model: TranslationPipeline | undefined;
let stopped = false;
const stopper = new InterruptableStoppingCriteria();
const criteria = new StoppingCriteriaList(); criteria.push(stopper);
const digest = async (buffer: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), value => value.toString(16).padStart(2, '0')).join('');

async function readBounded(response: Response, limit: number, onBytes = (_bytes: number) => {}) {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error('Размер ресурса переводчика превышает манифест.');
      chunks.push(value); onBytes(value.byteLength);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const data = new Uint8Array(size);
  let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return data.buffer;
}

export async function loadTranslator(base: string, progress: (value: number, text: string) => void) {
  const cache = await caches.open(TRANSLATOR_CACHE);
  const metadataCache = await caches.open(TRANSLATOR_METADATA_CACHE);
  const manifestUrl = base + 'translation-info.json';
  const cachedManifest = await metadataCache.match(manifestUrl);
  const request = async (url: string) => {
    if (!url.startsWith(base)) throw Error('Запрещён адрес ресурса переводчика.');
    const response = await fetch(url, { credentials: 'omit', mode: 'cors', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw Error(`HTTP ${response.status}: не удалось загрузить переводчик. Выполните npm run translator:download и опубликуйте ресурсы.`);
    return response;
  };
  const manifestResponse = cachedManifest || await request(manifestUrl);
  const info = await manifestResponse.clone().json();
  const expected = [...TRANSLATOR.files, TRANSLATOR.runtime];
  if (info.schema !== 1 || info.modelId !== TRANSLATOR.modelId || info.revision !== TRANSLATOR.revision || info.transformers !== TRANSLATOR.transformers || !Array.isArray(info.files) || info.files.length !== expected.length) throw Error('Манифест переводчика не соответствует проверенной версии. Удалите кеш переводчика и обновите ресурсы.');
  for (const file of expected) {
    const packed = info.files.find((item: { path: string }) => item.path === file.path);
    if (!packed || !Number.isSafeInteger(packed.bytes) || packed.bytes <= 0 || packed.bytes > file.bytes * 2 || !/^[a-f0-9]{64}$/.test(packed.sha256)) throw Error('Повреждён манифест переводчика.');
  }
  await metadataCache.put(manifestUrl, manifestResponse);
  const received = new Map<string, number>();
  const total = expected.reduce((sum, item) => sum + item.bytes, 0);
  async function artifact(path: string) {
    const file = expected.find(item => item.path === path)!;
    const packed = info.files.find((item: { path: string }) => item.path === path);
    const url = base + path + '.gz';
    const cached = await cache.match(url);
    const response = cached || await request(url);
    let read = 0;
    const payload = await readBounded(response, Math.max(packed.bytes, file.bytes), bytes => {
      read += bytes; received.set(path, Math.max(received.get(path) || 0, read));
      const value = Math.min(0.95, Array.from(received.values()).reduce((sum, count) => sum + count, 0) / total * 0.95);
      progress(value, `Переводчик: загрузка и проверка ${Math.round(value * 100)}%`);
    });
    const magic = new Uint8Array(payload, 0, Math.min(3, payload.byteLength));
    const isGzip = magic[0] === 0x1f && magic[1] === 0x8b && magic[2] === 8;
    // Hosts such as Vite preview send Content-Encoding:gzip and the browser
    // already decodes it. The fixed, embedded plaintext hash is authoritative
    // in both cases; verify the compressed manifest hash when bytes are gzip.
    if (isGzip && (payload.byteLength !== packed.bytes || await digest(payload) !== packed.sha256)) { await cache.delete(url); throw Error('Ошибка SHA256: ресурс переводчика повреждён.'); }
    const data = isGzip ? await readBounded(new Response(new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'))), file.bytes) : payload;
    if (data.byteLength !== file.bytes || await digest(data) !== file.sha256) { await cache.delete(url); throw Error('Ошибка SHA256 распакованной модели переводчика.'); }
    if (!cached) await cache.put(url, new Response(payload));
    received.set(path, file.bytes);
    return new Response(data);
  }
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = base;
  env.remoteHost = base;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.useCustomCache = true;
  env.customCache = {
    match: async (key: string) => {
      const prefix = base + 'opus-mt-en-ru/';
      const path = String(key).startsWith(prefix) ? String(key).slice(prefix.length) : '';
      return TRANSLATOR.files.some(file => file.path === path) ? artifact(path) : undefined;
    },
    put: async () => {},
  };
  const wasm = await (await artifact(TRANSLATOR.runtime.path)).arrayBuffer();
  const runtime = env.backends.onnx.wasm;
  if (!runtime) throw Error('WebAssembly backend переводчика недоступен.');
  runtime.numThreads = 1;
  runtime.proxy = false;
  runtime.wasmPaths = { mjs: new URL(ortModuleUrl, self.location.href).href };
  runtime.wasmBinary = new Uint8Array(wasm);
  progress(0.95, 'Подготовка локального переводчика на CPU…');
  // Narrow the factory signature: the library's union of all supported tasks
  // exceeds TypeScript's union expansion limit, although this task is fixed.
  const create = pipeline as unknown as (task: 'translation', id: string, options: { dtype: 'q8'; device: 'wasm'; local_files_only: true }) => Promise<TranslationPipeline>;
  model = await create('translation', 'opus-mt-en-ru', { dtype: 'q8', device: 'wasm', local_files_only: true });
  // Some tokenizer metadata is optional for this library version. Retain the
  // complete pinned bundle so the cache readiness check also covers it.
  for (const file of TRANSLATOR.files) if (!await cache.match(base + file.path + '.gz')) await artifact(file.path);
  progress(1, 'Переводчик готов');
}

export function stopTranslation() { stopped = true; stopper.interrupt(); }
export async function translateToRussian(text: string, onSentence = (_done: number, _total: number) => {}) {
  if (!model) throw Error('Переводчик не запущен.');
  stopped = false; stopper.reset();
  const parts = translationParts(text);
  const count = parts.filter(part => part.text).length;
  let done = 0;
  const output: string[] = [];
  for (const part of parts) {
    // ORT/WASM can settle its promises synchronously, starving the worker's
    // message queue. Yield a task between sentences so Stop can be received.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (stopped) throw Error('Перевод остановлен.');
    if (!part.text) { output.push(part.prefix); continue; }
    // OPUS-MT is trained on sentences. Whole paragraphs can silently drop
    // sentences; translate every sentence, preserving original whitespace.
    const inputs = model.tokenizer(part.text, { truncation: false, padding: false });
    if (inputs.input_ids.dims.at(-1)! > 400) throw Error('Слишком длинное предложение для переводчика. Разбейте его на несколько предложений.');
    const maxTokens = 384;
    const ids = await model.model.generate({ ...inputs, max_new_tokens: maxTokens, do_sample: false, num_beams: 1, stopping_criteria: criteria }) as Tensor;
    if (stopped) throw Error('Перевод остановлен.');
    if (ids.dims.at(-1)! >= maxTokens) throw Error('Перевод предложения достиг лимита. Неполный перевод не будет показан как готовый.');
    const result = model.tokenizer.batch_decode(ids, { skip_special_tokens: true })[0].trim();
    if (!result) throw Error('Переводчик вернул пустое предложение.');
    output.push(part.prefix + result + part.suffix);
    onSentence(++done, count);
  }
  return output.join('');
}
