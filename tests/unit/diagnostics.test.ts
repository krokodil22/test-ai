import { afterEach, expect, it, vi } from 'vitest';
import { runDiagnostics, validateReference, DIAGNOSTIC_PROFILE } from '../../src/diagnostics';
import { ComparisonStopped } from '../../src/comparison';
import type { StageRequest } from '../../src/comparison';
import { referenceFixture } from '../fixtures/reference';
import { describeGpu, browserEnvironment } from '../../src/gpu-info';
import { readFile } from 'node:fs/promises';
afterEach(() => vi.unstubAllGlobals());
it('runs six fresh RU/EN requests with the same neutral system and greedy decoding, keeping exact results', async () => {
  const requests: StageRequest[] = [];
  const results = await runDiagnostics(async request => { requests.push(request); return { text: request.sourceText, finish: 'complete', seconds: 1 }; }, () => {}, () => false);
  expect(requests).toHaveLength(6);
  expect(results.map(item => item.caseId)).toEqual(DIAGNOSTIC_PROFILE.cases.map(item => item.id));
  for (const [i, request] of requests.entries()) {
    expect(request.messages).toEqual([{ role: 'system', content: DIAGNOSTIC_PROFILE.systemPrompt }, { role: 'user', content: DIAGNOSTIC_PROFILE.cases[i].prompt }]);
    expect(request.temperature).toBe(0); expect(request.topP).toBe(1); expect(request.seed).toBe(42);
    expect(request.enableThinking).toBe(false); expect(request.frequencyPenalty).toBe(0); expect(request.presencePenalty).toBe(0);
    expect(results[i].text).toBe(request.sourceText);
  }
});
it('stops the diagnostic suite before another generation and rejects empty results', async () => {
  let stopped = false; let calls = 0;
  await expect(runDiagnostics(async () => { calls++; stopped = true; return { text: '4', finish: 'complete', seconds: 1 }; }, () => {}, () => stopped)).rejects.toBeInstanceOf(ComparisonStopped);
  expect(calls).toBe(1);
  await expect(runDiagnostics(async () => ({ text: '', finish: 'complete', seconds: 1 }), () => {}, () => false)).rejects.toThrow('пустой ответ');
});
it('accepts only the matching complete CPU reference, never labels a mismatched run as comparable', () => {
  expect(validateReference(referenceFixture).results).toHaveLength(6);
  expect(() => validateReference({ ...referenceFixture, complete: false })).toThrow();
  expect(() => validateReference({ ...referenceFixture, dtype: 'float16' })).toThrow();
  expect(() => validateReference({ ...referenceFixture, settings: { ...referenceFixture.settings, temperature: 0.7 } })).toThrow('Настройки');
  expect(() => validateReference({ ...referenceFixture, results: referenceFixture.results.slice(1) })).toThrow();
  expect(() => validateReference({ ...referenceFixture, results: referenceFixture.results.map((result, i) => i ? result : { ...result, prompt: 'Other prompt' }) })).toThrow('запросов');
});
it('ships an actual complete CPU result matching the exact current questions and protocol', async () => {
  const data = JSON.parse(await readFile(new URL('../../public/diagnostics/qwen3-reference.json', import.meta.url), 'utf8'));
  const reference = validateReference(data);
  expect(reference.engine).toBe('Transformers 4.51.3');
  expect(reference.results.every(result => Number.isFinite(result.seconds) && result.seconds > 0)).toBe(true);
  expect(reference.results.filter(result => result.caseId.startsWith('arithmetic')).map(result => result.text)).toEqual(['4', '4']);
});
it('exports actual adapter versus device limits and handles privacy-hidden GPU identity', () => {
  const adapter = { features: new Set(['shader-f16']), limits: { maxStorageBufferBindingSize: 268435456 }, get info() { throw Error('Withheld'); } } as unknown as GPUAdapter;
  const device = { features: new Set(['shader-f16']), limits: { maxStorageBufferBindingSize: 155582464 } } as unknown as GPUDevice;
  const info = describeGpu(adapter, device);
  expect(info.adapter.description).toBe('');
  expect(info.adapter.limits.maxStorageBufferBindingSize).toBe(268435456);
  expect(info.device.limits.maxStorageBufferBindingSize).toBe(155582464);
  vi.stubGlobal('navigator', { userAgent: 'Test browser', platform: 'Test platform', language: 'ru', hardwareConcurrency: 4, gpu: {} });
  expect(browserEnvironment().webgpu).toBe(true);
});
