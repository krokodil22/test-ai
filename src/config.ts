export const MODEL_ID = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';
export const MODEL_NAME = 'Qwen2.5 · 0.5B';
export const CONTEXT_TOKENS = 4096;
export const MAX_REPLY_TOKENS = 512;
export const MAX_INPUT_CHARS = 1200;
export const SYSTEM_PROMPT = 'Ты — Рядом, внимательный ИИ-помощник. Отвечай на русском языке, ясно и кратко. Если не знаешь ответ, так и скажи. Не выдумывай факты.';
export const MODEL_ESTIMATE = '289 МБ';
export const CACHE_SCOPES = ['webllm/model', 'webllm/config', 'webllm/wasm', 'ryadom/metadata-v1'] as const;

export function resourceBase(pageUrl: string = location.href): string {
  const appBase = new URL(import.meta.env.BASE_URL, pageUrl);
  const configured = import.meta.env.VITE_MODEL_BASE_URL || 'models/qwen2.5-0.5b/';
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
  if (info?.schema !== 1 || info.modelId !== MODEL_ID || !Array.isArray(info.files) || info.files.length < 4 || !Number.isFinite(info.downloadBytes) || info.downloadBytes <= 0) {
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
