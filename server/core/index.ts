/**
 * Wyshbone Supervisor - Core Module
 * 
 * This module provides the foundational types and interfaces for the
 * Supervisor system. It defines the contracts that all agents, tasks,
 * events, and messages must follow.
 * 
 * SUP-1: Create /core/ folder + base interfaces
 * 
 * @module core
 */

// Re-export all types from the types submodule
export * from './types';

// Export version for debugging
export const CORE_VERSION = '1.0.0';

