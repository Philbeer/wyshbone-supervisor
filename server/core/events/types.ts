/**
 * Domain Event Types
 * 
 * Strongly-typed event definitions for the Supervisor system.
 * These events flow through the EventBus and are used for
 * internal coordination between agents and components.
 */

import type { 
  BaseSupervisorEvent, 
  TypedSupervisorEvent,
  TaskStatus,
  TaskPriority,
  Metadata 
} from '../types';

// ============================================
// EVENT TYPE CONSTANTS
// ============================================

/**
 * All domain event type identifiers
 */
export const EventTypes = {
  // Lead events
  LEAD_CREATED: 'lead.created',
  LEAD_UPDATED: 'lead.updated',
  
  // Search events
  SEARCH_RUN: 'search.run',
  SEARCH_COMPLETED: 'search.completed',
  
  // Task events
  TASK_QUEUED: 'task.queued',
  TASK_STARTED: 'task.started',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
} as const;

export type EventType = typeof EventTypes[keyof typeof EventTypes];

// ============================================
// LEAD EVENT PAYLOADS
// ============================================

/**
 * Payload for LeadCreated event
 */
export interface LeadCreatedPayload {
  /**
   * Unique lead identifier
   */
  leadId: string;

  /**
   * User who owns this lead
   */
  userId: string;

  /**
   * Optional account for multi-tenant isolation
   */
  accountId?: string;

  /**
   * Lead source (e.g., 'google_places', 'hunter', 'manual')
   */
  source: string;

  /**
   * Business/contact name
   */
  name: string;

  /**
   * Business domain or website
   */
  domain?: string;

  /**
   * Contact email address
   */
  email?: string;

  /**
   * Lead score (0-100)
   */
  score?: number;

  /**
   * Additional lead data
   */
  data?: Metadata;
}

/**
 * Payload for LeadUpdated event
 */
export interface LeadUpdatedPayload {
  /**
   * Lead identifier
   */
  leadId: string;

  /**
   * User who owns this lead
   */
  userId: string;

  /**
   * Optional account for multi-tenant isolation
   */
  accountId?: string;

  /**
   * Fields that were updated
   */
  updatedFields: string[];

  /**
   * Previous values (partial)
   */
  previousValues?: Metadata;

  /**
   * New values (partial)
   */
  newValues?: Metadata;

  /**
   * Update source/reason
   */
  updateSource?: string;
}

// ============================================
// SEARCH EVENT PAYLOADS
// ============================================

/**
 * Payload for SearchRun event
 */
export interface SearchRunPayload {
  /**
   * Unique search identifier
   */
  searchId: string;

  /**
   * User who initiated the search
   */
  userId: string;

  /**
   * Optional account for multi-tenant isolation
   */
  accountId?: string;

  /**
   * Search query string
   */
  query: string;

  /**
   * Target region/location
   */
  region?: string;

  /**
   * Target country code
   */
  country?: string;

  /**
   * Data source being searched
   */
  dataSource: string;

  /**
   * Maximum results requested
   */
  maxResults?: number;

  /**
   * Search filters applied
   */
  filters?: Metadata;
}

/**
 * Payload for SearchCompleted event
 */
export interface SearchCompletedPayload {
  /**
   * Search identifier
   */
  searchId: string;

  /**
   * User who initiated the search
   */
  userId: string;

  /**
   * Optional account for multi-tenant isolation
   */
  accountId?: string;

  /**
   * Whether search succeeded
   */
  success: boolean;

  /**
   * Number of results found
   */
  resultCount: number;

  /**
   * Data source that was searched
   */
  dataSource: string;

  /**
   * Whether fallback was used
   */
  fallbackUsed?: boolean;

  /**
   * Fallback source if used
   */
  fallbackSource?: string;

  /**
   * Search duration in milliseconds
   */
  durationMs: number;

  /**
   * Error message if failed
   */
  error?: string;
}

// ============================================
// TASK EVENT PAYLOADS
// ============================================

/**
 * Payload for TaskQueued event
 */
export interface TaskQueuedPayload {
  /**
   * Task identifier
   */
  taskId: string;

  /**
   * Task type identifier
   */
  taskType: string;

  /**
   * User who queued the task
   */
  userId: string;

  /**
   * Optional account for multi-tenant isolation
   */
  accountId?: string;

  /**
   * Agent assigned to execute (if known)
   */
  agentId?: string;

  /**
   * Task priority
   */
  priority?: TaskPriority;

  /**
   * Position in queue
   */
  queuePosition?: number;

  /**
   * Task input summary (not full payload)
   */
  inputSummary?: string;
}

/**
 * Payload for TaskStarted event
 */
export interface TaskStartedPayload {
  /**
   * Task identifier
   */
  taskId: string;

  /**
   * Task type identifier
   */
  taskType: string;

  /**
   * User who owns the task
   */
  userId: string;

  /**
   * Optional account for multi-tenant isolation
   */
  accountId?: string;

  /**
   * Agent executing the task
   */
  agentId: string;

  /**
   * Attempt number (1 for first attempt)
   */
  attempt: number;

  /**
   * Maximum attempts allowed
   */
  maxAttempts?: number;
}

/**
 * Payload for TaskCompleted event
 */
export interface TaskCompletedPayload {
  /**
   * Task identifier
   */
  taskId: string;

  /**
   * Task type identifier
   */
  taskType: string;

  /**
   * User who owns the task
   */
  userId: string;

  /**
   * Optional account for multi-tenant isolation
   */
  accountId?: string;

  /**
   * Agent that executed the task
   */
  agentId: string;

  /**
   * Final task status
   */
  status: 'succeeded';

  /**
   * Execution duration in milliseconds
   */
  durationMs: number;

  /**
   * Number of attempts taken
   */
  attempts: number;

  /**
   * Result summary (not full output)
   */
  resultSummary?: string;

  /**
   * Output metadata
   */
  outputMeta?: Metadata;
}

/**
 * Payload for TaskFailed event
 */
export interface TaskFailedPayload {
  /**
   * Task identifier
   */
  taskId: string;

  /**
   * Task type identifier
   */
  taskType: string;

  /**
   * User who owns the task
   */
  userId: string;

  /**
   * Optional account for multi-tenant isolation
   */
  accountId?: string;

  /**
   * Agent that attempted the task
   */
  agentId: string;

  /**
   * Final task status
   */
  status: 'failed' | 'timeout' | 'cancelled';

  /**
   * Execution duration in milliseconds
   */
  durationMs: number;

  /**
   * Number of attempts made
   */
  attempts: number;

  /**
   * Error code
   */
  errorCode?: string;

  /**
   * Error message
   */
  errorMessage: string;

  /**
   * Whether task can be retried
   */
  retryable?: boolean;
}

// ============================================
// TYPED EVENT DEFINITIONS
// ============================================

/**
 * LeadCreated domain event
 */
export type LeadCreatedEvent = TypedSupervisorEvent<LeadCreatedPayload>;

/**
 * LeadUpdated domain event
 */
export type LeadUpdatedEvent = TypedSupervisorEvent<LeadUpdatedPayload>;

/**
 * SearchRun domain event
 */
export type SearchRunEvent = TypedSupervisorEvent<SearchRunPayload>;

/**
 * SearchCompleted domain event
 */
export type SearchCompletedEvent = TypedSupervisorEvent<SearchCompletedPayload>;

/**
 * TaskQueued domain event
 */
export type TaskQueuedEvent = TypedSupervisorEvent<TaskQueuedPayload>;

/**
 * TaskStarted domain event
 */
export type TaskStartedEvent = TypedSupervisorEvent<TaskStartedPayload>;

/**
 * TaskCompleted domain event
 */
export type TaskCompletedEvent = TypedSupervisorEvent<TaskCompletedPayload>;

/**
 * TaskFailed domain event
 */
export type TaskFailedEvent = TypedSupervisorEvent<TaskFailedPayload>;

/**
 * Union of all domain events
 */
export type DomainEvent =
  | LeadCreatedEvent
  | LeadUpdatedEvent
  | SearchRunEvent
  | SearchCompletedEvent
  | TaskQueuedEvent
  | TaskStartedEvent
  | TaskCompletedEvent
  | TaskFailedEvent;

