import { it, expect } from 'vitest';
import { mkdtemp, mkdir, copyFile, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../../', import.meta.url));
const sha = body => createHash('sha256').update(body).digest('hex');
const gitBlob = body => createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tetrikanets-downloader-'));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'licenses'));
  await copyFile(join(project, 'scripts/download-model.mjs'), join(root, 'scripts/download-model.mjs'));
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'junction');
  await writeFile(join(root, 'licenses/fixture.txt'), 'Test fixture license\n');
  const plain = 'Tensor data for the downloader regression test. '.repeat(40);
  const files = {
    'mlc-chat-config.json': JSON.stringify({ tokenizer_files: ['tokenizer.json'] }),
    'ndarray-cache.json': JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin' }] }),
    'tokenizer.json': '{}',
    'params_shard_0.bin': plain,
  };
  const source = {
    modelId: 'downloader-test-model', repository: 'test/downloader', revision: 'a'.repeat(40),
    directory: 'test-model', packaging: 'gzip-shards', license: { file: 'fixture.txt' },
    runtime: { url: 'https://fixture.invalid/model.wasm', bytes: 12, sha256: sha('fixture-wasm'), webllm: '0.2.79' },
  };
  await writeFile(join(root, 'scripts/model-source.json'), JSON.stringify(source));
  const metadata = {
    sha: source.revision,
    siblings: Object.entries(files).map(([rfilename, body]) => ({ rfilename, size: Buffer.byteLength(body), ...(rfilename.endsWith('.bin') ? { lfs: { sha256: sha(body), size: Buffer.byteLength(body) } } : { blobId: gitBlob(body) }) })),
  };
  // Only network responses are replaced. Each test executes the actual CLI in
  // a separate Node process, with its own empty output directory and streams.
  const preload = join(root, 'fixture-fetch.mjs');
  const metadataUrl = `https://huggingface.co/api/models/${source.repository}/revision/${source.revision}?blobs=true`;
  const filePrefix = `https://huggingface.co/${source.repository}/resolve/${source.revision}/`;
  await writeFile(preload, `
    const files = ${JSON.stringify(files)};
    globalThis.fetch = async input => {
      const url = String(input);
      if (process.env.TETRIKANETS_TEST_OFFLINE === '1') throw Error('Verification must not fetch resources');
      if (url === ${JSON.stringify(metadataUrl)}) return Response.json(${JSON.stringify(metadata)});
      if (process.env.TETRIKANETS_TEST_CACHED === '1') throw Error('Cached resources must not be downloaded');
      if (url === ${JSON.stringify(source.runtime.url)}) return new Response('fixture-wasm');
      if (url.startsWith(${JSON.stringify(filePrefix)})) {
        const body = files[url.slice(${filePrefix.length})];
        if (body !== undefined) return new Response(body);
      }
      throw Error('Unexpected fixture request: ' + url);
    };
  `);
  const output = join(root, 'output');
  const run = (args = [], env = {}) => exec(process.execPath, ['--import', preload, join(root, 'scripts/download-model.mjs'), '--output', output, ...args], { cwd: root, env: { ...process.env, ...env }, timeout: 10000, maxBuffer: 1024 * 1024 });
  return { root, output, run, plain, archive: join(output, 'resolve/main/params_shard_0.bin.gz') };
}

it('downloads into an empty directory, creates the first archive, reuses it and verifies offline', async () => {
  const f = await fixture();
  try {
    const first = await f.run();
    expect(first.stdout).toContain('Downloading resolve/main/params_shard_0.bin:');
    expect(first.stdout).toContain('Ready:');
    expect(first.stderr).not.toContain('Unhandled');
    expect(gunzipSync(await readFile(f.archive)).toString()).toBe(f.plain);
    await expect(readFile(join(f.output, 'resolve/main/params_shard_0.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    const manifest = JSON.parse(await readFile(join(f.output, 'model-info.json'), 'utf8'));
    expect(manifest.files.find(file => file.path.endsWith('.bin')).download.encoding).toBe('gzip');
    const reused = await f.run([], { TETRIKANETS_TEST_CACHED: '1' });
    expect(reused.stdout).toContain('Verified existing archive resolve/main/params_shard_0.bin.gz');
    expect(reused.stdout).not.toContain('Downloading');
    const verified = await f.run(['--verify'], { TETRIKANETS_TEST_OFFLINE: '1' });
    expect(verified.stdout).toContain('All 5 runtime files verified');
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 15000);

it.each(['invalid gzip', 'expanded size exceeded'])('reports %s through the CLI error handler', async kind => {
  const f = await fixture();
  try {
    await f.run();
    await writeFile(f.archive, kind === 'invalid gzip' ? Buffer.from('not gzip') : gzipSync(f.plain.repeat(2)));
    let failure;
    try { await f.run(); } catch (error) { failure = error; }
    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toContain('Model download failed:');
    expect(failure?.stderr).toContain('Completed verified files are retained');
    expect(failure?.stderr).not.toContain("Unhandled 'error' event");
    if (kind === 'expanded size exceeded') expect(failure?.stderr).toContain('Expanded model resource');
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 15000);
