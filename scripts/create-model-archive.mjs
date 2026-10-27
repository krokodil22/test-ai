#!/usr/bin/env node
import { readFile, stat, mkdir, rename, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function tarHeader(name, size) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.startsWith('/') || name.includes('..') || name.length > 100 || !Number.isSafeInteger(size) || size < 0) throw Error('Invalid archive entry');
  const header = Buffer.alloc(512);
  const put = (value, offset, width) => { if (Buffer.byteLength(value) > width) throw Error('Archive field overflow'); header.write(value, offset, width, 'ascii'); };
  const number = (value, offset, width) => put(value.toString(8).padStart(width - 1, '0') + '\0', offset, width);
  put(name, 0, 100); number(0o644, 100, 8); number(0, 108, 8); number(0, 116, 8);
  number(size, 124, 12); number(0, 136, 12); header.fill(32, 148, 156);
  put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
  put(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

export async function createModelArchive(directory, output) {
  directory = resolve(directory); output = resolve(output);
  const info = JSON.parse(await readFile(resolve(directory, 'model-info.json'), 'utf8'));
  if (!info.files?.length || info.downloadBytes >= 2 ** 31) throw Error('Model is missing or exceeds the GitHub Releases per-file limit of 2 GiB');
  const names = ['model-info.json', 'LICENSE', ...info.files.map(file => file.download?.path || file.path)];
  if (await stat(resolve(directory, 'resolve/main/README.md')).catch(() => false)) names.push('README.md');
  await mkdir(dirname(output), { recursive: true });
  const temporary = output + '.part';
  async function* blocks() {
    for (const name of names) {
      const path = resolve(directory, name === 'README.md' ? 'resolve/main/README.md' : name);
      if (!path.startsWith(directory + '/')) throw Error('Archive path escapes model directory');
      const size = (await stat(path)).size;
      yield tarHeader(name, size);
      const entry = info.files.find(file => (file.download?.path || file.path) === name);
      const hash = createHash('sha256');
      let actual = 0;
      for await (const chunk of createReadStream(path)) { hash.update(chunk); actual += chunk.length; yield chunk; }
      if (actual !== size || entry && (size !== (entry.download?.bytes || entry.bytes) || hash.digest('hex') !== (entry.download?.sha256 || entry.sha256))) throw Error(`Archive integrity mismatch: ${name}`);
      if (size % 512) yield Buffer.alloc(512 - size % 512);
    }
    yield Buffer.alloc(1024);
  }
  try {
    await pipeline(Readable.from(blocks()), createWriteStream(temporary));
    if ((await stat(temporary)).size >= 2 ** 31) throw Error('Archive exceeds the GitHub Releases per-file limit of 2 GiB');
    await rename(temporary, output);
  }
  finally { await rm(temporary, { force: true }); }
  return (await stat(output)).size;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = JSON.parse(await readFile(new URL('./model-source.json', import.meta.url), 'utf8'));
  const args = process.argv.slice(2);
  const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const output = option('--output') || `.cache/${source.directory}.tar`;
  const bytes = await createModelArchive(option('--directory') || `public/models/${source.directory}`, output);
  console.log(`Verified model archive: ${output} · ${(bytes / 1e6).toFixed(1)} MB`);
}
