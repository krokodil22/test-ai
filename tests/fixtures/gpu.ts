// Compile-time test replacement. Never imported into the production build.
export async function probeGpu(): Promise<string> {
  const error = (globalThis as unknown as { __gpuFailure?: string }).__gpuFailure;
  if (error) throw new Error(error);
  return 'Тестовый адаптер';
}
export function monitorGpu(_onLost: () => void, onDevice?: (info: import('../../src/gpu-info').RuntimeGpuInfo) => void): void {
  onDevice?.({ adapter: { vendor: 'TEST ONLY', architecture: '', device: '', description: 'Mock GPU', features: ['shader-f16'], limits: { maxStorageBufferBindingSize: 268435456 } }, device: { features: ['shader-f16'], limits: { maxStorageBufferBindingSize: 155582464 } } });
}
