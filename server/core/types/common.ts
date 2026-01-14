/**
 * Common Type Aliases and Utilities
 * 
 * Shared type definitions used throughout the Supervisor core module.
 */

/**
 * UUID string type alias for documentation
 */
export type UUID = string;

/**
 * ISO 8601 timestamp string
 */
export type ISOTimestamp = string;

/**
 * User identifier
 */
export type UserId = string;

/**
 * Account identifier for multi-tenant isolation
 */
export type AccountId = string;

/**
 * Agent identifier
 */
export type AgentId = string;

/**
 * Task identifier
 */
export type TaskId = string;

/**
 * Event identifier
 */
export type EventId = string;

/**
 * Correlation ID for request tracing
 */
export type CorrelationId = string;

/**
 * JSON-serializable value
 */
export type JsonValue = 
  | string 
  | number 
  | boolean 
  | null 
  | JsonValue[] 
  | { [key: string]: JsonValue };

/**
 * Generic key-value metadata
 */
export type Metadata = Record<string, unknown>;

/**
 * Result type for operations that can fail
 */
export type Result<T, E = Error> = 
  | { success: true; data: T }
  | { success: false; error: E };

/**
 * Async result type
 */
export type AsyncResult<T, E = Error> = Promise<Result<T, E>>;

/**
 * Handler function type for events
 */
export type EventHandler<T = unknown> = (event: T) => void | Promise<void>;

/**
 * Subscription handle for unsubscribing
 */
export interface Subscription {
  /**
   * Unique subscription identifier
   */
  id: string;

  /**
   * Unsubscribe from the event/channel
   */
  unsubscribe: () => void;
}

/**
 * Generic pagination parameters
 */
export interface PaginationParams {
  /**
   * Number of items to skip
   */
  offset?: number;

  /**
   * Maximum items to return
   */
  limit?: number;

  /**
   * Cursor for cursor-based pagination
   */
  cursor?: string;
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  /**
   * Result items
   */
  items: T[];

  /**
   * Total count (if available)
   */
  total?: number;

  /**
   * Whether more items exist
   */
  hasMore: boolean;

  /**
   * Next page cursor
   */
  nextCursor?: string;
}

/**
 * Health check status
 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Component health check result
 */
export interface HealthCheckResult {
  /**
   * Component name
   */
  component: string;

  /**
   * Health status
   */
  status: HealthStatus;

  /**
   * Status message
   */
  message?: string;

  /**
   * Check timestamp
   */
  checkedAt: ISOTimestamp;

  /**
   * Additional health details
   */
  details?: Record<string, unknown>;
}

