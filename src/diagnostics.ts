import profile from './diagnostic-cases.json';
import { ComparisonInputError, ComparisonStopped } from './comparison';
import type { StageRunner, StageResult } from './comparison';
export const DIAGNOSTIC_PROFILE = profile;
export interface DiagnosticResult extends Omit<StageResult, 'stage'> { caseId: string; prompt: string; maxTokens: number }
export async function runDiagnostics(run: StageRunner, update: (event: { phase: 'start'; caseId: string } | { phase: 'complete'; result: DiagnosticResult }) => void, stopped: () => boolean) {
  const results: DiagnosticResult[] = [];
  for (const item of profile.cases) {
    if (stopped()) throw new ComparisonStopped();
    update({ phase: 'start', caseId: item.id });
    const result = await run({ stage: 'direct', sourceText: item.prompt, messages: [{ role: 'system', content: profile.systemPrompt }, { role: 'user', content: item.prompt }], maxTokens: item.maxTokens, ...profile.settings });
    if (stopped()) throw new ComparisonStopped();
    if (!result.text.trim()) throw new ComparisonInputError(`Проверка «${item.label}» вернула пустой ответ.`);
    const completed = { ...result, caseId: item.id, prompt: item.prompt, maxTokens: item.maxTokens };
    results.push(completed); update({ phase: 'complete', result: completed });
  }
  return results;
}
export interface CpuReference {
  schema: 1; kind: 'cpu-reference'; protocol: string; complete: boolean; model: string; revision: string; engine: string; dtype: string; quantization: string; generatedAt: string;
  systemPrompt: string; settings: typeof profile.settings;
  results: Array<{ caseId: string; prompt: string; maxTokens: number; text: string; finish: 'complete' | 'length'; seconds: number; generatedTokens: number }>;
}
export function validateReference(value: unknown): CpuReference {
  const reference = value as CpuReference;
  if (reference?.schema !== 1 || reference.kind !== 'cpu-reference' || reference.protocol !== profile.protocol || reference.complete !== true || reference.model !== 'Qwen/Qwen3-1.7B' || reference.revision !== '70d244cc86ccca08cf5af4e1e306ecf908b1ad5e' || reference.dtype !== 'float32' || reference.quantization !== 'none' || typeof reference.engine !== 'string' || reference.systemPrompt !== profile.systemPrompt || !Array.isArray(reference.results) || reference.results.length !== profile.cases.length) throw Error('Файл CPU-сравнения несовместим с этой диагностикой.');
  for (const [key, setting] of Object.entries(profile.settings)) if (reference.settings?.[key as keyof typeof profile.settings] !== setting) throw Error('Настройки CPU-сравнения отличаются.');
  for (const item of profile.cases) {
    const result = reference.results.find(result => result.caseId === item.id);
    if (!result || result.prompt !== item.prompt || result.maxTokens !== item.maxTokens || typeof result.text !== 'string' || !result.text.trim() || !['complete', 'length'].includes(result.finish)) throw Error('Набор запросов CPU-сравнения отличается.');
  }
  return reference;
}
