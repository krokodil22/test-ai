// WebLLM seeds an empty thinking block when enable_thinking=false. Depending
// on the decoder it can be included in streamed deltas. Strip that exact
// leading runtime block, even if it is split across chunks, preserving text.
export function visibleQwenStream() {
  const prefix = '<think>\n\n</think>\n\n';
  let pending = '';
  let decided = false;
  return (delta: string) => {
    if (decided) return delta;
    pending += delta;
    if (prefix.startsWith(pending)) return '';
    decided = true;
    const text = pending.startsWith(prefix) ? pending.slice(prefix.length) : pending;
    pending = '';
    return text;
  };
}
