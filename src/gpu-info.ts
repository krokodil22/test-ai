const LIMITS = ['maxStorageBufferBindingSize', 'maxBufferSize', 'maxComputeWorkgroupStorageSize', 'maxStorageBuffersPerShaderStage', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX'] as const;
function limits(value?: GPUSupportedLimits) {
  return Object.fromEntries(LIMITS.flatMap(key => typeof value?.[key] === 'number' ? [[key, value[key]]] : []));
}
export function describeGpu(adapter: GPUAdapter, device: GPUDevice) {
  let info: GPUAdapterInfo | undefined;
  try { info = adapter.info; } catch { /* Browser may withhold identifying fields. */ }
  return {
    adapter: { vendor: info?.vendor || '', architecture: info?.architecture || '', device: info?.device || '', description: info?.description || '', features: Array.from(adapter.features || []).sort(), limits: limits(adapter.limits) },
    device: { features: Array.from(device.features || []).sort(), limits: limits(device.limits) },
  };
}
export type RuntimeGpuInfo = ReturnType<typeof describeGpu>;
export function browserEnvironment() {
  return { userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language, hardwareConcurrency: navigator.hardwareConcurrency, secureContext: globalThis.isSecureContext, webgpu: !!navigator.gpu };
}
