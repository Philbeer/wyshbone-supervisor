/**
 * Subconscious Vertical Mapping
 * 
 * SUP-16: Map brewery vertical → default subconscious packs
 * 
 * This module provides a clean mapping from verticals to their default
 * subconscious packs. Each vertical can specify which subcon packs should
 * run by default for accounts in that vertical.
 * 
 * Usage:
 *   import { getDefaultSubconPackIdsForVertical } from './SubconVerticalMapping';
 *   
 *   const packIds = getDefaultSubconPackIdsForVertical('brewery');
 *   // Returns: ['stale_leads']
 */

import type { VerticalId } from '../core/verticals/types';
import type { SubconsciousPackId } from './types';

// ============================================
// TYPES
// ============================================

/**
 * Configuration mapping a vertical to its default subconscious packs.
 * 
 * @example
 * ```ts
 * const breweryConfig: VerticalSubconConfig = {
 *   verticalId: 'brewery',
 *   defaultPackIds: ['stale_leads'],
 * };
 * ```
 */
export interface VerticalSubconConfig {
  /** The vertical this configuration applies to */
  verticalId: VerticalId;
  /** Default subconscious pack IDs that should run for this vertical */
  defaultPackIds: SubconsciousPackId[];
}

// ============================================
// CONFIGURATION
// ============================================

/**
 * Configuration array mapping each vertical to its default subcon packs.
 * 
 * Currently supports:
 * - brewery: stale_leads pack for tracking neglected leads
 * 
 * Add new vertical mappings here as verticals are created.
 */
const verticalSubconConfigs: VerticalSubconConfig[] = [
  {
    verticalId: 'brewery',
    defaultPackIds: [
      'stale_leads', // Track leads that haven't been contacted
    ],
  },
  // Future verticals can be added here:
  // {
  //   verticalId: 'dental',
  //   defaultPackIds: ['stale_leads', 'appointment_followup'],
  // },
];

// ============================================
// HELPERS
// ============================================

/**
 * Get the default subconscious pack IDs for a given vertical.
 * 
 * If the vertical is not found in the configuration, falls back to
 * the brewery config (since that's the only one we support right now).
 * If no configuration exists at all, returns an empty array.
 * 
 * @param verticalId - The vertical to get pack IDs for
 * @returns Array of SubconsciousPackId that should run for this vertical
 * 
 * @example
 * ```ts
 * const packIds = getDefaultSubconPackIdsForVertical('brewery');
 * // ['stale_leads']
 * 
 * const unknownPackIds = getDefaultSubconPackIdsForVertical('unknown' as any);
 * // ['stale_leads'] (falls back to brewery)
 * ```
 */
export function getDefaultSubconPackIdsForVertical(verticalId: VerticalId): SubconsciousPackId[] {
  const config = verticalSubconConfigs.find(c => c.verticalId === verticalId);
  
  if (config) {
    return config.defaultPackIds;
  }
  
  // Fallback: use brewery config if present, or empty array
  const breweryConfig = verticalSubconConfigs.find(c => c.verticalId === 'brewery');
  return breweryConfig ? breweryConfig.defaultPackIds : [];
}

/**
 * Get the full vertical subcon configuration for a given vertical.
 * 
 * @param verticalId - The vertical to get config for
 * @returns The config object if found, undefined otherwise
 */
export function getVerticalSubconConfig(verticalId: VerticalId): VerticalSubconConfig | undefined {
  return verticalSubconConfigs.find(c => c.verticalId === verticalId);
}

/**
 * List all vertical subcon configurations.
 * 
 * Returns a copy of the configurations array to prevent mutation.
 * 
 * @returns Array of all VerticalSubconConfig entries
 * 
 * @example
 * ```ts
 * const configs = listVerticalSubconConfigs();
 * // [{ verticalId: 'brewery', defaultPackIds: ['stale_leads'] }]
 * ```
 */
export function listVerticalSubconConfigs(): VerticalSubconConfig[] {
  return verticalSubconConfigs.slice();
}

/**
 * Check if a vertical has any default subcon packs configured.
 * 
 * @param verticalId - The vertical to check
 * @returns true if the vertical has at least one default pack
 */
export function hasDefaultSubconPacks(verticalId: VerticalId): boolean {
  const packIds = getDefaultSubconPackIdsForVertical(verticalId);
  return packIds.length > 0;
}
