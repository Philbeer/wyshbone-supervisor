/**
 * Subconscious Pack Registry
 * 
 * Registry for storing and executing subconscious packs.
 * SUP-10: SubconsciousPack type + registry
 * 
 * Usage:
 *   import { registerSubconPack, runSubconPack } from './subcon';
 *   
 *   registerSubconPack(myPack);
 *   const result = await runSubconPack('stale_leads', { userId: '...', accountId: '...' });
 */

import type { 
  SubconsciousPack, 
  SubconsciousPackId, 
  SubconContext, 
  SubconOutput,
  SubconRunResult 
} from './types';
import { SubconPackNotFoundError } from './types';

// ============================================
// REGISTRY STORAGE
// ============================================

/**
 * Internal map storing registered subconscious packs.
 * Key is the pack ID, value is the pack implementation.
 */
const packRegistry = new Map<SubconsciousPackId, SubconsciousPack>();

// ============================================
// REGISTRY API
// ============================================

/**
 * Register a subconscious pack.
 * 
 * @param pack - The pack to register
 * @throws Error if a pack with the same ID is already registered
 * 
 * @example
 * ```ts
 * registerSubconPack({
 *   id: 'stale_leads',
 *   async run(ctx) { return { nudges: [], completedAt: new Date().toISOString() }; }
 * });
 * ```
 */
export function registerSubconPack(pack: SubconsciousPack): void {
  if (packRegistry.has(pack.id)) {
    console.warn(`[SubconRegistry] Overwriting existing pack: ${pack.id}`);
  }
  packRegistry.set(pack.id, pack);
  console.log(`[SubconRegistry] Registered pack: ${pack.id}`);
}

/**
 * Get a registered subconscious pack by ID.
 * 
 * @param id - The pack ID to look up
 * @returns The pack if found, undefined otherwise
 * 
 * @example
 * ```ts
 * const pack = getSubconPack('stale_leads');
 * if (pack) {
 *   await pack.run(context);
 * }
 * ```
 */
export function getSubconPack(id: SubconsciousPackId): SubconsciousPack | undefined {
  return packRegistry.get(id);
}

/**
 * Check if a pack is registered.
 * 
 * @param id - The pack ID to check
 * @returns true if registered, false otherwise
 */
export function hasSubconPack(id: SubconsciousPackId): boolean {
  return packRegistry.has(id);
}

/**
 * List all registered pack IDs.
 * 
 * @returns Array of registered pack IDs
 */
export function listSubconPacks(): SubconsciousPackId[] {
  return Array.from(packRegistry.keys());
}

/**
 * Run a subconscious pack by ID.
 * 
 * This is the main entry point for executing packs.
 * It handles lookup, execution, and error wrapping.
 * 
 * @param id - The pack ID to run
 * @param context - Context for the pack run
 * @returns Result object with success status and output/error
 * @throws SubconPackNotFoundError if pack is not registered
 * 
 * @example
 * ```ts
 * const result = await runSubconPack('stale_leads', {
 *   userId: 'user_123',
 *   accountId: 'account_456'
 * });
 * 
 * if (result.success) {
 *   console.log('Nudges:', result.output?.nudges);
 * } else {
 *   console.error('Failed:', result.error);
 * }
 * ```
 */
export async function runSubconPack(
  id: SubconsciousPackId,
  context: SubconContext
): Promise<SubconRunResult> {
  const pack = packRegistry.get(id);
  
  if (!pack) {
    throw new SubconPackNotFoundError(id);
  }
  
  console.log(`[SubconRegistry] Running pack: ${id} for user: ${context.userId}`);
  
  try {
    const output = await pack.run(context);
    
    console.log(`[SubconRegistry] Pack ${id} completed - ${output.nudges.length} nudge(s)`);
    
    return {
      success: true,
      packId: id,
      output
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[SubconRegistry] Pack ${id} failed:`, errorMessage);
    
    return {
      success: false,
      packId: id,
      error: errorMessage
    };
  }
}

// ============================================
// TESTING UTILITIES
// ============================================

/**
 * Clear all registered packs (for testing only).
 * @internal
 */
export function _clearRegistry(): void {
  packRegistry.clear();
}

/**
 * Get the current registry size (for testing only).
 * @internal
 */
export function _getRegistrySize(): number {
  return packRegistry.size;
}

