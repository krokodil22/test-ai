import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';

for (const [name, language] of Object.entries({ javascript, typescript, python, bash, json, css, xml })) hljs.registerLanguage(name, language);
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const parser = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escape(text),
    // Message content must never trigger image requests or navigation.
    image: ({ text }) => `<span>[изображение: ${escape(text)}]</span>`,
    link({ tokens }) { return `<span class="markdown-link">${this.parser.parseInline(tokens)}</span>`; },
    code: ({ text, lang }) => {
      const language = (lang || '').split(/\s/)[0].toLowerCase();
      const known = hljs.getLanguage(language);
      const highlighted = known ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escape(text);
      return `<pre><code class="hljs${known ? ` language-${escape(language)}` : ''}">${highlighted}</code></pre>`;
    },
  },
});

export function markdown(text: string): string {
  return DOMPurify.sanitize(parser.parse(text, { async: false }), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'span', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['class', 'start'],
    ALLOW_DATA_ATTR: false,
  });
}
