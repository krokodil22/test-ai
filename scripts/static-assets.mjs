import { cp, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';

// Local developers can retain old downloads. Only the active model is shipped
// to prevent 0.5B + 1.5B from exceeding the GitHub Pages site-size limit.
export async function copyPublicAssets(publicDirectory, outputDirectory, modelDirectory) {
  if (!/^[a-zA-Z0-9._-]+$/.test(modelDirectory)) throw new Error('Invalid model directory');
  try { await stat(publicDirectory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await cp(publicDirectory, outputDirectory, {
    recursive: true,
    filter(source) {
      const path = relative(publicDirectory, source).split(sep).join('/');
      return !path.startsWith('models/') || path === `models/${modelDirectory}` || path.startsWith(`models/${modelDirectory}/`);
    },
  });
}
