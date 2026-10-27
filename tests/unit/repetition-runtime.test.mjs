import { expect, it, vi } from 'vitest';
import { readFile, writeFile, mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { MODEL_CHAT_OPTIONS, MODEL_ID } from '../../src/config';
import { comparePenalty, comparisonCompletionRequest } from '../../src/comparison';

it('uses the actual WebLLM public request and sampler to switch 1.1 → no penalty → 1.1 without reloading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tetrikanets-runtime-'));
  try {
    // Re-export the pinned bundle's private pipeline only in a temporary test
    // module. The dependency and production build stay untouched. Tensor/GPU
    // operations are spies; the actual request mapping and branch logic run.
    const require = createRequire(import.meta.url);
    const source = await readFile(require.resolve('@mlc-ai/web-llm'), 'utf8');
    await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction');
    const modulePath = join(root, 'runtime.mjs');
    await writeFile(modulePath, source.replace(/\/\/# sourceMappingURL=.*$/m, '') + '\nexport { LLMChatPipeline };\n');
    const { MLCEngine, LLMChatPipeline, ModelType } = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
    const repetition = vi.fn();
    const additive = vi.fn();
    const pipeline = Object.assign(Object.create(LLMChatPipeline.prototype), {
      config: { ...MODEL_CHAT_OPTIONS, temperature: 0.7, top_p: 0.8 },
      appearedTokensFreq: new Map([[7, 3]]),
      logitsOnCPU: {}, updateLogitsOnCPU: vi.fn(), device: { sync: async () => {} },
      tvm: { beginScope() {}, endScope() {}, cpu() {}, empty: () => ({ copyFrom() {} }), applyRepetitionPenalty: repetition, applyPresenceAndFrequencyPenalty: additive, sampleTopPFromLogits: () => 7 },
    });
    const engine = new MLCEngine({ logLevel: 'ERROR' });
    engine.getLLMStates = () => [MODEL_ID, pipeline, pipeline.config];
    engine.loadedModelIdToModelType.set(MODEL_ID, ModelType.LLM);
    engine.loadedModelIdToLock.set(MODEL_ID, { acquire: async () => {} });
    engine.asyncGenerate = async function* (_request, _model, selected, _config, genConfig) {
      const token = await selected.sampleTokenFromLogits({}, genConfig);
      yield { choices: [{ delta: { content: String(token) } }] };
    };
    const requests = [];
    await comparePenalty('Как приготовить омлет из двух яиц?', async request => {
      requests.push(request);
      repetition.mockClear(); additive.mockClear();
      const stream = await engine.chat.completions.create(comparisonCompletionRequest(request));
      for await (const _chunk of stream) { /* executes the actual sampler */ }
      if (request.stage === 'direct') {
        expect(repetition).toHaveBeenCalledOnce();
        expect(repetition.mock.calls[0][2]).toBe(1.1);
        expect(additive).not.toHaveBeenCalled();
      } else {
        expect(repetition).not.toHaveBeenCalled();
        expect(additive).toHaveBeenCalledOnce();
        expect(additive.mock.calls[0].slice(-2)).toEqual([0, 0]);
      }
      return { text: 'Текст для проверки протокола, не ответ модели.', finish: 'complete', seconds: 1 };
    }, () => {}, () => false);
    repetition.mockClear(); additive.mockClear();
    const repeated = await engine.chat.completions.create(comparisonCompletionRequest(requests[0]));
    for await (const _chunk of repeated) { /* ensure zeros were not persisted */ }
    expect(repetition).toHaveBeenCalledOnce();
    expect(additive).not.toHaveBeenCalled();
    expect(pipeline.config.frequency_penalty).toBeUndefined();
    expect(pipeline.config.presence_penalty).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
