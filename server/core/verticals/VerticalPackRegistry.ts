/**
 * Vertical Pack Registry
 * 
 * Registry for storing and retrieving vertical packs.
 * SUP-14: BreweryVerticalPack (pipeline, scripts, queries)
 * 
 * Usage:
 *   import { getVerticalPack, listVerticalPacks } from './core/verticals';
 *   
 *   const breweryPack = getVerticalPack('brewery');
 *   const allPacks = listVerticalPacks();
 */

import type { VerticalId, VerticalPack } from './types';
import { BreweryVerticalPack } from '../../verticals/brewery/BreweryVerticalPack';

// ============================================
// REGISTRY STORAGE
// ============================================

/**
 * Registry of vertical packs indexed by vertical ID.
 * Add new verticals here as they are implemented.
 */
const verticalPacksById: Record<VerticalId, VerticalPack> = {
  brewery: BreweryVerticalPack,
};

// ============================================
// REGISTRY API
// ============================================

/**
 * Get a vertical pack by its ID.
 * 
 * @param id - The vertical ID to look up
 * @returns The vertical pack if found, undefined otherwise
 * 
 * @example
 * ```ts
 * const pack = getVerticalPack('brewery');
 * if (pack) {
 *   console.log(pack.leadPipeline);
 * }
 * ```
 */
export function getVerticalPack(id: VerticalId): VerticalPack | undefined {
  return verticalPacksById[id];
}

/**
 * List all registered vertical packs.
 * 
 * @returns Array of all registered vertical packs
 * 
 * @example
 * ```ts
 * const packs = listVerticalPacks();
 * packs.forEach(p => console.log(p.name));
 * ```
 */
export function listVerticalPacks(): VerticalPack[] {
  return Object.values(verticalPacksById);
}

/**
 * List all registered vertical IDs.
 * 
 * @returns Array of all registered vertical IDs
 */
export function listVerticalIds(): VerticalId[] {
  return Object.keys(verticalPacksById) as VerticalId[];
}

/**
 * Check if a vertical pack is registered.
 * 
 * @param id - The vertical ID to check
 * @returns true if registered, false otherwise
 */
export function hasVerticalPack(id: VerticalId): boolean {
  return id in verticalPacksById;
}
