// Compile-time test replacement. Never imported into the production build.
export async function probeGpu(): Promise<string> {
  const error = (globalThis as unknown as { __gpuFailure?: string }).__gpuFailure;
  if (error) throw new Error(error);
  return 'Тестовый адаптер';
}
export function monitorGpu(_onLost: () => void): void {}
