import type { ExecutorInput, ExecutorOutput } from './types';

export type ExecutorFn = (input: ExecutorInput) => Promise<ExecutorOutput>;

export interface ExecutorMeta {
  description: string;
  strengths: string;
  limitations: string;
  typicalUse: string;
  costTier: 'cheap' | 'moderate' | 'expensive';
}

const registry = new Map<string, ExecutorFn>();
const metaRegistry = new Map<string, ExecutorMeta>();

export function registerExecutor(executorType: string, fn: ExecutorFn, meta?: ExecutorMeta): void {
  registry.set(executorType, fn);
  if (meta) metaRegistry.set(executorType, meta);
  console.log(`[EXECUTOR_REGISTRY] Registered executor: ${executorType}${meta ? ' (with metadata)' : ''}`);
}

export function getExecutor(executorType: string): ExecutorFn | undefined {
  return registry.get(executorType);
}

export function getAvailableExecutors(): string[] {
  return Array.from(registry.keys());
}

export function getExecutorMeta(executorType: string): ExecutorMeta | undefined {
  return metaRegistry.get(executorType);
}

export function getAllExecutorMeta(): Map<string, ExecutorMeta> {
  return new Map(metaRegistry);
}
