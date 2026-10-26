/// <reference types="vite/client" />
declare const __COMPARISON_TEST_ENGINE__: boolean;
declare module '#translator-backend' {
  export function loadTranslator(base: string, progress: (value: number, text: string) => void): Promise<void>;
  export function translateToRussian(text: string, progress?: (done: number, total: number) => void): Promise<string>;
  export function stopTranslation(): void;
}
declare module '#gpu' {
  export { probeGpu, monitorGpu } from './gpu';
}
