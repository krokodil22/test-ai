import source from './model-source.json' with { type: 'json' };
export const releaseTag = `model-${source.directory}-${source.revision.slice(0, 12)}`;
export const archiveName = `${source.directory}.tar`;
export function releaseUrl(repository) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw Error('Invalid GitHub repository');
  return `https://github.com/${repository}/releases/download/${releaseTag}/${archiveName}`;
}
