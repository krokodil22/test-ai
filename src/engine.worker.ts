/// <reference lib="webworker" />
import { MLCEngine } from '@mlc-ai/web-llm';
import { probeGpu, monitorGpu } from '#gpu';
import { MODEL_ID, CONTEXT_TOKENS, MAX_REPLY_TOKENS, validateModelInfo } from './config';
import { buildContext } from './context';
import { explainError } from './errors';
import type { WorkerEvent, WorkerRequest } from './types';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (event: WorkerEvent) => scope.postMessage(event);
let engine: MLCEngine | undefined;
let active: string | undefined;
let stopped = false;
let loading = false;
let fatal = false;
let resourceHashes = new Map<string, string>();
const nativeFetch = globalThis.fetch.bind(globalThis);

async function init(base: string) {
  if (engine || loading) return;
  loading = true;
  try {
    await probeGpu();
    monitorGpu(() => {
      fatal = true;
      send({ type: 'error', id: active, message: explainError(new Error('GPU device lost')), fatal: true });
    });
    const root = new URL(base);
    if (root.protocol !== 'https:' && !(root.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(root.hostname))) throw new Error('Ресурсы должны использовать HTTPS.');
    // Even unexpected URLs inside model manifests cannot contact third parties.
    globalThis.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input), base);
      if (url.origin !== root.origin || !url.href.startsWith(base) || url.search || url.hash || (options?.method || (input instanceof Request ? input.method : 'GET')) !== 'GET') throw new Error('Запрещён сетевой запрос вне каталога ресурсов модели.');
      const isRuntime = url.href === `${base}model.wasm`;
      // WebLLM intentionally bypasses its WASM cache on localhost. Keep our own
      // entry in the same scope so development also reuses every resource.
      if (isRuntime && resourceHashes.has(url.href)) {
        const cachedRuntime = await (await caches.open('webllm/wasm')).match(url.href);
        if (cachedRuntime) return cachedRuntime;
      }
      const response = await nativeFetch(url, { ...options, method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', mode: 'cors' });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ресурс модели недоступен`);
      const expected = resourceHashes.get(url.href);
      if (expected) {
        const buffer = await response.arrayBuffer();
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
        if (digest !== expected) throw new Error('Ошибка SHA256: ресурс модели повреждён.');
        const verified = new Response(buffer, { status: response.status, headers: response.headers });
        if (isRuntime) await (await caches.open('webllm/wasm')).put(url.href, verified.clone());
        return verified;
      }
      return response;
    };
    const metadataCache = await caches.open('ryadom/metadata-v1');
    const infoUrl = `${base}model-info.json`;
    const response = await metadataCache.match(infoUrl) || await fetch(infoUrl);
    const info = validateModelInfo(await response.clone().json());
    await metadataCache.put(infoUrl, response);
    send({ type: 'size', bytes: info.downloadBytes });
    resourceHashes = new Map(info.files.map(file => [new URL(file.path, base).href, file.sha256]));
    engine = new MLCEngine({
      logLevel: 'ERROR',
      appConfig: {
        useIndexedDBCache: false,
        model_list: [{
          model_id: MODEL_ID,
          // WebLLM requires /resolve/<revision>/ even for a self-hosted URL.
          model: `${base}resolve/main/`,
          model_lib: `${base}model.wasm`,
          required_features: ['shader-f16'],
          overrides: { context_window_size: CONTEXT_TOKENS },
        }],
      },
      initProgressCallback: report => send({ type: 'progress', progress: report.progress, text: report.text }),
    });
    await engine.reload(MODEL_ID);
    if (!fatal) send({ type: 'ready' });
  } catch (error) {
    fatal = true;
    send({ type: 'error', message: explainError(error), fatal: true });
  } finally { loading = false; }
}

scope.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === 'init') { await init(data.base); return; }
  if (data.type === 'stop') {
    if (active === data.id) { stopped = true; void engine?.interruptGenerate(); }
    return;
  }
  if (data.type !== 'generate') return;
  if (active || loading || !engine || fatal) {
    send({ type: 'error', id: data.id, message: 'Модель занята или не запущена.', fatal: false });
    return;
  }
  active = data.id;
  stopped = false;
  try {
    const context = buildContext(data.messages);
    send({ type: 'context', id: active, dropped: context.dropped });
    await engine.resetChat();
    if (stopped) { send({ type: 'done', id: active, reason: 'stopped' }); return; }
    const stream = await engine.chat.completions.create({
      messages: context.messages,
      stream: true,
      max_tokens: MAX_REPLY_TOKENS,
      temperature: 0.65,
      top_p: 0.9,
      frequency_penalty: 0.2,
    });
    let reason: 'complete' | 'length' = 'complete';
    for await (const chunk of stream) {
      if (fatal) break;
      // Drain the interrupted iterator: WebLLM 0.2.79 releases its model lock
      // only when the stream completes. Calling iterator.return() here would
      // leave the next generation waiting forever.
      if (stopped) { void engine.interruptGenerate(); continue; }
      const choice = chunk.choices[0];
      if (choice?.delta.content) send({ type: 'token', id: active, text: choice.delta.content });
      if (choice?.finish_reason === 'length') reason = 'length';
    }
    if (!fatal) send({ type: 'done', id: active, reason: stopped ? 'stopped' : reason });
  } catch (error) {
    // A broken GPU/runtime must be re-created, not silently reused.
    fatal = !/контекст|длинное/.test(String(error));
    send({ type: 'error', id: active, message: explainError(error), fatal });
  } finally { active = undefined; }
};
