export async function probeGpu(): Promise<string> {
  if (!globalThis.isSecureContext) throw new Error('Нужен HTTPS: WebGPU недоступен на незащищённом сайте. Для разработки подходит localhost.');
  if (!navigator.gpu) throw new Error('В этом браузере недоступен WebGPU. Откройте сайт в актуальном Chrome на компьютере и включите аппаратное ускорение.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Графический адаптер WebGPU недоступен. Проверьте драйвер и аппаратное ускорение в Chrome.');
  if (!adapter.features.has('shader-f16')) throw new Error('Ваш GPU не поддерживает shader-f16, необходимый этой модели. Попробуйте актуальный Chrome на другом компьютере.');
  if (adapter.limits.maxStorageBufferBindingSize < 128 * 1024 * 1024) throw new Error('Ограничения GPU слишком малы для этой модели. Нужен буфер WebGPU размером от 128 МиБ.');
  // Check device creation before any model download. Memory availability is not exposed by WebGPU.
  const device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
  device.destroy();
  return adapter.info?.description || adapter.info?.vendor || 'WebGPU';
}

// Observe the actual device allocated by WebLLM, including loss while the engine is idle.
export function monitorGpu(onLost: () => void): void {
  const original = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async options => {
    const adapter = await original(options);
    if (adapter) {
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async descriptor => {
        const device = await requestDevice(descriptor);
        void device.lost.then(info => { if (info.reason !== 'destroyed') onLost(); });
        device.addEventListener('uncapturederror', event => {
          if (event.error instanceof GPUOutOfMemoryError) onLost();
        });
        return device;
      };
    }
    return adapter;
  };
}
