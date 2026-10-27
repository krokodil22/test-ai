import { cp, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';

// Local developers can retain old downloads. Only the active model is shipped
// to prevent multiple model versions from exceeding the static host limit.
export async function copyPublicAssets(publicDirectory, outputDirectory, modelDirectory, archive = false) {
  if (!/^[a-zA-Z0-9._-]+$/.test(modelDirectory)) throw new Error('Invalid model directory');
  try { await stat(publicDirectory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await cp(publicDirectory, outputDirectory, {
    recursive: true,
    filter(source) {
      const path = relative(publicDirectory, source).split(sep).join('/');
      if (archive && path.startsWith(`models/${modelDirectory}/`)) return ['model-info.json', 'LICENSE'].includes(path.slice(`models/${modelDirectory}/`.length));
      return !path.startsWith('models/') || path === `models/${modelDirectory}` || path.startsWith(`models/${modelDirectory}/`);
    },
  });
}
