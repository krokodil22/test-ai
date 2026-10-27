import { expect, it, vi } from 'vitest';
import { readFile, writeFile, mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { MODEL_CHAT_OPTIONS, MODEL_ID } from '../../src/config';
import { comparePenalty, comparisonCompletionRequest } from '../../src/comparison';

it('forwards repetition penalties through the actual WebLLM 0.2.86 public request and GPU sampler', async () => {
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
    const penalty = vi.fn();
    const tensor = () => ({ data: undefined, copyFrom(value) { this.data = value; return this; }, view() { return this; }, toArray: () => new Int32Array([7]), dispose() {} });
    const pipeline = Object.assign(Object.create(LLMChatPipeline.prototype), {
      config: { ...MODEL_CHAT_OPTIONS, temperature: 0.7, top_p: 0.8 },
      appearedTokensFreq: new Map([[7, 3]]),
      fullVocabSize: 8, sampleIndices: [0], sampleIndicesDevice: tensor(), topPDevice: tensor(),
      device: { sync: async () => {} },
      fapplyPenalty: penalty, fsoftmaxWithTemperature: () => tensor(), fargsortProbs: () => ({ get: () => tensor() }), fsampleWithTopP: () => tensor(),
      tvm: { beginScope() {}, endScope() {}, cpu() {}, empty: tensor, uniform: tensor, detachFromCurrentScope: value => value },
    });
    const engine = new MLCEngine({ logLevel: 'ERROR' });
    engine.getLLMStates = () => [MODEL_ID, pipeline, pipeline.config];
    engine.loadedModelIdToModelType.set(MODEL_ID, ModelType.LLM);
    engine.loadedModelIdToLock.set(MODEL_ID, { acquire: async () => {} });
    engine.asyncGenerate = async function* (_request, _model, selected, _config, genConfig) {
      const token = await selected.sampleFromRawLogits(tensor(), genConfig);
      yield { choices: [{ delta: { content: String(token) } }] };
    };
    const requests = [];
    await comparePenalty('Как приготовить омлет из двух яиц?', async request => {
      requests.push(request);
      penalty.mockClear();
      const stream = await engine.chat.completions.create(comparisonCompletionRequest(request));
      for await (const _chunk of stream) { /* executes the actual sampler */ }
      if (request.stage === 'direct') {
        expect(penalty).toHaveBeenCalledOnce();
        expect(Array.from(penalty.mock.calls[0][5].data).slice(0, 2)).toEqual([0, 0]);
        expect(penalty.mock.calls[0][5].data[2]).toBeCloseTo(1.1);
      } else {
        expect(penalty).not.toHaveBeenCalled();
      }
      return { text: 'Текст для проверки протокола, не ответ модели.', finish: 'complete', seconds: 1 };
    }, () => {}, () => false);
    penalty.mockClear();
    const repeated = await engine.chat.completions.create(comparisonCompletionRequest(requests[0]));
    for await (const _chunk of repeated) { /* ensure zeros were not persisted */ }
    expect(penalty).toHaveBeenCalledOnce();
    expect(pipeline.config.repetition_penalty).toBe(1);
    expect(pipeline.config.frequency_penalty).toBe(0);
    expect(pipeline.config.presence_penalty).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
