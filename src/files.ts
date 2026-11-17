/** Only extracted text is kept in chat history; original files stay with the user. */
export interface Attachment {
  name: string;
  size: number;
  text: string;
  truncated: boolean;
  note: string;
}
export interface DataTable { headers: string[]; rows: string[][] }
export type FileRequest = { type: 'read'; file: File } | { type: 'export'; table: DataTable; format: 'xlsx' | 'csv' };
export type FileResult = { type: 'read'; attachment: Attachment } | { type: 'export'; bytes: Uint8Array; mime: string } | { type: 'error'; message: string };
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
  return !!a && typeof a.name === 'string' && a.name.length <= 180 && Number.isSafeInteger(a.size) && a.size > 0 && a.size <= MAX_FILE_BYTES && typeof a.text === 'string' && a.text.length > 0 && a.text.length <= MAX_FILE_TEXT && typeof a.truncated === 'boolean' && typeof a.note === 'string' && a.note.length <= 300;
}
export function validateTable(table: DataTable): void {
  if (!table || !Array.isArray(table.headers) || !table.headers.length || table.headers.length > 20 || !Array.isArray(table.rows) || table.rows.length > 200 || !table.rows.length || table.rows.some(row => !Array.isArray(row) || row.length !== table.headers.length)) throw new Error('Таблица должна содержать заголовки и от 1 до 200 строк, не более 20 столбцов.');
  const cells = [...table.headers, ...table.rows.flat()];
  if (cells.some(cell => typeof cell !== 'string' || cell.length > 2000) || cells.join('').length > 40000) throw new Error('Таблица слишком велика для экспорта.');
}
export function safeDownloadName(name: string): string {
  return name.replace(/\.[^.]*$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80) || 'Таблица';
}
