/**
 * Supervisor Scheduler Implementation
 * 
 * A lightweight, synchronous FIFO task queue for Supervisor.
 * All operations are in-memory with no external dependencies.
 */

import type { 
  SupervisorScheduler, 
  ScheduledTask, 
  EnqueueOptions,
  SchedulerStats 
} from './types';

/**
 * Generate a unique task ID
 */
function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * In-memory FIFO implementation of SupervisorScheduler.
 * 
 * Features:
 * - Synchronous operations
 * - FIFO ordering
 * - Statistics tracking
 * - Zero external dependencies
 */
export class InMemoryScheduler<T = unknown> implements SupervisorScheduler<T> {
  /**
   * Internal task queue (FIFO)
   */
  private queue: ScheduledTask<T>[] = [];

  /**
   * Statistics counters
   */
  private stats: {
    totalEnqueued: number;
    totalDequeued: number;
    lastEnqueuedAt?: string;
    lastDequeuedAt?: string;
  } = {
    totalEnqueued: 0,
    totalDequeued: 0
  };

  /**
   * Add a task to the end of the queue.
   */
  enqueue(type: string, payload: T, options: EnqueueOptions = {}): ScheduledTask<T> {
    const now = new Date().toISOString();
    
    const task: ScheduledTask<T> = {
      id: options.id || generateTaskId(),
      type,
      payload,
      createdAt: now,
      priority: options.priority,
      metadata: options.metadata
    };

    this.queue.push(task);
    
    // Update stats
    this.stats.totalEnqueued++;
    this.stats.lastEnqueuedAt = now;

    return task;
  }

  /**
   * Remove and return the first task from the queue.
   */
  dequeue(): ScheduledTask<T> | undefined {
    const task = this.queue.shift();
    
    if (task) {
      this.stats.totalDequeued++;
      this.stats.lastDequeuedAt = new Date().toISOString();
    }

    return task;
  }

  /**
   * View the first task without removing it.
   */
  peek(): ScheduledTask<T> | undefined {
    return this.queue[0];
  }

  /**
   * Get the current queue size.
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is empty.
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Clear all tasks from the queue.
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Get current scheduler statistics.
   */
  getStats(): SchedulerStats {
    return {
      queueSize: this.queue.length,
      totalEnqueued: this.stats.totalEnqueued,
      totalDequeued: this.stats.totalDequeued,
      lastEnqueuedAt: this.stats.lastEnqueuedAt,
      lastDequeuedAt: this.stats.lastDequeuedAt
    };
  }
}

/**
 * Create a new InMemoryScheduler instance.
 * Factory function for convenient instantiation.
 */
export function createScheduler<T = unknown>(): SupervisorScheduler<T> {
  return new InMemoryScheduler<T>();
}
