export function translationParts(text: string) {
  if (!text.trim() || text.length > 12000) throw Error('Введите английский текст длиной от 1 до 12 000 символов.');
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  return text.split(/(\r?\n[ \t]*\r?\n)/).flatMap(paragraph => {
    if (!paragraph.trim()) return [{ prefix: paragraph, text: '', suffix: '' }];
    return Array.from(segmenter.segment(paragraph), ({ segment }) => {
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment)!;
      return { prefix: match[1], text: match[2], suffix: match[3] };
    });
  });
}
