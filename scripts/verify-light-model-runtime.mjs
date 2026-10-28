import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import model from './light-model-source.json' with { type: 'json' };

// Runs the pinned WebLLM WASM loader and VM on CPU, reading _metadata only.
// No shaders, GPU, generated answers or fake weight tensors are involved.
const directory = await mkdtemp(join(tmpdir(), 'tetrikanets-metadata-'));
try {
  const require = createRequire(import.meta.url);
  const bundle = await readFile(require.resolve('@mlc-ai/web-llm'), 'utf8');
  const modulePath = join(directory, 'runtime.mjs');
  await writeFile(modulePath, 'const __dirname = "/tmp"; const module = { exports: {} };\n' + bundle + '\nexport const inspectedRuntime = libExports$2;\n');
  const { inspectedRuntime } = await import(pathToFileURL(modulePath).href);
  async function inspect(path, expected) {
    const bytes = Uint8Array.from(await readFile(path));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== expected.bytes || hash !== expected.sha256 || !WebAssembly.validate(bytes)) throw Error(`Runtime integrity failed: ${path}`);
    const runtime = await inspectedRuntime.instantiate(bytes.buffer, inspectedRuntime.createPolyfillWASI(), () => {});
    try {
      runtime.registerFunc('wasm.WebGPUCreateShader', () => { throw Error('GPU execution is forbidden in the metadata check'); });
      runtime.beginScope();
      const vm = runtime.createVirtualMachine(runtime.cpu());
      const metadata = JSON.parse(vm.getFunction('_metadata')().toString());
      runtime.endScope();
      return metadata;
    } finally { runtime.dispose(); }
  }
  const base = new URL(`../public/models/${model.directory}/`, import.meta.url);
  const economy = await inspect(new URL('model.wasm', base), model.runtime);
  if (economy.quantization !== 'q4f16_1' || economy.kv_state_kind !== 'kv_cache' || economy.prefill_chunk_size !== 256 || economy.max_batch_size !== 1 || economy.context_window_size !== 2048) throw Error('Unexpected light runtime compilation settings');
  const weights = JSON.parse(await readFile(new URL('resolve/main/tensor-cache.json', base), 'utf8'));
  const tensorFiles = new Map(weights.records.flatMap(shard => shard.records).map(record => [record.name, record]));
  for (const param of economy.params) {
    const tensor = tensorFiles.get(param.name);
    if (!tensor || JSON.stringify(param.shape) !== JSON.stringify(tensor.shape) || param.dtype !== tensor.dtype) throw Error(`Weight manifest does not match ${param.name}`);
  }
  const simplify = (metadata, artifact) => ({ sha256: artifact.sha256, bytes: artifact.bytes, prefillChunkSize: metadata.prefill_chunk_size, maxBatchSize: metadata.max_batch_size, compiledContextTokens: metadata.context_window_size, compilerTemporaryBufferBytes: metadata.memory_usage });
  const report = {
    schema: 1, kind: 'light-runtime-metadata-check', engine: '@mlc-ai/web-llm 0.2.86', modelId: model.modelId, revision: model.revision,
    weightsMatchPinnedManifest: true, compatibleParameters: economy.params.length, runtime: simplify(economy, model.runtime),
    checks: ['WASM SHA-256 and byte size', 'Native WebLLM WASM instantiation and CPU VM _metadata', 'All weight parameter names, dimensions and dtypes', 'Expected compiled prefill and batch bounds'],
    limitations: 'Compiler estimates are not measured GPU/RAM consumption. Shader execution, answer quality and performance on a 4 GB device are not verified here.',
  };
  const output = process.argv.indexOf('--output');
  if (output >= 0) {
    if (!process.argv[output + 1]) throw Error('Missing --output path');
    await writeFile(process.argv[output + 1], JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
