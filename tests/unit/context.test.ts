import { describe, it, expect } from 'vitest';
import { buildContext, tokenUpperBound } from '../../src/context';
import { CONTEXT_TOKENS, MAX_REPLY_TOKENS } from '../../src/config';
import type { Message } from '../../src/types';
const user = (text: string): Message => ({ id: crypto.randomUUID(), role: 'user', content: text });
const assistant = (text: string): Message => ({ id: crypto.randomUUID(), role: 'assistant', content: text });
describe('bounded context', () => {
  it('keeps system and most recent whole turns without changing visible history', () => {
    const history = [user('старый вопрос'.repeat(60)), assistant('старый ответ'.repeat(60)), user('следующий вопрос'.repeat(60)), assistant('следующий ответ'.repeat(60)), user('Новый вопрос')];
    const original = structuredClone(history);
    const result = buildContext(history);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[1].role).toBe('user');
    expect(result.messages.at(-1)?.content).toBe('Новый вопрос');
    expect(result.messages.reduce((sum, message) => sum + tokenUpperBound(message.content), 0)).toBeLessThanOrEqual(CONTEXT_TOKENS - MAX_REPLY_TOKENS - 128);
    expect(history).toEqual(original);
  });
  it('rejects an oversized newest message instead of overflowing GPU context', () => {
    expect(() => buildContext([user('я'.repeat(5000))])).toThrow('слишком длинное');
  });
  it('never feeds an errored assistant response into another generation', () => {
    const result = buildContext([user('вопрос'), { ...assistant('ошибка'), status: 'error' }, user('ещё вопрос')]);
    expect(result.messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(result.messages.some(message => message.content === 'ошибка')).toBe(false);
  });
  it('counts UTF-8 bytes conservatively for Russian and emoji', () => {
    expect(tokenUpperBound('Привет 👋')).toBeGreaterThan('Привет 👋'.length + 32);
  });
});
