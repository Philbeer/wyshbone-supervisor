/**
 * Scheduler Types
 * 
 * Type definitions for the Supervisor task scheduler.
 */

import type { TaskPriority, Metadata } from '../types';

/**
 * A scheduled task entry in the queue.
 */
export interface ScheduledTask<T = unknown> {
  /**
   * Unique identifier for this task
   */
  id: string;

  /**
   * Task type identifier (e.g., 'lead.search', 'email.enrich')
   */
  type: string;

  /**
   * Task payload data
   */
  payload: T;

  /**
   * ISO timestamp when task was created/enqueued
   */
  createdAt: string;

  /**
   * Optional task priority
   */
  priority?: TaskPriority;

  /**
   * Optional metadata
   */
  metadata?: Metadata;
}

/**
 * Options for enqueuing a task
 */
export interface EnqueueOptions {
  /**
   * Custom task ID (auto-generated if not provided)
   */
  id?: string;

  /**
   * Task priority (defaults to 'normal')
   */
  priority?: TaskPriority;

  /**
   * Additional metadata
   */
  metadata?: Metadata;
}

/**
 * Result of a dequeue operation
 */
export interface DequeueResult<T = unknown> {
  /**
   * Whether a task was available
   */
  success: boolean;

  /**
   * The dequeued task (if available)
   */
  task?: ScheduledTask<T>;
}

/**
 * Scheduler statistics
 */
export interface SchedulerStats {
  /**
   * Current queue size
   */
  queueSize: number;

  /**
   * Total tasks enqueued since creation
   */
  totalEnqueued: number;

  /**
   * Total tasks dequeued since creation
   */
  totalDequeued: number;

  /**
   * Timestamp of last enqueue operation
   */
  lastEnqueuedAt?: string;

  /**
   * Timestamp of last dequeue operation
   */
  lastDequeuedAt?: string;
}

/**
 * Core SupervisorScheduler interface.
 * 
 * Provides FIFO task queue management for Supervisor.
 */
export interface SupervisorScheduler<T = unknown> {
  /**
   * Add a task to the queue.
   * 
   * @param type - Task type identifier
   * @param payload - Task payload data
   * @param options - Optional enqueue configuration
   * @returns The created scheduled task
   */
  enqueue(type: string, payload: T, options?: EnqueueOptions): ScheduledTask<T>;

  /**
   * Remove and return the next task from the queue.
   * 
   * @returns The next task, or undefined if queue is empty
   */
  dequeue(): ScheduledTask<T> | undefined;

  /**
   * View the next task without removing it.
   * 
   * @returns The next task, or undefined if queue is empty
   */
  peek(): ScheduledTask<T> | undefined;

  /**
   * Get the current number of tasks in the queue.
   * 
   * @returns Queue size
   */
  size(): number;

  /**
   * Check if the queue is empty.
   * 
   * @returns True if queue has no tasks
   */
  isEmpty(): boolean;

  /**
   * Clear all tasks from the queue.
   */
  clear(): void;

  /**
   * Get scheduler statistics.
   * 
   * @returns Current scheduler stats
   */
  getStats(): SchedulerStats;
}
