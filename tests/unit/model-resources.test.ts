import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { prepareModelCache, auditModelCache } from '../../src/model-resources';
import type { ModelInfo } from '../../src/config';
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const base = 'https://models.example.test/qwen3/';
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const plain = Buffer.from('Verified tensor bytes, including repeated values.');
  const packed = gzipSync(plain);
  const file: ModelInfo['files'][number] = { path: 'resolve/main/params_shard_0.bin', bytes: plain.length, sha256: sha(plain), scope: 'webllm/model', download: { path: 'resolve/main/params_shard_0.bin.gz', encoding: 'gzip', bytes: packed.length, sha256: sha(packed) } };
  const info: ModelInfo = { schema: 1, modelId: 'fixture', revision: 'fixture', downloadBytes: packed.length, files: [file] };
  const entries = new Map<string, Response>();
  vi.stubGlobal('caches', { open: async () => ({ match: async (key: string) => entries.get(key)?.clone(), put: async (key: string, response: Response) => entries.set(key, response.clone()), delete: async (key: string) => entries.delete(key) }) });
  return { plain, packed, file, info, entries };
}
it.each([false, true])('expands a static gzip resource into WebLLM cache URLs and reuses it (browser decoded=%s)', async decoded => {
  const { plain, packed, file, info, entries } = fixture();
  const read = vi.fn(async () => new Response(Uint8Array.from(decoded ? plain : packed)));
  await prepareModelCache(base, info, read, () => {});
  expect(read).toHaveBeenCalledWith(base + file.download!.path, expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error' }));
  expect(await entries.get(base + file.path)!.clone().text()).toBe(plain.toString());
  await prepareModelCache(base, info, read, () => {});
  expect(read).toHaveBeenCalledTimes(1);
});
it('rejects a changed archive before caching its contents', async () => {
  const { packed, info, entries } = fixture(); packed[5] ^= 1;
  await expect(prepareModelCache(base, info, async () => new Response(Uint8Array.from(packed)), () => {})).rejects.toThrow('SHA256');
  expect(entries.size).toBe(0);
});
it('verifies tensor bytes even if the compressed manifest hash matches', async () => {
  const { file, info, entries } = fixture();
  const wrong = gzipSync('Incorrect tensor bytes');
  file.download = { ...file.download!, bytes: wrong.length, sha256: sha(wrong) };
  await expect(prepareModelCache(base, info, async () => new Response(Uint8Array.from(wrong)), () => {})).rejects.toThrow('SHA256');
  expect(entries.size).toBe(0);
});
it('audits the real cached bytes without trusting the marker, fetching data or accepting a damaged entry', async () => {
  const { plain, file, info, entries } = fixture();
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  entries.set(base + file.path, new Response(Uint8Array.from(plain), { headers: { 'X-Tetrikanets-SHA256': file.sha256 } }));
  expect(await auditModelCache(base, info, () => {}, () => false)).toMatchObject({ valid: true, checkedFiles: 1, checkedBytes: plain.length });
  entries.set(base + file.path, new Response('damaged', { headers: { 'X-Tetrikanets-SHA256': file.sha256 } }));
  await expect(auditModelCache(base, info, () => {}, () => false)).rejects.toThrow('SHA-256');
  entries.clear(); await expect(auditModelCache(base, info, () => {}, () => false)).rejects.toThrow('отсутствует');
  await expect(auditModelCache(base, info, () => {}, () => true)).rejects.toThrow('остановлена');
  expect(fetch).not.toHaveBeenCalled();
});
