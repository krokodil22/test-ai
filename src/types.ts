import type { ComparisonMode, ComparisonResult, ComparisonStage, StageResult } from './comparison';
import type { DiagnosticResult } from './diagnostics';
import type { RuntimeGpuInfo } from './gpu-info';
import type { CacheAudit } from './model-resources';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'complete' | 'stopped' | 'error' | 'length';
}
export interface Conversation { id: string; title: string; createdAt: number; messages: Message[] }
export type PromptMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type WorkerRequest =
  | { type: 'init'; base: string; translatorBase?: string; archive?: File }
  | { type: 'generate'; id: string; messages: Message[] }
  | { type: 'compare'; id: string; prompt: string; mode: ComparisonMode }
  | { type: 'diagnose'; id: string }
  | { type: 'stop'; id: string };
export type WorkerEvent =
  | { type: 'progress'; progress: number; text: string }
  | { type: 'size'; bytes: number }
  | { type: 'ready' }
  | { type: 'gpu-info'; info: RuntimeGpuInfo }
  | { type: 'diagnostic-audit'; id: string; checked: number; total: number; result?: CacheAudit }
  | { type: 'diagnostic-start'; id: string; caseId: string }
  | { type: 'diagnostic-token'; id: string; caseId: string; text: string }
  | { type: 'diagnostic-result'; id: string; result: DiagnosticResult }
  | { type: 'diagnostic-done'; id: string; stopped: boolean }
  | { type: 'context'; id: string; dropped: number }
  | { type: 'token'; id: string; text: string }
  | { type: 'done'; id: string; reason: 'complete' | 'stopped' | 'length' }
  | { type: 'comparison-stage'; id: string; stage: ComparisonStage }
  | { type: 'comparison-token'; id: string; stage: ComparisonStage; text: string }
  | { type: 'comparison-reasoning'; id: string; text: string }
  | { type: 'comparison-result'; id: string; result: StageResult }
  | { type: 'comparison-progress'; id: string; done: number; total: number }
  | { type: 'comparison-done'; id: string; result?: ComparisonResult; stopped: boolean }
  | { type: 'error'; id?: string; message: string; fatal: boolean };
