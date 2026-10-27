import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createModelArchive, tarHeader } from '../../scripts/create-model-archive.mjs';
import { archiveResources } from '../../src/model-archive';
import { prepareModelCache } from '../../src/model-resources';

const directories = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tetrikanets-archive-')); directories.push(directory);
  const plain = Buffer.from('Locally imported tensor bytes.'); const packed = gzipSync(plain);
  const file = { path: 'resolve/main/params_shard_0.bin', bytes: plain.length, sha256: sha(plain), scope: 'webllm/model', download: { encoding: 'gzip', path: 'resolve/main/params_shard_0.bin.gz', bytes: packed.length, sha256: sha(packed) } };
  const info = { schema: 1, modelId: 'fixture', revision: 'revision', downloadBytes: packed.length, files: [file] };
  await mkdir(join(directory, 'resolve/main'), { recursive: true });
  await Promise.all([writeFile(join(directory, 'model-info.json'), JSON.stringify(info)), writeFile(join(directory, 'LICENSE'), 'Fixture license'), writeFile(join(directory, file.download.path), packed)]);
  const output = join(directory, 'model.tar'); await createModelArchive(directory, output);
  const bytes = await readFile(output);
  return { bytes, info, plain, packed, directory };
}
it('imports the real generated archive, verifies weights and reuses cache without network requests', async () => {
  const { bytes, info, plain, directory } = await fixture();
  const second = join(directory, 'second.tar'); await createModelArchive(directory, second);
  expect(await readFile(second)).toEqual(bytes); // Reproducible publication.
  const external = vi.fn(); vi.stubGlobal('fetch', external);
  const entries = new Map();
  vi.stubGlobal('caches', { open: async () => ({ match: async key => entries.get(key)?.clone(), put: async (key, response) => entries.set(key, new Response(await response.arrayBuffer(), { headers: response.headers })) }) });
  const base = 'https://site.example/test-ai/models/fixture/';
  const local = await archiveResources(new Blob([bytes]), base, info);
  await prepareModelCache(base, info, local, () => {});
  expect(await entries.get(base + info.files[0].path).clone().text()).toBe(plain.toString());
  await prepareModelCache(base, info, async () => { throw Error('Cache must be reused'); }, () => {});
  await expect(local('https://unexpected.example/resource')).rejects.toThrow('Архив');
  expect(external).not.toHaveBeenCalled();
});
it('rejects incorrect model identity, damaged headers and truncated archives', async () => {
  const { bytes, info } = await fixture();
  await expect(archiveResources(new Blob([bytes]), 'https://site.example/', { ...info, revision: 'other' })).rejects.toThrow('Архив');
  const damaged = Buffer.from(bytes); damaged[0] ^= 1;
  await expect(archiveResources(new Blob([damaged]), 'https://site.example/', info)).rejects.toThrow('Архив');
  await expect(archiveResources(new Blob([bytes.subarray(0, -1)]), 'https://site.example/', info)).rejects.toThrow('Архив');
  await expect(archiveResources(new Blob([Buffer.alloc(4096)]), 'https://site.example/', info)).rejects.toThrow('Архив');
});
it('detects corrupted payloads using the manifest SHA-256', async () => {
  const { bytes, info } = await fixture();
  // Last non-padding entry is the packed tensor.
  const needle = Buffer.from([0x1f, 0x8b, 8]); const offset = bytes.indexOf(needle); expect(offset).toBeGreaterThan(0); bytes[offset + 8] ^= 1;
  vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined, put: async (_key, response) => { await response.arrayBuffer(); }, delete: vi.fn() }) });
  const base = 'https://site.example/'; const local = await archiveResources(new Blob([bytes]), base, info);
  await expect(prepareModelCache(base, info, local, () => {})).rejects.toThrow('SHA256');
});
it('refuses unsafe paths and changed source files when publishing an archive', async () => {
  expect(() => tarHeader('../outside', 1)).toThrow('Invalid');
  const { directory, info } = await fixture();
  await writeFile(join(directory, info.files[0].download.path), 'changed');
  await expect(createModelArchive(directory, join(directory, 'bad.tar'))).rejects.toThrow('integrity');
});
