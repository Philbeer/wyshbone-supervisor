/**
 * Task Runner Implementation
 * 
 * The core task execution engine for Supervisor.
 * Handles lifecycle hooks, timeout, retries, and error wrapping.
 */

import type { TaskError, TaskStatus, Metadata } from '../types';
import type { SupervisorEventBus } from '../event-bus';
import type { 
  TaskRunner,
  TaskRunnerConfig,
  TaskExecutor,
  TaskExecutionContext,
  RunTaskOptions,
  RunTaskResult,
  TaskLifecycleContext,
  TaskLifecycleHooks,
  LogHook,
  FeatureId
} from './types';
import { EventTypes } from '../events';

/**
 * Generate a unique task ID
 */
function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Default log hook that writes to console
 */
const defaultLogHook: LogHook = (level, message, data) => {
  const prefix = `[TaskRunner]`;
  const timestamp = new Date().toISOString();
  const logData = data ? ` ${JSON.stringify(data)}` : '';
  
  switch (level) {
    case 'debug':
      console.debug(`${prefix} ${timestamp} DEBUG: ${message}${logData}`);
      break;
    case 'info':
      console.log(`${prefix} ${timestamp} INFO: ${message}${logData}`);
      break;
    case 'warn':
      console.warn(`${prefix} ${timestamp} WARN: ${message}${logData}`);
      break;
    case 'error':
      console.error(`${prefix} ${timestamp} ERROR: ${message}${logData}`);
      break;
  }
};

/**
 * Create a TaskError from an unknown error
 */
function normalizeError(error: unknown, retryable: boolean = false): TaskError {
  if (error instanceof Error) {
    return {
      code: 'TASK_ERROR',
      message: error.message,
      stack: error.stack,
      cause: error,
      retryable
    };
  }
  
  return {
    code: 'UNKNOWN_ERROR',
    message: String(error),
    retryable
  };
}

/**
 * Sleep helper for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute with timeout
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  taskId: string
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout>;
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Task ${taskId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutHandle!);
    return result;
  } catch (error) {
    clearTimeout(timeoutHandle!);
    throw error;
  }
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<Omit<TaskRunnerConfig, 'hooks'>> = {
  defaultTimeoutMs: 30000,       // 30 seconds
  defaultMaxAttempts: 3,
  retryBaseDelayMs: 1000,        // 1 second
  exponentialBackoff: true
};

/**
 * Core TaskRunner implementation.
 * 
 * Features:
 * - Lifecycle hooks (before, after, onError)
 * - Structured logging
 * - Timeout handling
 * - Retry with exponential backoff
 * - Error normalization
 * - Event emission via EventBus
 */
export class SupervisorTaskRunner implements TaskRunner {
  private config: TaskRunnerConfig;
  private eventBus?: SupervisorEventBus;

  constructor(config: TaskRunnerConfig = {}, eventBus?: SupervisorEventBus) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = eventBus;
  }

  /**
   * Get current configuration
   */
  getConfig(): TaskRunnerConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  configure(config: Partial<TaskRunnerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Set the event bus for emitting task events
   */
  setEventBus(eventBus: SupervisorEventBus): void {
    this.eventBus = eventBus;
  }

  /**
   * Run a feature with the given payload
   */
  async runFeature<TInput = unknown, TOutput = unknown>(
    featureId: FeatureId,
    payload: TInput,
    executor: TaskExecutor<TInput, TOutput>,
    options: RunTaskOptions<TInput, TOutput> = {}
  ): Promise<RunTaskResult<TOutput>> {
    const taskId = generateTaskId();
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    
    // Merge options with defaults
    const timeoutMs = options.timeoutMs ?? this.config.defaultTimeoutMs ?? DEFAULT_CONFIG.defaultTimeoutMs;
    const maxAttempts = options.maxAttempts ?? this.config.defaultMaxAttempts ?? DEFAULT_CONFIG.defaultMaxAttempts;
    
    // Merge hooks
    const hooks: TaskLifecycleHooks<TInput, TOutput> = {
      ...this.config.hooks,
      ...options.hooks
    };
    
    // Get log function
    const log: LogHook = hooks.onLog ?? defaultLogHook;
    
    log('info', `Starting feature: ${featureId}`, { taskId, featureId });

    // Emit TaskQueued event
    await this.emitEvent(EventTypes.TASK_QUEUED, {
      taskId,
      taskType: featureId,
      userId: options.userId ?? 'system',
      accountId: options.accountId,
      priority: 'normal',
      inputSummary: typeof payload === 'object' ? JSON.stringify(payload).substring(0, 100) : String(payload)
    });

    let lastError: TaskError | undefined;
    let attempts = 0;
    let status: TaskStatus = 'running';

    // Retry loop
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      const attemptStartTime = Date.now();
      
      // Build lifecycle context
      const lifecycleContext: TaskLifecycleContext<TInput, TOutput> = {
        task: {
          id: taskId,
          type: featureId,
          input: payload,
          status: 'running',
          createdAt: startedAt,
          startedAt: new Date().toISOString(),
          attempts: attempt,
          maxAttempts,
          correlationId: options.correlationId,
          metadata: options.metadata
        },
        attempt,
        startedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startTime,
        metadata: options.metadata
      };

      // Build execution context
      const executionContext: TaskExecutionContext = {
        taskId,
        featureId,
        attempt,
        log,
        metadata: options.metadata
      };

      try {
        // Call beforeTask hook
        if (hooks.beforeTask) {
          await hooks.beforeTask(lifecycleContext);
        }

        // Emit TaskStarted event
        await this.emitEvent(EventTypes.TASK_STARTED, {
          taskId,
          taskType: featureId,
          userId: options.userId ?? 'system',
          accountId: options.accountId,
          agentId: 'task-runner',
          attempt,
          maxAttempts
        });

        log('debug', `Executing attempt ${attempt}/${maxAttempts}`, { taskId, featureId });

        // Execute with timeout
        const result = await withTimeout(
          executor(payload, executionContext),
          timeoutMs,
          taskId
        );

        // Success!
        const durationMs = Date.now() - startTime;
        status = 'succeeded';

        const taskResult: RunTaskResult<TOutput> = {
          taskId,
          featureId,
          success: true,
          data: result,
          durationMs,
          attempts,
          status,
          startedAt,
          completedAt: new Date().toISOString()
        };

        // Call afterTask hook
        if (hooks.afterTask) {
          await hooks.afterTask(lifecycleContext, {
            success: true,
            data: result,
            durationMs
          });
        }

        // Emit TaskCompleted event
        await this.emitEvent(EventTypes.TASK_COMPLETED, {
          taskId,
          taskType: featureId,
          userId: options.userId ?? 'system',
          accountId: options.accountId,
          agentId: 'task-runner',
          status: 'succeeded',
          durationMs,
          attempts,
          resultSummary: typeof result === 'object' ? JSON.stringify(result).substring(0, 100) : String(result)
        });

        log('info', `Feature completed successfully: ${featureId}`, { 
          taskId, 
          durationMs, 
          attempts 
        });

        return taskResult;

      } catch (error) {
        const attemptDurationMs = Date.now() - attemptStartTime;
        const isTimeout = error instanceof Error && error.message.includes('timed out');
        lastError = normalizeError(error, attempt < maxAttempts);

        log('warn', `Attempt ${attempt} failed: ${lastError.message}`, {
          taskId,
          featureId,
          attempt,
          isTimeout,
          durationMs: attemptDurationMs
        });

        // Call onError hook
        if (hooks.onError) {
          await hooks.onError(lifecycleContext, lastError);
        }

        // Retry if we have attempts remaining
        if (attempt < maxAttempts) {
          const delayMs = this.config.exponentialBackoff
            ? (this.config.retryBaseDelayMs ?? DEFAULT_CONFIG.retryBaseDelayMs) * Math.pow(2, attempt - 1)
            : (this.config.retryBaseDelayMs ?? DEFAULT_CONFIG.retryBaseDelayMs);
          
          log('debug', `Retrying in ${delayMs}ms...`, { taskId, attempt, nextAttempt: attempt + 1 });
          await sleep(delayMs);
        }
      }
    }

    // All attempts failed
    const durationMs = Date.now() - startTime;
    status = lastError?.message.includes('timed out') ? 'timeout' : 'failed';

    const failedResult: RunTaskResult<TOutput> = {
      taskId,
      featureId,
      success: false,
      error: lastError,
      durationMs,
      attempts,
      status,
      startedAt,
      completedAt: new Date().toISOString()
    };

    // Call afterTask hook for failure
    if (hooks.afterTask) {
      await hooks.afterTask(
        {
          task: {
            id: taskId,
            type: featureId,
            input: payload,
            status,
            createdAt: startedAt,
            attempts,
            error: lastError?.message
          },
          attempt: attempts,
          startedAt,
          elapsedMs: durationMs,
          metadata: options.metadata
        },
        {
          success: false,
          error: lastError,
          durationMs
        }
      );
    }

    // Emit TaskFailed event
    await this.emitEvent(EventTypes.TASK_FAILED, {
      taskId,
      taskType: featureId,
      userId: options.userId ?? 'system',
      accountId: options.accountId,
      agentId: 'task-runner',
      status: status as 'failed' | 'timeout',
      durationMs,
      attempts,
      errorCode: lastError?.code,
      errorMessage: lastError?.message ?? 'Unknown error',
      retryable: false
    });

    log('error', `Feature failed: ${featureId}`, {
      taskId,
      durationMs,
      attempts,
      error: lastError?.message
    });

    return failedResult;
  }

  /**
   * Alias for runFeature (matches doc spec naming)
   */
  async runTask<TInput = unknown, TOutput = unknown>(
    taskType: string,
    input: TInput,
    executor: TaskExecutor<TInput, TOutput>,
    options?: RunTaskOptions<TInput, TOutput>
  ): Promise<RunTaskResult<TOutput>> {
    return this.runFeature(taskType, input, executor, options);
  }

  /**
   * Emit an event via the EventBus (if available)
   */
  private async emitEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.eventBus) {
      return;
    }

    try {
      await this.eventBus.publish({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        type,
        timestamp: new Date().toISOString(),
        source: 'task-runner',
        payload
      });
    } catch (error) {
      // Don't let event emission errors affect task execution
      console.error('[TaskRunner] Failed to emit event:', error);
    }
  }
}

/**
 * Create a new TaskRunner instance.
 * Factory function for convenient instantiation.
 */
export function createTaskRunner(
  config?: TaskRunnerConfig,
  eventBus?: SupervisorEventBus
): TaskRunner {
  return new SupervisorTaskRunner(config, eventBus);
}

