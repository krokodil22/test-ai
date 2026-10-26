// Real second-origin server: browser CORS checks remain enabled.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
let allowCors = true;
const files = [
  { path: 'model.wasm', scope: 'webllm/wasm', body: 'fixture' },
  { path: 'resolve/main/mlc-chat-config.json', scope: 'webllm/config', body: '{}' },
  { path: 'resolve/main/ndarray-cache.json', scope: 'webllm/model', body: '{"records":[]}' },
  { path: 'resolve/main/tokenizer.json', scope: 'webllm/model', body: '{}' },
];
const info = { schema: 1, modelId: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', revision: '9bd564b064631febf14deadcac492efb761d60c3', downloadBytes: 879804433, files: files.map(({ path, scope, body }) => ({ path, scope, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') })) };
createServer(async (request, response) => {
  if (request.url === '/health') { response.end('ok'); return; }
  if (request.url === '/control' && request.method === 'POST') {
    let body = ''; for await (const part of request) body += part;
    allowCors = JSON.parse(body).allowCors;
    response.end('ok'); return;
  }
  const body = request.url.endsWith('/model-info.json') ? JSON.stringify(info) : files.find(file => request.url.endsWith('/' + file.path))?.body;
  if (body === undefined) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', ...(allowCors ? { 'Access-Control-Allow-Origin': 'http://127.0.0.1:5175' } : {}) });
  response.end(body);
}).listen(5176, '127.0.0.1');
