/**
 * Base Task Definition Types
 * 
 * Defines the structure for tasks that agents execute.
 * Tasks are discrete units of work with inputs, outputs, and lifecycle.
 */

/**
 * Task execution status
 */
export type TaskStatus = 
  | 'pending'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout';

/**
 * Task priority levels
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Base definition for all Supervisor tasks.
 * 
 * Tasks are the fundamental unit of work in the Supervisor system.
 * Agents receive tasks, execute them, and return results.
 */
export interface BaseTaskDefinition<TInput = unknown, TOutput = unknown> {
  /**
   * Unique identifier for this task instance
   */
  id: string;

  /**
   * Task type identifier (e.g., 'lead.search', 'email.enrich')
   */
  type: string;

  /**
   * Human-readable task name/label
   */
  name?: string;

  /**
   * Task description
   */
  description?: string;

  /**
   * ID of the agent assigned to execute this task
   */
  agentId?: string;

  /**
   * Task input data
   */
  input: TInput;

  /**
   * Task output data (populated after completion)
   */
  output?: TOutput;

  /**
   * Current task status
   */
  status: TaskStatus;

  /**
   * Task priority for queue ordering
   */
  priority?: TaskPriority;

  /**
   * ISO timestamp when task was created
   */
  createdAt: string;

  /**
   * ISO timestamp when task started executing
   */
  startedAt?: string;

  /**
   * ISO timestamp when task completed
   */
  completedAt?: string;

  /**
   * Timeout in milliseconds
   */
  timeoutMs?: number;

  /**
   * Number of execution attempts
   */
  attempts?: number;

  /**
   * Maximum allowed attempts
   */
  maxAttempts?: number;

  /**
   * Error message if task failed
   */
  error?: string;

  /**
   * Correlation ID for tracing
   */
  correlationId?: string;

  /**
   * Parent task ID for subtasks
   */
  parentTaskId?: string;

  /**
   * IDs of tasks this depends on
   */
  dependsOn?: string[];

  /**
   * Additional task metadata
   */
  metadata?: Record<string, unknown>;
}

/**
 * Task result wrapper with standardized structure
 */
export interface TaskResult<T = unknown> {
  /**
   * Whether the task succeeded
   */
  success: boolean;

  /**
   * Result data (if successful)
   */
  data?: T;

  /**
   * Human-readable summary
   */
  summary?: string;

  /**
   * Error details (if failed)
   */
  error?: TaskError;

  /**
   * Execution duration in milliseconds
   */
  durationMs?: number;

  /**
   * Additional result metadata
   */
  metadata?: Record<string, unknown>;
}

/**
 * Standardized task error structure
 */
export interface TaskError {
  /**
   * Error code for programmatic handling
   */
  code: string;

  /**
   * Human-readable error message
   */
  message: string;

  /**
   * Stack trace (in development)
   */
  stack?: string;

  /**
   * Original error details
   */
  cause?: unknown;

  /**
   * Whether this error is retryable
   */
  retryable?: boolean;
}

