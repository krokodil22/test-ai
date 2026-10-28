import { afterEach, expect, it, vi } from 'vitest';
import { activeModel, configureModel, MODEL_ID, CONTEXT_TOKENS, MAX_REPLY_TOKENS, MAX_INPUT_CHARS, GENERATION_OPTIONS, LEGACY_MODEL_IDS, SYSTEM_PROMPT, resourceBase } from '../../src/config';
import { readModelKey, modelByKey } from '../../src/models';
import { readMemoryMode, runtimeFor } from '../../src/memory-mode';
import { buildContext, tokenUpperBound } from '../../src/context';
import { probeGpu } from '../../src/gpu';
import { comparisonCompletionRequest, compareAnswers } from '../../src/comparison';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); configureModel('qwen35-4b'); });
it('defaults to 4B economy and does not classify either supported model as obsolete', () => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  expect(readModelKey()).toBe('qwen35-4b'); expect(readMemoryMode()).toBe('economy');
  expect(LEGACY_MODEL_IDS).not.toContain('Qwen2.5-0.5B-Instruct-q4f16_1-MLC');
  expect(() => modelByKey('unknown')).toThrow('Неизвестная');
});
it('switches all inference limits and omits the unsupported thinking prefix for Qwen2.5', () => {
  configureModel('qwen2.5-0.5b');
  expect(MODEL_ID).toBe('Qwen2.5-0.5B-Instruct-q4f16_1-MLC');
  expect(CONTEXT_TOKENS).toBe(2048); expect(MAX_REPLY_TOKENS).toBe(256); expect(MAX_INPUT_CHARS).toBe(600);
  expect(GENERATION_OPTIONS.extra_body).toBeUndefined(); expect(readMemoryMode()).toBe('standard');
  expect(runtimeFor('economy')).toMatchObject({ path: 'model.wasm', mode: 'standard', contextTokens: 2048, maxBatchSize: 1 });
  const request = comparisonCompletionRequest({ stage: 'direct', sourceText: 'Привет', messages: [{ role: 'user', content: 'Привет' }], maxTokens: 64, temperature: 0, topP: 1, seed: 42, enableThinking: false });
  expect(request.extra_body).toBeUndefined();
  const messages = [{ id: 'one', role: 'user' as const, content: 'я'.repeat(600) }];
  const before = structuredClone(messages); const context = buildContext(messages);
  expect(context.messages[0].content).toBe(SYSTEM_PROMPT);
  expect(context.messages.reduce((sum, item) => sum + tokenUpperBound(item.content), 0) + MAX_REPLY_TOKENS + 128).toBeLessThanOrEqual(CONTEXT_TOKENS);
  expect(messages).toEqual(before);
});
it('supports per-model URLs and a shared CORS storage root', () => {
  vi.stubEnv('BASE_URL', '/test-ai/'); vi.stubEnv('VITE_MODEL_BASE_URL', 'https://main.example/big/');
  vi.stubEnv('VITE_LIGHT_MODEL_BASE_URL', 'https://small.example/light/');
  expect(resourceBase('https://site.example/test-ai/')).toBe('https://main.example/big/');
  configureModel('qwen2.5-0.5b'); expect(resourceBase('https://site.example/test-ai/')).toBe('https://small.example/light/');
  vi.stubEnv('VITE_LIGHT_MODEL_BASE_URL', ''); vi.stubEnv('VITE_MODELS_BASE_URL', 'https://storage.example/all-models');
  expect(resourceBase('https://site.example/test-ai/')).toBe('https://storage.example/all-models/qwen2.5-0.5b/');
});
it('checks the selected model against the real GPU preflight code before loading any resources', async () => {
  vi.stubGlobal('isSecureContext', true);
  const destroy = vi.fn();
  const adapter = { features: new Set(['shader-f16']), limits: { maxStorageBufferBindingSize: 268435456, maxBufferSize: 268435456, maxComputeWorkgroupStorageSize: 32768, maxStorageBuffersPerShaderStage: 10 }, requestDevice: vi.fn(async () => ({ destroy })), info: { description: 'Small adapter' } };
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => adapter } });
  await expect(probeGpu()).rejects.toThrow('слишком малы');
  configureModel('qwen2.5-0.5b'); await expect(probeGpu()).resolves.toBe('Small adapter');
  expect(adapter.requestDevice).toHaveBeenCalledOnce(); expect(destroy).toHaveBeenCalledOnce();
  expect(activeModel().source.minimumStorageBufferBytes).toBe(134217728);
});

it('fits the translation experiment into the light model context without its demonstration turn', async () => {
  configureModel('qwen2.5-0.5b');
  const requests: Array<{ stage: string; messages: Array<{content: string}>; maxTokens: number }> = [];
  await compareAnswers('Придумай короткий поучительный рассказ про свинку, которая не умела плавать', async request => {
    requests.push(request);
    const text = request.stage === 'translate-input' ? 'Write a short story about a pig that could not swim.' : request.stage === 'english-answer' ? 'The pig could not swim. Her friends helped her learn.' : 'Свинка не умела плавать. Друзья помогли ей научиться.';
    return { text, finish: 'complete', seconds: 1 };
  }, () => {}, () => false);
  for (const request of requests.filter(item => item.stage !== 'translate-output')) {
    expect(request.messages.reduce((sum, message) => sum + tokenUpperBound(message.content), 0) + request.maxTokens + 128).toBeLessThanOrEqual(CONTEXT_TOKENS);
  }
  expect(requests.find(item => item.stage === 'translate-input')!.messages).toHaveLength(2);
});
