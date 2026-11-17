import type { WorkbookRef, WorkbookInfo, TableQuery, TableResult } from './files';
import { getWorkbookInfo, queryTable, downloadQuery } from './file-client';
import { deleteWorkbook } from './workbook-store';

export function workbookPanel(root: HTMLElement, options: {
  select: (ref?: WorkbookRef) => void;
  record: (result: TableResult) => void;
  explain: (result: TableResult) => void;
  error: (message: string) => void;
}) {
  root.innerHTML = `<div id="workbook-bar" class="workbook-bar" hidden><div><strong id="workbook-name"></strong><p id="workbook-coverage"></p></div><button type="button" id="workbook-open" class="file-button">Операции с таблицей</button><button type="button" id="workbook-detach" class="file-button">Отсоединить</button></div>
    <dialog id="table-dialog" class="settings-dialog table-dialog" aria-labelledby="table-title"><div class="dialog-header"><div><h2 id="table-title">Вся таблица</h2><p id="table-source"></p></div><button type="button" id="table-close" class="file-button">Закрыть</button></div>
    <p class="table-help">Расчёты выполняются по всем строкам выбранного листа, без запуска модели. Все листы файла доступны в списке. Модель получает готовый отчёт, а не всю книгу в одном запросе.</p>
    <div class="table-controls"><label>Лист<select id="table-sheet"></select></label><label class="table-check"><input type="checkbox" id="table-headers" checked> Первая строка — заголовки</label><label>Операция<select id="table-operation"><option value="overview">Обзор всех столбцов</option><option value="stats">Сумма, среднее, минимум и максимум</option><option value="rows">Все строки</option><option value="search">Поиск по всем ячейкам</option><option value="filter">Фильтр строк</option><option value="group">Группировка</option></select></label><label id="table-column-label">Столбец<select id="table-column"></select></label><label id="table-group-label">Группировать по<select id="table-group"></select></label><label id="table-aggregate-label">Расчёт<select id="table-aggregate"><option value="count">Количество строк</option><option value="sum">Сумма</option><option value="mean">Среднее</option><option value="min">Минимум</option><option value="max">Максимум</option></select></label><label id="table-operator-label">Условие<select id="table-operator"><option value="contains">Содержит текст</option><option value="eq">Равно</option><option value="ne">Не равно</option><option value="gt">Больше</option><option value="gte">Больше или равно</option><option value="lt">Меньше</option><option value="lte">Меньше или равно</option><option value="empty">Пусто</option><option value="notEmpty">Не пусто</option></select></label><label id="table-value-label">Значение<input id="table-value" maxlength="500" autocomplete="off"></label></div>
    <div class="table-actions"><button type="button" id="table-run" class="secondary-button">Рассчитать по всей таблице</button><button type="button" id="table-source-download" class="secondary-button">Скачать весь лист в Excel</button></div>
    <p id="table-status" role="status"></p><section id="table-result" hidden><p id="table-result-summary"></p><div class="table-grid" tabindex="0" aria-label="Результат операции"><table id="table-grid"></table></div><div class="table-pager"><button type="button" id="table-prev" class="file-button">Назад</button><span id="table-page"></span><button type="button" id="table-next" class="file-button">Далее</button></div><div class="table-actions"><button type="button" id="table-download-xlsx" class="secondary-button">Скачать весь результат Excel</button><button type="button" id="table-download-csv" class="secondary-button">Скачать весь результат CSV</button><button type="button" id="table-record" class="secondary-button">Сохранить расчёт в чат</button><button type="button" id="table-explain" class="secondary-button">Задать ИИ вопрос по расчёту</button></div></section>
    <p class="table-help">Формулы не вычисляются: используются сохранённые значения. Предпросмотр показывает по 20 строк; скачивание включает весь результат и все столбцы.</p><button type="button" id="table-delete" class="danger-button">Удалить эту таблицу с устройства</button></dialog>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  root.querySelector('.table-controls')!.insertAdjacentHTML('beforeend', `<label class="table-check"><input id="table-condition-enabled" type="checkbox"> Считать только строки по условию</label><div id="table-condition" class="table-condition" hidden><label>Столбец условия<select id="table-condition-column"></select></label><label>Сравнение<select id="table-condition-operator"></select></label><label>Значение условия<input id="table-condition-value" maxlength="500"></label></div>`);
  el<HTMLSelectElement>('table-condition-operator').replaceChildren(...Array.from(el<HTMLSelectElement>('table-operator').options).map(option => option.cloneNode(true)));
  const dialog = el<HTMLDialogElement>('table-dialog');
  let ref: WorkbookRef | undefined, info: WorkbookInfo | undefined, result: TableResult | undefined;
  let controller: AbortController | undefined, externalBusy = false;
  let key = '';
  const value = (id: string) => el<HTMLSelectElement>(id).value;
  function enabled() {
    for (const button of root.querySelectorAll<HTMLButtonElement>('button')) if (!['table-close'].includes(button.id)) button.disabled = !!controller || externalBusy;
    for (const control of root.querySelectorAll<HTMLSelectElement | HTMLInputElement>('select,input')) control.disabled = !!controller || externalBusy;
    el<HTMLButtonElement>('table-prev').disabled ||= !result || result.page === 0;
    el<HTMLButtonElement>('table-next').disabled ||= !result || result.page + 1 >= result.pageCount;
  }
  function controls() {
    const op = value('table-operation');
    el('table-column-label').hidden = !['stats', 'filter', 'group'].includes(op);
    el('table-group-label').hidden = op !== 'group';
    el('table-aggregate-label').hidden = op !== 'group';
    el('table-operator-label').hidden = op !== 'filter';
    el('table-value-label').hidden = !['filter', 'search'].includes(op) || (op === 'filter' && ['empty', 'notEmpty'].includes(value('table-operator')));
    el('table-condition').hidden = !el<HTMLInputElement>('table-condition-enabled').checked;
  }
  function query(): TableQuery {
    return { operation: value('table-operation') as TableQuery['operation'], column: Number(value('table-column')), groupBy: Number(value('table-group')), aggregate: value('table-aggregate') as TableQuery['aggregate'], operator: value('table-operator') as TableQuery['operator'], value: el<HTMLInputElement>('table-value').value,
      ...(el<HTMLInputElement>('table-condition-enabled').checked ? { condition: { column: Number(value('table-condition-column')), operator: value('table-condition-operator') as NonNullable<TableQuery['condition']>['operator'], value: el<HTMLInputElement>('table-condition-value').value } } : {}) };
  }
  async function task(work: (signal: AbortSignal) => Promise<void>) {
    if (controller || externalBusy) return;
    const active = new AbortController(); controller = active;
    el('table-status').textContent = 'Обрабатываем все данные выбранного листа…'; enabled();
    try { await work(active.signal); if (!active.signal.aborted) el('table-status').textContent = ''; }
    catch (error) { if (!active.signal.aborted) { const message = error instanceof Error ? error.message : 'Ошибка обработки таблицы.'; el('table-status').textContent = message; options.error(message); } }
    finally { if (controller === active) controller = undefined; enabled(); }
  }
  function showResult(next: TableResult) {
    result = next; el('table-result').hidden = false;
    el('table-result-summary').textContent = next.summary;
    const table = el<HTMLTableElement>('table-grid'); table.replaceChildren();
    const head = table.createTHead().insertRow();
    next.headers.forEach(text => { const cell = document.createElement('th'); cell.textContent = text; head.append(cell); });
    const body = table.createTBody();
    next.rows.forEach(row => { const tr = body.insertRow(); row.forEach(text => { const cell = tr.insertCell(); cell.textContent = text.length > 500 ? text.slice(0, 500) + '…' : text; }); });
    el('table-page').textContent = `Страница ${next.page + 1} из ${next.pageCount} · всего ${next.totalRows} строк результата`;
    enabled();
  }
  async function run(page = 0, selectedQuery = query()) { if (!ref) return; const source = { ...ref }; await task(async signal => showResult(await queryTable(source, selectedQuery, undefined, page, signal))); }
  function setInfo(next: WorkbookInfo) {
    info = next;
    el('workbook-name').textContent = next.name;
    const sheet = next.sheets[next.ref.sheet];
    el('workbook-coverage').textContent = `Загружено целиком · «${sheet.name}»: ${sheet.rows} строк, ${sheet.columns} столбцов · ${next.sheets.length} листов`;
    el('table-source').textContent = next.name;
    const sheets = el<HTMLSelectElement>('table-sheet'); sheets.replaceChildren();
    next.sheets.forEach((sheet, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = `${sheet.name} · ${sheet.rows} строк`; sheets.append(option); });
    sheets.value = String(next.ref.sheet); el<HTMLInputElement>('table-headers').checked = next.ref.hasHeaders;
    for (const id of ['table-column', 'table-group', 'table-condition-column']) {
      const select = el<HTMLSelectElement>(id), previous = select.value; select.replaceChildren();
      next.headers.forEach((header, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = header; select.append(option); });
      if (Number(previous) < next.headers.length) select.value = previous || '0';
    }
    controls();
  }
  el('workbook-open').addEventListener('click', () => dialog.showModal());
  el('workbook-detach').addEventListener('click', () => options.select());
  el('table-close').addEventListener('click', () => { controller?.abort(); controller = undefined; dialog.close(); enabled(); });
  dialog.addEventListener('cancel', () => { controller?.abort(); controller = undefined; enabled(); });
  for (const id of ['table-operation', 'table-operator', 'table-aggregate']) el(id).addEventListener('change', controls);
  el('table-condition-enabled').addEventListener('change', controls);
  root.querySelector('.table-controls')!.addEventListener('change', event => { if (!(event.target as HTMLElement).id.match(/^table-(sheet|headers)$/)) { result = undefined; el('table-result').hidden = true; } });
  el('table-sheet').addEventListener('change', () => { if (ref) options.select({ ...ref, sheet: Number(value('table-sheet')) }); });
  el('table-headers').addEventListener('change', () => { if (ref) options.select({ ...ref, hasHeaders: el<HTMLInputElement>('table-headers').checked }); });
  el('table-run').addEventListener('click', () => void run());
  el('table-prev').addEventListener('click', () => { if (result) void run(result.page - 1, result.query); });
  el('table-next').addEventListener('click', () => { if (result) void run(result.page + 1, result.query); });
  el('table-record').addEventListener('click', () => { if (result) { options.record(result); dialog.close(); } });
  el('table-explain').addEventListener('click', () => { if (result) { options.explain(result); dialog.close(); } });
  for (const format of ['xlsx', 'csv'] as const) el(`table-download-${format}`).addEventListener('click', () => { if (result && info) void task(async signal => downloadQuery(result!.workbook, result!.query, format, info!.name + ' — результат', signal)); });
  el('table-source-download').addEventListener('click', () => { if (ref && info) void task(async signal => downloadQuery(ref!, { operation: 'rows' }, 'xlsx', info!.name + ' — весь лист', signal)); });
  el('table-delete').addEventListener('click', async () => {
    if (!ref || !confirm('Удалить все данные этого файла из браузера? Текст прежних расчётов останется в истории.')) return;
    const id = ref.id;
    await task(async () => { await deleteWorkbook(id); options.select(); dialog.close(); });
  });
  controls();
  return {
    update(next: WorkbookRef | undefined, busy: boolean) {
      externalBusy = busy;
      const nextKey = JSON.stringify(next) || '';
      if (nextKey !== key) {
        key = nextKey; ref = next; info = undefined; result = undefined;
        controller?.abort(); controller = undefined; el('table-result').hidden = true;
        el('workbook-bar').hidden = !next;
        if (next) {
          el('workbook-name').textContent = 'Таблица'; el('workbook-coverage').textContent = 'Читаем сохранённые данные…';
          const active = new AbortController(); controller = active;
          void getWorkbookInfo(next, active.signal).then(setInfo).catch(error => { if (!active.signal.aborted) { el('workbook-coverage').textContent = error instanceof Error ? error.message : 'Таблица недоступна.'; } }).finally(() => { if (controller === active) controller = undefined; enabled(); });
        } else dialog.close();
      }
      enabled();
    },
    async openResult(source: { workbook: WorkbookRef; query: TableQuery }) {
      controller?.abort(); controller = undefined;
      ref = source.workbook;
      dialog.showModal();
      await task(async signal => { setInfo(await getWorkbookInfo(source.workbook, signal)); showResult(await queryTable(source.workbook, source.query, undefined, 0, signal)); });
    },
  };
}
