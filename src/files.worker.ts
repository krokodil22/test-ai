/// <reference lib="webworker" />
import { readFileData, readWorkbook, exportTable, writeTable } from './file-data';
import { fileExtension } from './files';
import { saveWorkbook, loadWorkbook, workbookEpoch } from './workbook-store';
import { workbookInfo, queryWorkbook, queryForQuestion, executeQuery } from './workbook-query';
import type { FileRequest, FileResult } from './files';
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async ({ data }: MessageEvent<FileRequest>) => {
  try {
    if (data.type === 'read') {
      if (['xlsx', 'csv'].includes(fileExtension(data.file.name))) {
        const epoch = await workbookEpoch();
        const book = readWorkbook(data.file.name, new Uint8Array(await data.file.arrayBuffer()));
        const ref = { id: book.id, sheet: book.sheets.findIndex(sheet => sheet.cells.length > 0), hasHeaders: true };
        const result = queryWorkbook(book, ref, { operation: 'overview' });
        await saveWorkbook(book, epoch);
        scope.postMessage({ type: 'read', attachment: result.attachment, info: result.info } satisfies FileResult);
        return;
      }
      const attachment = readFileData(data.file.name, new Uint8Array(await data.file.arrayBuffer()));
      scope.postMessage({ type: 'read', attachment } satisfies FileResult);
    } else if (data.type === 'export') {
      const result = exportTable(data.table, data.format);
      scope.postMessage({ type: 'export', ...result } satisfies FileResult, [result.bytes.buffer]);
    } else if (data.type === 'workbook-info') {
      scope.postMessage({ type: 'workbook-info', info: workbookInfo(await loadWorkbook(data.ref.id), data.ref) } satisfies FileResult);
    } else if (data.type === 'query') {
      const book = await loadWorkbook(data.ref.id);
      const query = data.query || queryForQuestion(book, data.ref, data.question || '');
      scope.postMessage({ type: 'query', result: queryWorkbook(book, data.ref, query, data.page) } satisfies FileResult);
    } else if (data.type === 'export-query') {
      const book = await loadWorkbook(data.ref.id);
      const result = writeTable(executeQuery(book, data.ref, data.query).table, data.format);
      scope.postMessage({ type: 'export', ...result } satisfies FileResult, [result.bytes.buffer]);
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Не удалось обработать файл.' } satisfies FileResult);
  }
};
