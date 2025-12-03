/**
 * Subconscious Pack Types
 * 
 * Type definitions for the subconscious engine.
 * SUP-10: SubconsciousPack type + registry
 * 
 * The subconscious engine runs background packs that analyze data
 * and produce "nudges" - suggestions or alerts for users.
 */

// ============================================
// PACK IDENTIFIERS
// ============================================

/**
 * Known subconscious pack identifiers.
 * Add new pack IDs here as the system grows.
 */
export type SubconsciousPackId = 'stale_leads';

// ============================================
// CONTEXT TYPES
// ============================================

/**
 * Context passed to subconscious packs when they run.
 * Contains the user/account scope and optional timing info.
 */
export interface SubconContext {
  /** User ID for whom the pack is running */
  userId: string;
  /** Account ID (tenant) scope */
  accountId: string;
  /** Optional timestamp for the run (defaults to now if not provided) */
  timestamp?: string;
}

// ============================================
// OUTPUT TYPES
// ============================================

/**
 * A single nudge produced by a subconscious pack.
 * Nudges are suggestions or alerts for users to act on.
 */
export interface SubconNudge {
  /** Type of nudge (e.g., 'stale_lead', 'follow_up', etc.) */
  type: string;
  /** Human-readable message describing the nudge */
  message: string;
  /** Priority level (higher = more urgent) */
  priority: 'low' | 'medium' | 'high';
  /** Related entity ID (e.g., lead ID) */
  entityId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Output from a subconscious pack run.
 * Contains the list of nudges to create.
 */
export interface SubconOutput {
  /** List of nudges produced by this pack */
  nudges: SubconNudge[];
  /** Optional summary of what the pack found */
  summary?: string;
  /** Timestamp when the pack completed */
  completedAt: string;
}

// ============================================
// PACK INTERFACE
// ============================================

/**
 * Interface for a subconscious pack.
 * 
 * Each pack has an ID and a run function that analyzes data
 * and produces nudges based on the given context.
 * 
 * @example
 * ```ts
 * const staleLeadsPack: SubconsciousPack = {
 *   id: 'stale_leads',
 *   async run(context) {
 *     // Analyze leads for staleness...
 *     return { nudges: [], completedAt: new Date().toISOString() };
 *   }
 * };
 * ```
 */
export interface SubconsciousPack {
  /** Unique identifier for this pack */
  id: SubconsciousPackId;
  /** Run the pack with the given context */
  run(context: SubconContext): Promise<SubconOutput>;
}

// ============================================
// REGISTRY TYPES
// ============================================

/**
 * Error thrown when a subconscious pack is not found in the registry.
 */
export class SubconPackNotFoundError extends Error {
  constructor(packId: string) {
    super(`Subconscious pack not found: ${packId}`);
    this.name = 'SubconPackNotFoundError';
  }
}

/**
 * Result of running a subconscious pack.
 */
export interface SubconRunResult {
  /** Whether the pack ran successfully */
  success: boolean;
  /** Pack ID that was run */
  packId: SubconsciousPackId;
  /** Output from the pack (if successful) */
  output?: SubconOutput;
  /** Error message (if failed) */
  error?: string;
}

