import type { CellValue, WorkbookData, WorkbookRef, WorkbookInfo, TableQuery, TableResult, DataTable } from './files';
import { validWorkbookRef } from './files';

export const displayCell = (cell: CellValue) => cell === null ? '' : String(cell);
export function columnLetter(index: number): string { let result = ''; for (index++; index > 0; index = Math.floor((index - 1) / 26)) result = String.fromCharCode(65 + (index - 1) % 26) + result; return result; }
export function numericCell(value: CellValue): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/[ \u00a0\u202f]/g, '');
  // Keep identifiers such as 00123 as text. No formula evaluation or parseFloat prefixes.
  if (/^[+-]?0\d/.test(text) || !/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i.test(text)) return undefined;
  const result = Number(text.replace(',', '.')); return Number.isFinite(result) ? result : undefined;
}
const numberText = (value: number) => Number.isFinite(value) ? String(Number(value.toPrecision(15))) : 'Переполнение';
export function workbookInfo(book: WorkbookData, ref: WorkbookRef): WorkbookInfo {
  if (!validWorkbookRef(ref) || book.id !== ref.id || !book.sheets[ref.sheet]) throw new Error('Выбранный лист недоступен. Выберите лист таблицы заново.');
  const sheet = book.sheets[ref.sheet];
  const width = sheet.cells[0]?.length || 0;
  return { ref, name: book.name, size: book.size,
    sheets: book.sheets.map(s => ({ name: s.name, rows: Math.max(0, s.cells.length - (ref.hasHeaders && s.cells.length ? 1 : 0)), columns: s.cells[0]?.length || 0 })),
    headers: Array.from({ length: width }, (_, index) => `${columnLetter(index + sheet.firstColumn)} · ${ref.hasHeaders ? displayCell(sheet.cells[0][index]).slice(0, 100) || 'Без названия' : 'Столбец'}`),
  };
}
function column(query: TableQuery, key: 'column' | 'groupBy', width: number): number {
  const index = query[key];
  if (!Number.isInteger(index) || index! < 0 || index! >= width) throw new Error('Выберите столбец для операции с таблицей.');
  return index!;
}
interface Stats { filled: number; count: number; sum: number; mean: number; min: number; max: number }
function statistics(rows: CellValue[][], index: number): Stats {
  let filled = 0, count = 0, sum = 0, compensation = 0, min = Infinity, max = -Infinity;
  for (const row of rows) {
    if (row[index] !== null && row[index] !== '') filled++;
    const number = numericCell(row[index]); if (number === undefined) continue;
    const corrected = number - compensation, next = sum + corrected;
    compensation = next - sum - corrected; sum = next;
    count++; min = Math.min(min, number); max = Math.max(max, number);
  }
  return { filled, count, sum, mean: count ? sum / count : 0, min, max };
}
const statisticsRow = (label: string, value: Stats): string[] => [label, String(value.filled), String(value.count), String(value.sum === 0 ? 0 : numberText(value.sum)), value.count ? numberText(value.mean) : '', value.count ? numberText(value.min) : '', value.count ? numberText(value.max) : ''];

function filterRows(rows: CellValue[][], width: number, condition: { column: number; operator: string; value: string }): CellValue[][] {
  const index = column({ operation: 'filter', column: condition.column }, 'column', width), op = condition.operator;
  if (!['contains', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'].includes(op)) throw new Error('Неизвестное условие фильтра.');
  const value = condition.value.trim().toLocaleLowerCase('ru-RU'), number = numericCell(condition.value);
  if (['gt', 'gte', 'lt', 'lte'].includes(op) && number === undefined) throw new Error('Для числового сравнения введите число.');
  return rows.filter(row => {
    const cell = row[index], text = displayCell(cell).trim().toLocaleLowerCase('ru-RU'), n = numericCell(cell);
    if (op === 'empty') return cell === null || cell === '';
    if (op === 'notEmpty') return cell !== null && cell !== '';
    if (op === 'contains') return text.includes(value);
    if (op === 'eq' || op === 'ne') { const equal = number !== undefined && n !== undefined ? n === number : text === value; return op === 'eq' ? equal : !equal; }
    return n !== undefined && (op === 'gt' ? n > number! : op === 'gte' ? n >= number! : op === 'lt' ? n < number! : n <= number!);
  });
}

export function queryForQuestion(book: WorkbookData, ref: WorkbookRef, question: string): TableQuery {
  const info = workbookInfo(book, ref), text = question.toLocaleLowerCase('ru-RU');
  const names = book.sheets[ref.sheet].cells[0] || [];
  const matched = ref.hasHeaders ? names.map((cell, i) => ({ name: displayCell(cell).toLocaleLowerCase('ru-RU').trim(), i })).filter(item => item.name.length > 1 && text.includes(item.name)).map(item => item.i) : [];
  if (/(?:найди|найти|поиск|find|search)/i.test(text) && !/(?:сумм|средн|миним|максим)/i.test(text)) {
    const quoted = question.match(/[«"“]([^»"”]+)[»"”]/)?.[1];
    if (quoted) return { operation: 'search', value: quoted };
    throw new Error('Для поиска укажите текст в кавычках: например, «Найди \"Арбат\"». Или откройте «Операции с таблицей».');
  }
  if (/(?:сумм|средн|миним|максим|\bsum\b|\baverage\b)/i.test(text)) {
    if (/(?:если|больше|меньше|кроме|только|(?:^|\s)(?:за|где)(?:\s|$)|\bif\b|\bwhere\b)/i.test(text)) throw new Error('Для расчёта с условием откройте «Операции с таблицей» и включите «Считать только строки по условию».');
    if (matched.length === 1) return { operation: 'stats', column: matched[0] };
    const rows = book.sheets[ref.sheet].cells.slice(ref.hasHeaders ? 1 : 0);
    const numeric = info.headers.map((_, i) => i).filter(i => rows.some(row => numericCell(row[i]) !== undefined));
    if (matched.length === 0 && numeric.length === 1) return { operation: 'stats', column: numeric[0] };
    throw new Error('Укажите название одного числового столбца или выберите его в «Операции с таблицей».');
  }
  return { operation: 'overview', ...(matched.length ? { column: matched[0] } : {}) };
}

export function executeQuery(book: WorkbookData, ref: WorkbookRef, query: TableQuery): { info: WorkbookInfo; table: DataTable; summary: string; core: string; scannedRows: number } {
  const info = workbookInfo(book, ref), sheet = book.sheets[ref.sheet];
  const allRows = sheet.cells.slice(ref.hasHeaders ? 1 : 0), width = info.headers.length;
  const rows = query.condition ? filterRows(allRows, width, query.condition) : allRows;
  if (!['overview', 'stats', 'rows', 'search', 'filter', 'group'].includes(query.operation)) throw new Error('Неизвестная операция с таблицей.');
  let table: DataTable;
  const scope = `Лист ${JSON.stringify(sheet.name)}: все ${allRows.length} строк, ${width} столбцов.` + (query.condition ? ` Условие: ${info.headers[query.condition.column]} ${query.condition.operator} ${JSON.stringify(query.condition.value)}. Отобрано ${rows.length} строк; расчёт ниже по ним.` : '');
  let core = scope, summary = scope;
  if (query.operation === 'overview' || query.operation === 'stats') {
    const indices = query.operation === 'stats' ? [column(query, 'column', width)] : info.headers.map((_, i) => i);
    const stats = indices.map(i => ({ i, value: statistics(rows, i) }));
    table = { headers: ['Столбец', 'Заполнено', 'Чисел', 'Сумма', 'Среднее', 'Минимум', 'Максимум'], rows: stats.map(({ i, value }) => statisticsRow(info.headers[i], value)) };
    const focused = query.column !== undefined ? stats.filter(s => s.i === query.column) : stats.filter(s => s.value.count).slice(0, 2);
    core += '\n' + focused.map(({ i, value }) => `${info.headers[i]}: чисел=${value.count}; сумма=${numberText(value.sum)}; среднее=${value.count ? numberText(value.mean) : 'нет'}; min=${value.count ? numberText(value.min) : 'нет'}; max=${value.count ? numberText(value.max) : 'нет'}.`).join('\n');
    summary += query.operation === 'stats' ? ` Расчёт по столбцу «${info.headers[query.column!]}».` : ' Статистика рассчитана для каждого столбца.';
  } else if (query.operation === 'group') {
    const keyIndex = column(query, 'groupBy', width), aggregate = query.aggregate || 'count';
    if (!['count', 'sum', 'mean', 'min', 'max'].includes(aggregate)) throw new Error('Неизвестный вид группировки.');
    const valueIndex = aggregate === 'count' ? 0 : column(query, 'column', width);
    const groups = new Map<string, { count: number; numeric: number; sum: number; compensation: number; min: number; max: number }>();
    for (const row of rows) {
      const key = displayCell(row[keyIndex]);
      const group = groups.get(key) || { count: 0, numeric: 0, sum: 0, compensation: 0, min: Infinity, max: -Infinity };
      group.count++;
      const number = numericCell(row[valueIndex]);
      if (number !== undefined) { const n = number - group.compensation, next = group.sum + n; group.compensation = next - group.sum - n; group.sum = next; group.numeric++; group.min = Math.min(group.min, number); group.max = Math.max(group.max, number); }
      groups.set(key, group);
    }
    const labels = { count: 'Количество строк', sum: 'Сумма', mean: 'Среднее', min: 'Минимум', max: 'Максимум' };
    table = { headers: [info.headers[keyIndex], labels[aggregate], 'Строк в группе', 'Числовых значений'], rows: [...groups].map(([key, g]) => [key, aggregate === 'count' ? String(g.count) : g.numeric ? numberText(aggregate === 'sum' ? g.sum : aggregate === 'mean' ? g.sum / g.numeric : aggregate === 'min' ? g.min : g.max) : '', String(g.count), aggregate === 'count' ? '' : String(g.numeric)]) };
    summary += ` Группировка по «${info.headers[keyIndex]}»: ${groups.size} групп, ${labels[aggregate].toLowerCase()}${aggregate === 'count' ? '' : ` столбца «${info.headers[valueIndex]}»`}.`;
    core = summary;
  } else {
    let selected = rows;
    if (query.operation === 'search') {
      const value = (query.value || '').trim().toLocaleLowerCase('ru-RU');
      if (!value) throw new Error('Введите текст для поиска по всей таблице.');
      selected = rows.filter(row => row.some(cell => displayCell(cell).toLocaleLowerCase('ru-RU').includes(value)));
      summary += ` Поиск ${JSON.stringify(query.value)} по всем ячейкам.`;
    }
    if (query.operation === 'filter') {
      selected = filterRows(rows, width, { column: column(query, 'column', width), operator: query.operator || 'contains', value: query.value || '' });
      summary += ` Фильтр: ${info.headers[query.column!]} ${query.operator || 'contains'} ${JSON.stringify(query.value || '')}.`;
    }
    table = { headers: ref.hasHeaders ? (sheet.cells[0] || []).map(displayCell) : info.headers.map((_, i) => columnLetter(i + sheet.firstColumn)), rows: selected.map(row => row.map(displayCell)) };
    summary += ` ${query.operation === 'rows' ? 'Просмотр' : 'Найдено'}: ${selected.length} строк.`;
    core = summary;
  }
  return { info, table, summary, core, scannedRows: allRows.length };
}
export function queryWorkbook(book: WorkbookData, ref: WorkbookRef, query: TableQuery, requestedPage = 0): TableResult {
  const { info, table, summary, core, scannedRows } = executeQuery(book, ref, query);
  const pageCount = Math.max(1, Math.ceil(table.rows.length / 20));
  const page = Math.max(0, Math.min(pageCount - 1, Number.isInteger(requestedPage) ? requestedPage : 0));
  const sampleRows = query.operation === 'overview' && !query.condition ? book.sheets[ref.sheet].cells.slice(ref.hasHeaders ? 1 : 0, (ref.hasHeaders ? 1 : 0) + 2).map(row => row.map(displayCell)) : table.rows.slice(0, 3);
  const sample = sampleRows.map(row => JSON.stringify(row));
  // Samples are explicitly labelled; the operation itself always scans all rows.
  let text = core + (sample.length ? '\nПервые строки результата (образец):\n' + sample.join('\n') : '');
  if (text.length > 6000) text = core;
  return { info, workbook: ref, query, summary, scannedRows, totalRows: table.rows.length, headers: table.headers,
    rows: table.rows.slice(page * 20, (page + 1) * 20), page, pageCount,
    attachment: { name: book.name, size: book.size, text, reportCore: core, truncated: false, workbook: ref,
      note: 'Таблица прочитана целиком. Локальный расчёт учитывает все строки выбранного листа. Формулы не вычисляются; сохранённые результаты могут быть устаревшими.' },
  };
}
