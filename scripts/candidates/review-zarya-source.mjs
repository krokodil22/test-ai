#!/usr/bin/env node
// Read-only architecture review: save public source as text, never execute it.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new EnvHttpProxyAgent());
const source = JSON.parse(await readFile('scripts/candidates/compact-zarya-orthrus-06.json', 'utf8'));
const root = `https://huggingface.co/${source.repository}/resolve/${source.revision}/`;
const response = await fetch(`https://huggingface.co/api/models/${source.repository}/revision/${source.revision}?blobs=true`, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw Error(`Source metadata HTTP ${response.status}`);
const metadata = await response.json();
if (metadata.sha !== source.revision) throw Error('Source revision mismatch');
const files = metadata.siblings.filter(file => /\.(py|md)$/.test(file.rfilename) || /^LICENSE(?:\.\w+)?$/i.test(file.rfilename));
if (files.length > 20) throw Error('Unexpected source tree size');
const texts = [];
for (const file of files) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(file.rfilename) || file.rfilename.includes('..')) throw Error('Unsafe source path');
  const response = await fetch(root + file.rfilename, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`Source HTTP ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length > 1_000_000) throw Error('Unexpected source file size');
  const sha256 = createHash('sha256').update(data).digest('hex');
  const git = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  if (file.lfs?.sha256 ? sha256 !== file.lfs.sha256 : git !== file.blobId) throw Error('Source integrity mismatch');
  texts.push({ path: file.rfilename, sha256, bytes: data.length, text: new TextDecoder().decode(data) });
}
await writeFile('docs/model-evaluation/zarya-source-review.json', JSON.stringify({ schema: 1, kind: 'public-source-for-architecture-review', repository: source.repository, revision: source.revision, license: metadata.cardData?.license, files: texts, note: 'Untrusted source text for human review; not executed or imported.' }, null, 2) + '\n');
