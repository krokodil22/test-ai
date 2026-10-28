import './style.css';
import { icon, spark } from './icons';
import { probeGpu } from '#gpu';
import { explainError } from './errors';
import { BOT_NAME, MODEL_NAME, MODEL_ESTIMATE, MAX_INPUT_CHARS, resourceBase, formatBytes, MODEL_DESCRIPTION, MODEL_GPU_MEMORY, MODEL_RAM, MODEL_ARCHIVE_MODE, MODELS, MODEL_SELECTION_KEY, configureModel, activeModel, CONTEXT_TOKENS, MAX_REPLY_TOKENS } from './config';
import { isModelCached, removeModelCache } from './cache';
import { modelDelivery } from './model-delivery';
import { memoryModeControl } from './memory-mode';
import { markdown } from './markdown';
import { readHistory, saveHistory, deleteHistory, MAX_CHATS, MAX_MESSAGES, HISTORY_KEY } from './storage';
import type { History } from './storage';
import type { Message, WorkerEvent, WorkerRequest } from './types';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div id="sidebar-backdrop" class="sidebar-backdrop"></div>
  <aside class="sidebar" id="sidebar" aria-label="История чатов">
    <a class="brand" href="#" aria-label="${BOT_NAME} — главная"><span class="brand-mark">${spark()}</span><span class="brand-name"><span>Великий</span> <strong>Тетриканец</strong></span></a>
    <div class="workspace-label">ВАШЕ ПРОСТРАНСТВО</div>
    <button id="new-chat" class="new-chat">${icon('plus')} Новый чат <span>${icon('arrow')}</span></button>
    <div class="history-heading"><span>Недавние чаты</span><span id="chat-count">0</span></div>
    <nav id="chat-list" class="chat-list" aria-label="Сохранённые чаты"></nav>
    <div class="sidebar-bottom">
      <div class="local-card"><span class="local-icon">${icon('lock')}</span><div><strong>Личное остаётся личным</strong><p>Ваши сообщения — только<br>на вашем устройстве.</p></div></div>
      <button id="settings-open" class="sidebar-settings">${icon('settings')} Настройки и данные ${icon('chevron')}</button>
      <div class="sidebar-footer"><span class="small-dot"></span> Без облака. Без подписки.</div>
    </div>
  </aside>
  <main class="main">
    <header class="topbar">
      <div class="topbar-left"><button id="menu-toggle" class="icon-button mobile-menu" aria-label="Открыть историю">${icon('menu')}</button><span class="topbar-title">${BOT_NAME}</span><span class="header-separator"></span><span class="model-label">${MODEL_NAME}</span></div>
      <button id="quick-start" class="secondary-button quick-start" hidden>Запустить модель</button><div class="private-badge">${icon('lock')} <span>Только на вашем устройстве</span></div>
    </header>
    <div id="model-delivery-panel"></div>
    <div id="scroll-area" class="scroll-area">
      <section id="welcome" class="welcome">
        <div class="welcome-emblem">${spark()}<span class="emblem-orbit"></span></div>
        <div class="eyebrow"><span class="small-dot"></span> ВАШ ПРИВАТНЫЙ ИИ-ПОМОЩНИК</div>
        <h1>Давайте начнём<br><span>с вашей мысли.</span></h1>
        <p class="welcome-description">Спросите, придумайте, разберитесь в сложном.<br>Ваш ИИ-помощник работает прямо в браузере.</p>
        <div id="model-card" class="model-card">
          <div class="model-card-head"><span class="model-card-icon">${icon('chip')}</span><div><h2 id="model-card-title">Модель для общения по-русски</h2><p id="model-card-description">Одна загрузка — и можно общаться.</p></div><span id="model-card-tag" class="model-card-tag">ЛОКАЛЬНО</span></div>
          <div class="model-facts"><span>${icon('download')} <b id="download-size">${MODEL_ESTIMATE}</b> один раз</span><span id="model-gpu-estimate">${icon('chip')} ${MODEL_GPU_MEMORY}</span><span>${icon('leaf')} Без регистрации</span></div>
          <div id="load-progress" class="load-progress" hidden><div class="progress-label"><span id="progress-text">Подготовка…</span><span id="progress-percent">0%</span></div><progress id="progress" max="1" value="0" aria-label="Загрузка модели"></progress></div>
          <button id="load-model" class="primary-button">${icon('download')} <span>Скачать и запустить</span> ${icon('chevron')}</button>
          <button id="cancel-load" class="text-button" hidden>Отменить загрузку</button>
          <p id="compatibility" class="compatibility">Проверяем поддержку WebGPU…</p>
        </div>
        <div class="suggestions-label">С ЧЕГО НАЧНЁМ?</div>
        <div class="suggestions">
          <button class="suggestion" data-prompt="Объясни простыми словами, как работают нейросети."><span class="suggestion-icon mint">${icon('book')}</span><strong>Понять сложное</strong><span>Объясните мне простыми словами…</span>${icon('chevron')}</button>
          <button class="suggestion" data-prompt="Предложи пять необычных идей для творческого выходного."><span class="suggestion-icon pink">${icon('bulb')}</span><strong>Найти идею</strong><span>Давайте придумаем что-нибудь…</span>${icon('chevron')}</button>
          <button class="suggestion" data-prompt="Покажи пример функции на JavaScript, которая удаляет дубликаты из массива, и объясни код."><span class="suggestion-icon blue">${icon('code')}</span><strong>Разобраться с кодом</strong><span>Помогите написать или объяснить…</span>${icon('chevron')}</button>
        </div>
      </section>
      <section id="messages" class="messages" aria-label="Переписка" hidden></section>
    </div>
    <div class="composer-area">
      <div id="notice" class="notice" role="status" hidden></div>
      <div id="generation-status" class="generation-status" role="status" hidden></div>
      <form id="composer" class="composer">
        <label class="sr-only" for="prompt">Сообщение для ИИ</label>
        <textarea id="prompt" rows="1" maxlength="${MAX_INPUT_CHARS}" placeholder="Какая мысль у вас сегодня?" aria-describedby="input-help"></textarea>
        <div class="composer-bottom"><span id="engine-status" class="engine-status"><span class="status-dot"></span> Модель не запущена</span><span id="character-count" class="character-count"></span><button id="cancel-inline" class="stop-button" type="button" hidden>Отменить</button><button id="stop" class="stop-button" type="button" hidden><span></span> Остановить</button><button id="send" class="send-button" type="submit" aria-label="Отправить" disabled>${icon('arrow')}</button></div>
      </form>
      <div class="composer-note"><span>${BOT_NAME} может ошибаться. Проверяйте важные факты.</span><span id="input-help">Enter — отправить <span>·</span> Shift + Enter — новая строка</span></div>
      <div class="bottom-signature">Сделано для ваших мыслей <span>${spark()}</span> С уважением к вашей приватности</div>
    </div>
  </main>
  <dialog id="settings" class="settings-dialog" aria-labelledby="settings-title">
    <div class="dialog-header"><div><span class="eyebrow">ВАШЕ УСТРОЙСТВО</span><h2 id="settings-title">Настройки и данные</h2></div><button id="settings-close" class="icon-button" aria-label="Закрыть настройки">${icon('close')}</button></div>
    <section class="settings-section"><h3>${icon('chip')} Локальная модель</h3><div class="memory-mode"><label for="model-select">Модель</label><select id="model-select" aria-label="Модель">${MODELS.map(model => `<option value="${model.key}" ${model.key === activeModel().key ? 'selected' : ''}>${model.source.displayName}</option>`).join('')}</select></div><p><strong id="settings-model-description">${MODEL_DESCRIPTION}</strong><br>Лицензия Apache 2.0 · WebLLM 0.2.86</p><p id="settings-model-requirements">Загрузка: <span id="settings-size">${MODEL_ESTIMATE}</span>. ${MODEL_GPU_MEMORY}, желательно 6 ГБ с запасом, и ${MODEL_RAM}. Контекст — 4 096 токенов, ответ — до 512 токенов.</p><p>Модель поддерживает русский язык, но ответы могут быть неточными. После смены модели рекомендуем начать новый чат. Прежняя переписка сохраняется. Старые реплики исключаются из контекста, оставаясь в истории.</p><div id="cache-status" class="cache-status">Проверяем кеш…</div><button id="settings-start" class="secondary-button">Запустить модель</button><button id="unload-model" class="secondary-button" disabled>Освободить память</button><button id="comparison-open" class="secondary-button">Сравнить режимы ответа</button><button id="diagnostics-open" class="secondary-button">Диагностика модели и GPU</button><button id="delete-model" class="secondary-button">${icon('trash')} Удалить модель и старые версии</button></section>
    <section class="settings-section"><h3>${icon('chat')} История переписки</h3><p>Чаты сохраняются в этом браузере. Общая история и кеш модели удаляются отдельно. Не используйте общий профиль браузера для личной переписки.</p><button id="delete-history" class="danger-button">${icon('trash')} Удалить всю историю</button></section>
    <section class="settings-section privacy-details"><h3>${icon('lock')} Как устроена приватность</h3><p>Ответы генерируются в Web Worker на вашем GPU. Сервер получает только запросы статических файлов. Внешних API, аналитики и телеметрии нет. Изображения и ссылки из ответов не загружаются.</p><p>Кеш может быть удалён браузером автоматически. Интерфейс сайта требует соединения при открытии; гарантированный офлайн-запуск всей страницы не предусмотрен.</p><p>Ресурсы модели: <code id="resource-location"></code></p></section>
  </dialog>
  <div id="toast" class="toast" role="status" hidden></div>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const textarea = $<HTMLTextAreaElement>('prompt');
const sendButton = $<HTMLButtonElement>('send');
const loadButton = $<HTMLButtonElement>('load-model');
const delivery = modelDelivery(loadButton, () => updateUi(), $('model-delivery-panel'));
const memory = memoryModeControl(document.querySelector('#settings .settings-section')!, () => updateUi());
const settings = $<HTMLDialogElement>('settings');
const scrollArea = $('scroll-area');
let history: History = { conversations: [], activeId: null };
let state: 'checking' | 'idle' | 'loading' | 'ready' | 'generating' | 'unsupported' = 'checking';
let worker: Worker | undefined;
let cached = false;
let base = '';
let activeResponse: Message | undefined;
let generationId: string | undefined;
let stopTimer: ReturnType<typeof setTimeout> | undefined;
let loadTimer: ReturnType<typeof setTimeout> | undefined;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let persistWarning = false;
let initialError = '';
try { history = readHistory(); } catch { initialError = 'Не удалось прочитать локальную историю. Можно продолжить без неё или удалить повреждённые данные в настройках.'; }

const current = () => history.conversations.find(chat => chat.id === history.activeId);
function notice(text: string, persistent = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = text;
  $('notice').hidden = !text;
  if (!persistent) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 10000);
}
function toast(text: string) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2500);
}
function persist() {
  try { saveHistory(history); } catch {
    if (!persistWarning) { persistWarning = true; notice('Браузер не сохранил историю: хранилище переполнено или запрещено. Чат продолжит работать в этой вкладке.', true); }
  }
}
function closeSidebar() { document.body.classList.remove('sidebar-open'); }
function renderChats() {
  const list = $('chat-list');
  list.replaceChildren();
  $('chat-count').textContent = String(history.conversations.length);
  if (!history.conversations.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-history';
    empty.innerHTML = `${icon('chat')}<p>Здесь появятся ваши чаты</p><span>Хранятся только у вас</span>`;
    list.append(empty);
  }
  for (const chat of [...history.conversations].reverse()) {
    const button = document.createElement('button');
    button.className = `chat-item ${chat.id === history.activeId ? 'active' : ''}`;
    button.disabled = state === 'generating';
    button.innerHTML = `${icon('chat')}<span></span>`;
    button.querySelector('span')!.textContent = chat.title;
    button.title = chat.title;
    if (chat.id === history.activeId) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => { history.activeId = chat.id; persist(); renderChats(); renderMessages(); closeSidebar(); });
    list.append(button);
  }
}
function renderMessages(streaming = false) {
  const shouldScroll = !streaming || scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < 160;
  const chat = current();
  const messages = chat?.messages || [];
  $('welcome').hidden = !!messages.length;
  $('messages').hidden = !messages.length;
  $('quick-start').hidden = !messages.length || state !== 'idle';
  if (streaming && activeResponse) {
    const element = document.querySelector<HTMLElement>(`[data-message-id="${activeResponse.id}"] .message-content`);
    if (element) { renderContent(element, activeResponse); if (shouldScroll) scrollArea.scrollTop = scrollArea.scrollHeight; return; }
  }
  $('messages').replaceChildren();
  for (const message of messages) {
    const article = document.createElement('article');
    article.className = `message message-${message.role}`;
    article.dataset.messageId = message.id;
    article.innerHTML = `<div class="message-avatar">${message.role === 'assistant' ? spark() : 'В'}</div><div class="message-body"><div class="message-author">${message.role === 'assistant' ? BOT_NAME : 'Вы'}${message.role === 'assistant' ? '<span>ЛОКАЛЬНЫЙ ИИ</span>' : ''}</div><div class="message-content"></div><div class="message-meta"></div></div>`;
    renderContent(article.querySelector('.message-content')!, message);
    const meta = article.querySelector<HTMLDivElement>('.message-meta')!;
    if (message.role === 'assistant' && message.content && message !== activeResponse) {
      const copy = document.createElement('button');
      copy.className = 'copy-message';
      copy.innerHTML = `${icon('copy')} Копировать`;
      copy.addEventListener('click', () => void copyText(message.content));
      meta.append(copy);
    }
    const labels = { stopped: 'Ответ остановлен', length: 'Достигнут предел ответа', error: 'Ответ прерван из-за ошибки', complete: '' };
    if (message.status && labels[message.status]) {
      const label = document.createElement('span');
      label.textContent = labels[message.status];
      meta.append(label);
    }
    $('messages').append(article);
  }
  if (shouldScroll) scrollArea.scrollTop = scrollArea.scrollHeight;
}
function renderContent(element: HTMLElement, message: Message) {
  if (message.role === 'user') { element.textContent = message.content; return; }
  if (!message.content && message === activeResponse) {
    element.innerHTML = '<span class="thinking-dots" aria-label="Готовлю ответ"><i></i><i></i><i></i></span>';
    return;
  }
  element.innerHTML = markdown(message.content);
  for (const block of element.querySelectorAll('pre')) {
    const copy = document.createElement('button');
    copy.className = 'copy-code';
    copy.innerHTML = `${icon('copy')} Копировать`;
    copy.addEventListener('click', () => void copyText(block.querySelector('code')?.textContent || ''));
    block.prepend(copy);
  }
}
async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); toast('Скопировано'); }
  catch { toast('Браузер запретил копирование. Выделите текст вручную.'); }
}
function updateUi() {
  const busy = state === 'generating';
  memory.update(state !== 'idle');
  $<HTMLSelectElement>('model-select').disabled = state === 'checking' || state === 'loading' || busy;
  textarea.maxLength = MAX_INPUT_CHARS;
  sendButton.disabled = state !== 'ready' || !textarea.value.trim();
  sendButton.hidden = busy;
  $('stop').hidden = !busy;
  $('new-chat').toggleAttribute('disabled', busy);
  $<HTMLButtonElement>('delete-model').disabled = busy || state === 'loading' || !base;
  $<HTMLButtonElement>('delete-history').disabled = busy;
  $<HTMLButtonElement>('comparison-open').disabled = busy || state === 'loading';
  $<HTMLButtonElement>('diagnostics-open').disabled = busy || state === 'loading';
  loadButton.disabled = ['checking', 'unsupported', 'loading', 'ready', 'generating'].includes(state);
  loadButton.disabled ||= !delivery.available(cached);
  delivery.update(cached, state === 'loading', state !== 'checking' && state !== 'unsupported');
  loadButton.hidden = ['loading', 'ready', 'generating'].includes(state);
  $('cancel-load').hidden = state !== 'loading';
  $('cancel-inline').hidden = state !== 'loading';
  $('load-progress').hidden = state !== 'loading';
  const labels = { checking: 'Проверяем WebGPU…', idle: 'Модель не запущена', loading: 'Загрузка модели…', ready: `Готов к разговору${memory.value() === 'economy' ? ' · Экономичный режим' : ''}`, generating: 'Генерирую ответ…', unsupported: 'WebGPU недоступен' };
  $('engine-status').innerHTML = `<span class="status-dot ${state === 'ready' || busy ? 'green' : ''}"></span>${labels[state]}`;
  $('generation-status').hidden = !busy && state !== 'loading';
  $('generation-status').textContent = busy ? `${BOT_NAME} обдумывает ответ…` : state === 'loading' ? 'Подготавливаем модель…' : '';
  $('model-card-title').textContent = state === 'ready' || busy ? 'Всё готово. Начнём разговор?' : 'Модель для общения по-русски';
  $('model-card-description').textContent = state === 'ready' || busy ? 'Задайте вопрос — ответ появится прямо здесь.' : cached ? 'Ресурсы в кеше. Осталось запустить модель.' : 'Одна загрузка — и можно общаться.';
  loadButton.querySelector('span')!.textContent = cached ? 'Запустить из кеша' : MODEL_ARCHIVE_MODE ? 'Открыть и запустить' : 'Скачать и запустить';
  $('cache-status').textContent = cached ? 'Ресурсы модели сохранены в браузере' : 'Модель не сохранена полностью. Частично загруженные файлы тоже можно удалить.';
  $('model-card-tag').textContent = state === 'ready' || busy ? 'ГОТОВО' : 'ЛОКАЛЬНО';
  $('character-count').textContent = textarea.value.length > MAX_INPUT_CHARS * 0.7 ? `${textarea.value.length} / ${MAX_INPUT_CHARS}` : '';
  $('quick-start').hidden = !current()?.messages.length || state !== 'idle';
  $('quick-start').textContent = cached ? 'Запустить из кеша' : `${MODEL_ARCHIVE_MODE ? 'Открыть' : 'Скачать'} модель · ${MODEL_ESTIMATE}`;
  $('settings-start').hidden = state !== 'idle';
  $<HTMLButtonElement>('unload-model').disabled = state !== 'ready';
}
async function refreshCache() {
  const cacheBase = base;
  try { const value = await isModelCached(cacheBase); if (cacheBase !== base) return; cached = value; }
  catch { if (cacheBase !== base) return; cached = false; }
  updateUi();
}
function stopWorker() {
  worker?.terminate();
  worker = undefined;
  clearTimeout(loadTimer);
  clearTimeout(stopTimer);
  loadTimer = undefined;
  stopTimer = undefined;
}
function sendWorker(data: WorkerRequest) { worker?.postMessage(data); }
async function startModel() {
  if (!['idle', 'unsupported'].includes(state)) return;
  if (!delivery.available(cached)) { notice('Скачайте архив модели и выберите файл .tar на этой странице.', true); return; }
  $('notice').hidden = true;
  state = 'loading';
  $<HTMLProgressElement>('progress').value = 0;
  $('progress-text').textContent = 'Проверка GPU…';
  $('progress-percent').textContent = '0%';
  updateUi();
  try {
    await probeGpu();
    if (state !== 'loading') return;
    if (!('caches' in globalThis)) throw new Error('Браузер не предоставляет Cache API. Откройте сайт по HTTPS в обычном окне Chrome.');
    void navigator.storage?.persist?.().catch(() => false);
    worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'tetrikanets-inference' });
    const thisWorker = worker;
    worker.onmessage = ({ data }: MessageEvent<WorkerEvent>) => { if (worker === thisWorker) onWorkerEvent(data); };
    worker.onerror = event => { event.preventDefault(); if (worker !== thisWorker) return; onWorkerEvent({ type: 'error', message: 'Worker модели завершился с ошибкой. Возможно, браузеру не хватает памяти. Запустите модель снова.', fatal: true }); };
    worker.onmessageerror = () => { if (worker === thisWorker) onWorkerEvent({ type: 'error', message: 'Не удалось получить ответ от worker. Запустите модель снова.', fatal: true }); };
    loadTimer = setTimeout(() => onWorkerEvent({ type: 'error', message: 'Загрузка заняла слишком много времени. Проверьте соединение и попробуйте снова: сохранённые файлы будут использованы повторно.', fatal: true }), 15 * 60 * 1000);
    sendWorker({ type: 'init', base, archive: delivery.file(), memoryMode: memory.value(), modelKey: activeModel().key });
  } catch (error) {
    state = 'idle';
    notice(explainError(error), true);
    updateUi();
  }
}
function finishResponse(status: Message['status']) {
  clearTimeout(stopTimer);
  clearTimeout(renderTimer);
  stopTimer = undefined;
  renderTimer = undefined;
  if (activeResponse) { activeResponse.status = status; if (!activeResponse.content) activeResponse.content = status === 'error' ? 'Ответ не был получен.' : 'Генерация остановлена.'; }
  activeResponse = undefined;
  generationId = undefined;
  persist();
  renderMessages();
  renderChats();
}
function onWorkerEvent(event: WorkerEvent) {
  if (event.type === 'progress') {
    const progress = Math.max(0, Math.min(1, event.progress));
    $<HTMLProgressElement>('progress').value = progress;
    $('progress-percent').textContent = `${Math.round(progress * 100)}%`;
    $('progress-text').textContent = event.text.startsWith('Модель:') ? event.text : /shader|pipeline|compil/i.test(event.text) ? 'Подготавливаем вычисления на GPU…' : progress > 0.98 ? 'Запускаем модель…' : 'Загружаем ресурсы или читаем кеш…';
    $('generation-status').textContent = `Запуск модели: ${Math.round(progress * 100)}% · ${$('progress-text').textContent}`;
    return;
  }
  if (event.type === 'size') { $('download-size').textContent = formatBytes(event.bytes); $('settings-size').textContent = formatBytes(event.bytes); return; }
  if (event.type === 'ready') {
    clearTimeout(loadTimer);
    state = 'ready';
    $('compatibility').textContent = 'Работает локально · Можно начинать разговор';
    void refreshCache();
    updateUi();
    textarea.focus();
    return;
  }
  if ('id' in event && event.id && event.id !== generationId) return;
  if (event.type === 'context' && event.dropped) notice(`Для этого ответа исключено старых реплик: ${event.dropped}. Они остаются в истории.`);
  if (event.type === 'token' && activeResponse) {
    activeResponse.content += event.text;
    if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = undefined; renderMessages(true); persist(); }, 90);
    return;
  }
  if (event.type === 'done') {
    state = 'ready';
    finishResponse(event.reason);
    updateUi();
    return;
  }
  if (event.type === 'error') {
    if (event.fatal) stopWorker();
    state = event.fatal ? 'idle' : 'ready';
    if (activeResponse) finishResponse('error');
    notice(event.message, true);
    void refreshCache();
    updateUi();
  }
}
function newChat() {
  if (state === 'generating') return;
  history.activeId = null;
  textarea.value = '';
  resizeInput();
  persist(); renderChats(); renderMessages(); closeSidebar(); textarea.focus();
}
function submit() {
  const content = textarea.value.trim();
  if (state !== 'ready' || !content) return;
  let chat = current();
  if (!chat) {
    if (history.conversations.length >= MAX_CHATS) { notice('Достигнут предел: 30 чатов. Удалите историю в настройках, чтобы начать заново.', true); return; }
    chat = { id: crypto.randomUUID(), title: content.slice(0, 42), createdAt: Date.now(), messages: [] };
    history.conversations.push(chat);
    history.activeId = chat.id;
  }
  if (chat.messages.length >= MAX_MESSAGES - 1) { notice('В этом чате уже 500 сообщений. Начните новый чат.', true); return; }
  chat.messages.push({ id: crypto.randomUUID(), role: 'user', content });
  const requestMessages = chat.messages.map(message => ({ ...message }));
  activeResponse = { id: crypto.randomUUID(), role: 'assistant', content: '' };
  generationId = activeResponse.id;
  chat.messages.push(activeResponse);
  state = 'generating';
  textarea.value = '';
  resizeInput();
  $('notice').hidden = true;
  persist(); renderChats(); renderMessages(); updateUi();
  sendWorker({ type: 'generate', id: generationId, messages: requestMessages });
}
function resizeInput() {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(160, textarea.scrollHeight)}px`;
  updateUi();
}
$('composer').addEventListener('submit', event => { event.preventDefault(); submit(); });
textarea.addEventListener('input', resizeInput);
textarea.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); } });
$('stop').addEventListener('click', () => {
  if (!generationId || stopTimer) return;
  sendWorker({ type: 'stop', id: generationId });
  $('generation-status').textContent = 'Останавливаем ответ…';
  stopTimer = setTimeout(() => {
    stopWorker(); state = 'idle'; finishResponse('stopped'); updateUi();
    notice('Worker остановлен принудительно. Для продолжения запустите модель из кеша в новом чате.', true);
  }, 6000);
});
$('new-chat').addEventListener('click', newChat);
document.querySelector('.brand')!.addEventListener('click', event => { event.preventDefault(); newChat(); });
$('load-model').addEventListener('click', () => void startModel());
$('quick-start').addEventListener('click', () => void startModel());
$('settings-start').addEventListener('click', () => { settings.close(); void startModel(); });
$('unload-model').addEventListener('click', () => {
  if (state !== 'ready') return;
  stopWorker(); state = 'idle'; updateUi();
  $('compatibility').textContent = 'Модель выгружена из памяти · Ресурсы остаются в кеше';
  notice('Модель выгружена. Можно запустить её снова из кеша или открыть в другой вкладке.');
});
function cancelLoad() { stopWorker(); state = 'idle'; updateUi(); void refreshCache(); notice('Загрузка отменена. Частично сохранённые файлы будут использованы повторно.'); }
$('cancel-load').addEventListener('click', cancelLoad);
$('cancel-inline').addEventListener('click', cancelLoad);
for (const suggestion of document.querySelectorAll<HTMLButtonElement>('.suggestion')) suggestion.addEventListener('click', () => { textarea.value = suggestion.dataset.prompt!; resizeInput(); textarea.focus(); });
$('settings-open').addEventListener('click', () => { closeSidebar(); void refreshCache(); settings.showModal(); });
$('settings-close').addEventListener('click', () => settings.close());
$('comparison-open').addEventListener('click', () => {
  if (state === 'generating' || state === 'loading') return;
  persist(); stopWorker();
  location.assign(new URL('compare.html', new URL(import.meta.env.BASE_URL, location.href)).href);
});
$('diagnostics-open').addEventListener('click', () => {
  if (state === 'generating' || state === 'loading') return;
  persist(); stopWorker();
  location.assign(new URL('diagnostics.html', new URL(import.meta.env.BASE_URL, location.href)).href);
});
settings.addEventListener('click', event => { if (event.target === settings) { const rect = settings.getBoundingClientRect(); const mouse = event as MouseEvent; if (mouse.clientX < rect.left || mouse.clientX > rect.right || mouse.clientY < rect.top || mouse.clientY > rect.bottom) settings.close(); } });
$('delete-history').addEventListener('click', () => {
  if (state === 'generating' || !confirm('Удалить всю историю переписки в этом браузере? Модель останется в кеше.')) return;
  try { deleteHistory(); history = { conversations: [], activeId: null }; renderChats(); renderMessages(); toast('Вся история удалена'); }
  catch { toast('Браузер запретил очистку истории'); }
});
$('delete-model').addEventListener('click', async () => {
  if (state === 'generating' || state === 'loading' || !confirm(`Удалить скачанную ${MODEL_NAME} и неподдерживаемые старые версии? Другая доступная модель и переписка сохранятся.`)) return;
  const button = $<HTMLButtonElement>('delete-model');
  button.disabled = true;
  stopWorker(); state = 'idle';
  try { await removeModelCache(base); cached = false; toast('Ресурсы модели удалены'); }
  catch { notice('Браузер не смог удалить все файлы. Повторите очистку или удалите данные сайта в настройках браузера.', true); }
  updateUi();
});
$('menu-toggle').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
$('sidebar-backdrop').addEventListener('click', closeSidebar);
window.addEventListener('pagehide', () => {
  stopWorker();
  if (state === 'generating') finishResponse('stopped');
  if (['loading', 'ready', 'generating'].includes(state)) state = 'idle';
  persist(); updateUi();
});
window.addEventListener('storage', event => {
  if (event.key !== HISTORY_KEY && event.key !== null) return;
  if (state === 'generating') {
    stopWorker(); state = 'idle'; activeResponse = undefined; generationId = undefined;
    clearTimeout(renderTimer); renderTimer = undefined;
  }
  try { history = readHistory(); renderChats(); renderMessages(); updateUi(); notice('История обновлена в другой вкладке.'); }
  catch { notice('Не удалось прочитать историю из другой вкладки.', true); }
});

function refreshModelLabels() {
  document.querySelector('.model-label')!.textContent = MODEL_NAME;
  $('download-size').textContent = MODEL_ESTIMATE;
  $('settings-model-description').textContent = MODEL_DESCRIPTION;
  $('settings-model-requirements').replaceChildren();
  const size = document.createElement('span'); size.id = 'settings-size'; size.textContent = MODEL_ESTIMATE;
  $('settings-model-requirements').append('Загрузка: ', size, `. ${MODEL_GPU_MEMORY} — ориентир, ${MODEL_RAM}. Контекст — ${CONTEXT_TOKENS} токенов, ответ — до ${MAX_REPLY_TOKENS} токенов. Работа на устройствах с 4 ГБ пока не подтверждена.`);
  $('model-gpu-estimate').innerHTML = `${icon('chip')} ${MODEL_GPU_MEMORY}`;
  $('delete-model').innerHTML = `${icon('trash')} Удалить выбранную модель и старые версии`;
}
let modelCheck = 0;
$('model-select').addEventListener('change', async () => {
  if (state === 'loading' || state === 'generating' || state === 'checking') return;
  const key = $<HTMLSelectElement>('model-select').value as import('./models').ModelKey;
  const check = ++modelCheck;
  stopWorker(); state = 'checking'; cached = false; base = '';
  configureModel(key);
  try { localStorage.setItem(MODEL_SELECTION_KEY, key); } catch { /* Current-page selection works without persistence. */ }
  memory.refresh(); refreshModelLabels(); updateUi();
  try {
    base = resourceBase(); $('resource-location').textContent = base;
    const gpu = await probeGpu();
    if (check !== modelCheck) return;
    state = 'idle'; $('compatibility').textContent = `WebGPU доступен · ${gpu}`;
    $('compatibility').classList.remove('compatibility-error');
    await refreshCache();
    notice(`Выбрана ${MODEL_NAME}. Переписка и кеш обеих моделей сохранены. Скачивание начнётся только по кнопке запуска.`, true);
  } catch (error) {
    if (check !== modelCheck) return;
    state = 'unsupported'; $('compatibility').textContent = explainError(error); notice(explainError(error), true);
  }
  updateUi();
});

async function boot() {
  refreshModelLabels(); renderChats(); renderMessages(); updateUi();
  if (initialError) notice(initialError, true);
  try {
    base = resourceBase();
    $('resource-location').textContent = base;
    const gpu = await probeGpu();
    $('compatibility').textContent = `WebGPU доступен · ${gpu} · Рекомендуем Chrome на компьютере`;
    state = 'idle';
    await refreshCache();
  } catch (error) {
    state = 'unsupported';
    const message = explainError(error);
    $('compatibility').textContent = message;
    $('compatibility').classList.add('compatibility-error');
    notice(message, true);
    updateUi();
  }
}
void boot();
