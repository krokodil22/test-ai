#!/usr/bin/env node
// Development-only CPU reference. These 4 GB weights never enter the website.
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new EnvHttpProxyAgent());
const profile = JSON.parse(await readFile(new URL('./reference-source.json', import.meta.url), 'utf8'));
const root = resolve('.cache/reference/qwen3-1.7b');
async function digest(path, algorithm, prefix = '') {
  const hash = createHash(algorithm).update(prefix);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function main() {
  const response = await fetch(`https://huggingface.co/api/models/${profile.repository}/revision/${profile.revision}?blobs=true`);
  if (!response.ok) throw Error(`Reference metadata: HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata.sha !== profile.revision) throw Error('Wrong reference revision');
  await mkdir(root, { recursive: true });
  for (const name of profile.files) {
    const entry = metadata.siblings.find(item => item.rfilename === name);
    if (!entry || !entry.size || !(entry.lfs?.sha256 || entry.blobId)) throw Error(`Missing integrity metadata: ${name}`);
    const path = resolve(root, name);
    const verified = async () => (await stat(path)).size === entry.size && (entry.lfs ? await digest(path, 'sha256') === entry.lfs.sha256 : await digest(path, 'sha1', `blob ${entry.size}\0`) === entry.blobId);
    try { if (await verified()) { console.log(`Verified existing reference ${name}`); continue; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    console.log(`Downloading reference ${name}: ${(entry.size / 1e6).toFixed(1)} MB`);
    let offset = await stat(path + '.part').then(value => value.size).catch(error => { if (error.code !== 'ENOENT') throw error; return 0; });
    if (offset >= entry.size) { await rm(path + '.part', { force: true }); offset = 0; }
    const download = await fetch(`https://huggingface.co/${profile.repository}/resolve/${profile.revision}/${name}`, { signal: AbortSignal.timeout(1800000), headers: offset ? { Range: `bytes=${offset}-` } : {} });
    if (!download.ok) throw Error(`Reference ${name}: HTTP ${download.status}`);
    if (offset && download.status === 206) {
      if (!download.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw Error('Incorrect resumed reference range');
      console.log(`Resuming reference ${name} at ${offset} bytes`);
    } else offset = 0;
    {
      // Retain partial files on network failure; a retry resumes with Range.
      await pipeline(download.body, createWriteStream(path + '.part', { flags: offset ? 'a' : 'w' }));
      // Only a fully verified file becomes the final artifact.
      const size = (await stat(path + '.part')).size;
      const actual = entry.lfs ? await digest(path + '.part', 'sha256') : await digest(path + '.part', 'sha1', `blob ${size}\0`);
      if (size !== entry.size || actual !== (entry.lfs?.sha256 || entry.blobId)) throw Error(`Reference integrity mismatch: ${name}`);
      await rename(path + '.part', path);
      console.log(`Verified reference ${name}`);
    }
  }
  console.log(`Reference ready: ${root}. Development-only; do not copy these weights into public/ or dist/.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
