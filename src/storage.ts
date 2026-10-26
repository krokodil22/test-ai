import type { Conversation } from './types';
export const HISTORY_KEY = 'ryadom:chats:v1';
export const MAX_CHATS = 30;
export const MAX_MESSAGES = 500;
export interface History { conversations: Conversation[]; activeId: string | null }
export function readHistory(): History {
  const raw = localStorage.getItem(HISTORY_KEY);
  if (!raw) return { conversations: [], activeId: null };
  const value = JSON.parse(raw) as History;
  if (!Array.isArray(value.conversations) || value.conversations.length > MAX_CHATS) throw new Error('Повреждённая локальная история');
  for (const chat of value.conversations) {
    if (typeof chat.id !== 'string' || typeof chat.title !== 'string' || !Number.isFinite(chat.createdAt) || !Array.isArray(chat.messages) || chat.messages.length > MAX_MESSAGES) throw new Error('Повреждённая история');
    for (const message of chat.messages) {
      if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 50000 || typeof message.id !== 'string') throw new Error('Повреждённое сообщение');
    }
  }
  return value;
}
export function saveHistory(history: History): void { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }
export function deleteHistory(): void { localStorage.removeItem(HISTORY_KEY); }
