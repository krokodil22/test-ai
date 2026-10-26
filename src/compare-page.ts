import './style.css';
import './compare.css';
import { BOT_NAME, MODEL_NAME, MODEL_ID, MODEL_REVISION, MODEL_ESTIMATE, MAX_INPUT_CHARS, MAX_REPLY_TOKENS, MODEL_CHAT_OPTIONS, GENERATION_OPTIONS, resourceBase } from './config';
import { COMPARISON_EXAMPLES, COMPARISON_STAGES, STAGE_LABELS, TRANSLATION_PROTOCOL, TRANSLATION_OPTIONS } from './comparison';
import type { ComparisonResult, ComparisonStage, StageResult } from './comparison';
import { isModelCached } from './cache';
import { probeGpu } from '#gpu';
import { explainError } from './errors';
import { icon, spark } from './icons';
import type { WorkerEvent } from './types';

document.querySelector('#comparison-app')!.innerHTML = `
<main class="compare-shell">
  <header class="compare-header"><a id="back-chat" href="./">${icon('chevron')} В чат</a><span>${BOT_NAME}</span><span class="compare-local">${icon('lock')} Локальный эксперимент</span></header>
  <section class="compare-intro"><span class="compare-spark">${spark()}</span><p class="eyebrow">ОДНА МОДЕЛЬ · ДВА СПОСОБА ОТВЕТИТЬ</p><h1>Помогает ли перевод?</h1><p>Сравните обычный русский ответ с ответом через английский. Используется та же ${MODEL_NAME}, без дополнительных моделей и внешних API.</p></section>
  ${__COMPARISON_TEST_ENGINE__ ? '<p class="notice" id="comparison-test-engine">ТЕСТОВЫЙ ДВИЖОК: ответы в этом запуске не показывают качество модели.</p>' : ''}
  <section class="compare-model"><div><strong id="model-status">Проверяем WebGPU…</strong><p id="cache-description">Сохранённые ресурсы чата используются повторно.</p></div><button id="comparison-load" class="primary-button" disabled>Запустить модель</button><button id="comparison-cancel-load" class="secondary-button" hidden>Отменить запуск</button><progress id="comparison-progress" max="1" value="0" hidden aria-label="Загрузка модели"></progress></section>
  <form id="comparison-form" class="compare-form"><label for="comparison-prompt">Запрос на русском</label><div id="comparison-examples" class="compare-examples"></div><textarea id="comparison-prompt" rows="3" maxlength="${MAX_INPUT_CHARS}"></textarea><p class="compare-hint">Тест отдельных текстовых запросов без истории чата. Сначала выполняется обычный ответ, затем три этапа с переводом. Сложные запросы займут больше времени.</p><div class="compare-actions"><button id="comparison-run" class="primary-button" disabled>Сравнить ответы</button><button id="comparison-stop" class="stop-button" type="button" hidden>Остановить</button><button id="comparison-export" class="secondary-button" type="button" disabled>${icon('download')} Скачать результаты JSON</button></div></form>
  <p id="comparison-notice" class="notice" role="status" hidden></p>
  <ol class="compare-steps">${COMPARISON_STAGES.map((stage, i) => `<li id="step-${stage}" data-state="pending"><span>${i + 1}</span><div><strong>${STAGE_LABELS[stage]}</strong><small id="status-${stage}">Ожидает запуска</small></div></li>`).join('')}</ol>
  <div class="compare-results"><article><div class="compare-result-head"><h2>Напрямую на русском</h2><span id="direct-time">—</span></div><div id="result-direct" class="compare-output">Здесь появится обычный ответ.</div></article><article><div class="compare-result-head"><h2>Через английский</h2><span id="bridge-time">—</span></div><div id="result-translated" class="compare-output">Здесь появится русский перевод английского ответа.</div></article></div>
  <details class="compare-intermediate"><summary>Посмотреть перевод запроса и английский ответ</summary><h3>Запрос после перевода RU → EN</h3><div id="result-input" class="compare-output">—</div><h3>Ответ модели на английском</h3><div id="result-english" class="compare-output">—</div></details>
  <footer class="compare-footer"><p id="comparison-summary">Оцените связность, естественность русского языка и сохранение смысла. Автоматического «победителя» нет.</p><p>В обоих вариантах seed = 42 и лимит ответа — 512 токенов. Для обратного перевода выделено до 1024 токенов. Перевод выполняется с temperature = 0 и без штрафа за повторы: имена и термины должны сохраняться. Проверка длины отсекает грубые отклонения, но не проверяет смысл. Qwen может ошибиться в переводе: это проверка гипотезы, не включённый режим чата.</p><p>Запросы не добавляются в историю чата. Результаты хранятся только в памяти этой вкладки; JSON сохраняется по вашей кнопке на устройство. Закройте другие вкладки с запущенной моделью, чтобы освободить GPU.</p></footer>
</main>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const prompt = $<HTMLTextAreaElement>('comparison-prompt');
const load = $<HTMLButtonElement>('comparison-load');
const run = $<HTMLButtonElement>('comparison-run');
const stop = $<HTMLButtonElement>('comparison-stop');
const exportButton = $<HTMLButtonElement>('comparison-export');
const outputs: Record<ComparisonStage, HTMLElement> = { direct: $('result-direct'), 'translate-input': $('result-input'), 'english-answer': $('result-english'), 'translate-output': $('result-translated') };
const seconds = (value: number) => `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с`;
let state: 'checking' | 'idle' | 'unsupported' | 'loading' | 'ready' | 'running' = 'checking';
let base = '';
let cached = false;
let worker: Worker | undefined;
let activeId: string | undefined;
let activeStage: ComparisonStage | undefined;
let loadTimer: ReturnType<typeof setTimeout> | undefined;
let stopTimer: ReturnType<typeof setTimeout> | undefined;
const reports: Array<{ createdAt: string; result: ComparisonResult }> = [];

for (const example of COMPARISON_EXAMPLES) {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = example.label;
  button.addEventListener('click', () => { prompt.value = example.prompt; update(); });
  $('comparison-examples').append(button);
}
prompt.value = COMPARISON_EXAMPLES[0].prompt;

function notice(text: string) { $('comparison-notice').textContent = text; $('comparison-notice').hidden = !text; }
function update() {
  run.disabled = state !== 'ready' || !prompt.value.trim();
  prompt.disabled = state === 'running';
  for (const button of $('comparison-examples').querySelectorAll('button')) button.disabled = state === 'running';
  load.hidden = state === 'ready' || state === 'running';
  load.disabled = state !== 'idle';
  load.textContent = cached ? 'Запустить из кеша' : `Скачать ${MODEL_ESTIMATE} и запустить`;
  $('comparison-cancel-load').hidden = state !== 'loading';
  $('comparison-progress').hidden = state !== 'loading';
  stop.hidden = state !== 'running';
  stop.disabled = !!stopTimer;
  exportButton.disabled = reports.length === 0 || state === 'running';
}
function terminate() {
  worker?.terminate(); worker = undefined;
  clearTimeout(loadTimer); clearTimeout(stopTimer); loadTimer = undefined; stopTimer = undefined;
}
function markStage(stage: ComparisonStage, status: string, kind: string) {
  $(`step-${stage}`).dataset.state = kind;
  $(`status-${stage}`).textContent = status;
}
function completeStage(result: StageResult) {
  outputs[result.stage].textContent = result.text;
  markStage(result.stage, `${seconds(result.seconds)}${result.finish === 'length' ? ' · достигнут лимит' : ''}`, result.finish === 'length' ? 'warning' : 'complete');
  if (result.stage === 'direct') $('direct-time').textContent = seconds(result.seconds);
}
function receive(event: WorkerEvent) {
  if (event.type === 'progress') {
    $<HTMLProgressElement>('comparison-progress').value = Math.min(1, Math.max(0, event.progress));
    $('model-status').textContent = `Загрузка и подготовка GPU: ${Math.round(event.progress * 100)}%`;
    return;
  }
  if (event.type === 'size') { $('cache-description').textContent = `Комплект модели: ${(event.bytes / 1e6).toFixed(1)} МБ. Дополнительных переводчиков нет.`; return; }
  if (event.type === 'ready') {
    clearTimeout(loadTimer); loadTimer = undefined; state = 'ready';
    $('model-status').textContent = 'Модель готова к сравнению';
    void isModelCached(base).then(value => { cached = value; update(); }).catch(() => {});
    update(); return;
  }
  if ('id' in event && event.id && event.id !== activeId) return;
  if (event.type === 'comparison-stage') {
    activeStage = event.stage; outputs[event.stage].textContent = '';
    markStage(event.stage, 'Выполняется…', 'running'); return;
  }
  if (event.type === 'comparison-token') {
    // The final translated answer is displayed only after translation ends;
    // diagnostics expose the English intermediate stream in a closed panel.
    if (event.stage !== 'translate-output') outputs[event.stage].append(document.createTextNode(event.text));
    return;
  }
  if (event.type === 'comparison-result') { completeStage(event.result); return; }
  if (event.type === 'comparison-done') {
    clearTimeout(stopTimer); stopTimer = undefined; state = 'ready'; activeId = undefined;
    if (event.stopped) {
      if (activeStage) markStage(activeStage, 'Остановлено · результат неполный', 'warning');
      notice('Проверка остановлена. Неполное сравнение не считается результатом.');
    } else if (event.result) {
      reports.push({ createdAt: new Date().toISOString(), result: event.result });
      if (event.result.stages[0].finish === 'length') notice('Прямой ответ достиг лимита токенов. Учитывайте это при сравнении полноты ответов.');
      $('bridge-time').textContent = seconds(event.result.bridgeSeconds);
      $('comparison-summary').textContent = `Сравнение завершено: обычный ответ — ${seconds(event.result.directSeconds)}, вариант с переводом — ${seconds(event.result.bridgeSeconds)}. Проверьте качество обоих текстов и смысл промежуточного перевода.`;
    }
    update(); return;
  }
  if (event.type === 'error') {
    if (activeStage && state === 'running') markStage(activeStage, 'Ошибка · результат неполный', 'warning');
    if (event.fatal) terminate();
    state = event.fatal ? 'idle' : 'ready'; activeId = undefined;
    clearTimeout(stopTimer); stopTimer = undefined;
    $('model-status').textContent = event.fatal ? 'Модель нужно запустить снова' : 'Модель готова';
    notice(event.message); update();
  }
}
async function startModel() {
  if (state !== 'idle') return;
  state = 'loading'; notice(''); update(); $('model-status').textContent = 'Проверяем GPU и запускаем модель…';
  try {
    await probeGpu();
    if (state !== 'loading') return;
    void navigator.storage?.persist?.().catch(() => false);
    worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'tetrikanets-comparison' });
    const currentWorker = worker;
    worker.onmessage = ({ data }: MessageEvent<WorkerEvent>) => { if (worker === currentWorker) receive(data); };
    worker.onerror = event => { event.preventDefault(); receive({ type: 'error', message: 'Worker завершился с ошибкой. Возможно, не хватает памяти. Закройте другие вкладки с моделью и запустите её снова.', fatal: true }); };
    worker.onmessageerror = () => receive({ type: 'error', message: 'Не удалось прочитать ответ worker. Запустите модель снова.', fatal: true });
    loadTimer = setTimeout(() => receive({ type: 'error', message: 'Запуск модели не завершился за 15 минут. Проверьте соединение и доступную память.', fatal: true }), 15 * 60 * 1000);
    worker.postMessage({ type: 'init', base });
  } catch (error) { terminate(); state = 'idle'; notice(explainError(error)); update(); }
}
$('comparison-form').addEventListener('submit', event => {
  event.preventDefault();
  if (state !== 'ready' || !prompt.value.trim()) return;
  state = 'running'; activeId = crypto.randomUUID(); activeStage = undefined; notice('');
  for (const stage of COMPARISON_STAGES) { markStage(stage, 'Ожидает запуска', 'pending'); outputs[stage].textContent = '—'; }
  $('direct-time').textContent = '—'; $('bridge-time').textContent = '—';
  $('comparison-summary').textContent = 'Выполняются четыре последовательных этапа. Дождитесь завершения или остановите проверку.';
  worker!.postMessage({ type: 'compare', id: activeId, prompt: prompt.value }); update();
});
stop.addEventListener('click', () => {
  if (!activeId || stopTimer) return;
  worker?.postMessage({ type: 'stop', id: activeId });
  notice('Останавливаем текущий этап…');
  stopTimer = setTimeout(() => {
    terminate(); state = 'idle'; activeId = undefined;
    if (activeStage) markStage(activeStage, 'Остановлено принудительно', 'warning');
    notice('Worker остановлен. Для нового сравнения запустите модель из кеша.'); update();
  }, 6000);
  update();
});
load.addEventListener('click', () => void startModel());
$('comparison-cancel-load').addEventListener('click', () => { terminate(); state = 'idle'; $('model-status').textContent = 'Запуск отменён'; update(); });
prompt.addEventListener('input', update);
$('back-chat').addEventListener('click', terminate);
window.addEventListener('pagehide', terminate);
exportButton.addEventListener('click', () => {
  const data = { schema: 1, modelId: MODEL_ID, revision: MODEL_REVISION, engine: __COMPARISON_TEST_ENGINE__ ? 'Test double (not inference)' : 'WebLLM 0.2.79', testing: __COMPARISON_TEST_ENGINE__, settings: { answer: { ...GENERATION_OPTIONS, maxTokens: MAX_REPLY_TOKENS }, translation: { protocol: TRANSLATION_PROTOCOL, ...TRANSLATION_OPTIONS, inputMaxTokens: MAX_REPLY_TOKENS, outputMaxTokens: MAX_REPLY_TOKENS * 2, effectiveRepetitionPenalty: 1 }, repetitionPenalty: MODEL_CHAT_OPTIONS.repetition_penalty }, reports };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'tetrikanets-comparison.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function boot() {
  update();
  try {
    base = resourceBase();
    await probeGpu();
    cached = await isModelCached(base).catch(() => false);
    state = 'idle'; $('model-status').textContent = 'WebGPU доступен';
    $('cache-description').textContent = cached ? 'Ресурсы уже в кеше. Повторная загрузка модели не нужна.' : `Первая загрузка: ${MODEL_ESTIMATE}. Используется общий кеш с чатом.`;
  } catch (error) { state = 'unsupported'; $('model-status').textContent = 'Совместимый WebGPU недоступен'; notice(explainError(error)); }
  update();
}
void boot();
