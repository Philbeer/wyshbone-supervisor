/**
 * Subconscious Scheduler Service
 * 
 * A simple in-process scheduler that periodically runs subconscious packs.
 * SUP-11: Simple scheduler (hourly/daily stub)
 * 
 * Features:
 * - Configurable tick interval
 * - Frequency-based scheduling (hourly/daily)
 * - In-memory last-run tracking
 * - Error handling (won't crash on pack failures)
 * - Enable/disable via environment variable
 * 
 * Usage:
 *   import { startSubconScheduler, stopSubconScheduler } from './subcon';
 *   
 *   // Start on server boot
 *   startSubconScheduler();
 *   
 *   // Stop gracefully
 *   stopSubconScheduler();
 */

import type { SubconContext } from './types';
import type { 
  SubconSchedule,
  SubconSchedulerConfig,
  ScheduleState,
  SubconSchedulerStatus,
  SubconScheduleId
} from './scheduler-types';
import { 
  DEFAULT_SCHEDULER_CONFIG, 
  FREQUENCY_INTERVALS 
} from './scheduler-types';
import { SUBCON_SCHEDULES, getEnabledSchedules } from './schedules';
import { runSubconPack, initializeSubconEngine } from './index';

// ============================================
// SCHEDULER STATE
// ============================================

/** Timer handle for the scheduler tick */
let tickTimer: ReturnType<typeof setInterval> | null = null;

/** Whether the scheduler is currently running */
let isRunning = false;

/** When the scheduler started */
let startedAt: string | null = null;

/** Number of ticks since start */
let tickCount = 0;

/** Current configuration */
let config: SubconSchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG };

/** Last run times for each schedule (in-memory) */
const scheduleStates = new Map<SubconScheduleId, ScheduleState>();

/** Time provider (for testability) */
let getNow: () => number = () => Date.now();

// ============================================
// CONFIGURATION
// ============================================

/**
 * Check if the scheduler is enabled via environment variable.
 * 
 * Set SUBCON_SCHEDULER_ENABLED=false to disable.
 */
function isSchedulerEnabled(): boolean {
  const envValue = process.env.SUBCON_SCHEDULER_ENABLED;
  
  if (envValue === undefined || envValue === '') {
    return config.enabled;
  }
  
  const normalized = envValue.toLowerCase().trim();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * Get the tick interval from environment or config.
 * 
 * Set SUBCON_TICK_INTERVAL_MS to override.
 */
function getTickIntervalMs(): number {
  const envValue = process.env.SUBCON_TICK_INTERVAL_MS;
  
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  
  return config.tickIntervalMs;
}

// ============================================
// SCHEDULE LOGIC
// ============================================

/**
 * Check if a schedule is due to run.
 * 
 * A schedule is due if:
 * - It has never run (lastRunAt is null), OR
 * - Enough time has passed since last run based on frequency
 * 
 * @param schedule - The schedule to check
 * @param now - Current timestamp in milliseconds
 * @returns true if the schedule should run now
 */
export function isScheduleDue(schedule: SubconSchedule, now: number): boolean {
  if (!schedule.enabled) {
    return false;
  }
  
  const state = scheduleStates.get(schedule.id);
  const lastRunAt = state?.lastRunAt ?? null;
  
  // Never run before - run now
  if (lastRunAt === null) {
    return true;
  }
  
  const interval = FREQUENCY_INTERVALS[schedule.frequency];
  const elapsed = now - lastRunAt;
  
  return elapsed >= interval;
}

/**
 * Get schedules that are due to run now.
 */
function getDueSchedules(now: number): SubconSchedule[] {
  return getEnabledSchedules().filter(schedule => isScheduleDue(schedule, now));
}

// ============================================
// EXECUTION
// ============================================

/**
 * Run a single schedule.
 * 
 * @param schedule - The schedule to run
 */
async function executeSchedule(schedule: SubconSchedule): Promise<void> {
  const now = getNow();
  
  console.log(`[SubconScheduler] Running schedule: ${schedule.id} (pack: ${schedule.packId})`);
  
  // Build context for the pack
  const context: SubconContext = {
    userId: config.defaultUserId,
    accountId: config.defaultAccountId,
    timestamp: new Date(now).toISOString(),
  };
  
  try {
    const result = await runSubconPack(schedule.packId, context);
    
    // Update state with success
    scheduleStates.set(schedule.id, {
      scheduleId: schedule.id,
      lastRunAt: now,
      lastRunSuccess: result.success,
      lastRunError: result.success ? undefined : result.error,
    });
    
    if (result.success) {
      const nudgeCount = result.output?.nudges.length ?? 0;
      console.log(`[SubconScheduler] Schedule ${schedule.id} completed - ${nudgeCount} nudge(s)`);
    } else {
      console.warn(`[SubconScheduler] Schedule ${schedule.id} returned failure: ${result.error}`);
    }
  } catch (error) {
    // Catch any unexpected errors - don't let them crash the scheduler
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[SubconScheduler] Schedule ${schedule.id} threw error:`, errorMessage);
    
    // Update state with failure
    scheduleStates.set(schedule.id, {
      scheduleId: schedule.id,
      lastRunAt: now,
      lastRunSuccess: false,
      lastRunError: errorMessage,
    });
  }
}

/**
 * Scheduler tick - runs on each interval.
 * 
 * Checks which schedules are due and runs them.
 */
async function tick(): Promise<void> {
  tickCount++;
  const now = getNow();
  
  const dueSchedules = getDueSchedules(now);
  
  if (dueSchedules.length > 0) {
    console.log(`[SubconScheduler] Tick #${tickCount} - ${dueSchedules.length} schedule(s) due`);
    
    // Run all due schedules (sequentially for simplicity)
    for (const schedule of dueSchedules) {
      await executeSchedule(schedule);
    }
  }
  // Silent tick if nothing is due (reduces log noise)
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Start the subconscious scheduler.
 * 
 * This will:
 * 1. Initialize the subconscious engine (register packs)
 * 2. Start a timer that ticks at the configured interval
 * 3. On each tick, run any schedules that are due
 * 
 * Safe to call multiple times - will only start once.
 * 
 * @param customConfig - Optional custom configuration
 */
export function startSubconScheduler(customConfig?: Partial<SubconSchedulerConfig>): void {
  // Check if enabled
  if (!isSchedulerEnabled()) {
    console.log('[SubconScheduler] Scheduler disabled via SUBCON_SCHEDULER_ENABLED=false');
    return;
  }
  
  // Already running?
  if (isRunning) {
    console.log('[SubconScheduler] Scheduler already running');
    return;
  }
  
  // Apply custom config
  if (customConfig) {
    config = { ...config, ...customConfig };
  }
  
  // Initialize the subcon engine (registers packs)
  initializeSubconEngine();
  
  const tickInterval = getTickIntervalMs();
  
  console.log('[SubconScheduler] Starting scheduler...');
  console.log(`[SubconScheduler] Tick interval: ${tickInterval}ms`);
  console.log(`[SubconScheduler] Schedules: ${SUBCON_SCHEDULES.length} defined, ${getEnabledSchedules().length} enabled`);
  
  isRunning = true;
  startedAt = new Date().toISOString();
  tickCount = 0;
  
  // Start the tick timer
  tickTimer = setInterval(() => {
    tick().catch(error => {
      // This should never happen since tick() handles its own errors,
      // but just in case...
      console.error('[SubconScheduler] Unexpected tick error:', error);
    });
  }, tickInterval);
  
  // Run first tick immediately
  tick().catch(error => {
    console.error('[SubconScheduler] Initial tick error:', error);
  });
  
  console.log('[SubconScheduler] Scheduler started');
}

/**
 * Stop the subconscious scheduler.
 * 
 * Safe to call multiple times.
 */
export function stopSubconScheduler(): void {
  if (!isRunning) {
    return;
  }
  
  console.log('[SubconScheduler] Stopping scheduler...');
  
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  
  isRunning = false;
  
  console.log('[SubconScheduler] Scheduler stopped');
}

/**
 * Get the current scheduler status.
 */
export function getSubconSchedulerStatus(): SubconSchedulerStatus {
  const schedules: ScheduleState[] = SUBCON_SCHEDULES.map(schedule => {
    const state = scheduleStates.get(schedule.id);
    return state ?? {
      scheduleId: schedule.id,
      lastRunAt: null,
      lastRunSuccess: null,
    };
  });
  
  return {
    running: isRunning,
    startedAt,
    tickCount,
    schedules,
  };
}

/**
 * Manually trigger a schedule to run (for testing/admin).
 * 
 * @param scheduleId - The schedule to run
 */
export async function triggerSchedule(scheduleId: SubconScheduleId): Promise<void> {
  const schedule = SUBCON_SCHEDULES.find(s => s.id === scheduleId);
  
  if (!schedule) {
    throw new Error(`Schedule not found: ${scheduleId}`);
  }
  
  await executeSchedule(schedule);
}

// ============================================
// TESTING UTILITIES
// ============================================

/**
 * Set a custom time provider (for testing).
 * @internal
 */
export function _setTimeProvider(provider: () => number): void {
  getNow = provider;
}

/**
 * Reset to default time provider.
 * @internal
 */
export function _resetTimeProvider(): void {
  getNow = () => Date.now();
}

/**
 * Clear all schedule states (for testing).
 * @internal
 */
export function _clearScheduleStates(): void {
  scheduleStates.clear();
}

/**
 * Get current schedule state (for testing).
 * @internal
 */
export function _getScheduleState(scheduleId: SubconScheduleId): ScheduleState | undefined {
  return scheduleStates.get(scheduleId);
}

/**
 * Force-set a schedule's last run time (for testing).
 * @internal
 */
export function _setScheduleLastRun(scheduleId: SubconScheduleId, lastRunAt: number | null): void {
  scheduleStates.set(scheduleId, {
    scheduleId,
    lastRunAt,
    lastRunSuccess: null,
  });
}

/**
 * Reset scheduler state completely (for testing).
 * @internal
 */
export function _resetScheduler(): void {
  stopSubconScheduler();
  scheduleStates.clear();
  config = { ...DEFAULT_SCHEDULER_CONFIG };
  startedAt = null;
  tickCount = 0;
  _resetTimeProvider();
}

