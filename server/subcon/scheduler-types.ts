/**
 * Subconscious Scheduler Types
 * 
 * Type definitions for the subconscious scheduler.
 * SUP-11: Simple scheduler (hourly/daily stub)
 * 
 * The scheduler periodically runs subconscious packs on defined schedules.
 */

import type { SubconsciousPackId } from './types';

// ============================================
// SCHEDULE IDENTIFIERS
// ============================================

/**
 * Known schedule identifiers.
 * Format: {packId}_{frequency} (e.g., "stale_leads_hourly")
 */
export type SubconScheduleId = 'stale_leads_hourly';

// ============================================
// SCHEDULE FREQUENCY
// ============================================

/**
 * How often a schedule should run.
 * 
 * - "hourly": Run once per hour (every 60 minutes)
 * - "daily": Run once per day (every 24 hours)
 * - "test_interval": Run very frequently for testing (every few seconds)
 */
export type ScheduleFrequency = 'hourly' | 'daily' | 'test_interval';

/**
 * Frequency intervals in milliseconds.
 */
export const FREQUENCY_INTERVALS: Record<ScheduleFrequency, number> = {
  hourly: 60 * 60 * 1000,      // 60 minutes
  daily: 24 * 60 * 60 * 1000,  // 24 hours
  test_interval: 5 * 1000,     // 5 seconds (for testing)
};

// ============================================
// SCHEDULE DEFINITION
// ============================================

/**
 * A subconscious schedule definition.
 * 
 * Defines when and how often a pack should run.
 */
export interface SubconSchedule {
  /** Unique identifier for this schedule */
  id: SubconScheduleId;
  /** The pack to run */
  packId: SubconsciousPackId;
  /** How often to run */
  frequency: ScheduleFrequency;
  /** Whether this schedule is active */
  enabled: boolean;
  /** Optional description */
  description?: string;
}

// ============================================
// SCHEDULER CONFIGURATION
// ============================================

/**
 * Configuration for the subconscious scheduler.
 */
export interface SubconSchedulerConfig {
  /** Whether the scheduler is enabled */
  enabled: boolean;
  /** Tick interval in milliseconds (how often scheduler checks for due schedules) */
  tickIntervalMs: number;
  /** Default context for packs (can be overridden per-schedule later) */
  defaultUserId: string;
  /** Default account ID (null means system-wide) */
  defaultAccountId: string;
}

/**
 * Default scheduler configuration.
 * Can be overridden via environment variables.
 */
export const DEFAULT_SCHEDULER_CONFIG: SubconSchedulerConfig = {
  enabled: true,
  tickIntervalMs: 60 * 1000, // Check every 60 seconds
  defaultUserId: 'system',
  defaultAccountId: 'system',
};

// ============================================
// SCHEDULE STATE
// ============================================

/**
 * Runtime state for a schedule.
 * Tracks when the schedule last ran.
 */
export interface ScheduleState {
  /** Schedule ID */
  scheduleId: SubconScheduleId;
  /** Last time this schedule ran (null if never) */
  lastRunAt: number | null;
  /** Last run result */
  lastRunSuccess: boolean | null;
  /** Error from last run (if failed) */
  lastRunError?: string;
}

// ============================================
// SCHEDULER STATUS
// ============================================

/**
 * Current status of the scheduler.
 */
export interface SubconSchedulerStatus {
  /** Whether the scheduler is running */
  running: boolean;
  /** When the scheduler started */
  startedAt: string | null;
  /** Number of ticks since start */
  tickCount: number;
  /** Schedule states */
  schedules: ScheduleState[];
}

