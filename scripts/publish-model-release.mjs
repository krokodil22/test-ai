import { spawnSync } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { releaseTag, archiveName } from './model-release.mjs';
import source from './model-source.json' with { type: 'json' };
const directory = `public/models/${source.directory}`;
const info = JSON.parse(await readFile(`${directory}/model-info.json`, 'utf8'));
const archive = `.cache/${archiveName}`;
if (!(await stat(archive)).size || info.modelId !== source.modelId || info.revision !== source.revision) throw Error('Build and verify the model archive before publishing');
const run = args => spawnSync('gh', args, { stdio: 'inherit' }).status;
const exists = spawnSync('gh', ['release', 'view', releaseTag], { stdio: 'ignore' }).status === 0;
if (!exists) {
  await writeFile('.cache/model-release-notes.md', `Статические ресурсы ${source.modelId}, ${source.license.name}.\n\nИсточник: https://huggingface.co/${source.repository}/tree/${source.revision}\n\nАрхив читается локально в браузере. Для своего хостинга используйте обычную сборку сайта со всеми ресурсами рядом. Каждый ресурс проверяется по SHA-256.\n`);
  const args = ['release', 'create', releaseTag, '--title', `${source.displayName} — локальные ресурсы`, '--notes-file', '.cache/model-release-notes.md'];
  if (process.env.GITHUB_SHA) args.push('--target', process.env.GITHUB_SHA);
  if (run(args)) process.exit(1);
}
if (run(['release', 'upload', releaseTag, archive, `${directory}/LICENSE`, '--clobber'])) process.exit(1);
