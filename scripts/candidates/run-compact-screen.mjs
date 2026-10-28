#!/usr/bin/env node
// Developer quality screening only. Never processes user messages.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const key = process.argv[2];
if (!/^[a-z0-9-]+$/.test(key || '')) throw Error('Expected a controlled candidate key');
const selected = JSON.parse(await readFile('scripts/candidates/compact-selection.json', 'utf8')).find(item => item.key === key);
if (!selected || !/^scripts\/candidates\/[a-z0-9.-]+\.json$/.test(selected.profile)) throw Error('Unknown candidate profile');
const source = JSON.parse(await readFile(selected.profile, 'utf8'));
const output = resolve(`.cache/compact-results/${key}`);
const model = resolve(`.cache/reference/compact-${key}`);
await mkdir(output, { recursive: true });
const status = { schema: 1, key, model: source.repository, revision: source.revision, license: selected.license, reasonForSelection: selected.reason, complete: false, execution: { runUrl: process.env.REFERENCE_RUN_URL, commit: process.env.REFERENCE_COMMIT }, results: [] };
let stage = 'download';
function run(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw Error(`${stage}: ${result.error?.message || `exit ${result.status}`}\n${result.stderr?.slice(-6000) || result.stdout?.slice(-3000) || ''}`);
}
try {
  run('node', ['scripts/download-reference.mjs', '--profile', selected.profile, '--output', model, '--parallel', '1']);
  await writeFile(`${output}/model-config.json`, await readFile(`${model}/config.json`));
  status.sourceFiles = [];
  for (const path of source.files) {
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(`${model}/${path}`)) { hash.update(chunk); bytes += chunk.length; }
    status.sourceFiles.push({ path, bytes, sha256: hash.digest('hex') });
  }
  const profiles = selected.profiles || [['diagnostics', 'src/diagnostic-cases.json'], ['production', 'scripts/candidates/qwen25-light-production.json']];
  for (const [name, cases] of profiles) {
    if (!/^[a-z0-9-]+$/.test(name) || !/^(src|scripts\/candidates)\/[a-z0-9.-]+\.json$/.test(cases)) throw Error('Unsafe controlled case profile');
    stage = name;
    const path = `${output}/${name}.json`;
    run('python', ['scripts/run-reference.py', '--profile', selected.profile, '--model', model, '--cases', cases, '--dtype', 'float32', '--threads', '4', '--output', path, ...(selected.auditEmbeddingTie ? ['--audit-embedding-tie'] : []), ...(selected.orthrusNativeAr ? ['--orthrus-native-ar'] : [])]);
    const report = JSON.parse(await readFile(path, 'utf8'));
    const profile = JSON.parse(await readFile(cases, 'utf8'));
    if (!report.complete || report.model !== source.repository || report.revision !== source.revision || report.dtype !== 'float32' || report.quantization !== 'none' || report.results.length !== profile.cases.length || JSON.stringify(report.settings) !== JSON.stringify(profile.settings) || report.systemPrompt !== profile.systemPrompt) throw Error('Reference output does not match the controlled profile');
    for (let index = 0; index < profile.cases.length; index++) {
      const actual = report.results[index]; const expected = profile.cases[index];
      if (actual.caseId !== expected.id || actual.prompt !== expected.prompt || actual.maxTokens !== expected.maxTokens || !actual.text.trim()) throw Error('Case or response mismatch');
    }
    report.sourceFiles = status.sourceFiles; report.execution = status.execution;
    await writeFile(path, JSON.stringify(report, null, 2) + '\n');
    status.results.push({ profile: name, cases: report.results.length, report: `${name}.json` });
  }
  status.complete = true;
} catch (error) {
  status.failure = { stage, message: error.message };
  console.error('Candidate execution did not complete:', error.message);
}
await writeFile(`${output}/status.json`, JSON.stringify(status, null, 2) + '\n');
// An execution failure is saved as data, never a successful quality assessment.
// The collecting job records every candidate, including incompatible checkpoints.
