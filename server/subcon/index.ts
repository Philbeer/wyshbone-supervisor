/**
 * Subconscious Engine Module
 * 
 * SUP-10: SubconsciousPack type + registry
 * SUP-11: Simple scheduler (hourly/daily stub)
 * 
 * This module provides the foundation for the subconscious engine:
 * - Type definitions for packs, contexts, and outputs
 * - Registry for storing and executing packs
 * - Built-in packs (stale_leads placeholder)
 * - Scheduler for periodic pack execution
 * 
 * Usage:
 *   import { 
 *     registerSubconPack, 
 *     runSubconPack, 
 *     startSubconScheduler,
 *     staleLeadsPack 
 *   } from './subcon';
 *   
 *   // Start the scheduler (registers packs automatically)
 *   startSubconScheduler();
 *   
 *   // Or manually register and run packs
 *   registerSubconPack(staleLeadsPack);
 *   const result = await runSubconPack('stale_leads', {
 *     userId: 'user_123',
 *     accountId: 'account_456'
 *   });
 * 
 * @module subcon
 */

// Re-export all types
export * from './types';
export * from './scheduler-types';

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

// Re-export schedules config
export { SUBCON_SCHEDULES, getScheduleById, getEnabledSchedules } from './schedules';

// Re-export scheduler functions
export {
  startSubconScheduler,
  stopSubconScheduler,
  getSubconSchedulerStatus,
  triggerSchedule,
  isScheduleDue,
  // Testing utilities
  _setTimeProvider,
  _resetTimeProvider,
  _clearScheduleStates,
  _getScheduleState,
  _setScheduleLastRun,
  _resetScheduler
} from './scheduler';

// ============================================
// AUTO-REGISTRATION
// ============================================

import { registerSubconPack } from './registry';
import { staleLeadsPack } from './packs';

/** Track if engine has been initialized */
let engineInitialized = false;

/**
 * Initialize the subconscious engine by registering all built-in packs.
 * Call this once at startup to make all packs available.
 * 
 * Safe to call multiple times - will only initialize once.
 */
export function initializeSubconEngine(): void {
  if (engineInitialized) {
    return;
  }
  
  console.log('[SubconEngine] Initializing...');
  
  // Register all built-in packs
  registerSubconPack(staleLeadsPack);
  
  engineInitialized = true;
  console.log('[SubconEngine] Initialization complete');
}

/**
 * Reset engine initialization state (for testing).
 * @internal
 */
export function _resetEngineInitialized(): void {
  engineInitialized = false;
}

// Export version for debugging
export const SUBCON_VERSION = '1.1.0';

