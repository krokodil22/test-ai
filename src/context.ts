import { CONTEXT_TOKENS, MAX_REPLY_TOKENS, SYSTEM_PROMPT } from './config';
import type { Message, PromptMessage } from './types';

// Qwen2's byte-level BPE cannot produce more tokens than UTF-8 bytes.
// Role delimiters and template additions have a separate generous allowance.
export const tokenUpperBound = (text: string) => new TextEncoder().encode(text).length + 32;
export function buildContext(history: Message[]): { messages: PromptMessage[]; dropped: number } {
  const budget = CONTEXT_TOKENS - MAX_REPLY_TOKENS - 128;
  const system: PromptMessage = { role: 'system', content: SYSTEM_PROMPT };
  const candidates: PromptMessage[] = [];
  for (const { role, content, status } of history) {
    if (!content || status === 'error') continue;
    // An unanswered/failed old question must not create consecutive user roles.
    if (role === 'user' && candidates.at(-1)?.role === 'user') candidates.pop();
    if (role === 'assistant' && candidates.at(-1)?.role !== 'user') continue;
    candidates.push({ role, content });
  }
  if (!candidates.length || candidates.at(-1)?.role !== 'user') throw new Error('Последним сообщением должен быть вопрос.');
  let used = tokenUpperBound(system.content);
  const selected: PromptMessage[] = [];
  // Keep whole turns. Never leave an orphan assistant message at the beginning.
  for (let end = candidates.length; end > 0;) {
    let start = end - 1;
    if (candidates[start].role === 'assistant') start--;
    if (start < 0 || candidates[start].role !== 'user') break;
    const turn = candidates.slice(start, end);
    const cost = turn.reduce((sum, message) => sum + tokenUpperBound(message.content), 0);
    if (used + cost > budget) {
      if (selected.length === 0) throw new Error('Сообщение слишком длинное для контекста. Сократите его и попробуйте снова.');
      break;
    }
    selected.unshift(...turn);
    used += cost;
    end = start;
  }
  return { messages: [system, ...selected], dropped: candidates.length - selected.length };
}
