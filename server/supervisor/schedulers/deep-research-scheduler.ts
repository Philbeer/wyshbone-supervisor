/**
 * Deep Research Poller Scheduler
 * 
 * Periodically triggers deep-research-poll jobs in Supervisor.
 * 
 * Configuration:
 * - ENABLE_DEEP_RESEARCH_POLLER: Set to "true" to enable (default: disabled)
 * - DEEP_RESEARCH_POLL_INTERVAL_MS: Polling interval in ms (default: 5000)
 * 
 * The scheduler calls the poll function directly (not via HTTP) for efficiency.
 */

import { 
  pollAllPendingRuns, 
  acquireDeepResearchPollLock, 
  releaseDeepResearchPollLock,
  isDeepResearchPollRunning 
} from '../jobs/handlers/deep-research-poll';

// ========================================
// CONFIGURATION
// ========================================

// Enable/disable via environment variable (default: disabled)
const POLLER_ENABLED = process.env.ENABLE_DEEP_RESEARCH_POLLER === 'true';

// Polling interval in milliseconds (default: 5000ms = 5 seconds)
const POLL_INTERVAL_MS = parseInt(
  process.env.DEEP_RESEARCH_POLL_INTERVAL_MS || '5000',
  10
);

// ========================================
// STATE
// ========================================

let schedulerInterval: NodeJS.Timeout | null = null;
let isSchedulerRunning = false;
let lastPollTime: Date | null = null;
let pollCount = 0;

// ========================================
// SCHEDULER FUNCTIONS
// ========================================

/**
 * Execute a single poll cycle
 */
async function executePollCycle(): Promise<void> {
  // Skip if already running (prevents overlap)
  if (isDeepResearchPollRunning()) {
    console.log('[DEEP_RESEARCH_SCHEDULER] Skipping - poll already in progress');
    return;
  }

  // Acquire lock
  if (!acquireDeepResearchPollLock()) {
    console.log('[DEEP_RESEARCH_SCHEDULER] Failed to acquire lock - skipping cycle');
    return;
  }

  try {
    pollCount++;
    lastPollTime = new Date();
    
    const result = await pollAllPendingRuns();
    
    // Only log when there's something to report
    if (result.pendingFound > 0 || pollCount % 60 === 0) {
      console.log(`[DEEP_RESEARCH_SCHEDULER] Poll #${pollCount}: ${result.pendingFound} pending, ${result.processed} processed (${result.succeeded} ok, ${result.failed} failed)`);
    }
    
  } catch (error: any) {
    console.error(`[DEEP_RESEARCH_SCHEDULER] Poll #${pollCount} failed:`, error.message);
  } finally {
    releaseDeepResearchPollLock();
  }
}

/**
 * Start the deep research poller scheduler
 */
export function startDeepResearchScheduler(): void {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (!POLLER_ENABLED) {
    console.log('[DEEP_RESEARCH_SCHEDULER] Deep Research poller: disabled');
    console.log('   Set ENABLE_DEEP_RESEARCH_POLLER=true to enable');
    return;
  }

  if (isSchedulerRunning) {
    console.log('[DEEP_RESEARCH_SCHEDULER] Scheduler already running');
    return;
  }

  // Production safety warnings
  if (isProduction) {
    console.log('');
    console.log('⚠️ '.repeat(20));
    console.log('[DEEP_RESEARCH_SCHEDULER] ⚠️  PRODUCTION WARNING ⚠️');
    console.log('[DEEP_RESEARCH_SCHEDULER] Deep Research poller is ENABLED in production.');
    console.log('[DEEP_RESEARCH_SCHEDULER] This will poll continuously and consume API resources.');
    console.log('⚠️ '.repeat(20));
    
    if (POLL_INTERVAL_MS < 3000) {
      console.log('');
      console.log('🚨 '.repeat(20));
      console.log('[DEEP_RESEARCH_SCHEDULER] 🚨 AGGRESSIVE POLLING WARNING 🚨');
      console.log(`[DEEP_RESEARCH_SCHEDULER] DEEP_RESEARCH_POLL_INTERVAL_MS is ${POLL_INTERVAL_MS}ms (< 3000ms).`);
      console.log('[DEEP_RESEARCH_SCHEDULER] This is an aggressive polling interval for production!');
      console.log('[DEEP_RESEARCH_SCHEDULER] Consider increasing to 5000ms or higher.');
      console.log('🚨 '.repeat(20));
    }
    console.log('');
  }

  console.log('[DEEP_RESEARCH_SCHEDULER] Deep Research poller: enabled');
  console.log(`   Interval: ${POLL_INTERVAL_MS}ms (${POLL_INTERVAL_MS / 1000}s)`);
  console.log('   Starting scheduler...');

  isSchedulerRunning = true;
  
  // Run initial poll immediately
  executePollCycle().catch(err => {
    console.error('[DEEP_RESEARCH_SCHEDULER] Initial poll failed:', err.message);
  });

  // Set up interval for subsequent polls
  schedulerInterval = setInterval(() => {
    executePollCycle().catch(err => {
      console.error('[DEEP_RESEARCH_SCHEDULER] Scheduled poll failed:', err.message);
    });
  }, POLL_INTERVAL_MS);

  console.log('[DEEP_RESEARCH_SCHEDULER] Scheduler started successfully\n');
}

/**
 * Stop the deep research poller scheduler
 */
export function stopDeepResearchScheduler(): void {
  if (!isSchedulerRunning) {
    console.log('[DEEP_RESEARCH_SCHEDULER] Scheduler is not running');
    return;
  }

  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }

  isSchedulerRunning = false;
  console.log('[DEEP_RESEARCH_SCHEDULER] Scheduler stopped');
  console.log(`   Total polls: ${pollCount}`);
  console.log(`   Last poll: ${lastPollTime?.toISOString() || 'never'}`);
}

/**
 * Check if the scheduler is running
 */
export function isDeepResearchSchedulerRunning(): boolean {
  return isSchedulerRunning;
}

/**
 * Get scheduler stats
 */
export function getSchedulerStats(): {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  pollCount: number;
  lastPollTime: string | null;
} {
  return {
    enabled: POLLER_ENABLED,
    running: isSchedulerRunning,
    intervalMs: POLL_INTERVAL_MS,
    pollCount,
    lastPollTime: lastPollTime?.toISOString() || null
  };
}

// ========================================
// EXPORTS
// ========================================

export default {
  startDeepResearchScheduler,
  stopDeepResearchScheduler,
  isDeepResearchSchedulerRunning,
  getSchedulerStats
};
