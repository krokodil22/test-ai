#!/usr/bin/env node
// Development-only CPU reference. Original weights never enter the website.
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { resolve, dirname, sep } from 'node:path';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new EnvHttpProxyAgent());
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); if (index < 0) return undefined; if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error(`Missing value: ${name}`); return args[index + 1]; };
const profile = JSON.parse(await readFile(option('--profile') || new URL('./reference-source.json', import.meta.url), 'utf8'));
const root = resolve(option('--output') || `.cache/reference/${profile.directory || profile.repository.split('/').at(-1).toLowerCase()}`);
const parallel = Number(option('--parallel') || 4);
if (!Number.isInteger(parallel) || parallel < 1 || parallel > 4) throw Error('--parallel must be 1–4');
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
    if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.includes('..') || !path.startsWith(root + sep)) throw Error('Unsafe reference artifact path');
    await mkdir(dirname(path), { recursive: true });
    const verified = async () => (await stat(path)).size === entry.size && (entry.lfs ? await digest(path, 'sha256') === entry.lfs.sha256 : await digest(path, 'sha1', `blob ${entry.size}\0`) === entry.blobId);
    try { if (await verified()) { console.log(`Verified existing reference ${name}`); continue; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    console.log(`Downloading reference ${name}: ${(entry.size / 1e6).toFixed(1)} MB`);
    let offset = await stat(path + '.part').then(value => value.size).catch(error => { if (error.code !== 'ENOENT') throw error; return 0; });
    if (offset >= entry.size) { await rm(path + '.part', { force: true }); offset = 0; }
    const address = `https://huggingface.co/${profile.repository}/resolve/${profile.revision}/${name}`;
    if (parallel > 1 && entry.size - offset > 64 * 1024 * 1024) {
      const width = Math.ceil((entry.size - offset) / parallel);
      const paths = Array.from({ length: parallel }, (_, index) => path + `.range-${index}`);
      const controller = new AbortController();
      try {
        const tasks = await Promise.allSettled(paths.map(async (chunk, index) => {
          const start = offset + index * width;
          const end = Math.min(entry.size - 1, start + width - 1);
          try {
            const response = await fetch(address, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1800000)]) });
            if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${entry.size}`) { await response.body?.cancel(); throw Error('Reference server rejected a byte range; retry --parallel 1'); }
            await pipeline(response.body, createWriteStream(chunk));
            if ((await stat(chunk)).size !== end - start + 1) throw Error('Reference chunk size mismatch');
          } catch (error) { controller.abort(); throw error; }
        }));
        const failed = tasks.find(task => task.status === 'rejected');
        if (failed) throw failed.reason;
        for (const chunk of paths) { await pipeline(createReadStream(chunk), createWriteStream(path + '.part', { flags: 'a' })); await rm(chunk); }
      } finally { await Promise.all(paths.map(chunk => rm(chunk, { force: true }))); }
      const actual = await digest(path + '.part', entry.lfs ? 'sha256' : 'sha1', entry.lfs ? '' : `blob ${entry.size}\0`);
      if ((await stat(path + '.part')).size !== entry.size || actual !== (entry.lfs?.sha256 || entry.blobId)) throw Error(`Reference integrity mismatch: ${name}`);
      await rename(path + '.part', path); console.log(`Verified reference ${name}`); continue;
    }
    const download = await fetch(address, { signal: AbortSignal.timeout(1800000), headers: offset ? { Range: `bytes=${offset}-` } : {} });
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
