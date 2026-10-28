import lowMemory from '#low-memory-runtime';
import { activeModel } from './config';
export type MemoryMode = 'standard' | 'economy';
const key = 'tetrikanets:memory-mode:v1';
export function readMemoryMode(): MemoryMode {
  if (!activeModel().supportsEconomy) return 'standard';
  try { return localStorage.getItem(key) === 'standard' ? 'standard' : 'economy'; }
  catch { return 'economy'; }
}
export function runtimeFor(mode: MemoryMode) {
  const model = activeModel(); const source = model.source;
  return mode === 'economy' && model.supportsEconomy
    ? { ...lowMemory, mode: 'economy' as MemoryMode }
    : { ...source.runtime, path: 'model.wasm', mode: 'standard' as MemoryMode, prefillChunkSize: source.runtime.prefillChunkSize || 1024, maxBatchSize: source.runtime.maxBatchSize || 128, contextTokens: model.contextTokens, experimental: false };
}
export function memoryModeControl(container: HTMLElement, changed: () => void) {
  const field = document.createElement('div'); field.className = 'memory-mode';
  const label = document.createElement('label'); label.textContent = 'Режим памяти';
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Режим памяти');
  for (const [value, text] of [['standard', 'Обычный — прежняя сборка'], ['economy', 'Экономичный']] as const) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
  }
  label.append(select);
  const hint = document.createElement('p');
  function describe() {
    hint.textContent = select.value === 'economy'
      ? 'Те же веса и контекст, меньшие рабочие буферы. Фактический расход зависит от устройства.'
      : 'Прежняя библиотека выполнения. Для проверки экономичного варианта выберите его перед запуском модели.';
  }
  function refresh() { select.value = readMemoryMode(); field.hidden = !activeModel().supportsEconomy; describe(); }
  select.addEventListener('change', () => {
    try { localStorage.setItem(key, select.value); } catch { /* Current-page selection remains usable. */ }
    describe(); changed();
  });
  refresh(); field.append(label, hint); container.append(field);
  return { value: () => activeModel().supportsEconomy ? select.value as MemoryMode : 'standard' as MemoryMode, refresh, update(locked: boolean) { select.disabled = locked || !activeModel().supportsEconomy; } };
}
