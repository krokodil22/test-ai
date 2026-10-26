#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import source from './translation-source.json' with { type: 'json' };

setGlobalDispatcher(new EnvHttpProxyAgent());
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
if (outputIndex >= 0 && (!args[outputIndex + 1] || args[outputIndex + 1].startsWith('--'))) throw Error('Missing --output directory');
const output = resolve(outputIndex >= 0 ? args[outputIndex + 1] : `public/translations/${source.directory}`);
const hash = data => createHash('sha256').update(data).digest('hex');
async function main() {
  await mkdir(output, { recursive: true });
  const files = [];
  for (const expected of [...source.files, source.runtime]) {
    const file = resolve(output, expected.path + '.gz');
    let compressed;
    try { compressed = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (compressed) {
      const data = gunzipSync(compressed);
      if (data.length !== expected.bytes || hash(data) !== expected.sha256) throw Error(`Integrity mismatch: ${expected.path}. Remove the damaged file and retry.`);
    } else {
      if (args.includes('--verify')) throw Error(`Missing ${file}`);
      let data;
      // The runtime is pinned by package-lock and checked against this profile.
      if (expected === source.runtime) data = await readFile(new URL('../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', import.meta.url));
      else {
        const response = await fetch(`https://huggingface.co/${source.repository}/resolve/${source.revision}/${expected.path}`, { signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw Error(`HTTP ${response.status}: ${expected.path}`);
        data = Buffer.from(await response.arrayBuffer());
      }
      if (data.length !== expected.bytes || hash(data) !== expected.sha256) throw Error(`Integrity mismatch: ${expected.path}`);
      compressed = gzipSync(data, { level: 9 });
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file + '.part', compressed);
      await rename(file + '.part', file);
    }
    files.push({ path: expected.path, bytes: compressed.length, sha256: hash(compressed) });
    console.log(`Verified ${expected.path}.gz: ${compressed.length} bytes`);
  }
  const manifest = { schema: 1, modelId: source.modelId, revision: source.revision, transformers: source.transformers, downloadBytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
  if (args.includes('--verify')) {
    const existing = JSON.parse(await readFile(resolve(output, 'translation-info.json'), 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw Error('Translation manifest differs from verified files');
  } else {
    await writeFile(resolve(output, 'translation-info.json.part'), JSON.stringify(manifest, null, 2) + '\n');
    await rename(resolve(output, 'translation-info.json.part'), resolve(output, 'translation-info.json'));
    await writeFile(resolve(output, 'LICENSE.txt'), await readFile(new URL('../licenses/Qwen2.5-APACHE-2.0.txt', import.meta.url)));
    await writeFile(resolve(output, 'NOTICE.txt'), `OPUS-MT English to Russian: Helsinki-NLP/opus-mt-en-ru. Apache-2.0.\nONNX conversion: Xenova/opus-mt-en-ru, revision ${source.revision}.\nTransformers.js ${source.transformers}: Apache-2.0. ONNX Runtime: MIT.\nSource: https://github.com/huggingface/transformers.js and https://github.com/microsoft/onnxruntime\n`);
    await writeFile(resolve(output, 'ONNX-RUNTIME-LICENSE.txt'), await readFile(new URL('../licenses/ONNX-RUNTIME-MIT.txt', import.meta.url)));
    await writeFile(resolve(output, 'TRANSFORMERS-LICENSE.txt'), await readFile(new URL('../node_modules/@huggingface/transformers/LICENSE', import.meta.url)));
  }
  console.log(`Translator ready: ${manifest.downloadBytes} bytes (${(manifest.downloadBytes / 1e6).toFixed(1)} MB compressed); all files verified.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
