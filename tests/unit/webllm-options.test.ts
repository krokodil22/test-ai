import { afterEach, expect, it, vi } from 'vitest';
import { MLCEngine } from '@mlc-ai/web-llm';
import type { ChatOptions } from '@mlc-ai/web-llm';
import { MODEL_CHAT_OPTIONS, MODEL_ID } from '../../src/config';

afterEach(() => vi.unstubAllGlobals());

it('overrides upstream zero penalties through the actual WebLLM reload path', async () => {
  // No GPU or weights are needed to reproduce the regression: WebLLM first
  // merges the remote chat config and only then fetches its WASM library.
  const stop = new Error('Stop before WASM/GPU initialization');
  vi.stubGlobal('location', { origin: 'https://test.example' });
  const fetchResource = vi.fn(async (request: Request) => {
    if (request.url.endsWith('.wasm')) throw stop;
    return Response.json({ frequency_penalty: 0, presence_penalty: 0, repetition_penalty: 1.1, context_window_size: 32768 });
  });
  const stores = new Map<string, Map<string, Response>>();
  vi.stubGlobal('caches', { open: async (name: string) => {
    const entries = stores.get(name) || new Map<string, Response>();
    stores.set(name, entries);
    return {
      match: async (request: Request) => entries.get(request.url)?.clone(),
      add: async (request: Request) => entries.set(request.url, await fetchResource(request)),
    };
  } });
  const engine = new MLCEngine({ logLevel: 'ERROR', appConfig: { model_list: [{ model_id: MODEL_ID, model: 'https://test.example/model/resolve/main/', model_lib: 'https://test.example/model/model.wasm', overrides: MODEL_CHAT_OPTIONS }] } });
  try {
    await expect(engine.reload(MODEL_ID)).rejects.toBe(stop);
    // A pinned-dependency regression test intentionally inspects the config
    // stored by WebLLM itself, rather than reimplementing its merge algorithm.
    const config = (engine as unknown as { loadedModelIdToChatConfig: Map<string, ChatOptions & { prefill_chunk_size: number }> }).loadedModelIdToChatConfig.get(MODEL_ID)!;
    expect(config.repetition_penalty).toBeGreaterThan(1);
    expect(config.frequency_penalty).toBeUndefined();
    expect(config.presence_penalty).toBeUndefined();
    expect(config.context_window_size).toBe(4096);
    expect(config.prefill_chunk_size).toBe(1024);
  } finally { await engine.unload(); }
});
