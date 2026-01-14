/**
 * Message and Event Envelope Types
 * 
 * Envelopes wrap messages and events for transport through the Supervisor system.
 * They provide routing information, delivery guarantees, and tracing.
 */

import type { BaseSupervisorEvent, EventPriority } from './base-event';

/**
 * Delivery acknowledgment modes
 */
export type DeliveryMode = 'fire_and_forget' | 'at_least_once' | 'exactly_once';

/**
 * Envelope status for tracking delivery
 */
export type EnvelopeStatus = 'pending' | 'delivered' | 'acknowledged' | 'failed' | 'expired';

/**
 * Base envelope fields shared by message and event envelopes
 */
interface BaseEnvelope {
  /**
   * Unique envelope identifier
   */
  id: string;

  /**
   * ISO timestamp when envelope was created
   */
  timestamp: string;

  /**
   * Correlation ID for tracing
   */
  correlationId?: string;

  /**
   * Trace ID for distributed tracing
   */
  traceId?: string;

  /**
   * Envelope delivery status
   */
  status?: EnvelopeStatus;

  /**
   * Delivery mode/guarantee
   */
  deliveryMode?: DeliveryMode;

  /**
   * Time-to-live in milliseconds
   */
  ttlMs?: number;

  /**
   * ISO timestamp when envelope expires
   */
  expiresAt?: string;

  /**
   * Number of delivery attempts
   */
  attempts?: number;

  /**
   * Headers for routing and metadata
   */
  headers?: Record<string, string>;
}

/**
 * Message envelope for point-to-point communication.
 * 
 * Used when sending messages to specific agents or services.
 */
export interface MessageEnvelope<T = unknown> extends BaseEnvelope {
  /**
   * Envelope type discriminator
   */
  envelopeType: 'message';

  /**
   * Target recipient (agent ID, service name, etc.)
   */
  to: string;

  /**
   * Sender identifier
   */
  from: string;

  /**
   * Message type identifier
   */
  messageType: string;

  /**
   * Reply-to address for request/response patterns
   */
  replyTo?: string;

  /**
   * Message payload
   */
  payload: T;

  /**
   * Message priority
   */
  priority?: EventPriority;
}

/**
 * Event envelope for pub/sub communication.
 * 
 * Used when broadcasting events to multiple subscribers.
 */
export interface EventEnvelope<T extends BaseSupervisorEvent = BaseSupervisorEvent> extends BaseEnvelope {
  /**
   * Envelope type discriminator
   */
  envelopeType: 'event';

  /**
   * Channel/topic the event is published to
   */
  channel: string;

  /**
   * The wrapped event
   */
  event: T;

  /**
   * Subscriber IDs that should receive this event (optional filter)
   */
  targetSubscribers?: string[];

  /**
   * Subscriber IDs that should NOT receive this event
   */
  excludeSubscribers?: string[];
}

/**
 * Union type for all envelope types
 */
export type Envelope<T = unknown> = MessageEnvelope<T> | EventEnvelope;

/**
 * Envelope acknowledgment response
 */
export interface EnvelopeAck {
  /**
   * Envelope ID being acknowledged
   */
  envelopeId: string;

  /**
   * Whether the envelope was successfully processed
   */
  success: boolean;

  /**
   * ISO timestamp of acknowledgment
   */
  acknowledgedAt: string;

  /**
   * Acknowledging entity ID
   */
  acknowledgedBy: string;

  /**
   * Error message if processing failed
   */
  error?: string;
}

