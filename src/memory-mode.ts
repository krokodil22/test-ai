import lowMemory from '#low-memory-runtime';
import source from '../scripts/model-source.json';

export type MemoryMode = 'standard' | 'economy';
const key = 'tetrikanets:memory-mode:v1';
export function readMemoryMode(): MemoryMode {
  try { return localStorage.getItem(key) === 'economy' ? 'economy' : 'standard'; }
  catch { return 'standard'; }
}
export function runtimeFor(mode: MemoryMode) {
  return mode === 'economy' ? { ...lowMemory, mode } : { ...source.runtime, path: 'model.wasm', mode, prefillChunkSize: 1024, maxBatchSize: 128, contextTokens: 4096, experimental: false };
}
export function memoryModeControl(container: HTMLElement, changed: () => void) {
  const field = document.createElement('div'); field.className = 'memory-mode';
  const label = document.createElement('label'); label.textContent = 'Режим памяти';
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Режим памяти');
  for (const [value, text] of [['standard', 'Обычный — прежняя сборка'], ['economy', 'Экономичный — пробный']] as const) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
  }
  select.value = readMemoryMode(); label.append(select);
  const hint = document.createElement('p');
  function describe() {
    hint.textContent = select.value === 'economy'
      ? 'Те же веса и контекст, меньшие рабочие буферы. Вариант для проверки на устройствах с небольшой памятью; стабильность на 8 ГБ ещё не подтверждена.'
      : 'Прежняя библиотека выполнения. Для проверки экономичного варианта выберите его перед запуском модели.';
  }
  select.addEventListener('change', () => {
    try { localStorage.setItem(key, select.value); } catch { /* Selection still works for this page. */ }
    describe(); changed();
  });
  describe(); field.append(label, hint); container.append(field);
  return { value: () => select.value as MemoryMode, update(locked: boolean) { select.disabled = locked; } };
}
