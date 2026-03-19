import type { ExecutorInput, ExecutorOutput } from './types';

export type ExecutorFn = (input: ExecutorInput) => Promise<ExecutorOutput>;

const registry = new Map<string, ExecutorFn>();

export function registerExecutor(executorType: string, fn: ExecutorFn): void {
  registry.set(executorType, fn);
  console.log(`[EXECUTOR_REGISTRY] Registered executor: ${executorType}`);
}

export function getExecutor(executorType: string): ExecutorFn | undefined {
  return registry.get(executorType);
}

export function getAvailableExecutors(): string[] {
  return Array.from(registry.keys());
}
