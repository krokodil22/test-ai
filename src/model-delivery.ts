import { MODEL_ARCHIVE_MODE } from './config';

// Optional GitHub Pages delivery. Ordinary hosting uses adjacent model files
// and never mounts this control or contacts the release server.
export function modelDelivery(button: HTMLButtonElement, changed: () => void, container?: HTMLElement) {
  const section = document.createElement('div');
  section.className = 'model-delivery';
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.tar'; input.setAttribute('aria-label', 'Архив модели .tar');
  if (MODEL_ARCHIVE_MODE) {
    const text = document.createElement('p');
    text.textContent = 'Один раз скачайте архив модели, затем выберите его здесь. Файл читается на устройстве и никуда не отправляется. При следующих запусках используется кеш браузера.';
    const address = import.meta.env.VITE_MODEL_ARCHIVE_URL;
    if (address) {
      const url = new URL(address, location.href);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw Error('Архив модели должен размещаться по HTTPS.');
      const link = document.createElement('a'); link.href = url.href; link.textContent = 'Скачать архив модели'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      section.append(link);
    }
    const label = document.createElement('label'); label.textContent = 'Выберите скачанный файл .tar: '; label.append(input);
    section.append(text, label);
    if (container) container.append(section); else button.before(section);
    input.addEventListener('change', changed);
  }
  return {
    file: () => MODEL_ARCHIVE_MODE ? input.files?.[0] : undefined,
    available: (cached: boolean) => !MODEL_ARCHIVE_MODE || cached || !!input.files?.[0],
    update(cached: boolean, busy: boolean, supported: boolean) { section.hidden = cached || !supported; section.inert = busy; },
  };
}
