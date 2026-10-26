import './style.css';
import './compare.css';
import { TranslatorClient } from './translator-client';
import { TRANSLATOR, TRANSLATOR_ESTIMATE, translatorBase, isTranslatorCached, clearTranslator } from './translation-config';
import { BOT_NAME } from './config';
import { icon } from './icons';

document.querySelector('#translator-app')!.innerHTML = `<main class="compare-shell">
<header class="compare-header"><a id="translation-back" href="./compare.html">${icon('chevron')} К сравнению</a><span>${BOT_NAME}</span><span class="compare-local">${icon('lock')} На вашем устройстве</span></header>
<section class="compare-intro"><p class="eyebrow">СПЕЦИАЛИЗИРОВАННЫЙ ПЕРЕВОДЧИК</p><h1>С английского на русский</h1><p>OPUS-MT переводит текст по предложениям на CPU в браузере. Для этой страницы WebGPU и запуск Qwen не нужны. Внешних API нет.</p></section>
${__COMPARISON_TEST_ENGINE__ ? '<p class="notice" id="translation-test-engine">ТЕСТОВЫЙ ДВИЖОК: эти ответы не показывают качество перевода.</p>' : ''}
<section class="compare-model"><div><strong id="translation-status">Проверяем кеш…</strong><p>Первая загрузка — ${TRANSLATOR_ESTIMATE}, включая модели, токенизатор и WASM. После распаковки — около 139 МБ; для выполнения потребуется дополнительная RAM.</p></div><button class="primary-button" id="translation-load" disabled>Скачать и запустить</button><button class="secondary-button" id="translation-cancel" hidden>Отменить запуск</button><progress id="translation-progress" max="1" value="0" hidden aria-label="Загрузка переводчика"></progress></section>
<form id="translation-form" class="compare-form"><label for="translation-source">Английский текст</label><textarea id="translation-source" rows="7" maxlength="12000">The pig could not swim. With her expertise in aquatic survival techniques, Meryl managed to use the bank of the pond to pull the pig back onto dry land safely.</textarea><label for="translation-file">Или выберите JSON сравнения: английский ответ будет прочитан локально</label><input id="translation-file" type="file" accept="application/json,.json"><div class="compare-actions"><button class="primary-button" id="translation-run" disabled>Перевести</button><button class="stop-button" id="translation-stop" type="button" hidden>Остановить</button><button class="secondary-button" id="translation-export" type="button" disabled>Скачать результат JSON</button></div></form>
<p id="translation-notice" class="notice" role="status" hidden></p>
<div class="compare-results translator-results"><article><div class="compare-result-head"><h2>Русский перевод</h2><span id="translation-time">—</span></div><div id="translation-result" class="compare-output">Здесь появится полный перевод.</div></article></div>
<footer class="compare-footer"><p>Это машинный перевод, смысл и термины нужно проверять. Выдуманные слова и ошибки исходного английского текста могут сохраниться. Код и сложный Markdown не защищены от перевода.</p><p>Текст и импортированный файл остаются в памяти вкладки. Переписка Qwen не меняется. Кнопка ниже удаляет только ресурсы переводчика.</p><button class="secondary-button" id="translation-delete">Удалить скачанный переводчик</button></footer>
</main>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = $<HTMLTextAreaElement>('translation-source');
let state: 'idle' | 'loading' | 'ready' | 'running' | 'unsupported' = 'idle';
let client: TranslatorClient | undefined;
let cached = false;
let base = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let result: { source: string; text: string; seconds: number } | undefined;
function notice(text: string) { $('translation-notice').textContent = text; $('translation-notice').hidden = !text; }
function update() {
  $<HTMLButtonElement>('translation-load').disabled = state !== 'idle';
  $('translation-load').hidden = state === 'ready' || state === 'running';
  $('translation-load').textContent = cached ? 'Запустить из кеша' : `Скачать ${TRANSLATOR_ESTIMATE} и запустить`;
  $('translation-cancel').hidden = state !== 'loading';
  $('translation-progress').hidden = state !== 'loading';
  $<HTMLButtonElement>('translation-run').disabled = state !== 'ready' || !input.value.trim();
  input.disabled = state === 'running';
  $<HTMLInputElement>('translation-file').disabled = state === 'running';
  $('translation-stop').hidden = state !== 'running';
  $<HTMLButtonElement>('translation-export').disabled = !result || state === 'running';
  $<HTMLButtonElement>('translation-delete').disabled = state === 'running' || state === 'loading';
}
function close() { client?.terminate(); client = undefined; clearTimeout(timer); timer = undefined; }
$('translation-load').addEventListener('click', async () => {
  if (state !== 'idle') return;
  state = 'loading'; notice(''); update();
  const current = new TranslatorClient((value, text) => { if (client !== current) return; $<HTMLProgressElement>('translation-progress').value = value; $('translation-status').textContent = text; });
  client = current;
  timer = setTimeout(() => { close(); state = 'idle'; notice('Загрузка не завершилась за 15 минут. Проверьте соединение и память.'); update(); }, 15 * 60 * 1000);
  try {
    await current.init(base);
    if (client !== current) return;
    clearTimeout(timer); timer = undefined; state = 'ready'; cached = await isTranslatorCached(base).catch(() => false);
    $('translation-status').textContent = 'OPUS-MT готов · CPU / WebAssembly'; update();
  } catch (error) { if (client !== current) return; close(); state = 'idle'; notice(String(error)); update(); }
});
$('translation-cancel').addEventListener('click', () => { close(); state = 'idle'; $('translation-status').textContent = 'Запуск отменён'; update(); });
$('translation-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state !== 'ready' || !client) return;
  const source = input.value;
  state = 'running'; result = undefined; notice(''); $('translation-result').textContent = 'Переводим предложения…'; $('translation-time').textContent = '—'; update();
  const current = client; const start = performance.now();
  try {
    const text = await current.translate(source, (done, total) => { $('translation-status').textContent = `Переведено предложений: ${done} / ${total}`; });
    if (client !== current) return;
    result = { source, text, seconds: (performance.now() - start) / 1000 };
    $('translation-result').textContent = text; $('translation-time').textContent = `${result.seconds.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с`;
  } catch (error) { if (client !== current) return; $('translation-result').textContent = 'Перевод не завершён.'; notice(String(error)); if (/WASM|Worker|backend|memory|памят/i.test(String(error))) { close(); state = 'idle'; update(); } }
  if (client === current) { clearTimeout(timer); timer = undefined; state = 'ready'; $('translation-status').textContent = 'OPUS-MT готов · CPU / WebAssembly'; update(); }
});
$('translation-stop').addEventListener('click', () => {
  if (state !== 'running' || timer) return;
  client?.stop(); notice('Останавливаем перевод…');
  timer = setTimeout(() => { close(); state = 'idle'; result = undefined; notice('Worker остановлен. Запустите переводчик из кеша.'); update(); }, 6000);
});
$('translation-delete').addEventListener('click', async () => {
  close(); await clearTranslator(); cached = false; state = 'idle'; $('translation-status').textContent = 'Кеш переводчика удалён'; notice('Qwen и история чата сохранены.'); update();
});
$('translation-file').addEventListener('change', async () => {
  const file = $<HTMLInputElement>('translation-file').files?.[0]; if (!file) return;
  try {
    if (file.size > 1_000_000) throw Error('JSON слишком большой (лимит 1 МБ).');
    const data = JSON.parse(await file.text());
    const text = data.reports?.at(-1)?.result?.stages?.find((stage: { stage: string }) => stage.stage === 'english-answer')?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw Error('В JSON не найден английский ответ длиной до 12 000 символов.');
    input.value = text; notice('Английский ответ прочитан из файла локально. Нажмите «Перевести».'); update();
  } catch (error) { notice(String(error)); }
});
$('translation-export').addEventListener('click', () => {
  if (!result) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify({ schema: 1, modelId: TRANSLATOR.modelId, revision: TRANSLATOR.revision, runtime: 'Transformers.js 3.8.1 / ONNX Runtime WASM / CPU', testing: __COMPARISON_TEST_ENGINE__, ...result }, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'tetrikanets-opus-translation.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
input.addEventListener('input', update);
$('translation-back').addEventListener('click', close);
window.addEventListener('pagehide', close);
void (async () => {
  try {
    if (!isSecureContext || !globalThis.WebAssembly || !globalThis.DecompressionStream || !globalThis.caches) throw Error('Нужны HTTPS, WebAssembly, Cache API и DecompressionStream в актуальном Chrome.');
    base = translatorBase(); cached = await isTranslatorCached(base).catch(() => false);
    $('translation-status').textContent = cached ? 'Переводчик сохранён в кеше' : 'Готов к первой загрузке';
  } catch (error) { state = 'unsupported'; notice(String(error)); }
  update();
})();
