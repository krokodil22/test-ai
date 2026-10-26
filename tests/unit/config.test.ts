import { describe, it, expect, vi } from 'vitest';
import { resourceBase, validateModelInfo } from '../../src/config';
import { explainError } from '../../src/errors';
describe('resource configuration', () => {
  it('resolves a repository prefix and a separate HTTPS storage', () => {
    vi.stubEnv('BASE_URL', '/test-ai/');
    vi.stubEnv('VITE_MODEL_BASE_URL', 'models/qwen/');
    expect(resourceBase('https://owner.github.io/test-ai/')).toBe('https://owner.github.io/test-ai/models/qwen/');
    vi.stubEnv('VITE_MODEL_BASE_URL', 'https://storage.example/models/qwen');
    expect(resourceBase('https://owner.github.io/test-ai/')).toBe('https://storage.example/models/qwen/');
    vi.unstubAllEnvs();
  });
  it('rejects insecure production resources and credentials', () => {
    vi.stubEnv('VITE_MODEL_BASE_URL', 'http://storage.example/qwen/');
    expect(() => resourceBase('https://site.example/')).toThrow('HTTPS');
    vi.stubEnv('VITE_MODEL_BASE_URL', 'https://user:password@storage.example/qwen/');
    expect(() => resourceBase('https://site.example/')).toThrow('пароль');
    vi.unstubAllEnvs();
  });
  it('rejects missing or malformed model manifests', () => {
    expect(() => validateModelInfo({})).toThrow('model-info');
  });
  it('distinguishes actionable errors', () => {
    expect(explainError(new Error('out of memory'))).toContain('Не хватает');
    expect(explainError(new Error('device lost'))).toContain('GPU потеряно');
    expect(explainError(new Error('Failed to fetch'))).toContain('CORS');
  });
});
