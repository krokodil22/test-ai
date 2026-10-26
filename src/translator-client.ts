export class TranslatorClient {
  private worker = new Worker(new URL('./translator.worker.ts', import.meta.url), { type: 'module', name: 'opus-en-ru-local' });
  private serial = 0;
  private pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void; sentence?: (done: number, total: number) => void }>();
  constructor(progress = (_value: number, _text: string) => {}) {
    this.worker.onmessage = ({ data }) => {
      if (data.kind === 'progress') { progress(data.value, data.text); return; }
      const call = this.pending.get(data.id); if (!call) return;
      if (data.kind === 'sentence') { call.sentence?.(data.done, data.total); return; }
      this.pending.delete(data.id);
      if (data.error || data.stopped) call.reject(Error(data.stopped ? 'Перевод остановлен.' : data.error));
      else call.resolve(data.text || '');
    };
    this.worker.onerror = event => { event.preventDefault(); this.fail(Error('Ошибка Worker переводчика. Проверьте доступную RAM и файлы WASM.')); };
    this.worker.onmessageerror = () => this.fail(Error('Не удалось прочитать ответ переводчика.'));
  }
  private fail(error: Error) { for (const call of this.pending.values()) call.reject(error); this.pending.clear(); }
  private call(type: 'init' | 'translate', payload: object, sentence?: (done: number, total: number) => void) {
    const id = ++this.serial;
    return new Promise<string>((resolve, reject) => { this.pending.set(id, { resolve, reject, sentence }); this.worker.postMessage({ type, id, ...payload }); });
  }
  async init(base: string) { await this.call('init', { base }); }
  translate(text: string, sentence?: (done: number, total: number) => void) { return this.call('translate', { text }, sentence); }
  stop() { this.worker.postMessage({ type: 'stop' }); }
  terminate() { this.worker.terminate(); this.fail(Error('Worker переводчика завершён.')); }
}
