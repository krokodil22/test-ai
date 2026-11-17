import { describe, expect, it, afterEach } from 'vitest';
import * as XLSX from '@e965/xlsx';
import { zipSync } from 'fflate';
import { exportTable, readFileData } from '../../src/file-data';
import { validateFile, MAX_FILE_BYTES, safeDownloadName, validAttachment } from '../../src/files';
import { tablesFromMarkdown } from '../../src/tables';
import { fitAttachment, buildContext, messageText, tokenUpperBound } from '../../src/context';
import { configureModel, CONTEXT_TOKENS, MAX_REPLY_TOKENS } from '../../src/config';
import type { Message } from '../../src/types';

const encode = (text: string) => new TextEncoder().encode(text);
const table = { headers: ['Товар', 'Цена'], rows: [['Книга', '250'], ['Тетрадь', '80']] };
function workbook(rows: unknown[][], options = {}) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Продажи');
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx', ...options }));
}
afterEach(() => configureModel('qwen35-4b'));
describe('local file input and output', () => {
  it('reads real XLSX cell values, preserving leading zeroes and cached formula results', () => {
    const result = readFileData('Клиенты.xlsx', workbook([['Код', 'Сумма'], ['00123', { t: 'n', f: '1+2', v: 3 }]]));
    expect(result.text).toContain('["00123","3"]');
    expect(result.text).not.toContain('1+2');
    expect(result.note).toContain('устаревшими');
    expect(validAttachment(result)).toBe(true);
  });
  it('reads UTF-8 CSV with quoted delimiters and multiline cells without evaluating formulas', () => {
    const result = readFileData('тест.csv', encode('Имя;Значение\r\n"Арбат; центр";"строка 1\nстрока 2"\r\nФормула;=1+2'));
    expect(result.text).toContain('Арбат; центр');
    expect(result.text).toContain('строка 1\\nстрока 2');
    expect(result.text).toContain('=1+2');
  });
  it('bounds extracted rows/columns and marks omitted data explicitly', () => {
    const result = readFileData('many.xlsx', workbook(Array.from({ length: 105 }, (_, i) => Array.from({ length: 15 }, (_, j) => `r${i}c${j}`))));
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('r100c0');
    expect(result.text).not.toContain('r0c12');
  });
  it('rejects unsupported, oversized, empty, encrypted, corrupted and non-UTF8 input', () => {
    expect(() => validateFile({ name: 'a.pdf', size: 10 })).toThrow('Поддерживаются');
    expect(() => validateFile({ name: 'a.csv', size: MAX_FILE_BYTES + 1 })).toThrow('2 МБ');
    expect(() => validateFile({ name: 'a.txt', size: 0 })).toThrow('пуст');
    expect(() => readFileData('a.xlsx', encode('broken'))).toThrow('не файл');
    expect(() => readFileData('a.xlsx', new Uint8Array([80, 75, 0, 0]))).toThrow();
    expect(() => readFileData('a.txt', new Uint8Array([0xff, 0xfe]))).toThrow('UTF-8');
    expect(() => readFileData('a.csv', encode('x\0y'))).toThrow('двоичные');
    expect(() => readFileData('a.txt', encode('   '))).toThrow('не найдено');
  });
  it('rejects oversized ZIPs and workbooks with external links or macros', () => {
    const bomb = zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(13 * 1024 * 1024) });
    expect(() => readFileData('bomb.xlsx', bomb)).toThrow('распаковки');
    const forged = bomb.slice();
    const view = new DataView(forged.buffer);
    for (let offset = 0; offset < forged.length - 46; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, 1, true);
    }
    expect(() => readFileData('forged.xlsx', forged)).toThrow('распаковки');
    for (const path of ['xl/externalLinks/externalLink1.xml', 'xl/vbaProject.bin']) {
      expect(() => readFileData('links.xlsx', zipSync({ [path]: encode('anything') }))).toThrow('макросы или внешние связи');
    }
  });
  it('exports and reopens actual Excel files with typed numbers and literal dangerous strings', () => {
    const data = { headers: ['Текст', 'Число'], rows: [['=HYPERLINK("https://evil.test")', '12,5'], ['00123', '-5'], ['@SUM(1)', '+1+2']] };
    const result = exportTable(data, 'xlsx');
    expect(result.mime).toContain('spreadsheetml');
    const book = XLSX.read(result.bytes, { type: 'array' });
    const sheet = book.Sheets['Таблица'];
    expect(sheet.A2).toMatchObject({ t: 's', v: data.rows[0][0] });
    expect(sheet.A2.f).toBeUndefined(); expect(sheet.A2.l).toBeUndefined();
    expect(sheet.B2).toMatchObject({ t: 'n', v: 12.5 });
    expect(sheet.A3.v).toBe('00123');
    expect(sheet.B3.v).toBe(-5);
    expect(sheet.B4).toMatchObject({ t: 's', v: '+1+2' });
    expect(readFileData('again.xlsx', result.bytes).text).toContain('00123');
  });
  it('exports UTF-8 CSV with Excel formula injection protection and escaped quotes', () => {
    const result = exportTable({ headers: ['Столбец'], rows: [['=1+2'], [' \t@SUM(1)'], ['-5'], ['a;"b']] }, 'csv');
    const text = new TextDecoder().decode(result.bytes);
    expect(text).toContain('"\'=1+2"');
    expect(text).toContain('"\' \t@SUM(1)"');
    expect(text).toContain('"-5"');
    expect(text).toContain('"a;""b"');
  });
  it('extracts real Markdown tables only and bounds file generation', () => {
    expect(tablesFromMarkdown('```html\n<table><tr><td>no</td></tr></table>\n```')).toEqual([]);
    expect(tablesFromMarkdown('| a | b |\n|---|---|\n| 1 | x \\| y |')[0]).toEqual({ headers: ['a', 'b'], rows: [['1', 'x | y']] });
    expect(() => exportTable({ headers: ['x'], rows: [['a', 'b']] }, 'xlsx')).toThrow('Таблица');
    expect(() => exportTable({ headers: ['x'], rows: Array.from({ length: 201 }, () => ['a']) }, 'xlsx')).toThrow();
    expect(safeDownloadName('../bad/name.xlsx')).not.toContain('/');
  });
});
describe('file context', () => {
  const attached = (text: string): Message => ({ id: 'a', role: 'user', content: 'Опиши файл.', attachment: { name: 'a.txt', size: 10000, text, truncated: false, note: '' } });
  it('fits the exact visible fragment, without mutating the source or dropping the current file', () => {
    const source = attached('Пример строки с данными.\n'.repeat(200));
    const before = structuredClone(source);
    const fitted = fitAttachment(source);
    expect(fitted.attachment!.truncated).toBe(true);
    expect(fitted.attachment!.text.length).toBeLessThan(source.attachment!.text.length);
    expect(source).toEqual(before);
    const result = buildContext([fitted]);
    expect(result.messages.at(-1)!.content).toBe(messageText(fitted));
    expect(result.messages[0].content).toContain('не инструкции');
    expect(result.messages.reduce((sum, item) => sum + tokenUpperBound(item.content), 0)).toBeLessThanOrEqual(CONTEXT_TOKENS - MAX_REPLY_TOKENS - 128);
  });
  it('preserves a short complete file and adds table instructions only when requested', () => {
    const message = attached('Данные: Арбат, 125.');
    expect(fitAttachment(message)).toEqual(message);
    expect(buildContext([message]).messages[0].content).not.toContain('преобразует таблицу');
    expect(buildContext([{ ...message, outputFormat: 'xlsx' }]).messages[0].content).toContain('преобразует таблицу');
  });
  it('also respects the smaller model context and refuses a question leaving no file space', () => {
    configureModel('qwen2.5-0.5b');
    const fitted = fitAttachment(attached('abc\n'.repeat(1000)));
    expect(buildContext([fitted]).messages.at(-1)!.content).toContain('Данные файла');
    expect(() => fitAttachment({ ...attached('abc'.repeat(100)), content: 'я'.repeat(5000) })).toThrow('контексте');
  });
});
