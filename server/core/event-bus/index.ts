/**
 * Event Bus Module - Barrel Export
 * 
 * Re-exports all event bus types and implementations.
 */

// Types
export type {
  SupervisorEventBus,
  SubscribeOptions,
  PublishOptions,
  PublishResult,
} from './types';

// Implementation
export { InMemoryEventBus, createEventBus } from './in-memory-event-bus';

