import { lexer } from 'marked';
import type { Tokens } from 'marked';
import type { DataTable } from './files';
import { validateTable } from './files';

export function tablesFromMarkdown(text: string): DataTable[] {
  const tables: DataTable[] = [];
  for (const token of lexer(text)) {
    if (token.type !== 'table') continue;
    const source = token as Tokens.Table;
    const literal = (value: string) => value.replace(/\\\|/g, '|');
    const table = { headers: source.header.map(cell => literal(cell.text)), rows: source.rows.map(row => row.map(cell => literal(cell.text))) };
    try { validateTable(table); tables.push(table); } catch { /* Oversized/empty tables have no file download. */ }
    if (tables.length === 5) break;
  }
  return tables;
}
