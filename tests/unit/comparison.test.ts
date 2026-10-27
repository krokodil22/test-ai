import { expect, it } from 'vitest';
import { compareAnswers, compareThinking, comparePenalty, comparisonCompletionRequest, checkTranslationShape, ComparisonInputError, ComparisonStopped, THINKING_MAX_TOKENS } from '../../src/comparison';
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

it('compares the same Russian prompt and sampling with explicit thinking flags and output budgets', async () => {
  const requests: StageRequest[] = [];
  const updates: ComparisonUpdate[] = [];
  const result = await compareThinking('  Рассказ про бегемота, который всех кусал  ', async request => {
    requests.push(request);
    return { text: request.enableThinking ? 'Он перестал кусаться.' : 'Обычный ответ.', seconds: requests.length * 3, finish: 'complete', ...(request.enableThinking ? { thinking: { status: 'complete', text: 'План рассказа.' } as const } : {}) };
  }, update => updates.push(update), () => false);
  expect(requests.map(request => request.stage)).toEqual(['direct', 'thinking']);
  expect(requests.map(request => request.enableThinking)).toEqual([false, true]);
  expect(requests.map(request => request.maxTokens)).toEqual([512, THINKING_MAX_TOKENS]);
  expect(requests[0].messages).toEqual(requests[1].messages);
  expect(requests[0].messages).not.toBe(requests[1].messages);
  expect(requests[1].messages.at(-1)?.content).toBe('Рассказ про бегемота, который всех кусал');
  for (const request of requests) {
    expect(request.seed).toBe(42);
    expect(request.temperature).toBe(0.7);
    expect(request.topP).toBe(0.8);
    expect(request.frequencyPenalty).toBeUndefined();
    expect(request.presencePenalty).toBeUndefined();
  }
  expect(result.mode).toBe('thinking');
  expect(result.directSeconds).toBe(3);
  expect(result.thinkingSeconds).toBe(6);
  expect(updates.map(update => update.phase)).toEqual(['start', 'complete', 'start', 'complete']);
});

it('validates the larger thinking context budget before either generation starts', async () => {
  let calls = 0;
  const run: StageRunner = async () => { calls++; return { text: 'Ответ', seconds: 1, finish: 'complete' }; };
  await expect(compareThinking('я'.repeat(1200), run, () => {}, () => false)).rejects.toThrow('не помещается в контекст');
  expect(calls).toBe(0);
});

it('retains a thinking-only length-limited attempt without presenting the reasoning as an answer', async () => {
  const result = await compareThinking('Короткий вопрос', async request => request.enableThinking
    ? { text: '', thinking: { status: 'unfinished', text: 'План ещё не готов.' }, finish: 'length', seconds: 5 }
    : { text: 'Ответ', finish: 'complete', seconds: 1 }, () => {}, () => false);
  expect(result.stages[1].text).toBe('');
  expect(result.stages[1].thinking?.status).toBe('unfinished');
  expect(result.stages[1].finish).toBe('length');
});

it('does not mark a cancelled thinking generation as a complete comparison', async () => {
  let stopped = false;
  let calls = 0;
  const run: StageRunner = async request => {
    calls++; if (request.enableThinking) stopped = true;
    return { text: 'Текст', finish: 'complete', seconds: 1 };
  };
  await expect(compareThinking('Вопрос', run, () => {}, () => stopped)).rejects.toBeInstanceOf(ComparisonStopped);
  expect(calls).toBe(2);
});

it('changes only the penalty for two isolated Russian answers with identical budgets and seeds', async () => {
  const requests: StageRequest[] = [];
  const result = await comparePenalty('  Омлет из двух яиц  ', async request => {
    requests.push(request);
    return { text: 'Ответ', finish: 'complete', seconds: requests.length };
  }, () => {}, () => false);
  expect(requests.map(request => request.stage)).toEqual(['direct', 'no-penalty']);
  expect(requests.map(request => request.enableThinking)).toEqual([false, false]);
  expect(requests.map(request => request.maxTokens)).toEqual([512, 512]);
  expect(requests.map(request => [request.seed, request.temperature, request.topP])).toEqual([[42, 0.7, 0.8], [42, 0.7, 0.8]]);
  expect(requests[0].messages).toEqual(requests[1].messages);
  expect(requests[0].messages).not.toBe(requests[1].messages);
  const baseline = comparisonCompletionRequest(requests[0]);
  const unpenalized = comparisonCompletionRequest(requests[1]);
  expect(baseline).toMatchObject({ frequency_penalty: 0, presence_penalty: 0, repetition_penalty: 1.1 });
  expect(unpenalized).toEqual({ ...baseline, repetition_penalty: 1 });
  expect(result.mode).toBe('penalty');
  expect(result.stages.map(stage => stage.effectiveRepetitionPenalty)).toEqual([1.1, 1]);
  expect(result.directSeconds).toBe(1); expect(result.noPenaltySeconds).toBe(2);
});

it('does not run the no-penalty variant after stopping the baseline', async () => {
  let stopped = false; let calls = 0;
  await expect(comparePenalty('Вопрос', async () => {
    calls++; stopped = true;
    return { text: 'Частичный ответ', finish: 'complete', seconds: 1 };
  }, () => {}, () => stopped)).rejects.toBeInstanceOf(ComparisonStopped);
  expect(calls).toBe(1);
});
