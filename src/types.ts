import type { ComparisonResult, ComparisonStage, StageResult } from './comparison';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'complete' | 'stopped' | 'error' | 'length';
}
export interface Conversation { id: string; title: string; createdAt: number; messages: Message[] }
export type PromptMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type WorkerRequest =
  | { type: 'init'; base: string; translatorBase?: string }
  | { type: 'generate'; id: string; messages: Message[] }
  | { type: 'compare'; id: string; prompt: string }
  | { type: 'stop'; id: string };
export type WorkerEvent =
  | { type: 'progress'; progress: number; text: string }
  | { type: 'size'; bytes: number }
  | { type: 'ready' }
  | { type: 'context'; id: string; dropped: number }
  | { type: 'token'; id: string; text: string }
  | { type: 'done'; id: string; reason: 'complete' | 'stopped' | 'length' }
  | { type: 'comparison-stage'; id: string; stage: ComparisonStage }
  | { type: 'comparison-token'; id: string; stage: ComparisonStage; text: string }
  | { type: 'comparison-result'; id: string; result: StageResult }
  | { type: 'comparison-progress'; id: string; done: number; total: number }
  | { type: 'comparison-done'; id: string; result?: ComparisonResult; stopped: boolean }
  | { type: 'error'; id?: string; message: string; fatal: boolean };
