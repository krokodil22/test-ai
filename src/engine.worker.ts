/// <reference lib="webworker" />
import { MLCEngine } from '@mlc-ai/web-llm';
import { probeGpu, monitorGpu } from '#gpu';
import { MODEL_ID, MODEL_CHAT_OPTIONS, MAX_REPLY_TOKENS, GENERATION_OPTIONS } from './config';
import { loadModelInfo, removeLegacyModelCache } from './cache';
import { buildContext } from './context';
import { explainError } from './errors';
import { compareAnswers, compareThinking, ComparisonStopped, ComparisonInputError } from './comparison';
import type { StageRequest } from './comparison';
import { TranslatorClient } from './translator-client';
import { prepareModelCache } from './model-resources';
import { visibleQwenStream, thinkingQwenStream } from './stream-text';
import type { WorkerEvent, WorkerRequest } from './types';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const send = (event: WorkerEvent) => scope.postMessage(event);
let engine: MLCEngine | undefined;
let translator: TranslatorClient | undefined;
let active: string | undefined;
let stopped = false;
let loading = false;
let fatal = false;
let resourceHashes = new Map<string, string>();
const nativeFetch = globalThis.fetch.bind(globalThis);

async function comparisonStage(request: StageRequest) {
  const start = performance.now();
  if (request.stage === 'translate-output') {
    if (!translator) throw new ComparisonInputError('Для обратного перевода нужен локальный OPUS-MT. Откройте обновлённую страницу эксперимента.');
    try {
      const text = await translator.translate(request.sourceText, (done, total) => send({ type: 'comparison-progress', id: active!, done, total }));
      if (stopped || fatal) throw new ComparisonStopped();
      return { text, finish: 'complete' as const, seconds: (performance.now() - start) / 1000 };
    } catch (error) {
      if (stopped || fatal) throw new ComparisonStopped();
      if (error instanceof Error && /Слишком длинное предложение|достиг лимита|пустое предложение/.test(error.message)) throw new ComparisonInputError(error.message);
      throw error;
    }
  }
  await engine!.resetChat();
  if (stopped || fatal) throw new ComparisonStopped();
  const stream = await engine!.chat.completions.create({ messages: request.messages, stream: true, stream_options: { include_usage: true }, max_tokens: request.maxTokens, temperature: request.temperature, top_p: request.topP, seed: request.seed, extra_body: { enable_thinking: request.enableThinking }, ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty, presence_penalty: request.presencePenalty } : {}) });
  const visible = visibleQwenStream();
  const thinking = request.enableThinking ? thinkingQwenStream() : undefined;
  let text = '';
  let reasoning = '';
  let generatedTokens: number | undefined;
  let firstAnswerSeconds: number | undefined;
  function emit(parts: { answer: string; reasoning: string }) {
    if (parts.reasoning) {
      reasoning += parts.reasoning;
      send({ type: 'comparison-reasoning', id: active!, text: parts.reasoning });
    }
    if (parts.answer) {
      if (firstAnswerSeconds === undefined && parts.answer.trim()) firstAnswerSeconds = (performance.now() - start) / 1000;
      text += parts.answer;
      send({ type: 'comparison-token', id: active!, stage: request.stage, text: parts.answer });
    }
  }
  let finish: 'complete' | 'length' = 'complete';
  for await (const chunk of stream) {
    if (fatal) break;
    if (stopped) { void engine!.interruptGenerate(); continue; }
    const choice = chunk.choices[0];
    if (choice?.delta.content) {
      emit(thinking ? thinking.push(choice.delta.content) : { answer: visible(choice.delta.content), reasoning: '' });
    }
    if (choice?.finish_reason === 'length') finish = 'length';
    if (chunk.usage) generatedTokens = chunk.usage.completion_tokens;
  }
  if (stopped || fatal) throw new ComparisonStopped();
  if (thinking) emit(thinking.finish());
  return { text: text.trim(), finish, seconds: (performance.now() - start) / 1000, generatedTokens, firstAnswerSeconds, ...(thinking ? { thinking: { status: thinking.status(), text: reasoning.trim() } } : {}) };
}

async function init(base: string, translatorBase?: string) {
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
    await removeLegacyModelCache();
    const info = await loadModelInfo(base);
    send({ type: 'size', bytes: info.downloadBytes });
    resourceHashes = new Map(info.files.map(file => [new URL(file.path, base).href, file.sha256]));
    const qwenShare = translatorBase ? 0.8 : 1;
    await prepareModelCache(base, info, nativeFetch, (value, text) => send({ type: 'progress', progress: value * 0.7 * qwenShare, text }));
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
          overrides: MODEL_CHAT_OPTIONS,
        }],
      },
      initProgressCallback: report => send({ type: 'progress', progress: (0.7 + report.progress * 0.3) * qwenShare, text: report.text }),
    });
    await engine.reload(MODEL_ID);
    if (translatorBase && !fatal) {
      translator = new TranslatorClient((value, text) => send({ type: 'progress', progress: 0.8 + value * 0.2, text }));
      await translator.init(translatorBase);
    }
    if (!fatal) send({ type: 'ready' });
  } catch (error) {
    translator?.terminate();
    fatal = true;
    send({ type: 'error', message: explainError(error), fatal: true });
  } finally { loading = false; }
}

scope.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === 'init') { await init(data.base, data.translatorBase); return; }
  if (data.type === 'stop') {
    if (active === data.id) { stopped = true; void engine?.interruptGenerate(); translator?.stop(); }
    return;
  }
  if (data.type !== 'generate' && data.type !== 'compare') return;
  if (active || loading || !engine || fatal) {
    send({ type: 'error', id: data.id, message: 'Модель занята или не запущена.', fatal: false });
    return;
  }
  active = data.id;
  stopped = false;
  if (data.type === 'compare') {
    try {
      const compare = data.mode === 'thinking' ? compareThinking : compareAnswers;
      const result = await compare(data.prompt, comparisonStage, update => {
        if (update.phase === 'start') send({ type: 'comparison-stage', id: data.id, stage: update.stage });
        else send({ type: 'comparison-result', id: data.id, result: update.result });
      }, () => stopped || fatal);
      send({ type: 'comparison-done', id: data.id, result, stopped: false });
    } catch (error) {
      if (error instanceof ComparisonStopped) { if (!fatal) send({ type: 'comparison-done', id: data.id, stopped: true }); }
      else {
        const recoverable = error instanceof ComparisonInputError;
        fatal = !recoverable;
        send({ type: 'error', id: data.id, message: recoverable ? error.message : explainError(error), fatal });
      }
    } finally { active = undefined; }
    return;
  }
  try {
    const context = buildContext(data.messages);
    send({ type: 'context', id: active, dropped: context.dropped });
    await engine.resetChat();
    if (stopped) { send({ type: 'done', id: active, reason: 'stopped' }); return; }
    const stream = await engine.chat.completions.create({
      messages: context.messages,
      stream: true,
      max_tokens: MAX_REPLY_TOKENS,
      ...GENERATION_OPTIONS,
    });
    const visible = visibleQwenStream();
    let reason: 'complete' | 'length' = 'complete';
    for await (const chunk of stream) {
      if (fatal) break;
      // Drain the interrupted iterator: WebLLM 0.2.79 releases its model lock
      // only when the stream completes. Calling iterator.return() here would
      // leave the next generation waiting forever.
      if (stopped) { void engine.interruptGenerate(); continue; }
      const choice = chunk.choices[0];
      if (choice?.delta.content) { const delta = visible(choice.delta.content); if (delta) send({ type: 'token', id: active, text: delta }); }
      if (choice?.finish_reason === 'length') reason = 'length';
    }
    if (!fatal) send({ type: 'done', id: active, reason: stopped ? 'stopped' : reason });
  } catch (error) {
    // A broken GPU/runtime must be re-created, not silently reused.
    fatal = !/контекст|длинное/.test(String(error));
    send({ type: 'error', id: active, message: explainError(error), fatal });
  } finally { active = undefined; }
};
