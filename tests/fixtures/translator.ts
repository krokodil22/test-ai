// A UI/protocol test double, never a quality measurement. The separate CPU
// production test runs the real ONNX weights and WASM, without WebGPU.
let stopped = false;
export async function loadTranslator(_base: string, progress: (value: number, text: string) => void) { progress(1, 'Тестовый переводчик'); }
export function stopTranslation() { stopped = true; }
export async function translateToRussian(source: string, onSentence: (done: number, total: number) => void) {
  stopped = false;
  if (!source.startsWith('TEST_ENGLISH_ANSWER')) throw Error('OPUS stage received wrong English source');
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, source.includes('SLOW_OPUS') ? 500 : 30));
    if (stopped) throw Error('Перевод остановлен.');
    onSentence(i + 1, 3);
  }
  return 'Тестовый русский перевод английского ответа.';
}
