import './style.css';
import './compare.css';
import { BOT_NAME, MODEL_ID, MODEL_REVISION, MODEL_ESTIMATE, resourceBase, MODEL_ARCHIVE_MODE } from './config';
import source from '../scripts/model-source.json';
import { DIAGNOSTIC_PROFILE as profile, validateReference } from './diagnostics';
import type { CpuReference, DiagnosticResult } from './diagnostics';
import { browserEnvironment } from './gpu-info';
import type { RuntimeGpuInfo } from './gpu-info';
import type { CacheAudit } from './model-resources';
import { isModelCached } from './cache';
import { modelDelivery } from './model-delivery';
import { probeGpu } from '#gpu';
import { explainError } from './errors';
import { icon } from './icons';
import type { WorkerEvent } from './types';

document.querySelector('#diagnostics-app')!.innerHTML = `<main class="compare-shell">
  <header class="compare-header"><a href="./">${icon('chevron')} В чат</a><span>${BOT_NAME}</span><span class="compare-local">${icon('lock')} Локальная диагностика</span></header>
  <section class="compare-intro"><p class="eyebrow">ПОИСК ПРИЧИНЫ ОШИБОК</p><h1>Как работает ваша модель?</h1><p>Шесть коротких проверок на русском и английском. Проверим файлы модели в кеше и сравним ответы с контрольным запуском на CPU. Используются прежние веса Qwen3; переводчик не нужен.</p></section>
  ${__COMPARISON_TEST_ENGINE__ ? '<p id="diagnostic-test-engine" class="notice">ТЕСТОВЫЙ ДВИЖОК: эти ответы не показывают качество модели.</p>' : ''}
  <section class="compare-model"><div><strong id="diagnostic-status">Проверяем WebGPU…</strong><p id="diagnostic-cache">Модель начнёт загружаться только по кнопке.</p></div><button id="diagnostic-load" class="primary-button" disabled>Запустить модель</button><button id="diagnostic-cancel" class="secondary-button" hidden>Отменить запуск</button><progress id="diagnostic-progress" max="1" value="0" hidden aria-label="Загрузка модели"></progress></section>
  <section class="compare-form"><p>Проверки выполняются по очереди: арифметика, омлет и времена года — каждый вопрос на двух языках. Во всех случаях короткий нейтральный системный запрос, без рассуждений и штрафов. Случайность отключена. История чата не используется.</p><div class="compare-actions"><button id="diagnostic-run" class="primary-button" disabled>Запустить 6 проверок</button><button id="diagnostic-stop" class="stop-button" hidden>Остановить</button><button id="diagnostic-export" class="secondary-button">${icon('download')} Скачать диагностику JSON</button></div></section>
  <p id="diagnostic-notice" class="notice" role="status" hidden></p>
  <p id="diagnostic-audit" class="compare-hint">Перед ответами заново проверим SHA-256 всех файлов в кеше. Ничего не скачиваем во время этой проверки.</p>
  <details class="compare-intermediate"><summary>Браузер и GPU, включаемые в JSON</summary><pre id="diagnostic-environment" class="compare-output"></pre><p>Эти сведения сохраняются только по вашей кнопке. Браузер может скрыть название GPU; свободную видеопамять WebGPU не сообщает.</p></details>
  <p id="diagnostic-reference-status" class="compare-hint">Читаем контрольный результат с этого сайта…</p>
  <div id="diagnostic-cases"></div>
  <footer class="compare-footer"><p>Сравнивайте смысл и выполнение задания. Контрольный результат получен исходной Qwen3.5 4B на CPU через Transformers в BF16, браузер использует четырёхбитную MLC-версию. Дословное совпадение не ожидается; различия сами по себе не доказывают неисправность GPU.</p><p>JSON содержит версии модели и выполнения, настройки, состояние проверки кеша, ответы, времена и доступные сведения о браузере и рабочем GPU. Он сохраняется на устройство; отправки отчёта и аналитики нет. Незавершённый запуск помечается как неполный. <a href="./compare.html">Другие сравнения</a></p></footer>
</main>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => $<HTMLButtonElement>(id);
const delivery = modelDelivery(button('diagnostic-load'), () => update());
const notice = (text: string) => { $('diagnostic-notice').textContent = text; $('diagnostic-notice').hidden = !text; };
for (const item of profile.cases) {
  const section = document.createElement('section');
  section.className = 'diagnostic-case';
  section.innerHTML = `<h2>${item.label}</h2><p class="compare-hint"></p><div class="compare-results"><article><div class="compare-result-head"><h3>Ваш браузер · WebLLM</h3><span id="status-${item.id}">Ожидает</span></div><div id="output-${item.id}" class="compare-output">—</div></article><article><div class="compare-result-head"><h3>Контроль · CPU / BF16</h3></div><div id="reference-${item.id}" class="compare-output">Читаем результат…</div></article></div>`;
  section.querySelector('p')!.textContent = item.prompt;
  $('diagnostic-cases').append(section);
}
let state: 'checking' | 'unsupported' | 'idle' | 'loading' | 'ready' | 'running' = 'checking';
let worker: Worker | undefined;
let base = '';
let cached = false;
let activeId: string | undefined;
let currentCase: string | undefined;
let complete = false;
let stopped = false;
let lastError = '';
let gpu: RuntimeGpuInfo | undefined;
let audit: CacheAudit | undefined;
let reference: CpuReference | undefined;
let results: DiagnosticResult[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
const environment = browserEnvironment();
function renderEnvironment() { $('diagnostic-environment').textContent = JSON.stringify({ browser: environment, gpu: gpu || 'Рабочее устройство ещё не создано' }, null, 2); }
function update() {
  button('diagnostic-load').hidden = state === 'ready' || state === 'running';
  button('diagnostic-load').disabled = state !== 'idle';
  button('diagnostic-load').disabled ||= !delivery.available(cached);
  delivery.update(cached, state === 'loading', state !== 'checking' && state !== 'unsupported');
  button('diagnostic-load').textContent = cached ? 'Запустить из кеша' : `${MODEL_ARCHIVE_MODE ? 'Открыть' : 'Скачать'} модель ${MODEL_ESTIMATE} и запустить`;
  button('diagnostic-run').disabled = state !== 'ready';
  button('diagnostic-stop').hidden = state !== 'running';
  button('diagnostic-stop').disabled = stopping;
  button('diagnostic-cancel').hidden = state !== 'loading';
  $('diagnostic-progress').hidden = state !== 'loading';
  button('diagnostic-export').disabled = state === 'running' || state === 'loading';
}
function terminate() { worker?.terminate(); worker = undefined; clearTimeout(timer); timer = undefined; }
function finishPartial(message: string) { complete = false; if (currentCase) $(`status-${currentCase}`).textContent = 'Неполный результат'; notice(message); }
function receive(event: WorkerEvent) {
  if (event.type === 'gpu-info') { gpu = event.info; renderEnvironment(); return; }
  if (event.type === 'progress') { $<HTMLProgressElement>('diagnostic-progress').value = event.progress; $('diagnostic-status').textContent = event.text; return; }
  if (event.type === 'ready') { clearTimeout(timer); state = 'ready'; cached = true; $('diagnostic-status').textContent = 'Модель готова'; $('diagnostic-cache').textContent = 'Модель запущена. Проверки используют сохранённые файлы без повторного скачивания.'; update(); return; }
  if ('id' in event && event.id && event.id !== activeId) return;
  if (event.type === 'diagnostic-audit') { audit = event.result; $('diagnostic-audit').textContent = event.result ? `SHA-256 совпал: ${event.checked} файлов, ${(event.result.checkedBytes / 1e6).toFixed(1)} МБ. Файлы не скачивались.` : `Проверяем кеш: ${event.checked} / ${event.total} файлов…`; return; }
  if (event.type === 'diagnostic-start') { currentCase = event.caseId; $(`output-${currentCase}`).textContent = ''; $(`status-${currentCase}`).textContent = 'Генерируется…'; return; }
  if (event.type === 'diagnostic-token') { $(`output-${event.caseId}`).append(document.createTextNode(event.text)); return; }
  if (event.type === 'diagnostic-result') {
    results.push(event.result); $(`output-${event.result.caseId}`).textContent = event.result.text;
    $(`status-${event.result.caseId}`).textContent = `${event.result.seconds.toFixed(1)} с${event.result.finish === 'length' ? ' · лимит' : ''}`;
    currentCase = undefined; return;
  }
  if (event.type === 'diagnostic-done') {
    clearTimeout(timer); stopping = false; stopped = event.stopped; state = 'ready'; activeId = undefined;
    complete = !stopped && results.length === profile.cases.length;
    if (stopped) finishPartial('Проверки остановлены. В JSON будет указано, что запуск неполный.');
    else notice(results.some(result => result.finish === 'length') ? 'Проверки завершены. Некоторые ответы достигли лимита; учитывайте это при сравнении.' : 'Проверки завершены. Сравните ответы по смыслу и сохраните JSON.');
    update(); return;
  }
  if (event.type === 'error') {
    lastError = event.message; finishPartial(event.message);
    if (event.fatal) terminate(); else clearTimeout(timer);
    state = event.fatal ? 'idle' : 'ready'; activeId = undefined; stopping = false;
    $('diagnostic-status').textContent = event.fatal ? 'Модель нужно запустить снова' : 'Модель готова'; update();
  }
}
button('diagnostic-load').onclick = async () => {
  if (state !== 'idle') return;
  state = 'loading'; notice(''); update();
  try {
    await probeGpu();
    if (state !== 'loading') return;
    worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'tetrikanets-diagnostics' });
    const current = worker;
    worker.onmessage = ({ data }: MessageEvent<WorkerEvent>) => { if (worker === current) receive(data); };
    worker.onerror = event => { event.preventDefault(); receive({ type: 'error', fatal: true, message: 'Ошибка Worker. Возможно, не хватает памяти.' }); };
    worker.onmessageerror = () => receive({ type: 'error', fatal: true, message: 'Не удалось прочитать сообщение Worker.' });
    timer = setTimeout(() => receive({ type: 'error', fatal: true, message: 'Запуск не завершился за 15 минут.' }), 15 * 60 * 1000);
    worker.postMessage({ type: 'init', base, archive: delivery.file() });
  } catch (error) { receive({ type: 'error', fatal: true, message: explainError(error) }); }
};
button('diagnostic-run').onclick = () => {
  if (state !== 'ready') return;
  results = []; complete = false; stopped = false; audit = undefined; lastError = ''; currentCase = undefined;
  for (const item of profile.cases) { $(`output-${item.id}`).textContent = '—'; $(`status-${item.id}`).textContent = 'Ожидает'; }
  activeId = crypto.randomUUID(); state = 'running'; notice(''); update();
  worker!.postMessage({ type: 'diagnose', id: activeId });
};
button('diagnostic-stop').onclick = () => {
  if (state !== 'running' || stopping) return;
  worker?.postMessage({ type: 'stop', id: activeId }); stopping = true; notice('Останавливаем…'); update();
  timer = setTimeout(() => { terminate(); stopped = true; finishPartial('Worker остановлен принудительно. Сохраните неполный отчёт; для повторной проверки запустите модель из кеша.'); state = 'idle'; activeId = undefined; stopping = false; update(); }, 6000);
};
button('diagnostic-cancel').onclick = () => { terminate(); state = 'idle'; $('diagnostic-status').textContent = 'Запуск отменён'; update(); };
button('diagnostic-export').onclick = () => {
  const partial = currentCase ? { caseId: currentCase, text: $(`output-${currentCase}`).textContent, status: 'incomplete' } : undefined;
  const report = { schema: 1, kind: 'browser-diagnostics', protocol: profile.protocol, createdAt: new Date().toISOString(), testing: __COMPARISON_TEST_ENGINE__, modelId: MODEL_ID, revision: MODEL_REVISION, runtime: { engine: 'WebLLM 0.2.86', wasmSha256: source.runtime.sha256, quantization: 'q4f16_1' }, environment: { browser: environment, gpu }, settings: { ...profile.settings, systemPrompt: profile.systemPrompt, resetContextBeforeEach: true }, cacheAudit: audit || { valid: false, status: 'not-completed' }, complete, stopped, error: lastError || undefined, results, partial, reference: reference || { status: 'unavailable' } };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'tetrikanets-diagnostics.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener('pagehide', terminate);
for (const link of document.querySelectorAll('a')) link.addEventListener('click', terminate);
async function boot() {
  renderEnvironment(); update();
  void (async () => {
    try {
      const url = new URL('diagnostics/model-reference.json', new URL(import.meta.env.BASE_URL, location.href));
      const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      reference = validateReference(await response.json());
      for (const result of reference.results) $(`reference-${result.caseId}`).textContent = result.text + (result.finish === 'length' ? '\n\n[Контрольный ответ достиг лимита токенов.]' : '');
      $('diagnostic-reference-status').textContent = `${reference.engine}, CPU / ${reference.dtype}, без квантования. Это заранее выполненный контрольный запуск; при открытии страницы CPU-модель не скачивается.`;
    } catch { $('diagnostic-reference-status').textContent = 'Контрольный файл недоступен или несовместим. Диагностику браузера можно выполнить и сохранить отдельно.'; for (const item of profile.cases) $(`reference-${item.id}`).textContent = 'Контрольный результат недоступен.'; }
  })();
  try { base = resourceBase(); await probeGpu(); cached = await isModelCached(base).catch(() => false); state = 'idle'; $('diagnostic-status').textContent = 'WebGPU доступен'; $('diagnostic-cache').textContent = cached ? 'Модель сохранена в кеше.' : `Загрузка модели: ${MODEL_ESTIMATE}. Начнётся по кнопке.`; }
  catch (error) { state = 'unsupported'; lastError = explainError(error); $('diagnostic-status').textContent = 'Совместимый WebGPU недоступен'; notice(lastError); }
  update();
}
void boot();
