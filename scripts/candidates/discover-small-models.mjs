#!/usr/bin/env node
// Development-only catalog lookup. Downloads JSON metadata, never model weights.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new EnvHttpProxyAgent());

const queries = ['ruadapt', 'QVikhr', 'Qwen3-0.6B', 'Qwen3-1.7B', 'SmolLM', '1B-Instruct-ru', '1.5B-Instruct-ru', 'Qwen3.5-0.8B', 'LFM2.5', 'gemma-4'];
const direct = ['Qwen/Qwen3-0.6B', 'HuggingFaceTB/SmolLM2-1.7B-Instruct', 'LiquidAI/LFM2.5-1.2B-Instruct', 'LiquidAI/LFM2-700M'];
const mlcTypes = new Set(['llama', 'qwen2', 'qwen3', 'qwen3_5', 'qwen3_5_text', 'gemma', 'gemma2', 'gemma3', 'gemma3_text', 'phi3', 'stablelm', 'olmo', 'olmo2']);
const known = new Map();
for (const name of await readdir('scripts/candidates')) {
  if (!name.endsWith('.json')) continue;
  const value = JSON.parse(await readFile(`scripts/candidates/${name}`, 'utf8'));
  if (value.repository && value.revision) known.set(value.repository, value.revision);
}
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(45000), headers: { 'user-agent': 'tetrikanets-development-model-evaluation' } });
  if (!response.ok) throw Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}
const names = new Set(direct);
const errors = [];
for (const query of queries) {
  try {
    const url = new URL('https://huggingface.co/api/models');
    url.search = new URLSearchParams({ search: query, sort: 'downloads', direction: '-1', limit: '7' });
    for (const item of await json(url)) if (item.id && !/gguf|gptq|awq|onnx|exl2|mlx|embedding|rerank/i.test(item.id)) names.add(item.id);
  } catch (error) { errors.push({ query, error: error.message }); }
}
const models = [];
async function inspect(id) {
  const metadata = await json(`https://huggingface.co/api/models/${id}?blobs=true`);
  const revision = metadata.sha;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Missing immutable model revision');
  const files = metadata.siblings || [];
  let config = {};
  if (files.some(file => file.rfilename === 'config.json')) config = await json(`https://huggingface.co/${id}/resolve/${revision}/config.json`);
  const weights = files.filter(file => /(?:^|\/)model(?:-\d+-of-\d+)?\.safetensors$/.test(file.rfilename));
  const parameters = metadata.safetensors?.total ?? Object.values(metadata.safetensors?.parameters || {}).reduce((a, b) => a + b, 0);
  const type = config.model_type || metadata.config?.model_type;
  const card = metadata.cardData || {};
  const language = Array.isArray(card.language) ? card.language : card.language ? [card.language] : [];
  const hasTemplate = files.some(file => ['tokenizer_config.json', 'chat_template.jinja'].includes(file.rfilename));
  const compact = parameters > 0 && parameters <= 1_800_000_000;
  const adapterOnly = !weights.length && files.some(file => file.rfilename === 'adapter_config.json');
  return {
    id, revision, downloads: metadata.downloads, parameterCount: parameters,
    weightBytes: weights.reduce((total, file) => total + (file.lfs?.size || file.size || 0), 0),
    weightFiles: weights.map(file => ({ path: file.rfilename, bytes: file.lfs?.size || file.size, sha256: file.lfs?.sha256 })),
    modelType: type, architectures: config.architectures, language, license: card.license,
    baseModels: card.base_model, gated: metadata.gated || false,
    hasOriginalSafetensors: weights.length > 0, adapterOnly, hasTokenizerConfig: hasTemplate,
    previouslyProfiledRevision: known.get(id), sameAsPreviouslyProfiled: known.get(id) === revision,
    compact, mlcArchitectureAvailable: mlcTypes.has(type),
    eligibleForScreening: compact && mlcTypes.has(type) && weights.length > 0 && hasTemplate && !metadata.gated && known.get(id) !== revision,
    config: { hiddenSize: config.hidden_size ?? config.text_config?.hidden_size, hiddenLayers: config.num_hidden_layers ?? config.text_config?.num_hidden_layers, vocabSize: config.vocab_size ?? config.text_config?.vocab_size },
    tokenizerFiles: files.filter(file => ['tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'chat_template.jinja', 'generation_config.json'].includes(file.rfilename)).map(file => file.rfilename),
  };
}
const list = [...names].sort();
for (let start = 0; start < list.length; start += 3) {
  const batch = list.slice(start, start + 3);
  const results = await Promise.allSettled(batch.map(inspect));
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === 'fulfilled') { models.push(result.value); console.log(result.value.id, result.value.parameterCount, result.value.modelType, result.value.eligibleForScreening ? 'eligible' : 'excluded'); }
    else errors.push({ id: batch[index], error: result.reason.message });
  }
}
const report = { schema: 1, kind: 'compact-model-catalog', createdAt: new Date().toISOString(), maxParameters: 1_800_000_000, queries, models, errors, note: 'Metadata and architecture screening only; no quality, WebGPU or 4 GB compatibility claim.' };
if (!models.length) throw Error('No metadata could be retrieved; refusing to publish an empty catalog');
await writeFile('docs/model-evaluation/compact-catalog.json', JSON.stringify(report, null, 2) + '\n');
