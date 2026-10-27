import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import model from './model-source.json' with { type: 'json' };
import runtime from './low-memory-runtime.json' with { type: 'json' };

setGlobalDispatcher(new EnvHttpProxyAgent());
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, `public/models/${model.directory}`, runtime.path);
async function valid(path) {
  try {
    if ((await stat(path)).size !== runtime.bytes) return false;
    const hash = createHash('sha256');
    for await (const part of createReadStream(path)) hash.update(part);
    return hash.digest('hex') === runtime.sha256;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
try {
  if (!/^[a-zA-Z0-9_-]+\.wasm$/.test(runtime.path) || !/^[a-f0-9]{64}$/.test(runtime.sha256) || !Number.isSafeInteger(runtime.bytes) || runtime.bytes <= 0 || new URL(runtime.url).protocol !== 'https:') throw Error('Invalid low-memory runtime source');
  if (await valid(destination)) console.log(`Verified low-memory runtime: ${(runtime.bytes / 1e6).toFixed(2)} MB · ${runtime.sha256}`);
  else {
    if (process.argv.includes('--verify')) throw Error('Low-memory runtime missing or corrupt. Run npm run runtime:download');
    await mkdir(resolve(destination, '..'), { recursive: true });
    const response = await fetch(runtime.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw Error(`HTTP ${response.status}: low-memory runtime unavailable`);
    const hash = createHash('sha256'); let bytes = 0;
    const temporary = destination + '.part';
    try {
      await pipeline(response.body, new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > runtime.bytes) { done(Error('Runtime larger than expected')); return; }
        hash.update(chunk); done(null, chunk);
      } }), createWriteStream(temporary));
      if (bytes !== runtime.bytes || hash.digest('hex') !== runtime.sha256) throw Error('Runtime SHA-256 mismatch');
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
    console.log(`Downloaded and verified low-memory runtime: ${(runtime.bytes / 1e6).toFixed(2)} MB`);
  }
} catch (error) { console.error(`Runtime download failed: ${error.message}`); process.exitCode = 1; }
