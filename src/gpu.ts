import source from '../scripts/model-source.json';
import { describeGpu } from './gpu-info';
import type { RuntimeGpuInfo } from './gpu-info';

export async function probeGpu(): Promise<string> {
  if (!globalThis.isSecureContext) throw new Error('Нужен HTTPS: WebGPU недоступен на незащищённом сайте. Для разработки подходит localhost.');
  if (source.packaging === 'gzip-shards' && !globalThis.DecompressionStream) throw new Error('Браузер не поддерживает распаковку ресурсов модели. Обновите настольный Chrome.');
  if (!navigator.gpu) throw new Error('В этом браузере недоступен WebGPU. Откройте сайт в актуальном Chrome на компьютере и включите аппаратное ускорение.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Графический адаптер WebGPU недоступен. Проверьте драйвер и аппаратное ускорение в Chrome.');
  if (!adapter.features.has('shader-f16')) throw new Error('Ваш GPU не поддерживает shader-f16, необходимый этой модели. Попробуйте актуальный Chrome на другом компьютере.');
  const requiredBuffer = source.minimumStorageBufferBytes;
  if (adapter.limits.maxStorageBufferBindingSize < requiredBuffer) throw new Error(`Ограничения GPU слишком малы для ${source.displayName}. Нужен буфер WebGPU от ${(requiredBuffer / 1024 / 1024).toFixed(1)} МиБ.`);
  if (adapter.limits.maxBufferSize < 256 * 1024 * 1024 || adapter.limits.maxComputeWorkgroupStorageSize < 32768 || adapter.limits.maxStorageBuffersPerShaderStage < 10) throw new Error('Ограничения WebGPU недостаточны для WebLLM: нужны maxBufferSize от 256 МиБ, рабочая память группы от 32 КиБ и 10 storage-буферов на стадию. Обновите браузер и драйвер GPU.');
  // Check device creation before any model download. Memory availability is not exposed by WebGPU.
  const device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'], requiredLimits: { maxStorageBufferBindingSize: requiredBuffer, maxBufferSize: adapter.limits.maxBufferSize >= 1024 * 1024 * 1024 ? 1024 * 1024 * 1024 : Math.max(requiredBuffer, 256 * 1024 * 1024), maxComputeWorkgroupStorageSize: 32768, maxStorageBuffersPerShaderStage: 10 } });
  device.destroy();
  return adapter.info?.description || adapter.info?.vendor || 'WebGPU';
}

// Observe the actual device allocated by WebLLM, including loss while the engine is idle.
export function monitorGpu(onLost: () => void, onDevice?: (info: RuntimeGpuInfo) => void): void {
  const original = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async options => {
    const adapter = await original(options);
    if (adapter) {
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async descriptor => {
        // The embedding tensor must fit both device buffer limits.
        const device = await requestDevice({ ...descriptor, requiredLimits: { ...descriptor?.requiredLimits, maxStorageBufferBindingSize: Math.max(descriptor?.requiredLimits?.maxStorageBufferBindingSize ?? 128 * 1024 * 1024, source.minimumStorageBufferBytes), maxBufferSize: Math.max(descriptor?.requiredLimits?.maxBufferSize ?? 256 * 1024 * 1024, source.minimumStorageBufferBytes) } });
        onDevice?.(describeGpu(adapter, device));
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
