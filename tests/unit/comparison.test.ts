import { expect, it } from 'vitest';
import { compareAnswers, ComparisonInputError, ComparisonStopped } from '../../src/comparison';
import type { StageRequest, StageRunner, ComparisonUpdate } from '../../src/comparison';

it('isolates four stages, passes English intermediates correctly, and records actual stage timings', async () => {
  const requests: StageRequest[] = [];
  const updates: ComparisonUpdate[] = [];
  const replies = ['Прямой ответ', 'Write a short story about a pig.', 'A pig learned to swim.', 'Свинка научилась плавать.'];
  const run: StageRunner = async request => {
    requests.push(request);
    return { text: replies[requests.length - 1], finish: 'complete', seconds: requests.length };
  };
  const result = await compareAnswers('Придумай рассказ про свинку', run, update => updates.push(update), () => false);
  expect(requests.map(request => request.stage)).toEqual(['direct', 'translate-input', 'english-answer', 'translate-output']);
  expect(requests[2].messages.at(-1)?.content).toBe(replies[1]);
  expect(requests[3].messages.at(-1)?.content).toBe(replies[2]);
  expect(requests.every(request => request.messages.length === 2 && request.seed === 42)).toBe(true);
  expect(result.prompt).toBe('Придумай рассказ про свинку');
  expect(result.directSeconds).toBe(1);
  expect(result.bridgeSeconds).toBe(9);
  expect(updates.filter(update => update.phase === 'complete')).toHaveLength(4);
});

it('does not start another generation after cancellation', async () => {
  let stopped = false;
  let calls = 0;
  const run: StageRunner = async () => { calls++; stopped = true; return { text: 'Частичный ответ', finish: 'complete', seconds: 1 }; };
  await expect(compareAnswers('Вопрос', run, () => {}, () => stopped)).rejects.toBeInstanceOf(ComparisonStopped);
  expect(calls).toBe(1);
});

it('does not use a truncated input translation as a complete English question', async () => {
  let calls = 0;
  const run: StageRunner = async () => { calls++; return { text: 'Nonempty text', finish: calls === 2 ? 'length' : 'complete', seconds: 1 }; };
  await expect(compareAnswers('Вопрос', run, () => {}, () => false)).rejects.toThrow('Перевод запроса обрезан');
  expect(calls).toBe(2);
});

it('rejects an empty translation and never calls the answer stage', async () => {
  let calls = 0;
  const run: StageRunner = async () => { calls++; return { text: calls === 2 ? ' ' : 'Ответ', finish: 'complete', seconds: 1 }; };
  await expect(compareAnswers('Вопрос', run, () => {}, () => false)).rejects.toBeInstanceOf(ComparisonInputError);
  expect(calls).toBe(2);
});

it('checks the translation context before calling the model', async () => {
  let calls = 0;
  const run: StageRunner = async () => { calls++; return { text: calls === 3 ? 'x'.repeat(4000) : 'Text', finish: 'complete', seconds: 1 }; };
  await expect(compareAnswers('Вопрос', run, () => {}, () => false)).rejects.toThrow('не помещается в контекст');
  expect(calls).toBe(3);
});
