// A deterministic test double exercises the REAL worker protocol, fetch guard,
// cache, progress and UI. This is NOT inference and is excluded from production.
interface File { path: string; scope: string }
export class MLCEngine {
  private interrupted = false;
  private locked = false;
  constructor(private options: {
    appConfig: { model_list: Array<{ model: string }> };
    initProgressCallback: (report: { progress: number; text: string }) => void;
  }) {}
  async reload() {
    const base = this.options.appConfig.model_list[0].model.replace(/resolve\/main\/$/, '');
    const info = await (await (await caches.open('ryadom/metadata-v1')).match(base + 'model-info.json'))!.json();
    for (const [i, file] of (info.files as File[]).entries()) {
      const cache = await caches.open(file.scope);
      const url = base + file.path;
      if (!await cache.match(url)) await cache.put(url, await fetch(url));
      if (file.path.endsWith('ndarray-cache.json')) {
        const data = await (await cache.match(url))!.json();
        if (data.externalURL) await fetch(data.externalURL);
      }
      this.options.initProgressCallback({ progress: (i + 1) / info.files.length, text: 'Loading' });
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  async resetChat() { if (this.locked) throw new Error('Model stream lock was not released'); this.interrupted = false; }
  async interruptGenerate() { this.interrupted = true; }
  chat = { completions: { create: async (request: { messages: Array<{ content: string }>; temperature?: number; frequency_penalty?: number; presence_penalty?: number }) => {
    const rawPrompt = request.messages.at(-1)!.content;
    const system = request.messages[0].content;
    const translation = system.startsWith('Translate the user message');
    const prompt = translation ? rawPrompt.match(/<source_text>\n([\s\S]*)\n<\/source_text>/)?.[1] || '' : rawPrompt;
    const slow = prompt.includes('[slow-opus]') || prompt.includes('SLOW_OPUS') ? ' SLOW_OPUS' : prompt.includes('[slow]') || prompt.includes('SLOW') ? ' SLOW' : '';
    if (translation && (request.messages.length !== 4 || request.temperature !== 0 || request.frequency_penalty !== 0 || request.presence_penalty !== 0)) throw new Error('Translation settings or task framing were lost');
    if (prompt.includes('[oom]')) throw new Error('GPU out of memory');
    if (prompt.includes('[lost]')) throw new Error('GPU device lost');
    this.locked = true;
    let text = '**Здравствуйте!** Это тестовый ответ.\n\n```javascript\nconst message = "Привет";\nconsole.log(message);\n```\n\n' + 'Текст появляется постепенно. '.repeat(3);
    if (system.startsWith('Translate the user message from Russian to English.')) text = prompt.includes('[translation-empty]') ? '' : 'TEST_ENGLISH_QUESTION: Write a short story.' + slow;
    if (translation && prompt.includes('[translation-drift]')) text = 'Once upon a time there was an animal. '.repeat(8);
    if (system.startsWith('You are') && system.includes('Respond in fluent English')) {
      if (!prompt.startsWith('TEST_ENGLISH_QUESTION')) throw new Error('English stage received wrong input');
      text = 'TEST_ENGLISH_ANSWER: A test pig learned to swim with help.' + slow;
    }
    if (system.startsWith('Translate the user message from English into natural Russian.')) {
      if (!prompt.startsWith('TEST_ENGLISH_ANSWER')) throw new Error('Final translation received wrong source');
      text = 'Тестовый русский перевод английского ответа.';
    }
    const engine = this;
    return (async function* () {
      for (let i = 0; i < text.length; i += 5) {
        await new Promise(resolve => setTimeout(resolve, prompt.includes('[slow]') || prompt.includes('SLOW') ? 50 : 15));
        if (engine.interrupted) break;
        yield { choices: [{ delta: { content: text.slice(i, i + 5) } }] };
      }
      yield { choices: [{ delta: {}, finish_reason: prompt.includes('[length]') ? 'length' : 'stop' }] };
      engine.locked = false;
    })();
  } } };
}
