import profile from '../../src/diagnostic-cases.json' with { type: 'json' };
import source from '../../scripts/reference-source.json' with { type: 'json' };
export const referenceFixture = {
  schema: 1, kind: 'cpu-reference', protocol: profile.protocol, complete: true, model: source.repository, revision: source.revision, engine: source.engine, dtype: source.dtype, quantization: 'none', generatedAt: '2026-10-27T00:00:00Z', systemPrompt: profile.systemPrompt, settings: profile.settings,
  results: profile.cases.map(item => ({ caseId: item.id, prompt: item.prompt, maxTokens: item.maxTokens, text: 'TEST CPU REFERENCE: ' + item.id, finish: 'complete', seconds: 1, generatedTokens: 5 })),
};
