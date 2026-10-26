import { CACHE_SCOPES, validateModelInfo } from './config';

export async function isModelCached(base: string): Promise<boolean> {
  if (!('caches' in globalThis)) return false;
  const metadata = await (await caches.open('ryadom/metadata-v1')).match(`${base}model-info.json`);
  if (!metadata) return false;
  const info = validateModelInfo(await metadata.json());
  for (const file of info.files) {
    if (!await (await caches.open(file.scope)).match(new URL(file.path, base).href)) return false;
  }
  return true;
}

export async function removeModelCache(base: string): Promise<void> {
  // Delete only this model's resources, never another app's caches or the chat history.
  for (const scope of CACHE_SCOPES) {
    const cache = await caches.open(scope);
    const entries = await cache.keys();
    await Promise.all(entries.filter(entry => entry.url.startsWith(base)).map(entry => cache.delete(entry)));
  }
}
