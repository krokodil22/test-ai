import { afterEach, expect, it, vi } from 'vitest';
import { translationParts } from '../../src/translation-text';
import { translatorBase } from '../../src/translation-config';
afterEach(() => vi.unstubAllEnvs());

it('preserves every sentence and paragraph separator instead of translating paragraphs as one sequence', () => {
  const source = 'The pig could not swim. Meryl helped it.\n\n"Do not worry," she said. "I will help you."\n\nThe pig learned to swim.';
  const parts = translationParts(source);
  expect(parts.map(part => part.prefix + part.text + part.suffix).join('')).toBe(source);
  expect(parts.filter(part => part.text)).toHaveLength(5);
  expect(parts.filter(part => !part.text).map(part => part.prefix)).toEqual(['\n\n', '\n\n']);
});
it('rejects empty and excessively long texts before model inference', () => {
  expect(() => translationParts('  ')).toThrow();
  expect(() => translationParts('x'.repeat(12001))).toThrow();
});
it('resolves translator resources under the repository path and supports an explicit CORS origin', () => {
  vi.stubEnv('BASE_URL', './');
  expect(translatorBase('https://example.test/test-ai/translate.html')).toBe('https://example.test/test-ai/translations/opus-mt-en-ru/');
  vi.stubEnv('VITE_TRANSLATOR_BASE_URL', 'https://storage.example.test/translation-v1');
  expect(translatorBase('https://example.test/')).toBe('https://storage.example.test/translation-v1/');
  vi.stubEnv('VITE_TRANSLATOR_BASE_URL', 'http://storage.example.test/translation-v1');
  expect(() => translatorBase('https://example.test/')).toThrow('HTTPS');
  vi.stubEnv('VITE_TRANSLATOR_BASE_URL', 'https://storage.example.test/data?secret=value');
  expect(() => translatorBase('https://example.test/')).toThrow('адрес');
});
