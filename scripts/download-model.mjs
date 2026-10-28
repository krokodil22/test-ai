#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip, createGunzip, gunzipSync } from 'node:zlib';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { validateStopTokens } from './model-tokenizer.mjs';

// Honor managed proxies, including their CA configuration; TLS verification stays enabled.
setGlobalDispatcher(new EnvHttpProxyAgent());
const project = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const valueOf = name => { const i = argv.indexOf(name); if (i < 0) return undefined; if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${name}`); return argv[i + 1]; };
const source = JSON.parse(await readFile(valueOf('--profile') || new URL('./model-source.json', import.meta.url), 'utf8'));
const destination = resolve(project, valueOf('--output') || `public/models/${source.directory}`);
const requestedRevision = valueOf('--revision') || source.revision;
const MB = n => `${(n / 1e6).toFixed(1)} MB`;
function pathFor(name) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.startsWith('/') || name.includes('..')) throw new Error(`Unsafe artifact path: ${name}`);
  const path = resolve(destination, name);
  if (!path.startsWith(destination + sep)) throw new Error('Artifact escapes output directory');
  return path;
}
async function hashes(path) {
  const size = (await stat(path)).size;
  const sha256 = createHash('sha256');
  const git = createHash('sha1').update(`blob ${size}\0`);
  for await (const chunk of createReadStream(path)) { sha256.update(chunk); git.update(chunk); }
  return { bytes: size, sha256: sha256.digest('hex'), git: git.digest('hex') };
}
async function hashesGzip(path, plainBytes) {
  const sha256 = createHash('sha256');
  const git = createHash('sha1').update(`blob ${plainBytes}\0`);
  let bytes = 0;
  // pipeline forwards errors from every stream, including ENOENT on the
  // source. A bare .pipe() leaves that source error unhandled on a fresh run.
  await pipeline(createReadStream(path), createGunzip(), async chunks => {
    for await (const chunk of chunks) {
      bytes += chunk.length;
      if (bytes > plainBytes) throw new Error('Expanded model resource is larger than expected');
      sha256.update(chunk); git.update(chunk);
    }
  });
  return { bytes, sha256: sha256.digest('hex'), git: git.digest('hex') };
}
async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000), redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${new URL(url).hostname}. Check network access and CORS/hosting configuration.`);
  return response;
}
async function download(url, name, expected = {}, scope = 'webllm/model') {
  const path = pathFor(name);
  const valid = result => (!expected.bytes || result.bytes === expected.bytes) && (!expected.sha256 || result.sha256 === expected.sha256) && (!expected.git || result.git === expected.git);
  try {
    const existing = await hashes(path);
    if (valid(existing) && (expected.sha256 || expected.git)) {
      console.log(`Verified existing ${name} (${MB(existing.bytes)})`);
      return { path: name, bytes: existing.bytes, sha256: existing.sha256, scope };
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (source.packaging === 'gzip-shards' && name.endsWith('.bin') && expected.bytes) {
    try {
      const existing = await hashesGzip(path + '.gz', expected.bytes);
      if (!valid(existing)) throw new Error(`Integrity mismatch: ${name}.gz. Remove the damaged archive and retry.`);
      console.log(`Verified existing archive ${name}.gz`);
      return { path: name, bytes: existing.bytes, sha256: existing.sha256, scope };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.part';
  try {
    const response = await request(url);
    let received = 0;
    let lastPrint = 0;
    const meter = new Transform({ transform(chunk, encoding, callback) {
      received += chunk.length;
      if (Date.now() - lastPrint > 2000) { lastPrint = Date.now(); console.log(`Downloading ${name}: ${MB(received)}${expected.bytes ? ` / ${MB(expected.bytes)}` : ''}`); }
      callback(null, chunk);
    } });
    await pipeline(response.body, meter, createWriteStream(temporary));
    const result = await hashes(temporary);
    if (!valid(result)) throw new Error(`Integrity/size mismatch: ${name}. Refusing to use this artifact.`);
    await rename(temporary, path);
    console.log(`Verified ${name}: ${MB(result.bytes)} · SHA256 ${result.sha256}`);
    return { path: name, bytes: result.bytes, sha256: result.sha256, scope };
  } finally { await rm(temporary, { force: true }); }
}
async function main() {
  if (argv.includes('--verify')) {
    const info = JSON.parse(await readFile(pathFor('model-info.json'), 'utf8'));
    if (info.modelId !== source.modelId || info.revision !== source.revision || !info.files?.length) throw new Error('Invalid model manifest');
    for (const file of info.files) {
      if (file.download) {
        const packed = await hashes(pathFor(file.download.path));
        if (packed.bytes !== file.download.bytes || packed.sha256 !== file.download.sha256) throw new Error(`Integrity mismatch: ${file.download.path}`);
      }
      const actual = file.download ? await hashesGzip(pathFor(file.download.path), file.bytes) : await hashes(pathFor(file.path));
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error(`Integrity mismatch: ${file.path}`);
    }
    console.log(`All ${info.files.length} runtime files verified. ${MB(info.downloadBytes)}. Revision: ${info.revision}`);
    return;
  }
  await mkdir(destination, { recursive: true });
  let wasm;
  if (source.runtime.bundledPath) {
    if (!/^vendor\/[a-zA-Z0-9_.-]+\.wasm\.gz$/.test(source.runtime.bundledPath)) throw Error('Unsafe bundled runtime path');
    const packed = await readFile(resolve(project, source.runtime.bundledPath));
    if (packed.length !== source.runtime.compressedBytes || createHash('sha256').update(packed).digest('hex') !== source.runtime.compressedSha256) throw Error('Bundled runtime integrity mismatch');
    const bytes = gunzipSync(packed, { maxOutputLength: source.runtime.bytes });
    if (bytes.length !== source.runtime.bytes || createHash('sha256').update(bytes).digest('hex') !== source.runtime.sha256) throw Error('Bundled runtime integrity mismatch');
    await writeFile(pathFor('model.wasm.part'), bytes); await rename(pathFor('model.wasm.part'), pathFor('model.wasm'));
    wasm = { path: 'model.wasm', bytes: bytes.length, sha256: source.runtime.sha256, scope: 'webllm/wasm' };
  } else wasm = await download(source.runtime.url, 'model.wasm', source.runtime, 'webllm/wasm');
  if (argv.includes('--runtime-only')) { console.log('Runtime verified. Model weights have NOT been downloaded.'); return; }
  // Resolve a mutable name to an immutable commit before downloading any weights.
  if (source.files && requestedRevision !== source.revision) throw Error('Pinned file integrity requires the pinned revision');
  const metadata = source.files ? { sha: source.revision, siblings: source.files.map(file => ({ rfilename: file.path, lfs: { sha256: file.sha256, size: file.bytes } })) } : await (await request(`https://huggingface.co/api/models/${source.repository}/revision/${encodeURIComponent(requestedRevision)}?blobs=true`)).json();
  if (!/^[0-9a-f]{40}$/.test(metadata.sha) || !Array.isArray(metadata.siblings)) throw new Error('Invalid Hugging Face repository metadata');
  const revision = metadata.sha;
  console.log(`Model revision: ${revision}. Use --revision ${revision} to reproduce this download.`);
  const downloadFile = async (name, scope = 'webllm/model') => {
    const record = metadata.siblings.find(file => file.rfilename === name);
    if (!record || !(record.lfs?.sha256 || record.blobId)) throw new Error(`Missing integrity metadata for ${name}`);
    const expected = record.lfs ? { sha256: record.lfs.sha256, bytes: record.lfs.size } : { git: record.blobId, bytes: record.size };
    return download(`https://huggingface.co/${source.repository}/resolve/${revision}/${name}`, `resolve/main/${name}`, expected, scope);
  };
  const config = await downloadFile('mlc-chat-config.json', 'webllm/config');
  const configData = JSON.parse(await readFile(pathFor(config.path), 'utf8'));
  if (source.chatConfigOverrides) {
    Object.assign(configData, { ...source.chatConfigOverrides, conv_template: { ...configData.conv_template, ...source.chatConfigOverrides.conv_template } });
    await writeFile(pathFor(config.path), JSON.stringify(configData, null, 2) + '\n');
    const patched = await hashes(pathFor(config.path));
    config.bytes = patched.bytes; config.sha256 = patched.sha256;
  }
  if (!configData.tokenizer_files?.includes('tokenizer.json')) throw new Error('Expected a WebLLM tokenizer.json');
  const manifest = await downloadFile(source.upstreamCacheManifest || source.cacheManifest || 'ndarray-cache.json');
  if (source.upstreamCacheManifest && source.upstreamCacheManifest !== source.cacheManifest) {
    const alias = `resolve/main/${source.cacheManifest}`;
    await writeFile(pathFor(alias), await readFile(pathFor(manifest.path)));
    manifest.path = alias;
  }
  const manifestData = JSON.parse(await readFile(pathFor(manifest.path), 'utf8'));
  if (!Array.isArray(manifestData.records) || !manifestData.records.length) throw new Error('Invalid model tensor manifest');
  const files = [wasm, config, manifest, await downloadFile('tokenizer.json')];
  const tokenizerFile = files.at(-1);
  if (source.tokenizerIntegrity && (tokenizerFile.bytes !== source.tokenizerIntegrity.bytes || tokenizerFile.sha256 !== source.tokenizerIntegrity.sha256)) throw Error('Tokenizer differs from the verified original model');
  validateStopTokens(configData, JSON.parse(await readFile(pathFor(tokenizerFile.path), 'utf8')));
  const shardNames = [...new Set(manifestData.records.map(record => record.dataPath))];
  for (const name of shardNames) files.push(await downloadFile(name));
  // Include the upstream model card and the pinned redistribution license.
  for (const name of ['README.md', 'LICENSE']) {
    if (metadata.siblings.some(file => file.rfilename === name)) await downloadFile(name);
  }
  await writeFile(pathFor('LICENSE'), await readFile(new URL(`../licenses/${source.license.file || 'Qwen2.5-APACHE-2.0.txt'}`, import.meta.url)));
  if (source.packaging === 'gzip-shards') {
    for (const file of files.filter(file => file.path.endsWith('.bin'))) {
      const plain = pathFor(file.path);
      try {
        await stat(plain);
        const packed = plain + '.gz';
        await pipeline(createReadStream(plain), createGzip({ level: 9 }), createWriteStream(packed + '.part'));
        await rename(packed + '.part', packed);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const packed = await hashes(plain + '.gz');
      file.download = { encoding: 'gzip', path: file.path + '.gz', bytes: packed.bytes, sha256: packed.sha256 };
      console.log(`Packed ${file.path}: ${MB(file.bytes)} → ${MB(packed.bytes)}`);
    }
  }
  const info = {
    schema: 1, modelId: source.modelId, revision,
    webllm: source.runtime.webllm, license: source.license.name,
    downloadBytes: files.reduce((total, file) => total + (file.download?.bytes || file.bytes), 0),
    unpackedBytes: files.reduce((total, file) => total + file.bytes, 0), files,
  };
  if (source.maxDownloadBytes && info.downloadBytes > source.maxDownloadBytes) throw new Error('Packed resources exceed the configured download limit. Do not publish this model.');
  await writeFile(pathFor('model-info.json.part'), JSON.stringify(info, null, 2) + '\n');
  await rename(pathFor('model-info.json.part'), pathFor('model-info.json'));
  // The verified archives are the published files. Retain old model folders;
  // remove only redundant plaintext shards from this newly prepared bundle.
  for (const file of files.filter(file => file.download)) await rm(pathFor(file.path), { force: true });
  console.log(`\nReady: ${destination}\nBrowser download: ${MB(info.downloadBytes)}. ${files.length} files.\nUpload this COMPLETE directory to your static model host, or run npm run build.\nNo model files should be committed to Git.`);
}
main().catch(error => {
  console.error(`\nModel download failed: ${error.message}${error.cause?.message ? ` (${error.cause.message})` : ''}`);
  console.error('Completed verified files are retained. Fix the prerequisite and run again. No incomplete manifest is created.');
  process.exitCode = 1;
});
