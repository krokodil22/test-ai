import mainSource from '../scripts/model-source.json';
import lightSource from '../scripts/light-model-source.json';
export type ModelKey = 'qwen35-4b' | 'qwen2.5-0.5b';
export interface ModelSource {
  modelId: string; repository: string; revision: string; directory: string;
  displayName: string; description: string; downloadBytes: number; vramRequiredMB: number;
  ramRecommendedGB: string; minimumStorageBufferBytes: number; cacheManifest: string;
  packaging: string; pagesDelivery: string;
  runtime: { webllm: string; bytes: number; sha256: string; url?: string; prefillChunkSize?: number; maxBatchSize?: number };
}
export interface ModelDefinition {
  key: ModelKey; source: ModelSource; contextTokens: number; maxReplyTokens: number;
  maxInputChars: number; supportsThinking: boolean; supportsEconomy: boolean;
}
export const MODELS: readonly ModelDefinition[] = [
  { key: 'qwen35-4b', source: mainSource, contextTokens: 4096, maxReplyTokens: 512, maxInputChars: 1200, supportsThinking: true, supportsEconomy: true },
  { key: 'qwen2.5-0.5b', source: lightSource, contextTokens: 2048, maxReplyTokens: 256, maxInputChars: 600, supportsThinking: false, supportsEconomy: false },
];
export const DEFAULT_MODEL_KEY: ModelKey = 'qwen35-4b';
export const MODEL_SELECTION_KEY = 'tetrikanets:model:v1';
export function modelByKey(key: string): ModelDefinition {
  const model = MODELS.find(item => item.key === key);
  if (!model) throw Error('Неизвестная модель. Обновите страницу и выберите модель в настройках.');
  return model;
}
export function readModelKey(): ModelKey {
  try { const key = localStorage.getItem(MODEL_SELECTION_KEY); return MODELS.some(model => model.key === key) ? key as ModelKey : DEFAULT_MODEL_KEY; }
  catch { return DEFAULT_MODEL_KEY; }
}
