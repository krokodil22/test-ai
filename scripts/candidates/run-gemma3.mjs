// Development-only preliminary screen on local ONNX INT8 weights.
import { AutoModelForCausalLM, AutoTokenizer, env } from '@huggingface/transformers';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = resolve('.cache/reference') + '/';
const profile = JSON.parse(await readFile('src/diagnostic-cases.json', 'utf8'));
const source = JSON.parse(await readFile('scripts/candidates/gemma3-1b-onnx.json', 'utf8'));
console.log('Loading local Gemma 3 1B ONNX INT8 on CPU');
const tokenizer = await AutoTokenizer.from_pretrained('gemma3-1b-onnx', { local_files_only: true });
const model = await AutoModelForCausalLM.from_pretrained('gemma3-1b-onnx', { local_files_only: true, dtype: 'int8', device: 'cpu', use_external_data_format: false, session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 } });
const report = { kind: 'candidate-screen', model: source.repository, revision: source.revision, engine: 'Transformers.js 3.8.1 / ONNX Runtime CPU', dtype: 'int8', systemAdaptation: 'Gemma does not support system role; neutral system text is prepended to the user message.', settings: profile.settings, results: [], complete: false };
await mkdir('.cache/reference', { recursive: true });
for (const item of profile.cases) {
  const inputs = tokenizer.apply_chat_template([{ role: 'user', content: profile.systemPrompt + '\n\n' + item.prompt }], { add_generation_prompt: true, return_dict: true });
  const start = performance.now();
  const output = await model.generate({ ...inputs, do_sample: false, max_new_tokens: item.maxTokens, repetition_penalty: 1, temperature: 1, top_p: 1 });
  const tokens = output.tolist()[0].slice(inputs.input_ids.dims.at(-1)).map(Number);
  const text = tokenizer.decode(tokens, { skip_special_tokens: true }).trim();
  const result = { caseId: item.id, prompt: item.prompt, text, finish: [1, 106].includes(tokens.at(-1)) ? 'complete' : 'length', generatedTokens: tokens.length, seconds: (performance.now() - start) / 1000 };
  report.results.push(result); console.log(result.caseId, result.seconds.toFixed(1) + 's', JSON.stringify(text));
  await writeFile('.cache/reference/gemma3-screening.json', JSON.stringify(report, null, 2));
}
report.complete = true;
await writeFile('.cache/reference/gemma3-screening.json', JSON.stringify(report, null, 2));
await model.dispose();
