import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import source from './scripts/model-source.json' with { type: 'json' };
import { copyPublicAssets } from './scripts/static-assets.mjs';

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const resource = env.VITE_MODEL_BASE_URL || `models/${source.directory}/`;
  const external = /^[a-z]+:/i.test(resource) ? new URL(resource) : undefined;
  const localDevelopment = command === 'serve' && external?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(external.hostname);
  if (external && external.protocol !== 'https:' && !localDevelopment) throw new Error('VITE_MODEL_BASE_URL must use HTTPS');
  const remote = external?.origin || '';
  const translatorResource = env.VITE_TRANSLATOR_BASE_URL;
  const translatorExternal = translatorResource && /^[a-z]+:/i.test(translatorResource) ? new URL(translatorResource) : undefined;
  if (translatorExternal && translatorExternal.protocol !== 'https:' && !(command === 'serve' && translatorExternal.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(translatorExternal.hostname))) throw Error('VITE_TRANSLATOR_BASE_URL must use HTTPS');
  const csp = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ${remote} ${translatorExternal?.origin || ''}; style-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'`;
  return {
    base: env.VITE_BASE_PATH || './',
    define: { __COMPARISON_TEST_ENGINE__: JSON.stringify(process.env.E2E_MOCK === '1') },
    publicDir: command === 'build' ? false : 'public',
    worker: { format: 'es' },
    resolve: {
      alias: {
        '#gpu': fileURLToPath(new URL(process.env.E2E_MOCK === '1' ? './tests/fixtures/gpu.ts' : './src/gpu.ts', import.meta.url)),
        '#translator-backend': fileURLToPath(new URL(process.env.E2E_MOCK === '1' ? './tests/fixtures/translator.ts' : './src/translator.ts', import.meta.url)),
        ...(process.env.E2E_MOCK === '1' ? { '@mlc-ai/web-llm': fileURLToPath(new URL('./tests/fixtures/webllm.ts', import.meta.url)) } : {}),
      },
    },
    plugins: [{
      name: 'static-privacy-policy',
      transformIndexHtml(html) {
        return html.replace('<!-- security-policy -->', command === 'build' ? `<meta http-equiv="Content-Security-Policy" content="${csp}">` : '');
      },
    }, {
      name: 'copy-active-model',
      apply: 'build',
      async writeBundle(options) {
        await copyPublicAssets(resolve('public'), resolve(options.dir!), source.directory, env.VITE_MODEL_DELIVERY === 'archive');
      },
    }],
    build: { target: 'es2022', chunkSizeWarningLimit: 6500, rollupOptions: { input: { main: resolve('index.html'), compare: resolve('compare.html'), translate: resolve('translate.html'), diagnostics: resolve('diagnostics.html') } } },
    test: { include: ['tests/unit/**/*.test.{ts,mjs}'] },
  };
});
