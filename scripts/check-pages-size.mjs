import { readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

async function totalBytes(directory) {
  let total = 0;
  for (const item of await readdir(directory)) {
    const path = join(directory, item);
    const entry = await stat(path);
    total += entry.isDirectory() ? await totalBytes(path) : entry.size;
  }
  return total;
}
const directory = resolve(process.argv[2] || 'dist');
const bytes = await totalBytes(directory);
if (bytes > 1_000_000_000) throw new Error(`GitHub Pages site exceeds 1 GB: ${bytes} bytes. Use separate model storage.`);
console.log(`GitHub Pages size: ${bytes} bytes (${(bytes / 1e6).toFixed(1)} MB), within 1 GB.`);
