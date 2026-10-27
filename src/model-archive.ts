import type { ModelInfo } from './config';

// Read only TAR headers up front; each weight is later read from a Blob slice.
// The complete multi-gigabyte archive is never materialized in RAM.
export async function archiveResources(file: Blob, base: string, info: ModelInfo): Promise<typeof fetch> {
  const fail = () => new Error('Архив модели повреждён или не подходит этой версии сайта. Скачайте указанный на странице файл .tar.');
  if (file.size < 1024 || file.size > info.downloadBytes + 1024 * 1024) throw fail();
  const expected = new Map(info.files.map(item => [item.download?.path || item.path, item.download?.bytes || item.bytes]));
  const entries = new Map<string, { offset: number; size: number }>();
  const decoder = new TextDecoder('ascii');
  const field = (bytes: Uint8Array) => decoder.decode(bytes).split('\0')[0];
  const octal = (bytes: Uint8Array) => {
    const text = field(bytes).trim();
    if (!/^[0-7]+$/.test(text)) throw fail();
    const value = parseInt(text, 8);
    if (!Number.isSafeInteger(value)) throw fail();
    return value;
  };
  let offset = 0;
  let ended = false;
  while (offset + 1024 <= file.size) {
    const header = new Uint8Array(await file.slice(offset, offset + 512).arrayBuffer());
    if (header.every(byte => byte === 0)) {
      if (file.size - offset !== 1024) throw fail();
      const tail = new Uint8Array(await file.slice(offset).arrayBuffer());
      if (tail.length !== 1024 || tail.some(byte => byte !== 0)) throw fail();
      ended = true; break;
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    const name = field(header.slice(0, 100));
    const size = octal(header.slice(124, 136));
    if (octal(header.slice(148, 156)) !== checksum || field(header.slice(257, 263)) !== 'ustar' || field(header.slice(345, 500)) || ![0, 48].includes(header[156]) || !/^[a-zA-Z0-9_./-]+$/.test(name) || name.startsWith('/') || name.includes('..') || entries.has(name)) throw fail();
    if (expected.has(name) ? size !== expected.get(name) : !['model-info.json', 'LICENSE', 'README.md'].includes(name) || size > 256 * 1024) throw fail();
    offset += 512;
    if (offset + size > file.size) throw fail();
    entries.set(name, { offset, size });
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended || [...expected.keys()].some(name => !entries.has(name)) || !entries.has('LICENSE')) throw fail();
  const metadata = entries.get('model-info.json');
  if (!metadata) throw fail();
  let archived: ModelInfo;
  try { archived = JSON.parse(await file.slice(metadata.offset, metadata.offset + metadata.size).text()); }
  catch { throw fail(); }
  if (!archived || typeof archived !== 'object' || archived.modelId !== info.modelId || archived.revision !== info.revision || JSON.stringify(archived.files) !== JSON.stringify(info.files)) throw fail();
  return (async (input: RequestInfo | URL) => {
    const address = input instanceof Request ? input.url : String(input);
    const entry = [...expected.keys()].find(path => new URL(path, base).href === address);
    if (!entry) throw fail();
    const part = entries.get(entry)!;
    // prepareModelCache verifies both the packed and unpacked SHA-256.
    return new Response(file.slice(part.offset, part.offset + part.size).stream());
  }) as typeof fetch;
}
