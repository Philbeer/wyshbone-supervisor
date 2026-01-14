/**
 * Events Module - Barrel Export
 * 
 * Re-exports all domain event types and constants.
 */

// Event type constants
export { EventTypes } from './types';
export type { EventType } from './types';

// Lead event payloads
export type {
  LeadCreatedPayload,
  LeadUpdatedPayload,
} from './types';

// Search event payloads
export type {
  SearchRunPayload,
  SearchCompletedPayload,
} from './types';

// Task event payloads
export type {
  TaskQueuedPayload,
  TaskStartedPayload,
  TaskCompletedPayload,
  TaskFailedPayload,
} from './types';

// Typed event definitions
export type {
  LeadCreatedEvent,
  LeadUpdatedEvent,
  SearchRunEvent,
  SearchCompletedEvent,
  TaskQueuedEvent,
  TaskStartedEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  DomainEvent,
} from './types';

