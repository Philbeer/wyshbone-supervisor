/**
 * Base Supervisor Event Types
 * 
 * Core event interfaces used throughout the Supervisor system.
 * All events flow through the EventBus and share this base structure.
 */

/**
 * Event priority levels for processing order
 */
export type EventPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Event lifecycle status
 */
export type EventStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Base interface for all Supervisor events.
 * 
 * Every event in the system extends this interface to ensure
 * consistent structure for routing, logging, and tracing.
 */
export interface BaseSupervisorEvent {
  /**
   * Unique identifier for this event instance
   */
  id: string;

  /**
   * Event type identifier (e.g., 'agent.started', 'task.completed')
   */
  type: string;

  /**
   * ISO timestamp when the event was created
   */
  timestamp: string;

  /**
   * Source of the event (agent ID, 'supervisor', 'system', etc.)
   */
  source: string;

  /**
   * Optional correlation ID for tracing related events
   */
  correlationId?: string;

  /**
   * Optional parent event ID for event chains
   */
  parentEventId?: string;

  /**
   * Event priority for processing order
   */
  priority?: EventPriority;

  /**
   * Arbitrary metadata for extensibility
   */
  metadata?: Record<string, unknown>;
}

/**
 * Generic typed event that extends BaseSupervisorEvent with a payload
 */
export interface TypedSupervisorEvent<T = unknown> extends BaseSupervisorEvent {
  /**
   * Event-specific payload data
   */
  payload: T;
}

