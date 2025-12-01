/**
 * Wyshbone Supervisor - Core Module
 * 
 * This module provides the foundational types and interfaces for the
 * Supervisor system. It defines the contracts that all agents, tasks,
 * events, and messages must follow.
 * 
 * SUP-1: Create /core/ folder + base interfaces
 * SUP-2: Implement SupervisorEventBus
 * SUP-3: Implement SupervisorScheduler
 * SUP-4: Define domain event types
 * 
 * @module core
 */

// Re-export all types from the types submodule
export * from './types';

// Re-export event bus types and implementation
export * from './event-bus';

// Re-export scheduler types and implementation
export * from './scheduler';

// Re-export domain event types
export * from './events';

// Export version for debugging
export const CORE_VERSION = '1.0.0';

