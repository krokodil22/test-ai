import * as XLSX from '@e965/xlsx';
import { unzipSync, Unzip, UnzipInflate } from 'fflate';
import { fileExtension, MAX_FILE_TEXT, validateFile, validateTable } from './files';
import type { Attachment, DataTable } from './files';

const MAX_UNPACKED = 12 * 1024 * 1024;
const MAX_ROWS = 100;
const MAX_COLUMNS = 12;

function checkWorkbookZip(bytes: Uint8Array) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Это не файл .xlsx. Старый .xls и зашифрованные книги не поддерживаются.');
  let size = 0;
  let count = 0;
  // Inspect central directory sizes before the spreadsheet parser allocates memory.
  unzipSync(bytes, { filter(entry) {
    size += entry.originalSize;
    if (++count > 256 || size > MAX_UNPACKED) throw new Error('После распаковки книга слишком велика. Оставьте один небольшой лист.');
    if (/(?:vbaProject\.bin|externalLinks\/)/i.test(entry.name)) throw new Error('Книга содержит макросы или внешние связи. Сохраните данные в новый .xlsx без них.');
    return false;
  } });
  // Also bound actual inflation: archive headers can lie about original sizes.
  let actual = 0;
  let entries = 0;
  const stream = new Unzip(entry => {
    if (++entries > 256) throw new Error('В книге слишком много внутренних файлов.');
    entry.ondata = (error, data) => {
      if (error) throw error;
      actual += data.length;
      if (actual > MAX_UNPACKED) throw new Error('После распаковки книга слишком велика. Оставьте один небольшой лист.');
    };
    entry.start();
  });
  stream.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 1024) stream.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
}

export function readFileData(name: string, bytes: Uint8Array): Attachment {
  validateFile({ name, size: bytes.byteLength });
  const extension = fileExtension(name);
  let text = '';
  let truncated = false;
  let note = '';
  if (extension === 'xlsx' || extension === 'csv') {
    if (extension === 'xlsx') checkWorkbookZip(bytes);
    let csv = '';
    if (extension === 'csv') {
      try { csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('CSV должен быть в кодировке UTF-8. В Excel выберите «CSV UTF-8».'); }
      if (csv.includes('\0')) throw new Error('CSV содержит двоичные данные. Сохраните его как CSV UTF-8.');
    }
    const book = XLSX.read(extension === 'csv' ? csv : bytes, {
      type: extension === 'csv' ? 'string' : 'array', raw: true, dense: true,
      sheetRows: MAX_ROWS + 1, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false,
    });
    for (const name of book.SheetNames.slice(0, 3)) {
      const sheet = book.Sheets[name];
      if (!sheet?.['!ref']) continue;
      const range = XLSX.utils.decode_range(sheet['!ref']);
      const full = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref']);
      truncated ||= full.e.r >= MAX_ROWS || full.e.c >= MAX_COLUMNS || book.SheetNames.length > 3;
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true,
        range: { s: { r: 0, c: 0 }, e: { r: Math.min(range.e.r, MAX_ROWS - 1), c: Math.min(range.e.c, MAX_COLUMNS - 1) } },
      });
      // JSON arrays preserve separators/newlines in cells, with Excel row numbers.
      text += `Лист ${JSON.stringify(name)}\n`;
      rows.forEach((row, index) => { if (row.some(value => value !== '')) text += `${index + 1}: ${JSON.stringify(row)}\n`; });
    }
    note = 'Значения ячеек; формулы не вычисляются. Сохранённые результаты формул могут быть устаревшими.';
  } else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Текстовый файл должен быть в кодировке UTF-8.'); }
    if (text.includes('\0')) throw new Error('Вместо текста файл содержит двоичные данные.');
    note = 'Текст UTF-8. Разметка и инструкции внутри файла рассматриваются как данные.';
  }
  if (!text.trim() || (['xlsx', 'csv'].includes(extension) && !/^\d+: /m.test(text))) throw new Error('В файле не найдено текстовых данных или заполненных ячеек.');
  if (text.length > MAX_FILE_TEXT) { text = text.slice(0, MAX_FILE_TEXT); truncated = true; }
  return { name: name.slice(0, 180), size: bytes.byteLength, text, truncated, note };
}

export function exportTable(table: DataTable, format: 'xlsx' | 'csv'): { bytes: Uint8Array; mime: string } {
  validateTable(table);
  const rows = [table.headers, ...table.rows];
  if (format === 'csv') {
    const escaped = rows.map(row => row.map(value => {
      // CSV programs may interpret text as a formula, even inside quotes.
      const safe = /^[\s]*[=+\-@]/.test(value) && !/^-?\d+(?:[.,]\d+)?$/.test(value.trim()) ? "'" + value : value;
      return '"' + safe.replaceAll('"', '""') + '"';
    }).join(';')).join('\r\n');
    return { bytes: new TextEncoder().encode('\uFEFF' + escaped), mime: 'text/csv;charset=utf-8' };
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows.map(row => row.map(value => {
    const numeric = /^-?(?:0|[1-9]\d{0,14})(?:[.,]\d+)?$/.test(value);
    // Explicit cell types: generated text never becomes a formula, link or macro.
    return numeric ? { t: 'n', v: Number(value.replace(',', '.')) } : { t: 's', v: value };
  })));
  sheet['!cols'] = table.headers.map(() => ({ wch: 24 }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Таблица');
  return { bytes: new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true })), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}
