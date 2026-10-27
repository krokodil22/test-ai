import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyPublicAssets } from '../../scripts/static-assets.mjs';
import source from '../../scripts/model-source.json' with { type: 'json' };

it('publishes only the active model, retains other static files, and preserves local old downloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ryadom-assets-'));
  const input = join(root, 'public');
  const output = join(root, 'dist');
  try {
    for (const name of ['qwen2.5-0.5b', 'qwen2.5-1.5b', source.directory]) {
      await mkdir(join(input, 'models', name), { recursive: true });
      await writeFile(join(input, 'models', name, 'weights.bin'), name);
    }
    await writeFile(join(input, 'favicon.svg'), '<svg/>');
    await mkdir(output);
    await writeFile(join(output, 'index.html'), 'built HTML');
    await copyPublicAssets(input, output, source.directory);
    expect(await readdir(join(output, 'models'))).toEqual([source.directory]);
    expect(await readFile(join(output, 'favicon.svg'), 'utf8')).toBe('<svg/>');
    expect(await readFile(join(output, 'index.html'), 'utf8')).toBe('built HTML');
    expect(await readFile(join(input, 'models/qwen2.5-0.5b/weights.bin'), 'utf8')).toBe('qwen2.5-0.5b');
  } finally { await rm(root, { recursive: true, force: true }); }
});
