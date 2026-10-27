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

// A leading Qwen3 thinking block is separate from the final answer. Delimiters
// can span chunks; never flash partial tags or reasoning in the answer panel.
export function thinkingQwenStream() {
  const open = '<think>';
  const close = '</think>';
  let phase: 'start' | 'thinking' | 'answer' = 'start';
  let pending = '';
  let detected = false;
  let complete = false;
  return {
    push(delta: string) {
      if (phase === 'answer') return { answer: delta, reasoning: '' };
      pending += delta;
      if (phase === 'start') {
        const leading = pending.trimStart();
        if (leading.startsWith(open)) {
          detected = true; phase = 'thinking'; pending = leading.slice(open.length);
        } else if (open.startsWith(leading)) return { answer: '', reasoning: '' };
        else {
          phase = 'answer'; const answer = pending; pending = '';
          return { answer, reasoning: '' };
        }
      }
      const end = pending.indexOf(close);
      if (end >= 0) {
        const result = { reasoning: pending.slice(0, end), answer: pending.slice(end + close.length) };
        complete = true; phase = 'answer'; pending = '';
        return result;
      }
      let keep = Math.min(close.length - 1, pending.length);
      while (keep > 0 && !close.startsWith(pending.slice(-keep))) keep--;
      const reasoning = pending.slice(0, pending.length - keep);
      pending = pending.slice(pending.length - keep);
      return { answer: '', reasoning };
    },
    finish() {
      const tail = { answer: phase === 'start' ? pending : '', reasoning: phase === 'thinking' ? pending : '' };
      pending = '';
      return tail;
    },
    status(): 'complete' | 'unfinished' | 'missing' { return complete ? 'complete' : detected ? 'unfinished' : 'missing'; },
  };
}
