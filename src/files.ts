/** Only extracted text is kept in chat history; original files stay with the user. */
export interface Attachment {
  name: string;
  size: number;
  text: string;
  truncated: boolean;
  note: string;
  workbook?: WorkbookRef;
  reportCore?: string;
}
export interface DataTable { headers: string[]; rows: string[][] }
export type CellValue = string | number | boolean | null;
export interface WorkbookRef { id: string; sheet: number; hasHeaders: boolean }
export interface SheetData { name: string; firstColumn: number; rowNumbers: number[]; cells: CellValue[][] }
export interface WorkbookData { schema: 1; id: string; name: string; size: number; sheets: SheetData[] }
export interface WorkbookInfo { ref: WorkbookRef; name: string; size: number; sheets: Array<{ name: string; rows: number; columns: number }>; headers: string[] }
export type TableOperation = 'overview' | 'stats' | 'rows' | 'search' | 'filter' | 'group';
export type FilterOperator = 'contains' | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'notEmpty';
export interface TableQuery { operation: TableOperation; column?: number; value?: string; operator?: FilterOperator; groupBy?: number; aggregate?: 'sum' | 'mean' | 'min' | 'max' | 'count'; condition?: { column: number; operator: FilterOperator; value: string } }
export interface TableResultRef { workbook: WorkbookRef; query: TableQuery; summary: string; totalRows: number; scannedRows: number }
export interface TableResult extends TableResultRef { info: WorkbookInfo; headers: string[]; rows: string[][]; page: number; pageCount: number; attachment: Attachment }
export type FileRequest = { type: 'read'; file: File }
  | { type: 'export'; table: DataTable; format: 'xlsx' | 'csv' }
  | { type: 'workbook-info'; ref: WorkbookRef }
  | { type: 'query'; ref: WorkbookRef; query?: TableQuery; question?: string; page?: number }
  | { type: 'export-query'; ref: WorkbookRef; query: TableQuery; format: 'xlsx' | 'csv' };
export type FileResult = { type: 'read'; attachment: Attachment; info?: WorkbookInfo }
  | { type: 'workbook-info'; info: WorkbookInfo }
  | { type: 'query'; result: TableResult }
  | { type: 'export'; bytes: Uint8Array; mime: string }
  | { type: 'error'; message: string };
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_TEXT = 12000;
export const FILE_ACCEPT = '.xlsx,.csv,.txt,.md,.json';
export const fileExtension = (name: string) => name.toLowerCase().split('.').at(-1) || '';
export function validateFile(file: Pick<File, 'name' | 'size'>): void {
  if (!['xlsx', 'csv', 'txt', 'md', 'json'].includes(fileExtension(file.name))) throw new Error('Поддерживаются .xlsx, .csv, .txt, .md и .json. PDF, изображения и старый .xls пока не поддерживаются.');
  if (!file.size) throw new Error('Файл пуст. Выберите файл с данными.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Файл больше 2 МБ. Сохраните нужный лист или небольшой фрагмент отдельно.');
}
export function validAttachment(value: unknown): value is Attachment {
  const a = value as Attachment;
  return !!a && typeof a.name === 'string' && a.name.length <= 180 && Number.isSafeInteger(a.size) && a.size > 0 && a.size <= MAX_FILE_BYTES && typeof a.text === 'string' && a.text.length > 0 && a.text.length <= MAX_FILE_TEXT && typeof a.truncated === 'boolean' && typeof a.note === 'string' && a.note.length <= 300 && (a.workbook === undefined || validWorkbookRef(a.workbook)) && (a.reportCore === undefined || (typeof a.reportCore === 'string' && a.reportCore.length <= MAX_FILE_TEXT));
}
export function validWorkbookRef(value: unknown): value is WorkbookRef {
  const ref = value as WorkbookRef;
  return !!ref && typeof ref.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(ref.id) && Number.isInteger(ref.sheet) && ref.sheet >= 0 && ref.sheet < 64 && typeof ref.hasHeaders === 'boolean';
}
export function validateTable(table: DataTable): void {
  if (!table || !Array.isArray(table.headers) || !table.headers.length || table.headers.length > 20 || !Array.isArray(table.rows) || table.rows.length > 200 || !table.rows.length || table.rows.some(row => !Array.isArray(row) || row.length !== table.headers.length)) throw new Error('Таблица должна содержать заголовки и от 1 до 200 строк, не более 20 столбцов.');
  const cells = [...table.headers, ...table.rows.flat()];
  if (cells.some(cell => typeof cell !== 'string' || cell.length > 2000) || cells.join('').length > 40000) throw new Error('Таблица слишком велика для экспорта.');
}
export function safeDownloadName(name: string): string {
  return name.replace(/\.[^.]*$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'Таблица';
}
