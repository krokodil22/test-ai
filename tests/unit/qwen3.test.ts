import { afterEach, expect, it, vi } from 'vitest';
import { visibleQwenStream, thinkingQwenStream } from '../../src/stream-text';
import { probeGpu, monitorGpu } from '../../src/gpu';
import source from '../../scripts/model-source.json';
afterEach(() => vi.unstubAllGlobals());
it('removes only the leading empty runtime thinking block across stream chunks', () => {
  const visible = visibleQwenStream();
  const chunks = ['<thi', 'nk>\n\n</thi', 'nk>\n\nПервый', ' ответ.'];
  expect(chunks.map(visible).join('')).toBe('Первый ответ.');
  const ordinary = visibleQwenStream();
  expect(['Русский текст ', '<think>в примере</think>'].map(ordinary).join('')).toBe('Русский текст <think>в примере</think>');
});

it('keeps thinking separate from the answer at every delimiter split and one character at a time', () => {
  const source = ' \n<think>Проверю героя и мораль.</think>\n\nБегемот перестал кусаться. Пример: <think>тег</think>.';
  const cases = Array.from({ length: source.length + 1 }, (_, i) => [source.slice(0, i), source.slice(i)]);
  cases.push([...source]);
  for (const chunks of cases) {
    const stream = thinkingQwenStream();
    const parts = chunks.map(chunk => stream.push(chunk));
    parts.push(stream.finish());
    expect(parts.map(part => part.reasoning).join('')).toBe('Проверю героя и мораль.');
    expect(parts.map(part => part.answer).join('')).toBe('\n\nБегемот перестал кусаться. Пример: <think>тег</think>.');
    expect(stream.status()).toBe('complete');
  }
});

it('reports unfinished reasoning without leaking it or a partial closing delimiter into the answer', () => {
  const stream = thinkingQwenStream();
  const parts = ['<thi', 'nk>Незаконченный план.', '</thi'].map(chunk => stream.push(chunk));
  parts.push(stream.finish());
  expect(parts.map(part => part.answer).join('')).toBe('');
  expect(parts.map(part => part.reasoning).join('')).toBe('Незаконченный план.</thi');
  expect(stream.status()).toBe('unfinished');
});

it('preserves a plain answer and reports that the requested thinking block was missing', () => {
  const stream = thinkingQwenStream();
  const parts = ['Обычный ', 'ответ <think>внутри примера</think>.'].map(chunk => stream.push(chunk));
  parts.push(stream.finish());
  expect(parts.map(part => part.answer).join('')).toBe('Обычный ответ <think>внутри примера</think>.');
  expect(parts.every(part => !part.reasoning)).toBe(true);
  expect(stream.status()).toBe('missing');
});
it('rejects a 128 MiB adapter before downloading the larger Qwen3 embedding tensor', async () => {
  const requestDevice = vi.fn();
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ features: new Set(['shader-f16']), limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024 }, requestDevice }) } });
  await expect(probeGpu()).rejects.toThrow('буфер');
  expect(requestDevice).not.toHaveBeenCalled();
});
it('checks decompression support before asking for the GPU adapter or model data', async () => {
  const requestAdapter = vi.fn();
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('DecompressionStream', undefined);
  vi.stubGlobal('navigator', { gpu: { requestAdapter } });
  await expect(probeGpu()).rejects.toThrow('распаковку');
  expect(requestAdapter).not.toHaveBeenCalled();
});
it('requests the model buffer limit and f16 before accepting the adapter', async () => {
  const destroy = vi.fn();
  const requestDevice = vi.fn(async () => ({ destroy }));
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ features: new Set(['shader-f16']), limits: { maxStorageBufferBindingSize: 256 * 1024 * 1024, maxBufferSize: 1024 * 1024 * 1024, maxComputeWorkgroupStorageSize: 32768, maxStorageBuffersPerShaderStage: 10 }, requestDevice }) } });
  await probeGpu();
  expect(requestDevice).toHaveBeenCalledWith({ requiredFeatures: ['shader-f16'], requiredLimits: { maxStorageBufferBindingSize: source.minimumStorageBufferBytes, maxBufferSize: 1024 * 1024 * 1024, maxComputeWorkgroupStorageSize: 32768, maxStorageBuffersPerShaderStage: 10 } });
  expect(destroy).toHaveBeenCalledOnce();
});
it('raises the runtime fallback device limit to fit Qwen3 while retaining its other requirements', async () => {
  const requestDevice = vi.fn(async (_descriptor?: GPUDeviceDescriptor) => ({ lost: new Promise(() => {}), addEventListener: vi.fn() }));
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ requestDevice }) } });
  monitorGpu(() => {});
  const adapter = await navigator.gpu.requestAdapter();
  await adapter!.requestDevice({ requiredFeatures: ['shader-f16'], requiredLimits: { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxStorageBuffersPerShaderStage: 10 } });
  expect(requestDevice).toHaveBeenCalledWith({ requiredFeatures: ['shader-f16'], requiredLimits: { maxStorageBufferBindingSize: source.minimumStorageBufferBytes, maxStorageBuffersPerShaderStage: 10 } });
});
