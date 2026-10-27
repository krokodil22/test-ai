import './style.css';
import './compare.css';
import { BOT_NAME, MODEL_NAME, MODEL_ID, MODEL_REVISION, MODEL_ESTIMATE, MAX_INPUT_CHARS, MAX_REPLY_TOKENS, MODEL_CHAT_OPTIONS, GENERATION_OPTIONS, SYSTEM_PROMPT, resourceBase } from './config';
import { COMPARISON_EXAMPLES, COMPARISON_STAGES, THINKING_STAGES, THINKING_MAX_TOKENS, THINKING_PROTOCOL, PENALTY_STAGES, PENALTY_PROTOCOL, STAGE_LABELS, TRANSLATION_PROTOCOL, TRANSLATION_OPTIONS } from './comparison';
import type { ComparisonMode, ComparisonResult, ComparisonStage, StageResult } from './comparison';
import { isModelCached } from './cache';
import { TRANSLATOR, TRANSLATOR_ESTIMATE, translatorBase, isTranslatorCached } from './translation-config';
import { probeGpu } from '#gpu';
import { explainError } from './errors';
import { icon, spark } from './icons';
import type { WorkerEvent } from './types';

const selectedMode = new URLSearchParams(location.search).get('mode');
const mode: ComparisonMode = selectedMode === 'translation' || selectedMode === 'thinking' ? selectedMode : 'penalty';
const isThinking = mode === 'thinking';
const isPenalty = mode === 'penalty';
const isTranslation = mode === 'translation';
const title = isPenalty ? 'Мешает ли штраф за повторы?' : isThinking ? 'Помогают ли рассуждения?' : 'Помогает ли перевод?';
const stages = isPenalty ? PENALTY_STAGES : isThinking ? THINKING_STAGES : COMPARISON_STAGES;
document.title = `${title} — ${BOT_NAME}`;

document.querySelector('#comparison-app')!.innerHTML = `
<main class="compare-shell">
  <header class="compare-header"><a id="back-chat" href="./">${icon('chevron')} В чат</a><span>${BOT_NAME}</span><span class="compare-local">${icon('lock')} Локальный эксперимент</span></header>
  <nav class="compare-modes" aria-label="Вид эксперимента"><a href="./compare.html" ${isPenalty ? 'aria-current="page"' : ''}>Штраф за повторы</a><a href="./compare.html?mode=thinking" ${isThinking ? 'aria-current="page"' : ''}>С рассуждениями и без</a><a href="./compare.html?mode=translation" ${isTranslation ? 'aria-current="page"' : ''}>Через английский</a><a href="./diagnostics.html">Диагностика</a></nav>
  <section class="compare-intro"><span class="compare-spark">${spark()}</span><p class="eyebrow">ДВА СПОСОБА ОТВЕТИТЬ</p><h1>${title}</h1><p>${isPenalty ? `Два русских ответа ${MODEL_NAME}: со штрафом за повторы 1,1 и без него — 1,0. Различается только штраф. Рассуждения и перевод выключены; используются те же веса из кеша.` : isThinking ? `Один запрос, два русских ответа ${MODEL_NAME}: с рассуждениями и без них. Те же веса, запрос и настройки случайности. Переводчик не нужен, новые ресурсы не скачиваются, если Qwen уже в кеше.` : `Сравните обычный русский ответ с ответом через английский. Ответы генерирует ${MODEL_NAME}. Обратный перевод выполняет отдельная OPUS-MT на CPU.`} Всё работает локально, без внешних API.</p></section>
  ${__COMPARISON_TEST_ENGINE__ ? '<p class="notice" id="comparison-test-engine">ТЕСТОВЫЙ ДВИЖОК: ответы в этом запуске не показывают качество модели.</p>' : ''}
  <section class="compare-model"><div><strong id="model-status">Проверяем WebGPU…</strong><p id="cache-description">Сохранённые ресурсы чата используются повторно.</p></div><button id="comparison-load" class="primary-button" disabled>Запустить модель</button><button id="comparison-cancel-load" class="secondary-button" hidden>Отменить запуск</button><progress id="comparison-progress" max="1" value="0" hidden aria-label="Загрузка модели"></progress></section>
  <form id="comparison-form" class="compare-form"><label for="comparison-prompt">Запрос на русском</label><div id="comparison-examples" class="compare-examples"></div><textarea id="comparison-prompt" rows="3" maxlength="${MAX_INPUT_CHARS}"></textarea><p class="compare-hint">Тест отдельных текстовых запросов без истории чата. ${isPenalty ? 'Сначала выполняется ответ со штрафом 1,1, затем без штрафа. Запрос и лимит ответа одинаковы.' : isThinking ? 'Сначала выполняется обычный ответ, затем ответ с рассуждениями. Во время размышлений итоговый ответ ещё не выводится; прогресс виден ниже.' : 'Сначала выполняется обычный ответ, затем три этапа с переводом.'} Сложные запросы займут больше времени.</p><div class="compare-actions"><button id="comparison-run" class="primary-button" disabled>Сравнить ответы</button><button id="comparison-stop" class="stop-button" type="button" hidden>Остановить</button><button id="comparison-export" class="secondary-button" type="button" disabled>${icon('download')} Скачать результаты JSON</button></div></form>
  <p id="comparison-notice" class="notice" role="status" hidden></p>
  <ol class="compare-steps ${!isTranslation ? 'compare-two-steps' : ''}">${stages.map((stage, i) => `<li id="step-${stage}" data-state="pending"><span>${i + 1}</span><div><strong>${STAGE_LABELS[stage]}</strong><small id="status-${stage}">Ожидает запуска</small></div></li>`).join('')}</ol>
  <div class="compare-results"><article><div class="compare-result-head"><h2>${isPenalty ? 'Штраф 1,1' : isThinking ? 'Без рассуждений' : 'Напрямую на русском'}</h2><span id="direct-time">—</span></div><div id="result-direct" class="compare-output">Здесь появится обычный ответ.</div></article><article><div class="compare-result-head"><h2>${isPenalty ? 'Без штрафа (1,0)' : isThinking ? 'С рассуждениями' : 'Через английский'}</h2><span id="variant-time">—</span></div><div id="${isPenalty ? 'result-no-penalty' : isThinking ? 'result-thinking' : 'result-translated'}" class="compare-output">${isPenalty ? 'Здесь появится ответ без штрафа за повторы.' : isThinking ? 'Здесь появится итоговый ответ после рассуждений.' : 'Здесь появится русский перевод английского ответа.'}</div></article></div>
  ${isPenalty ? '' : isThinking ? '<details class="compare-intermediate"><summary>Посмотреть рассуждения модели</summary><p id="reasoning-status">Рассуждения отображаются отдельно от итогового ответа. Они тоже могут содержать ошибки.</p><div id="result-reasoning" class="compare-output">—</div></details>' : '<details class="compare-intermediate"><summary>Посмотреть перевод запроса и английский ответ</summary><h3>Запрос после перевода RU → EN</h3><div id="result-input" class="compare-output">—</div><h3>Ответ модели на английском</h3><div id="result-english" class="compare-output">—</div></details>'}
  <footer class="compare-footer"><p id="comparison-summary">Оцените связность, естественность русского языка и выполнение условий запроса. Автоматического «победителя» нет.</p><p>${isPenalty ? `В обоих вариантах один запрос и одинаковые настройки генерации. Лимит каждого ответа — ${MAX_REPLY_TOKENS} токенов. Каждый вариант начинает без истории. Меняется только штраф за повторы: 1,1 → 1,0. Оцените смысл, русский язык и наличие повторов; настройки и времена сохраняются в JSON.` : isThinking ? `Оба варианта получают один и тот же запрос с одинаковыми настройками генерации и начинают без истории. Без рассуждений — до ${MAX_REPLY_TOKENS} токенов; с рассуждениями — до ${THINKING_MAX_TOKENS} на рассуждения и итоговый ответ вместе. Время справа включает рассуждения. Настройки и различие лимитов сохраняются в JSON. Для длинного запроса может не хватить контекста. Режим рассуждений не гарантирует улучшение.` : 'В обоих вариантах seed = 42 и лимит ответа — 512 токенов. OPUS-MT переводит по одному предложению, до 384 токенов перевода на каждое. Запрос RU → EN переводит Qwen с temperature = 0. Проверка длины отсекает грубые отклонения, но не проверяет смысл.'} Это проверка гипотезы; основной чат продолжает работать без рассуждений.</p>${!isTranslation ? '' : '<p><a id="translator-open" href="./translate.html">Проверить только EN → RU, импортировать JSON или удалить переводчик</a></p>'}<p>Запросы не добавляются в историю чата. Результаты хранятся только в памяти этой вкладки; JSON сохраняется по вашей кнопке на устройство. Закройте другие вкладки с запущенной моделью, чтобы освободить GPU.</p></footer>
</main>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const prompt = $<HTMLTextAreaElement>('comparison-prompt');
const load = $<HTMLButtonElement>('comparison-load');
const run = $<HTMLButtonElement>('comparison-run');
const stop = $<HTMLButtonElement>('comparison-stop');
const exportButton = $<HTMLButtonElement>('comparison-export');
const outputIds: Record<ComparisonStage, string> = { direct: 'result-direct', thinking: 'result-thinking', 'no-penalty': 'result-no-penalty', 'translate-input': 'result-input', 'english-answer': 'result-english', 'translate-output': 'result-translated' };
const output = (stage: ComparisonStage) => $(outputIds[stage]);
const seconds = (value: number) => `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с`;
let state: 'checking' | 'idle' | 'unsupported' | 'loading' | 'ready' | 'running' = 'checking';
let base = '';
let cached = false;
let translationCached = false;
let translationBase = '';
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
prompt.value = COMPARISON_EXAMPLES[isPenalty ? 3 : isThinking ? 1 : 0].prompt;

function notice(text: string) { $('comparison-notice').textContent = text; $('comparison-notice').hidden = !text; }
function update() {
  run.disabled = state !== 'ready' || !prompt.value.trim();
  prompt.disabled = state === 'running';
  for (const button of $('comparison-examples').querySelectorAll('button')) button.disabled = state === 'running';
  load.hidden = state === 'ready' || state === 'running';
  load.disabled = state !== 'idle';
  load.textContent = !isTranslation ? (cached ? 'Запустить из кеша' : `Скачать Qwen ${MODEL_ESTIMATE} и запустить`) : cached && translationCached ? 'Запустить из кеша' : cached ? `Запустить Qwen из кеша + скачать переводчик ${TRANSLATOR_ESTIMATE}` : `Скачать Qwen ${MODEL_ESTIMATE}${translationCached ? '' : ` + переводчик ${TRANSLATOR_ESTIMATE}`} и запустить`;
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
  output(result.stage).textContent = result.text || 'Итоговый ответ не получен.';
  const issue = stageIssue(result);
  markStage(result.stage, `${seconds(result.seconds)}${result.generatedTokens !== undefined ? ` · ${result.generatedTokens} токенов` : ''}${issue ? ` · ${issue}` : ''}`, issue ? 'warning' : 'complete');
  if (result.stage === 'direct') $('direct-time').textContent = seconds(result.seconds);
  if (result.stage === 'thinking') {
    $('result-reasoning').textContent = result.thinking?.text || 'Модель не выдала блок рассуждений.';
    $('reasoning-status').textContent = result.thinking?.status === 'complete' ? `Рассуждения завершены.${result.firstAnswerSeconds !== undefined ? ` Первый текст ответа появился через ${seconds(result.firstAnswerSeconds)}.` : ''} Это текст модели, его точность не проверена.` : result.thinking?.status === 'unfinished' ? 'Рассуждения не завершены. Итоговый ответ не получен.' : 'Режим рассуждений запрошен, но модель не выдала ожидаемый блок. Этот запуск не подтверждает использование рассуждений.';
  }
}
function stageIssue(result: StageResult) {
  if (result.thinking?.status === 'unfinished') return 'рассуждения не завершены, ответа нет';
  if (!result.text.trim()) return 'итогового ответа нет';
  if (result.finish === 'length') return 'достигнут лимит токенов, текст может быть обрезан';
  if (result.thinking?.status === 'missing') return 'блок рассуждений не получен';
  return '';
}
function receive(event: WorkerEvent) {
  if (event.type === 'progress') {
    $<HTMLProgressElement>('comparison-progress').value = Math.min(1, Math.max(0, event.progress));
    $('model-status').textContent = event.text.startsWith('Модель:') || event.text.startsWith('Переводчик') || event.text.includes('CPU') ? event.text : `Загрузка и подготовка GPU: ${Math.round(event.progress * 100)}%`;
    return;
  }
  if (event.type === 'size') { $('cache-description').textContent = `Комплект модели: ${(event.bytes / 1e6).toFixed(1)} МБ. ${!isTranslation ? 'Оба варианта используют эти же веса; переводчик не загружается.' : `OPUS-MT: ${TRANSLATOR_ESTIMATE} дополнительно; общий кеш с отдельной страницей перевода.`}`; return; }
  if (event.type === 'ready') {
    clearTimeout(loadTimer); loadTimer = undefined; state = 'ready';
    $('model-status').textContent = 'Модель готова к сравнению';
    void isModelCached(base).then(value => { cached = value; update(); }).catch(() => {});
    if (isTranslation) void isTranslatorCached(translationBase).then(value => { translationCached = value; update(); }).catch(() => {});
    update(); return;
  }
  if ('id' in event && event.id && event.id !== activeId) return;
  if (event.type === 'comparison-stage') {
    activeStage = event.stage; output(event.stage).textContent = '';
    if (event.stage === 'thinking') { $('result-reasoning').textContent = ''; $('reasoning-status').textContent = 'Модель начала генерацию. Рассуждения появятся здесь.'; }
    markStage(event.stage, 'Выполняется…', 'running'); return;
  }
  if (event.type === 'comparison-token') {
    // The final translated answer is displayed only after translation ends;
    // diagnostics expose the English intermediate stream in a closed panel.
    if (event.stage !== 'translate-output') output(event.stage).append(document.createTextNode(event.text));
    if (event.stage === 'thinking' && event.text.trim()) markStage('thinking', 'Пишет итоговый ответ…', 'running');
    return;
  }
  if (event.type === 'comparison-reasoning') {
    $('result-reasoning').append(document.createTextNode(event.text));
    markStage('thinking', 'Думает… итогового ответа пока нет', 'running');
    return;
  }
  if (event.type === 'comparison-progress') { markStage('translate-output', `Переведено предложений: ${event.done} / ${event.total}`, 'running'); return; }
  if (event.type === 'comparison-result') { completeStage(event.result); return; }
  if (event.type === 'comparison-done') {
    clearTimeout(stopTimer); stopTimer = undefined; state = 'ready'; activeId = undefined;
    if (event.stopped) {
      if (activeStage) markStage(activeStage, 'Остановлено · результат неполный', 'warning');
      if (activeStage === 'thinking') $('reasoning-status').textContent = 'Генерация остановлена. Рассуждения и ответ могут быть неполными.';
      notice('Проверка остановлена. Неполное сравнение не считается результатом.');
    } else if (event.result) {
      reports.push({ createdAt: new Date().toISOString(), result: event.result });
      const issues = event.result.stages.map(result => { const issue = stageIssue(result); return issue ? `${STAGE_LABELS[result.stage]}: ${issue}.` : ''; }).filter(Boolean);
      if (issues.length) notice(issues.join(' '));
      const variantSeconds = event.result.mode === 'penalty' ? event.result.noPenaltySeconds : event.result.mode === 'thinking' ? event.result.thinkingSeconds : event.result.bridgeSeconds;
      $('variant-time').textContent = seconds(variantSeconds);
      $('comparison-summary').textContent = `Сравнение завершено: ${isPenalty ? 'штраф 1,1' : 'обычный ответ'} — ${seconds(event.result.directSeconds)}, ${isPenalty ? 'без штрафа (1,0)' : isThinking ? 'ответ с рассуждениями' : 'вариант с переводом'} — ${seconds(variantSeconds)}. ${issues.length ? 'Есть ограничения или неполные результаты; учитывайте предупреждения.' : 'Проверьте связность и выполнение условий в обоих текстах.'}`;
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
    worker.postMessage({ type: 'init', base, ...(isTranslation ? { translatorBase: translationBase } : {}) });
  } catch (error) { terminate(); state = 'idle'; notice(explainError(error)); update(); }
}
$('comparison-form').addEventListener('submit', event => {
  event.preventDefault();
  if (state !== 'ready' || !prompt.value.trim()) return;
  state = 'running'; activeId = crypto.randomUUID(); activeStage = undefined; notice('');
  for (const stage of stages) { markStage(stage, 'Ожидает запуска', 'pending'); output(stage).textContent = '—'; }
  if (isThinking) { $('result-reasoning').textContent = '—'; $('reasoning-status').textContent = 'Рассуждения отображаются отдельно от итогового ответа.'; }
  $('direct-time').textContent = '—'; $('variant-time').textContent = '—';
  $('comparison-summary').textContent = `Выполняются ${!isTranslation ? 'два' : 'четыре'} последовательных этапа. Дождитесь завершения или остановите проверку.`;
  worker!.postMessage({ type: 'compare', id: activeId, prompt: prompt.value, mode }); update();
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
document.getElementById('translator-open')?.addEventListener('click', terminate);
for (const link of document.querySelectorAll('.compare-modes a')) link.addEventListener('click', terminate);
window.addEventListener('pagehide', terminate);
exportButton.addEventListener('click', () => {
  const data = { schema: 1, mode, modelId: MODEL_ID, revision: MODEL_REVISION, engine: __COMPARISON_TEST_ENGINE__ ? 'Test double (not inference)' : 'WebLLM 0.2.79', testing: __COMPARISON_TEST_ENGINE__, settings: { answer: { ...GENERATION_OPTIONS, maxTokens: MAX_REPLY_TOKENS }, ...(isPenalty ? { penalty: { protocol: PENALTY_PROTOCOL, seed: 42, samePrompt: true, resetContextBeforeEach: true, systemPrompt: SYSTEM_PROMPT, baseline: { ...GENERATION_OPTIONS, maxTokens: MAX_REPLY_TOKENS, effectiveRepetitionPenalty: MODEL_CHAT_OPTIONS.repetition_penalty, application: 'model-repetition' }, withoutPenalty: { ...GENERATION_OPTIONS, maxTokens: MAX_REPLY_TOKENS, effectiveRepetitionPenalty: 1, frequency_penalty: 0, presence_penalty: 0, application: 'zero-additive' } } } : isThinking ? { thinking: { protocol: THINKING_PROTOCOL, ...GENERATION_OPTIONS, extra_body: { enable_thinking: true }, maxTokens: THINKING_MAX_TOKENS, budgetIncludesReasoningAndAnswer: true, seed: 42, samePrompt: true, resetContextBeforeEach: true, systemPrompt: SYSTEM_PROMPT } } : { translation: { protocol: TRANSLATION_PROTOCOL, input: { engine: 'Qwen3 / WebLLM', extra_body: GENERATION_OPTIONS.extra_body, ...TRANSLATION_OPTIONS, maxTokens: MAX_REPLY_TOKENS, effectiveRepetitionPenalty: 1 }, output: { modelId: TRANSLATOR.modelId, revision: TRANSLATOR.revision, transformers: TRANSLATOR.transformers, device: 'wasm / CPU', sentenceBySentence: true, maxSourceTokensPerSentence: 400, maxNewTokensPerSentence: 384, do_sample: false } } }), repetitionPenalty: MODEL_CHAT_OPTIONS.repetition_penalty }, reports };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'tetrikanets-comparison.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function boot() {
  update();
  try {
    base = resourceBase(); if (isTranslation) translationBase = translatorBase();
    await probeGpu();
    [cached, translationCached] = await Promise.all([isModelCached(base).catch(() => false), !isTranslation ? Promise.resolve(false) : isTranslatorCached(translationBase).catch(() => false)]);
    state = 'idle'; $('model-status').textContent = 'WebGPU доступен';
    $('cache-description').textContent = `Qwen: ${cached ? 'сохранена в кеше' : MODEL_ESTIMATE}. ${!isTranslation ? 'Одна модель для обоих вариантов, без переводчика.' : `OPUS-MT: ${translationCached ? 'сохранена в кеше' : TRANSLATOR_ESTIMATE}.`} Скачивание начнётся по кнопке, если ресурсы отсутствуют в кеше.`;
  } catch (error) { state = 'unsupported'; $('model-status').textContent = 'Совместимый WebGPU недоступен'; notice(explainError(error)); }
  update();
}
void boot();
