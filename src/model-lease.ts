// Web Locks belong to this origin and are released automatically when their
// worker dies. Hold the lock for the entire model lifetime, including loading:
// chat, comparisons and diagnostics must never allocate parallel GPU copies.
export async function holdModelLease(): Promise<void> {
  if (!navigator.locks) throw Error('Браузер не поддерживает защиту от нескольких копий модели. Обновите Chrome и откройте сайт по HTTPS.');
  await new Promise<void>((resolve, reject) => {
    void navigator.locks.request('tetrikanets:inference:v1', { ifAvailable: true }, async lock => {
      if (!lock) {
        reject(Error('Модель уже запущена в другой вкладке этого сайта. Закройте её или нажмите там «Освободить память», затем повторите запуск здесь.'));
        return;
      }
      resolve();
      await new Promise<void>(() => {});
    }).catch(reject);
  });
}
