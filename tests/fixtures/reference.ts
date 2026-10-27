import profile from '../../src/diagnostic-cases.json' with { type: 'json' };
export const referenceFixture = {
  schema: 1, kind: 'cpu-reference', protocol: profile.protocol, complete: true, model: 'Qwen/Qwen3-1.7B', revision: '70d244cc86ccca08cf5af4e1e306ecf908b1ad5e', engine: 'TEST reference (not inference)', dtype: 'float32', quantization: 'none', generatedAt: '2026-10-27T00:00:00Z', systemPrompt: profile.systemPrompt, settings: profile.settings,
  results: profile.cases.map(item => ({ caseId: item.id, prompt: item.prompt, maxTokens: item.maxTokens, text: 'TEST CPU REFERENCE: ' + item.id, finish: 'complete', seconds: 1, generatedTokens: 5 })),
};
