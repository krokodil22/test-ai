/// <reference lib="webworker" />
import { loadTranslator, translateToRussian, stopTranslation } from '#translator-backend';
let loaded = false;
let busy = false;
let stopped = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'stop') { stopped = true; stopTranslation(); return; }
  if (busy) { self.postMessage({ id: data.id, error: 'Переводчик занят.' }); return; }
  busy = true; stopped = false;
  try {
    if (data.type === 'init') {
      const base = new URL(data.base);
      if (base.href !== data.base || !base.href.endsWith('/') || base.search || base.hash || base.username || base.password || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw Error('Некорректный HTTPS-адрес переводчика.');
      await loadTranslator(base.href, (value, text) => self.postMessage({ kind: 'progress', value, text }));
      loaded = true; self.postMessage({ id: data.id });
    } else if (data.type === 'translate') {
      if (!loaded) throw Error('Переводчик не запущен.');
      const text = await translateToRussian(data.text, (done, total) => self.postMessage({ kind: 'sentence', id: data.id, done, total }));
      self.postMessage({ id: data.id, text, stopped });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const explained = /out of memory|memory access|allocation/i.test(message) ? 'Не хватает памяти для переводчика. Закройте другие вкладки и запустите его снова.' : /no available backend|WebAssembly|WASM/i.test(message) ? `Не удалось запустить WASM переводчика. Проверьте файлы ресурсов и поддержку WebAssembly/SIMD в браузере. ${message}` : message;
    self.postMessage({ id: data.id, error: explained, stopped });
  }
  finally { busy = false; }
};
