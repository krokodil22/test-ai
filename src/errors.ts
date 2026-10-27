import { MODEL_GPU_MEMORY, MODEL_RAM } from './config';

export function explainError(error: unknown): string {
  if (error instanceof Error && /^(Архив модели|Выберите скачанный архив|Браузер не смог сохранить)/.test(error.message)) return error.message;
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/device.?lost|gpu.*(lost|потер)|потер.*gpu/i.test(text)) return 'Соединение с GPU потеряно. Закройте тяжёлые вкладки и запустите модель снова. Сохранённая переписка останется на устройстве.';
  if (/out of memory|outofmemory|allocation|alloc.*(fail|error)|memory access|недостаточно.*памят/i.test(text)) return `Не хватает оперативной или графической памяти. Закройте другие приложения и вкладки, затем запустите модель снова. Нужно ${MODEL_GPU_MEMORY} с запасом и ${MODEL_RAM}.`;
  if (/quota|storage.*full/i.test(text)) return 'Недостаточно места в браузерном хранилище. Освободите место или удалите скачанную модель в настройках.';
  if (/fetch|network|HTTP|CORS|download|скач|загруз.*ресурс/i.test(text)) return 'Не удалось загрузить ресурсы модели. Проверьте соединение, наличие файлов на хостинге и CORS. Повторный запуск использует уже сохранённые файлы.';
  if (/shader-f16|WebGPU|адаптер|HTTPS|браузер|GPU/i.test(text)) return text.replace(/^\w*Error: /, '');
  if (/контекст|длинное/i.test(text)) return text.replace(/^\w*Error: /, '');
  if (/integrity|sha256|хеш|манифест|model-info|mlc-chat-config/i.test(text)) return 'Ресурсы модели неполные или повреждены. Удалите модель из кеша. Владельцу сайта: повторите npm run model:download и разместите полный каталог ресурсов.';
  return 'Не удалось выполнить операцию. Попробуйте запустить модель снова. Если ошибка повторяется, проверьте ресурсы и консоль браузера.';
}
