import { it, expect } from 'vitest';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const sha = data => createHash('sha256').update(data).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tetrikanets-runtime-prepare-'));
  await mkdir(join(root, 'scripts')); await mkdir(join(root, 'vendor'));
  await copyFile(new URL('../../scripts/prepare-low-memory-runtime.mjs', import.meta.url), join(root, 'scripts/prepare-low-memory-runtime.mjs'));
  const plain = Buffer.from('Fixture runtime code, without model weights.');
  const packed = gzipSync(plain);
  const source = { path: 'runtime.wasm', bytes: plain.length, sha256: sha(plain), bundledPath: 'vendor/runtime.wasm.gz', compressedBytes: packed.length, compressedSha256: sha(packed) };
  await writeFile(join(root, 'scripts/model-source.json'), JSON.stringify({ directory: 'fixture' }));
  await writeFile(join(root, 'scripts/low-memory-runtime.json'), JSON.stringify(source));
  await writeFile(join(root, source.bundledPath), packed);
  await writeFile(join(root, 'offline.mjs'), 'globalThis.fetch = () => { throw Error("No network allowed"); };');
  const output = join(root, 'public/models/fixture/runtime.wasm');
  const run = (...args) => exec(process.execPath, ['--import', join(root, 'offline.mjs'), join(root, 'scripts/prepare-low-memory-runtime.mjs'), ...args], { cwd: root });
  return { root, plain, source, output, run };
}
it('prepares a bundled runtime offline, preserves an existing verified file and supports verification-only mode', async () => {
  const f = await fixture();
  try {
    await expect(f.run('--verify')).rejects.toMatchObject({ code: 1 });
    expect((await f.run()).stdout).toContain('Prepared low-memory runtime');
    expect(await readFile(f.output)).toEqual(f.plain);
    const before = (await stat(f.output)).mtimeMs;
    expect((await f.run()).stdout).toContain('Verified low-memory runtime');
    expect((await stat(f.output)).mtimeMs).toBe(before);
    expect((await f.run('--verify')).stdout).toContain('Verified low-memory runtime');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it('rejects corrupt bundled code and a decompression size overrun without replacing a verified runtime', async () => {
  const f = await fixture();
  try {
    await f.run();
    await writeFile(join(f.root, f.source.bundledPath), 'damaged');
    await expect(f.run()).rejects.toMatchObject({ stderr: expect.stringContaining('Bundled runtime SHA-256 mismatch') });
    await writeFile(join(f.root, f.source.bundledPath), gzipSync(f.plain));
    f.source.bytes--;
    await writeFile(join(f.root, 'scripts/low-memory-runtime.json'), JSON.stringify(f.source));
    await expect(f.run()).rejects.toMatchObject({ stderr: expect.stringContaining('larger than expected') });
    expect(await readFile(f.output)).toEqual(f.plain);
    expect(await readdir(join(f.root, 'public/models/fixture'))).toEqual(['runtime.wasm']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
