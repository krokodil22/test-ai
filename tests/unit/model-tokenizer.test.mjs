import { expect, it } from 'vitest';
import { validateStopTokens } from '../../scripts/model-tokenizer.mjs';
it('rejects stop IDs copied from a different tokenizer, even within one model family', () => {
  const tokenizer = { added_tokens: [{ content: '<|endoftext|>', id: 40 }, { content: '<|im_end|>', id: 42 }] };
  const config = { vocab_size: 64, conv_template: { stop_str: ['<|endoftext|>', '<|im_end|>'], stop_token_ids: [20, 40] } };
  expect(() => validateStopTokens(config, tokenizer)).toThrow('expected 42');
  config.conv_template.stop_token_ids = [40, 42];
  expect(() => validateStopTokens(config, tokenizer)).not.toThrow();
  config.conv_template.stop_token_ids.push(64);
  expect(() => validateStopTokens(config, tokenizer)).toThrow('Invalid');
});
