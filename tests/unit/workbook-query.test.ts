import { describe, it, expect } from 'vitest';
import * as XLSX from '@e965/xlsx';
import { readWorkbook, writeTable } from '../../src/file-data';
import { executeQuery, queryWorkbook, queryForQuestion, numericCell, workbookInfo } from '../../src/workbook-query';
import { buildContext, fitAttachment } from '../../src/context';
import type { WorkbookData, WorkbookRef } from '../../src/files';

const book: WorkbookData = { schema: 1, id: 'test-id', name: 'Все данные.xlsx', size: 5000, sheets: [{ name: 'Продажи', firstColumn: 0, rowNumbers: Array.from({ length: 1001 }, (_, i) => i + 1), cells: [
  ['Город', 'Продажи', 'Код'], ...Array.from({ length: 1000 }, (_, i) => [i === 999 ? 'Последний' : i % 2 ? 'Москва' : 'Казань', i + 1, '00123']),
] }] };
const ref: WorkbookRef = { id: book.id, sheet: 0, hasHeaders: true };
describe('whole workbook operations', () => {
  it('calculates accurate statistics over every row, including row 1001', () => {
    const result = executeQuery(book, ref, { operation: 'stats', column: 1 });
    expect(result.scannedRows).toBe(1000);
    expect(result.table.rows[0]).toEqual(['B · Продажи', '1000', '1000', '500500', '500.5', '1', '1000']);
    expect(result.core).toContain('сумма=500500');
    expect(result.core).not.toContain('фрагмент');
  });
  it('searches late rows and returns all matches using explicit pagination', () => {
    const found = queryWorkbook(book, ref, { operation: 'search', value: 'Последний' });
    expect(found.totalRows).toBe(1); expect(found.rows[0][1]).toBe('1000');
    const many = queryWorkbook(book, ref, { operation: 'search', value: 'Москва' }, 24);
    expect(many.scannedRows).toBe(1000); expect(many.totalRows).toBe(499); expect(many.pageCount).toBe(25);
    expect(many.rows).toHaveLength(19); expect(many.rows.at(-1)![1]).toBe('998');
  });
  it('filters every row and exports all matching rows instead of just the current page', () => {
    const query = { operation: 'filter' as const, column: 1, operator: 'gte' as const, value: '150' };
    const result = executeQuery(book, ref, query);
    expect(result.table.rows).toHaveLength(851);
    const exported = writeTable(result.table, 'xlsx');
    const reread = readWorkbook('again.xlsx', exported.bytes);
    expect(reread.sheets[0].cells).toHaveLength(852);
    expect(reread.sheets[0].cells.at(-1)![1]).toBe(1000);
  });
  it('supports conditions on one column and statistics/grouping on another', () => {
    const condition = { column: 0, operator: 'eq' as const, value: 'Казань' };
    const stats = executeQuery(book, ref, { operation: 'stats', column: 1, condition });
    expect(stats.scannedRows).toBe(1000);
    expect(stats.table.rows[0][3]).toBe('250000');
    expect(stats.core).toContain('Отобрано 500');
    const groups = executeQuery(book, ref, { operation: 'group', groupBy: 0, column: 1, aggregate: 'sum' });
    expect(groups.table.rows).toContainEqual(['Последний', '1000', '1', '1']);
    expect(groups.table.rows).toContainEqual(['Казань', '250000', '500', '500']);
  });
  it('handles numeric text, blanks, precision, dates and headerless first rows explicitly', () => {
    expect(numericCell('1\u00a0234,50')).toBe(1234.5);
    expect(numericCell('00123')).toBeUndefined(); expect(numericCell('=1+2')).toBeUndefined(); expect(numericCell('12 руб')).toBeUndefined();
    const data: WorkbookData = { ...book, sheets: [{ name: 'Без шапки', firstColumn: 0, rowNumbers: [1, 2, 3, 4, 5], cells: [[0.1], [0.2], [null], ['нет'], ['00123']] }] };
    expect(executeQuery(data, { ...ref, hasHeaders: false }, { operation: 'stats', column: 0 }).table.rows[0]).toEqual(['A · Столбец', '4', '2', '0.3', '0.15', '0.1', '0.2']);
  });
  it('loads every sheet and all wide columns, retains empty rows and ignores formatted-only ranges', () => {
    const workbook = XLSX.utils.book_new();
    for (let sheet = 0; sheet < 4; sheet++) {
      const data = [Array.from({ length: 25 }, (_, i) => 'Столбец ' + i), ...Array.from({ length: 150 }, (_, i) => Array.from({ length: 25 }, (_, c) => i === 149 && c === 24 ? 99999 : 1))];
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(data), 'Лист ' + sheet);
    }
    const result = readWorkbook('wide.xlsx', new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true })));
    expect(result.sheets).toHaveLength(4);
    expect(result.sheets[3].cells[150][24]).toBe(99999);
    const stats = executeQuery(result, { id: result.id, sheet: 3, hasHeaders: true }, { operation: 'stats', column: 24 });
    expect(stats.table.rows[0][3]).toBe('100148');
    expect(workbookInfo(result, { id: result.id, sheet: 3, hasHeaders: true }).headers).toHaveLength(25);
  });
  it('builds bounded model reports without replacing all-row statistics with a raw prefix', () => {
    const report = queryWorkbook(book, ref, { operation: 'stats', column: 1 }).attachment;
    const fitted = fitAttachment({ id: 'u', role: 'user', content: 'Какая сумма Продажи?', attachment: { ...report, text: report.text + '\nДополнение.'.repeat(1000) } });
    expect(fitted.attachment!.truncated).toBe(false);
    expect(fitted.attachment!.text).toContain('500500');
    expect(buildContext([fitted]).messages.at(-1)!.content).toContain('full-table-report');
  });
  it('understands simple explicit questions and refuses to guess conditional or ambiguous sums', () => {
    expect(queryForQuestion(book, ref, 'Найди сумму Продажи')).toEqual({ operation: 'stats', column: 1 });
    expect(queryForQuestion(book, ref, 'Найди "Последний"')).toEqual({ operation: 'search', value: 'Последний' });
    expect(() => queryForQuestion(book, ref, 'Сумма Продажи только в Москве')).toThrow('условию');
    expect(() => executeQuery(book, ref, { operation: 'stats', column: 100 })).toThrow('столбец');
    expect(() => executeQuery(book, ref, { operation: 'filter', column: 1, operator: 'gte', value: 'не число' })).toThrow('число');
  });
});
