// A deterministic test double exercises the REAL worker protocol, fetch guard,
// cache, progress and UI. This is NOT inference and is excluded from production.
import profile from '../../src/diagnostic-cases.json';
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
  chat = { completions: { create: async (request: { messages: Array<{ content: string }>; temperature?: number; top_p?: number; frequency_penalty?: number; presence_penalty?: number; extra_body?: { enable_thinking?: boolean }; max_tokens?: number; stream_options?: { include_usage?: boolean } }) => {
    const thinking = request.extra_body?.enable_thinking === true;
    if (request.extra_body?.enable_thinking === undefined) throw new Error('Qwen3 mode must be explicit');
    if (thinking && (request.max_tokens !== 2048 || request.messages.length !== 2 || request.temperature !== 0.7)) throw new Error('Thinking experiment settings were lost');
    const rawPrompt = request.messages.at(-1)!.content;
    const system = request.messages[0].content;
    const diagnostic = system === profile.systemPrompt;
    const diagnosticCase = diagnostic ? profile.cases.find(item => item.prompt === rawPrompt) : undefined;
    if (diagnostic && (!diagnosticCase || request.messages.length !== 2 || request.temperature !== 0 || request.top_p !== 1 || request.max_tokens !== diagnosticCase.maxTokens || thinking || request.frequency_penalty !== 0 || request.presence_penalty !== 0)) throw new Error('Diagnostic request settings were lost');
    const translation = system.startsWith('Translate the user message');
    const unpenalized = !translation && request.frequency_penalty === 0 && request.presence_penalty === 0;
    if (unpenalized && !diagnostic && (thinking || request.max_tokens !== 512 || request.temperature !== 0.7)) throw new Error('Penalty comparison settings were lost');
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
    if (unpenalized) text = prompt.includes('[penalty-empty]') ? '' : 'Тестовый русский ответ без штрафа за повторы.';
    if (diagnostic) text = diagnosticCase!.id.startsWith('arithmetic') ? '4' : 'Тестовый диагностический ответ: ' + diagnosticCase!.id;
    if (thinking) {
      text = '<think>Сначала проверю условие рассказа. Бегемот должен перестать кусаться.</think>\n\nТестовый итоговый ответ с рассуждениями.';
      if (prompt.includes('[thinking-unfinished]')) text = '<think>Рассуждение ещё не закончено. <img src="https://invalid.test/private">';
      if (prompt.includes('[thinking-empty-answer]')) text = '<think>План составлен.</think>\n\n';
      if (prompt.includes('[thinking-missing]')) text = 'Ответ без ожидаемого блока рассуждений.';
    } else text = '<think>\n\n</think>\n\n' + text;
    const engine = this;
    return (async function* () {
      for (let i = 0; i < text.length; i += 5) {
        await new Promise(resolve => setTimeout(resolve, prompt.includes('[slow]') || prompt.includes('SLOW') || (thinking && prompt.includes('[slow-thinking]')) || (unpenalized && prompt.includes('[slow-penalty]')) ? 50 : 15));
        if (engine.interrupted) break;
        yield { choices: [{ delta: { content: text.slice(i, i + 5) } }] };
      }
      yield { choices: [{ delta: {}, finish_reason: prompt.includes('[length]') || (thinking && prompt.includes('[thinking-unfinished]')) ? 'length' : 'stop' }] };
      if (request.stream_options?.include_usage) yield { choices: [], usage: { completion_tokens: thinking ? 80 : 40 } };
      engine.locked = false;
    })();
  } } };
}
