import { spawnSync } from 'node:child_process';
import { releaseUrl } from './model-release.mjs';
import source from './model-source.json' with { type: 'json' };
const repository = process.env.GITHUB_REPOSITORY || process.env.MODEL_RELEASE_REPOSITORY || 'krokodil22/test-ai';
const result = spawnSync('npm', ['run', 'build'], {
  stdio: 'inherit', shell: process.platform === 'win32',
  env: { ...process.env, VITE_BASE_PATH: process.env.VITE_BASE_PATH || `/${repository.split('/')[1]}/`, VITE_MODEL_DELIVERY: source.pagesDelivery || 'files', VITE_MODEL_ARCHIVE_URL: process.env.VITE_MODEL_ARCHIVE_URL || releaseUrl(repository) },
});
process.exit(result.status ?? 1);
