/**
 * Subconscious Engine Module
 * 
 * SUP-10: SubconsciousPack type + registry
 * 
 * This module provides the foundation for the subconscious engine:
 * - Type definitions for packs, contexts, and outputs
 * - Registry for storing and executing packs
 * - Built-in packs (stale_leads placeholder)
 * 
 * Usage:
 *   import { 
 *     registerSubconPack, 
 *     runSubconPack, 
 *     staleLeadsPack 
 *   } from './subcon';
 *   
 *   // Register the built-in pack
 *   registerSubconPack(staleLeadsPack);
 *   
 *   // Run a pack
 *   const result = await runSubconPack('stale_leads', {
 *     userId: 'user_123',
 *     accountId: 'account_456'
 *   });
 * 
 * @module subcon
 */

// Re-export all types
export * from './types';

// Re-export registry functions
export {
  registerSubconPack,
  getSubconPack,
  hasSubconPack,
  listSubconPacks,
  runSubconPack,
  // Testing utilities
  _clearRegistry,
  _getRegistrySize
} from './registry';

// Re-export packs
export * from './packs';

// ============================================
// AUTO-REGISTRATION
// ============================================

import { registerSubconPack } from './registry';
import { staleLeadsPack } from './packs';

/**
 * Initialize the subconscious engine by registering all built-in packs.
 * Call this once at startup to make all packs available.
 */
export function initializeSubconEngine(): void {
  console.log('[SubconEngine] Initializing...');
  
  // Register all built-in packs
  registerSubconPack(staleLeadsPack);
  
  console.log('[SubconEngine] Initialization complete');
}

// Export version for debugging
export const SUBCON_VERSION = '1.0.0';

