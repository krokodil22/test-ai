// Real second-origin server: browser CORS checks remain enabled.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import source from '../../scripts/model-source.json' with { type: 'json' };
let allowCors = true;
let gzipEncoding = false;
const files = [
  { path: 'model.wasm', scope: 'webllm/wasm', body: 'fixture' },
  { path: 'resolve/main/mlc-chat-config.json', scope: 'webllm/config', body: '{}' },
  { path: `resolve/main/${source.cacheManifest}`, scope: 'webllm/model', body: '{"records":[]}' },
  { path: 'resolve/main/tokenizer.json', scope: 'webllm/model', body: '{}' },
  { path: 'resolve/main/params_shard_0.bin', scope: 'webllm/model', body: 'cors fixture weights' },
];
const info = { schema: 1, modelId: source.modelId, revision: source.revision, downloadBytes: source.downloadBytes, files: files.map(({ path, scope, body }) => ({ path, scope, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), ...(path.endsWith('.bin') ? { download: { encoding: 'gzip', path: path + '.gz', bytes: gzipSync(body).length, sha256: createHash('sha256').update(gzipSync(body)).digest('hex') } } : {}) })) };
createServer(async (request, response) => {
  if (request.url === '/health') { response.end('ok'); return; }
  if (request.url === '/control' && request.method === 'POST') {
    let body = ''; for await (const part of request) body += part;
    const settings = JSON.parse(body);
    allowCors = settings.allowCors; gzipEncoding = !!settings.gzipEncoding;
    response.end('ok'); return;
  }
  const file = files.find(file => request.url.endsWith('/' + file.path + (file.path.endsWith('.bin') ? '.gz' : '')));
  const body = request.url.endsWith('/model-info.json') ? JSON.stringify(info) : file?.path.endsWith('.bin') ? gzipSync(file.body) : file?.body;
  if (body === undefined) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', ...(allowCors ? { 'Access-Control-Allow-Origin': 'http://127.0.0.1:5175' } : {}), ...(gzipEncoding && file?.path.endsWith('.bin') ? { 'Content-Encoding': 'gzip' } : {}) });
  response.end(body);
}).listen(5176, '127.0.0.1');
