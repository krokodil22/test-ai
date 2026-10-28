import source from '../scripts/model-source.json';
import { MODELS, modelByKey, readModelKey } from './models';
import type { ModelKey } from './models';

export { MODELS, MODEL_SELECTION_KEY } from './models';
export type { ModelKey } from './models';
let selected = modelByKey(readModelKey());
export const activeModel = () => selected;
export const BOT_NAME = 'Великий Тетриканец';
export let MODEL_ID = ''; export let MODEL_REVISION = ''; export let MODEL_NAME = '';
export let MODEL_DESCRIPTION = ''; export let MODEL_RESOURCE_PATH = '';
export let MODEL_GPU_MEMORY = ''; export let MODEL_RAM = ''; export let MODEL_ESTIMATE = '';
export let CONTEXT_TOKENS = 4096; export let MAX_REPLY_TOKENS = 512; export let MAX_INPUT_CHARS = 1200;
export let SYSTEM_PROMPT = ''; export let MODEL_ARCHIVE_MODE = false; export let SUPPORTS_THINKING = true;
export let GENERATION_OPTIONS: { temperature: number; top_p: number; repetition_penalty: number; frequency_penalty: number; presence_penalty: number; extra_body?: { enable_thinking: boolean } };
export let MODEL_CHAT_OPTIONS: { context_window_size: number; max_history_size: number; repetition_penalty: number; frequency_penalty: number; presence_penalty: number };
export const LEGACY_MODEL_IDS = source.legacyModelIds.filter(id => !MODELS.some(model => model.source.modelId === id));
export const CACHE_SCOPES = ['webllm/model', 'webllm/config', 'webllm/wasm', 'ryadom/metadata-v1'] as const;

export function configureModel(key: ModelKey): void {
  selected = modelByKey(key);
  const source = selected.source;
  MODEL_ID = source.modelId; MODEL_REVISION = source.revision; MODEL_NAME = source.displayName;
  MODEL_DESCRIPTION = source.description; MODEL_RESOURCE_PATH = `models/${source.directory}/`;
  MODEL_GPU_MEMORY = `≈ ${(source.vramRequiredMB / 1000).toFixed(1).replace('.', ',')} ГБ памяти GPU`;
  MODEL_RAM = `${source.ramRecommendedGB} ГБ свободной RAM`; MODEL_ESTIMATE = formatBytes(source.downloadBytes);
  CONTEXT_TOKENS = selected.contextTokens; MAX_REPLY_TOKENS = selected.maxReplyTokens; MAX_INPUT_CHARS = selected.maxInputChars;
  SUPPORTS_THINKING = selected.supportsThinking;
  SYSTEM_PROMPT = selected.supportsThinking
    ? `Ты — ${BOT_NAME}, внимательный ИИ-помощник. Отвечай на естественном русском языке, ясно и по существу. Меняй язык только по просьбе пользователя. Не выдавай выдумки за факты. В творческих заданиях создавай вымышленные истории. Если не знаешь ответ на фактический вопрос, скажи об этом. Обычно отвечай кратко. Короткий рассказ должен занимать 100–150 слов: сохрани героев и условия запроса, заверши сюжет и сформулируй понятную мораль.`
    : `Ты — ${BOT_NAME}. Отвечай кратко и понятно на русском языке. Сохраняй смысл вопроса и не выдумывай факты. Если не знаешь ответ, скажи об этом.`;
  GENERATION_OPTIONS = { temperature: 0.7, top_p: 0.8, repetition_penalty: 1, frequency_penalty: 0, presence_penalty: 0, ...(selected.supportsThinking ? { extra_body: { enable_thinking: false } } : {}) };
  MODEL_CHAT_OPTIONS = { context_window_size: CONTEXT_TOKENS, max_history_size: 1, repetition_penalty: 1, frequency_penalty: 0, presence_penalty: 0 };
  MODEL_ARCHIVE_MODE = import.meta.env.VITE_MODEL_DELIVERY === 'archive' && source.pagesDelivery === 'archive';
}
configureModel(selected.key);

export function resourceBase(pageUrl: string = location.href): string {
  const appBase = new URL(import.meta.env.BASE_URL, pageUrl);
  const override = selected.key === 'qwen35-4b' ? import.meta.env.VITE_MODEL_BASE_URL : import.meta.env.VITE_LIGHT_MODEL_BASE_URL;
  const configured = override || (import.meta.env.VITE_MODELS_BASE_URL ? `${import.meta.env.VITE_MODELS_BASE_URL.replace(/\/?$/, '/')}${selected.source.directory}/` : MODEL_RESOURCE_PATH);
  const url = new URL(configured.endsWith('/') ? configured : `${configured}/`, appBase);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Ресурсы модели должны загружаться по HTTPS. HTTP допустим только на localhost.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Адрес ресурсов не должен содержать пароль, параметры или фрагмент.');
  return url.href;
}

export interface ModelInfo {
  schema: 1;
  modelId: string;
  revision: string;
  downloadBytes: number;
  unpackedBytes?: number;
  files: Array<{ path: string; bytes: number; sha256: string; scope: typeof CACHE_SCOPES[number]; download?: { encoding: 'gzip'; path: string; bytes: number; sha256: string } }>;
}

export function validateModelInfo(value: unknown): ModelInfo {
  const info = value as ModelInfo;
  if (info?.schema !== 1 || info.modelId !== MODEL_ID || info.revision !== MODEL_REVISION || !Array.isArray(info.files) || info.files.length < 4 || !Number.isFinite(info.downloadBytes) || info.downloadBytes <= 0) {
    throw new Error('Некорректный model-info.json. Выполните npm run model:download и опубликуйте все ресурсы.');
  }
  for (const file of info.files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.includes('..') || file.path.startsWith('/') || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isFinite(file.bytes) || file.bytes <= 0 || !CACHE_SCOPES.includes(file.scope)) {
      throw new Error('Некорректная запись в манифесте ресурсов модели.');
    }
    if (file.download && (file.download.encoding !== 'gzip' || file.download.path !== file.path + '.gz' || !Number.isSafeInteger(file.download.bytes) || file.download.bytes <= 0 || !/^[a-f0-9]{64}$/.test(file.download.sha256))) throw new Error('Некорректный архив модели в манифесте ресурсов.');
  }
  for (const path of ['model.wasm', 'resolve/main/mlc-chat-config.json', `resolve/main/${activeModel().source.cacheManifest}`, 'resolve/main/tokenizer.json']) {
    if (!info.files.some(file => file.path === path)) throw new Error(`В манифесте нет ${path}.`);
  }
  return info;
}

export function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} ГБ` : `${Math.ceil(bytes / 1e6)} МБ`;
}
