/**
 * Task Runner Types
 * 
 * Type definitions for the Supervisor task execution engine.
 */

import type { 
  BaseTaskDefinition, 
  TaskResult, 
  TaskError,
  TaskStatus,
  Metadata,
  ISOTimestamp
} from '../types';

// ============================================
// FEATURE IDENTIFIERS
// ============================================

/**
 * Known feature identifiers that can be run
 */
export type FeatureId = 
  | 'lead.search'
  | 'lead.enrich'
  | 'email.find'
  | 'email.verify'
  | 'monitor.create'
  | 'monitor.run'
  | 'plan.execute'
  | string; // Allow custom features

// ============================================
// LIFECYCLE HOOKS
// ============================================

/**
 * Context passed to lifecycle hooks
 */
export interface TaskLifecycleContext<TInput = unknown, TOutput = unknown> {
  /**
   * Task being executed
   */
  task: BaseTaskDefinition<TInput, TOutput>;

  /**
   * Current attempt number (1-based)
   */
  attempt: number;

  /**
   * Start timestamp of current attempt
   */
  startedAt: ISOTimestamp;

  /**
   * Elapsed time in milliseconds
   */
  elapsedMs: number;

  /**
   * Additional context metadata
   */
  metadata?: Metadata;
}

/**
 * Hook called before task execution starts
 */
export type BeforeTaskHook<TInput = unknown> = (
  context: TaskLifecycleContext<TInput>
) => void | Promise<void>;

/**
 * Hook called after task execution completes (success or failure)
 */
export type AfterTaskHook<TInput = unknown, TOutput = unknown> = (
  context: TaskLifecycleContext<TInput, TOutput>,
  result: TaskResult<TOutput>
) => void | Promise<void>;

/**
 * Hook called when task fails (before retry if applicable)
 */
export type OnErrorHook<TInput = unknown> = (
  context: TaskLifecycleContext<TInput>,
  error: TaskError
) => void | Promise<void>;

/**
 * Hook called for logging/tracing
 */
export type LogHook = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: Metadata
) => void;

/**
 * All lifecycle hooks
 */
export interface TaskLifecycleHooks<TInput = unknown, TOutput = unknown> {
  beforeTask?: BeforeTaskHook<TInput>;
  afterTask?: AfterTaskHook<TInput, TOutput>;
  onError?: OnErrorHook<TInput>;
  onLog?: LogHook;
}

// ============================================
// TASK RUNNER CONFIGURATION
// ============================================

/**
 * Configuration for the task runner
 */
export interface TaskRunnerConfig {
  /**
   * Default timeout for tasks in milliseconds
   */
  defaultTimeoutMs?: number;

  /**
   * Default maximum retry attempts
   */
  defaultMaxAttempts?: number;

  /**
   * Base delay for retry backoff in milliseconds
   */
  retryBaseDelayMs?: number;

  /**
   * Whether to use exponential backoff for retries
   */
  exponentialBackoff?: boolean;

  /**
   * Global lifecycle hooks
   */
  hooks?: TaskLifecycleHooks;
}

// ============================================
// TASK EXECUTION
// ============================================

/**
 * Function that executes the actual task logic
 */
export type TaskExecutor<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: TaskExecutionContext
) => Promise<TOutput>;

/**
 * Context available during task execution
 */
export interface TaskExecutionContext {
  /**
   * Task ID
   */
  taskId: string;

  /**
   * Feature/task type being executed
   */
  featureId: string;

  /**
   * Current attempt number
   */
  attempt: number;

  /**
   * Log function for structured logging
   */
  log: LogHook;

  /**
   * Signal for cancellation (future use)
   */
  signal?: AbortSignal;

  /**
   * Additional metadata
   */
  metadata?: Metadata;
}

/**
 * Options for running a single task/feature
 */
export interface RunTaskOptions<TInput = unknown, TOutput = unknown> {
  /**
   * Task-specific timeout in milliseconds (overrides default)
   */
  timeoutMs?: number;

  /**
   * Maximum attempts (overrides default)
   */
  maxAttempts?: number;

  /**
   * Task-specific hooks (merged with global hooks)
   */
  hooks?: TaskLifecycleHooks<TInput, TOutput>;

  /**
   * Correlation ID for tracing
   */
  correlationId?: string;

  /**
   * User ID for context
   */
  userId?: string;

  /**
   * Account ID for multi-tenant context
   */
  accountId?: string;

  /**
   * Additional metadata
   */
  metadata?: Metadata;
}

/**
 * Result of running a task through the runner
 */
export interface RunTaskResult<TOutput = unknown> {
  /**
   * Task ID that was executed
   */
  taskId: string;

  /**
   * Feature ID that was run
   */
  featureId: string;

  /**
   * Whether execution succeeded
   */
  success: boolean;

  /**
   * Output data (if successful)
   */
  data?: TOutput;

  /**
   * Error details (if failed)
   */
  error?: TaskError;

  /**
   * Total execution time in milliseconds
   */
  durationMs: number;

  /**
   * Number of attempts made
   */
  attempts: number;

  /**
   * Final task status
   */
  status: TaskStatus;

  /**
   * Timestamps
   */
  startedAt: ISOTimestamp;
  completedAt: ISOTimestamp;
}

// ============================================
// TASK RUNNER INTERFACE
// ============================================

/**
 * Core TaskRunner interface.
 * 
 * Provides task execution with lifecycle hooks, timeout handling,
 * and error wrapping for the Supervisor system.
 */
export interface TaskRunner {
  /**
   * Run a feature/task with the given payload.
   * 
   * @param featureId - Feature identifier to run
   * @param payload - Input payload for the feature
   * @param executor - Function that executes the feature logic
   * @param options - Optional execution configuration
   * @returns Promise resolving to execution result
   */
  runFeature<TInput = unknown, TOutput = unknown>(
    featureId: FeatureId,
    payload: TInput,
    executor: TaskExecutor<TInput, TOutput>,
    options?: RunTaskOptions<TInput, TOutput>
  ): Promise<RunTaskResult<TOutput>>;

  /**
   * Alias for runFeature (matches doc spec naming)
   */
  runTask<TInput = unknown, TOutput = unknown>(
    taskType: string,
    input: TInput,
    executor: TaskExecutor<TInput, TOutput>,
    options?: RunTaskOptions<TInput, TOutput>
  ): Promise<RunTaskResult<TOutput>>;

  /**
   * Get current runner configuration
   */
  getConfig(): TaskRunnerConfig;

  /**
   * Update runner configuration
   */
  configure(config: Partial<TaskRunnerConfig>): void;
}

