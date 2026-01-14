/**
 * In-Memory Event Bus Implementation
 * 
 * A lightweight, dependency-free pub/sub event bus for Supervisor.
 * Handles event routing, concurrent handler execution, and error isolation.
 */

import type { BaseSupervisorEvent, EventHandler, Subscription } from '../types';
import type { 
  SupervisorEventBus, 
  SubscribeOptions, 
  PublishOptions, 
  PublishResult 
} from './types';

/**
 * Internal handler registration structure
 */
interface HandlerRegistration<T extends BaseSupervisorEvent = BaseSupervisorEvent> {
  id: string;
  handler: EventHandler<T>;
  options: SubscribeOptions;
}

/**
 * Generate a unique subscription ID
 */
function generateSubscriptionId(): string {
  return `sub_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Check if an event type matches a subscription pattern.
 * Supports exact match and wildcard (*) patterns.
 * 
 * @example
 * matchesPattern('agent.started', 'agent.started') // true
 * matchesPattern('agent.started', 'agent.*') // true
 * matchesPattern('agent.started', '*') // true
 * matchesPattern('agent.started', 'task.*') // false
 */
function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }
  
  if (pattern === eventType) {
    return true;
  }
  
  // Handle wildcard patterns like 'agent.*'
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return eventType.startsWith(prefix + '.');
  }
  
  // Handle patterns like 'agent.**' for deep matching
  if (pattern.endsWith('.**')) {
    const prefix = pattern.slice(0, -3);
    return eventType.startsWith(prefix + '.') || eventType === prefix;
  }
  
  return false;
}

/**
 * In-memory implementation of SupervisorEventBus.
 * 
 * Features:
 * - Type-safe event handling
 * - Wildcard pattern matching
 * - Concurrent handler execution
 * - Error isolation (one handler failure doesn't affect others)
 * - Optional one-time subscriptions
 * - Handler filtering
 */
export class InMemoryEventBus implements SupervisorEventBus {
  /**
   * Map of event type patterns to handler registrations
   */
  private handlers: Map<string, HandlerRegistration[]> = new Map();

  /**
   * Map of subscription IDs to their event type for fast lookup
   */
  private subscriptionIndex: Map<string, string> = new Map();

  /**
   * Subscribe to events matching a type pattern.
   */
  subscribe<T extends BaseSupervisorEvent = BaseSupervisorEvent>(
    eventType: string,
    handler: EventHandler<T>,
    options: SubscribeOptions = {}
  ): Subscription {
    const subscriptionId = options.subscriberId || generateSubscriptionId();
    
    const registration: HandlerRegistration<T> = {
      id: subscriptionId,
      handler,
      options
    };

    // Get or create handler list for this event type
    const existingHandlers = this.handlers.get(eventType) || [];
    existingHandlers.push(registration as HandlerRegistration);
    this.handlers.set(eventType, existingHandlers);

    // Index the subscription for fast unsubscribe
    this.subscriptionIndex.set(subscriptionId, eventType);

    // Return subscription handle
    return {
      id: subscriptionId,
      unsubscribe: () => this.unsubscribe(subscriptionId)
    };
  }

  /**
   * Publish an event to all matching subscribers.
   * 
   * Handlers are executed concurrently using Promise.all.
   * Errors are caught and logged, not thrown.
   */
  async publish<T extends BaseSupervisorEvent = BaseSupervisorEvent>(
    event: T,
    options: PublishOptions = {}
  ): Promise<PublishResult> {
    const matchingHandlers: HandlerRegistration[] = [];
    const toRemove: string[] = []; // Track one-time subscriptions to remove

    // Find all handlers that match this event type
    for (const [pattern, registrations] of this.handlers.entries()) {
      if (matchesPattern(event.type, pattern)) {
        for (const registration of registrations) {
          // Apply filter if present
          if (registration.options.filter && !registration.options.filter(event)) {
            continue;
          }
          
          matchingHandlers.push(registration);
          
          // Mark one-time subscriptions for removal
          if (registration.options.once) {
            toRemove.push(registration.id);
          }
        }
      }
    }

    const errors: string[] = [];
    let errorCount = 0;

    // Execute all handlers concurrently
    if (matchingHandlers.length > 0) {
      const handlerPromises = matchingHandlers.map(async (registration) => {
        try {
          // Create a promise for the handler
          const handlerPromise = Promise.resolve(registration.handler(event));
          
          // Apply timeout if specified
          if (options.timeoutMs) {
            const timeoutPromise = new Promise<void>((_, reject) => {
              setTimeout(() => reject(new Error('Handler timeout')), options.timeoutMs);
            });
            await Promise.race([handlerPromise, timeoutPromise]);
          } else {
            await handlerPromise;
          }
        } catch (error) {
          // Log error but don't throw - isolate handler failures
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(
            `[EventBus] Handler error for event "${event.type}":`,
            errorMessage
          );
          errors.push(errorMessage);
          errorCount++;
        }
      });

      // Wait for all handlers if requested, otherwise fire-and-forget
      if (options.awaitHandlers !== false) {
        await Promise.all(handlerPromises);
      }
    }

    // Remove one-time subscriptions
    for (const subscriptionId of toRemove) {
      this.unsubscribe(subscriptionId);
    }

    return {
      eventId: event.id,
      handlerCount: matchingHandlers.length,
      errorCount,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Unsubscribe a handler by subscription ID.
   */
  unsubscribe(subscriptionId: string): void {
    const eventType = this.subscriptionIndex.get(subscriptionId);
    if (!eventType) {
      return; // Already unsubscribed or never existed
    }

    const handlers = this.handlers.get(eventType);
    if (handlers) {
      const filtered = handlers.filter(h => h.id !== subscriptionId);
      if (filtered.length > 0) {
        this.handlers.set(eventType, filtered);
      } else {
        this.handlers.delete(eventType);
      }
    }

    this.subscriptionIndex.delete(subscriptionId);
  }

  /**
   * Check if there are any subscribers for an event type.
   */
  hasSubscribers(eventType: string): boolean {
    return this.subscriberCount(eventType) > 0;
  }

  /**
   * Get count of subscribers that would receive an event of this type.
   */
  subscriberCount(eventType: string): number {
    let count = 0;
    
    for (const [pattern, registrations] of this.handlers.entries()) {
      if (matchesPattern(eventType, pattern)) {
        count += registrations.length;
      }
    }
    
    return count;
  }

  /**
   * Clear all subscriptions.
   */
  clear(): void {
    this.handlers.clear();
    this.subscriptionIndex.clear();
  }
}

/**
 * Create a new InMemoryEventBus instance.
 * Factory function for convenient instantiation.
 */
export function createEventBus(): SupervisorEventBus {
  return new InMemoryEventBus();
}

