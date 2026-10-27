// Validate the conversation's single-token terminators against the real
// tokenizer, rather than borrowing IDs from another model in the family.
export function validateStopTokens(config, tokenizer) {
  const template = config.conv_template;
  if (!template || !Array.isArray(template.stop_token_ids)) throw Error('Missing model stop tokens');
  for (const stop of template.stop_str || []) {
    const token = tokenizer.added_tokens?.find(token => token.content === stop);
    if (token && !template.stop_token_ids.includes(token.id)) throw Error(`Stop token mismatch for ${stop}: expected ${token.id}`);
  }
  for (const id of template.stop_token_ids) if (!Number.isSafeInteger(id) || id < 0 || id >= config.vocab_size) throw Error('Invalid model stop token ID');
}
