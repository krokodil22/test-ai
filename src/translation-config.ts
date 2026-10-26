import source from '../scripts/translation-source.json';

export const TRANSLATOR = source;
export const TRANSLATOR_CACHE = `tetrikanets/opus-en-ru/${source.revision}`;
export const TRANSLATOR_METADATA_CACHE = 'tetrikanets/translator-metadata-v1';
export const TRANSLATOR_CACHE_PREFIX = 'tetrikanets/opus-en-ru/';
export const TRANSLATOR_ESTIMATE = '≈ 84 МБ';
export function translatorBase(pageUrl = location.href) {
  const app = new URL(import.meta.env.BASE_URL, pageUrl);
  const configured = import.meta.env.VITE_TRANSLATOR_BASE_URL || `translations/${source.directory}/`;
  const base = new URL(configured.endsWith('/') ? configured : configured + '/', app);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw Error('Ресурсы переводчика должны использовать HTTPS.');
  if (base.username || base.password || base.search || base.hash) throw Error('Некорректный адрес ресурсов переводчика.');
  return base.href;
}
export async function isTranslatorCached(base: string) {
  const cache = await caches.open(TRANSLATOR_CACHE);
  const metadata = await (await caches.open(TRANSLATOR_METADATA_CACHE)).match(base + 'translation-info.json');
  if (!metadata) return false;
  const info = await metadata.json();
  if (info.revision !== source.revision) return false;
  for (const file of [...source.files, source.runtime]) if (!await cache.match(base + file.path + '.gz')) return false;
  return true;
}
export async function clearTranslator() {
  for (const name of await caches.keys()) if (name.startsWith(TRANSLATOR_CACHE_PREFIX) || name === TRANSLATOR_METADATA_CACHE) await caches.delete(name);
}
