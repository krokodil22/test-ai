import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import model from './model-source.json' with { type: 'json' };
import runtime from './low-memory-runtime.json' with { type: 'json' };

const destination = new URL(`../public/models/${model.directory}/${runtime.path}`, import.meta.url);
const sha = data => createHash('sha256').update(data).digest('hex');
async function valid(path) {
  try {
    if ((await stat(path)).size !== runtime.bytes) return false;
    const hash = createHash('sha256');
    for await (const part of createReadStream(path)) hash.update(part);
    return hash.digest('hex') === runtime.sha256;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
try {
  if (!/^[a-zA-Z0-9_-]+\.wasm$/.test(runtime.path) || !/^vendor\/[a-zA-Z0-9_.-]+\.wasm\.gz$/.test(runtime.bundledPath) || !/^[a-f0-9]{64}$/.test(runtime.sha256) || !Number.isSafeInteger(runtime.bytes) || runtime.bytes <= 0) throw Error('Invalid low-memory runtime profile');
  const bundled = await readFile(new URL('../' + runtime.bundledPath, import.meta.url));
  if (bundled.length !== runtime.compressedBytes || sha(bundled) !== runtime.compressedSha256) throw Error('Bundled runtime SHA-256 mismatch');
  if (await valid(destination)) console.log(`Verified low-memory runtime: ${(runtime.bytes / 1e6).toFixed(2)} MB · ${runtime.sha256}`);
  else {
    if (process.argv.includes('--verify')) throw Error('Low-memory runtime missing or corrupt. Run npm run runtime:prepare');
    await mkdir(new URL('./', destination), { recursive: true });
    const hash = createHash('sha256'); let bytes = 0;
    const temporary = new URL(destination.href + '.part');
    try {
      await pipeline(Readable.from([bundled]), createGunzip(), new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > runtime.bytes) { done(Error('Runtime larger than expected')); return; }
        hash.update(chunk); done(null, chunk);
      } }), createWriteStream(temporary));
      if (bytes !== runtime.bytes || hash.digest('hex') !== runtime.sha256) throw Error('Runtime SHA-256 mismatch');
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
    console.log(`Prepared low-memory runtime from bundled code: ${(runtime.bytes / 1e6).toFixed(2)} MB`);
  }
} catch (error) { console.error(`Runtime preparation failed: ${error.message}`); process.exitCode = 1; }
