import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const resource = env.VITE_MODEL_BASE_URL || 'models/qwen2.5-0.5b/';
  const external = /^[a-z]+:/i.test(resource) ? new URL(resource) : undefined;
  const localDevelopment = command === 'serve' && external?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(external.hostname);
  if (external && external.protocol !== 'https:' && !localDevelopment) throw new Error('VITE_MODEL_BASE_URL must use HTTPS');
  const remote = external?.origin || '';
  const csp = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ${remote}; style-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'`;
  return {
    base: env.VITE_BASE_PATH || './',
    worker: { format: 'es' },
    resolve: {
      alias: {
        '#gpu': fileURLToPath(new URL(process.env.E2E_MOCK === '1' ? './tests/fixtures/gpu.ts' : './src/gpu.ts', import.meta.url)),
        ...(process.env.E2E_MOCK === '1' ? { '@mlc-ai/web-llm': fileURLToPath(new URL('./tests/fixtures/webllm.ts', import.meta.url)) } : {}),
      },
    },
    plugins: [{
      name: 'static-privacy-policy',
      transformIndexHtml(html) {
        return html.replace('<!-- security-policy -->', command === 'build' ? `<meta http-equiv="Content-Security-Policy" content="${csp}">` : '');
      },
    }],
    build: { target: 'es2022', chunkSizeWarningLimit: 6500 },
    test: { include: ['tests/unit/**/*.test.ts'] },
  };
});
