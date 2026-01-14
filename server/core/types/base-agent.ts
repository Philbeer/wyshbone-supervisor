/**
 * Base Agent Configuration Types
 * 
 * Defines the configuration structure for all Supervisor agents.
 * Agents are autonomous units that respond to events and execute tasks.
 */

/**
 * Agent operational status
 */
export type AgentStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'error';

/**
 * Agent capability identifiers
 */
export type AgentCapability = 
  | 'lead_generation'
  | 'email_enrichment'
  | 'data_research'
  | 'monitoring'
  | 'scheduling'
  | 'system'
  | string; // Allow custom capabilities

/**
 * Base configuration for all Supervisor agents.
 * 
 * Each agent type can extend this with specific config options.
 */
export interface BaseAgentConfig {
  /**
   * Unique identifier for the agent instance
   */
  id: string;

  /**
   * Human-readable agent name
   */
  name: string;

  /**
   * Agent description/purpose
   */
  description?: string;

  /**
   * Agent version string
   */
  version?: string;

  /**
   * Whether the agent is enabled
   */
  enabled: boolean;

  /**
   * List of capabilities this agent provides
   */
  capabilities?: AgentCapability[];

  /**
   * Event types this agent subscribes to
   */
  subscribesTo?: string[];

  /**
   * Maximum concurrent tasks this agent can handle
   */
  maxConcurrentTasks?: number;

  /**
   * Task timeout in milliseconds
   */
  taskTimeoutMs?: number;

  /**
   * Retry configuration for failed tasks
   */
  retryConfig?: AgentRetryConfig;

  /**
   * Agent-specific settings
   */
  settings?: Record<string, unknown>;
}

/**
 * Retry configuration for agent tasks
 */
export interface AgentRetryConfig {
  /**
   * Maximum number of retry attempts
   */
  maxRetries: number;

  /**
   * Base delay between retries in milliseconds
   */
  baseDelayMs: number;

  /**
   * Whether to use exponential backoff
   */
  exponentialBackoff?: boolean;

  /**
   * Maximum delay cap in milliseconds
   */
  maxDelayMs?: number;
}

/**
 * Agent metadata for registry and introspection
 */
export interface AgentMetadata {
  /**
   * Agent registration timestamp
   */
  registeredAt: string;

  /**
   * Last activity timestamp
   */
  lastActiveAt?: string;

  /**
   * Current operational status
   */
  status: AgentStatus;

  /**
   * Number of tasks processed
   */
  tasksProcessed?: number;

  /**
   * Number of tasks failed
   */
  tasksFailed?: number;

  /**
   * Additional runtime metadata
   */
  runtime?: Record<string, unknown>;
}

