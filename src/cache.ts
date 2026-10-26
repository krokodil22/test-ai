import { CACHE_SCOPES, LEGACY_MODEL_IDS, validateModelInfo } from './config';

async function clearBases(bases: string[]): Promise<void> {
  for (const scope of CACHE_SCOPES) {
    const cache = await caches.open(scope);
    const entries = await cache.keys();
    await Promise.all(entries.filter(entry => bases.some(base => entry.url.startsWith(base))).map(entry => cache.delete(entry)));
  }
}

async function legacyBases(): Promise<string[]> {
  const metadata = await caches.open('ryadom/metadata-v1');
  const bases: string[] = [];
  for (const key of await metadata.keys()) {
    if (!key.url.endsWith('/model-info.json')) continue;
    try {
      const info = await (await metadata.match(key))!.json();
      if (info.schema === 1 && LEGACY_MODEL_IDS.includes(info.modelId)) bases.push(key.url.slice(0, -'model-info.json'.length));
    } catch { /* An unrelated or corrupt entry is not evidence of ownership. */ }
  }
  return bases;
}

export async function removeLegacyModelCache(): Promise<void> {
  await clearBases(await legacyBases());
}

export async function loadModelInfo(base: string) {
  const metadata = await caches.open('ryadom/metadata-v1');
  const url = `${base}model-info.json`;
  const cached = await metadata.match(url);
  if (cached) {
    try { return validateModelInfo(await cached.json()); }
    catch {
      // Custom storage may keep the same URL between releases. Clear stale
      // weights AND WASM before fetching the new manifest, not just metadata.
      await clearBases([base]);
    }
  }
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}: model-info.json`);
  const info = validateModelInfo(await response.clone().json());
  await metadata.put(url, response);
  return info;
}

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
  // The current model and recognized legacy versions belong to this app.
  // Other applications' caches and all chat history remain intact.
  await clearBases([base, ...await legacyBases()]);
}
