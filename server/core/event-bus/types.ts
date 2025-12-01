/**
 * Event Bus Types
 * 
 * Type definitions for the Supervisor event bus system.
 */

import type { BaseSupervisorEvent, EventHandler, Subscription } from '../types';

/**
 * Event bus subscription options
 */
export interface SubscribeOptions {
  /**
   * Optional subscriber ID for tracking
   */
  subscriberId?: string;

  /**
   * Filter function to selectively receive events
   */
  filter?: (event: BaseSupervisorEvent) => boolean;

  /**
   * Whether to receive events only once then auto-unsubscribe
   */
  once?: boolean;
}

/**
 * Event bus publish options
 */
export interface PublishOptions {
  /**
   * Whether to wait for all handlers to complete
   */
  awaitHandlers?: boolean;

  /**
   * Timeout for handler execution in milliseconds
   */
  timeoutMs?: number;
}

/**
 * Result of publishing an event
 */
export interface PublishResult {
  /**
   * Event ID that was published
   */
  eventId: string;

  /**
   * Number of handlers that received the event
   */
  handlerCount: number;

  /**
   * Number of handlers that failed
   */
  errorCount: number;

  /**
   * Error messages from failed handlers
   */
  errors?: string[];
}

/**
 * Core SupervisorEventBus interface.
 * 
 * Provides pub/sub messaging for internal Supervisor coordination.
 * All agents and components communicate through this bus.
 */
export interface SupervisorEventBus {
  /**
   * Subscribe to events of a specific type.
   * 
   * @param eventType - Event type pattern to subscribe to (e.g., 'agent.started', 'task.*')
   * @param handler - Async function to handle received events
   * @param options - Optional subscription configuration
   * @returns Subscription handle for unsubscribing
   */
  subscribe<T extends BaseSupervisorEvent = BaseSupervisorEvent>(
    eventType: string,
    handler: EventHandler<T>,
    options?: SubscribeOptions
  ): Subscription;

  /**
   * Publish an event to all matching subscribers.
   * 
   * @param event - The event to publish
   * @param options - Optional publish configuration
   * @returns Promise resolving to publish result
   */
  publish<T extends BaseSupervisorEvent = BaseSupervisorEvent>(
    event: T,
    options?: PublishOptions
  ): Promise<PublishResult>;

  /**
   * Unsubscribe by subscription ID.
   * 
   * @param subscriptionId - ID of the subscription to remove
   */
  unsubscribe(subscriptionId: string): void;

  /**
   * Check if there are any subscribers for an event type.
   * 
   * @param eventType - Event type to check
   * @returns True if there are subscribers
   */
  hasSubscribers(eventType: string): boolean;

  /**
   * Get count of subscribers for an event type.
   * 
   * @param eventType - Event type to check
   * @returns Number of subscribers
   */
  subscriberCount(eventType: string): number;

  /**
   * Clear all subscriptions.
   */
  clear(): void;
}

