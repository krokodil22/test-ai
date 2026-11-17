/// <reference lib="webworker" />
import { readFileData, exportTable } from './file-data';
import type { FileRequest, FileResult } from './files';
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async ({ data }: MessageEvent<FileRequest>) => {
  try {
    if (data.type === 'read') {
      const attachment = readFileData(data.file.name, new Uint8Array(await data.file.arrayBuffer()));
      scope.postMessage({ type: 'read', attachment } satisfies FileResult);
    } else if (data.type === 'export') {
      const result = exportTable(data.table, data.format);
      scope.postMessage({ type: 'export', ...result } satisfies FileResult, [result.bytes.buffer]);
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Не удалось обработать файл.' } satisfies FileResult);
  }
};
