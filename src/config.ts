import source from '../scripts/model-source.json';

export const MODEL_ID = source.modelId;
export const MODEL_REVISION = source.revision;
export const MODEL_NAME = source.displayName;
export const MODEL_DESCRIPTION = source.description;
export const MODEL_RESOURCE_PATH = `models/${source.directory}/`;
export const MODEL_GPU_MEMORY = `≈ ${(source.vramRequiredMB / 1000).toFixed(1).replace('.', ',')} ГБ памяти GPU`;
export const MODEL_RAM = `${source.ramRecommendedGB} ГБ свободной RAM`;
export const LEGACY_MODEL_IDS: readonly string[] = source.legacyModelIds;
export const CONTEXT_TOKENS = 4096;
export const MAX_REPLY_TOKENS = 512;
export const MAX_INPUT_CHARS = 1200;
export const SYSTEM_PROMPT = 'Ты — Рядом, внимательный ИИ-помощник. Отвечай на естественном русском языке, ясно и кратко. Меняй язык только по просьбе пользователя. Соблюдай грамматику. Если не знаешь ответ, скажи об этом. Не выдумывай факты.';
export const MODEL_ESTIMATE = formatBytes(source.downloadBytes);
export const GENERATION_OPTIONS = { temperature: 0.35, top_p: 0.85, frequency_penalty: 0, presence_penalty: 0 } as const;
export const CACHE_SCOPES = ['webllm/model', 'webllm/config', 'webllm/wasm', 'ryadom/metadata-v1'] as const;

export function resourceBase(pageUrl: string = location.href): string {
  const appBase = new URL(import.meta.env.BASE_URL, pageUrl);
  const configured = import.meta.env.VITE_MODEL_BASE_URL || MODEL_RESOURCE_PATH;
  const url = new URL(configured.endsWith('/') ? configured : `${configured}/`, appBase);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Ресурсы модели должны загружаться по HTTPS. HTTP допустим только на localhost.');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Адрес ресурсов не должен содержать пароль, параметры или фрагмент.');
  return url.href;
}

export interface ModelInfo {
  schema: 1;
  modelId: string;
  revision: string;
  downloadBytes: number;
  files: Array<{ path: string; bytes: number; sha256: string; scope: typeof CACHE_SCOPES[number] }>;
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
  }
  for (const path of ['model.wasm', 'resolve/main/mlc-chat-config.json', 'resolve/main/ndarray-cache.json', 'resolve/main/tokenizer.json']) {
    if (!info.files.some(file => file.path === path)) throw new Error(`В манифесте нет ${path}.`);
  }
  return info;
}

export function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} ГБ` : `${Math.ceil(bytes / 1e6)} МБ`;
}
