import { expect, it } from 'vitest';
import { compareAnswers, checkTranslationShape, ComparisonInputError, ComparisonStopped } from '../../src/comparison';
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
  expect(requests[3].messages.at(-1)?.content).toContain(`<source_text>\n${replies[2]}\n</source_text>`);
  expect(requests[1].messages.at(-1)?.content).toContain('<source_text>\nПридумай рассказ про свинку\n</source_text>');
  expect(requests.map(request => request.messages.length)).toEqual([2, 4, 2, 4]);
  expect(requests.every(request => request.seed === 42)).toBe(true);
  for (const request of [requests[1], requests[3]]) {
    expect(request.temperature).toBe(0);
    expect(request.frequencyPenalty).toBe(0);
    expect(request.presencePenalty).toBe(0);
  }
  expect(requests[0].frequencyPenalty).toBeUndefined();
  expect(requests[2].frequencyPenalty).toBeUndefined();
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

it('checks the Qwen context before generating an English answer', async () => {
  let calls = 0;
  const run: StageRunner = async () => { calls++; return { text: calls === 2 ? 'x'.repeat(4000) : 'Text', finish: 'complete', seconds: 1 }; };
  await expect(compareAnswers('Вопрос', run, () => {}, () => false)).rejects.toThrow('не помещается в контекст');
  expect(calls).toBe(2);
});

it('passes a complete English answer to the CPU translator without a Qwen prompt budget', async () => {
  const english = 'A pig returned safely to dry land. '.repeat(70);
  const requests: StageRequest[] = [];
  const run: StageRunner = async request => {
    requests.push(request);
    return { text: ['Прямой ответ', 'Write a story.', english, 'Свинка вернулась на сушу. '.repeat(70)][requests.length - 1], finish: 'complete', seconds: 1 };
  };
  await compareAnswers('Придумай рассказ', run, () => {}, () => false);
  expect(requests).toHaveLength(4);
  expect(requests[3].sourceText).toBe(english);
});

it('stops when a short instruction is answered with a story instead of being translated', async () => {
  let calls = 0;
  const run: StageRunner = async () => {
    calls++;
    return { text: calls === 2 ? 'Once upon a time there was a little animal. '.repeat(9) : 'Прямой ответ', finish: 'complete', seconds: 1 };
  };
  await expect(compareAnswers('Придумай короткий рассказ про свинку', run, () => {}, () => false)).rejects.toThrow('Длина перевода');
  expect(calls).toBe(2);
});

it('allows ordinary translation expansion and repeated names without claiming semantic validation', () => {
  expect(() => checkTranslationShape('Напиши рассказ про свинку, которая не умеет плавать.', 'Write a story about a little pig that does not know how to swim.')).not.toThrow();
  expect(() => checkTranslationShape('Piggy saw the farmer. Piggy thanked the farmer.', 'Свинка увидела фермера. Свинка поблагодарила фермера.')).not.toThrow();
  // Length cannot detect substitutions; keep this limitation explicit.
  expect(() => checkTranslationShape('A pig swims.', 'Пёсик плавает.')).not.toThrow();
});
