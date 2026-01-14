/**
 * Daily Agent Cron Job
 *
 * Automatically runs the autonomous agent daily at 9am for all active users.
 * Generates goals, executes tasks, and handles errors gracefully per user.
 */

import cron from 'node-cron';
import { executeTasksForAllUsers } from '../autonomous-agent';
import { supabase } from '../supabase';

// ========================================
// TYPES
// ========================================

export interface CronExecutionResult {
  cronJobId: string;
  scheduledTime: string;
  actualStartTime: string;
  actualEndTime: string;
  totalUsers: number;
  successfulUsers: number;
  failedUsers: number;
  totalTasksGenerated: number;
  totalTasksExecuted: number;
  totalSuccessfulTasks: number;
  totalInterestingResults: number;
  userResults: Array<{
    userId: string;
    tasksGenerated: number;
    tasksExecuted: number;
    successful: number;
    interesting: number;
    error?: string;
  }>;
  duration: number;
}

// ========================================
// CONFIGURATION
// ========================================

// Default: 9am daily in local timezone
const DEFAULT_CRON_SCHEDULE = '0 9 * * *';

// Environment variable override for testing
const CRON_SCHEDULE = process.env.DAILY_AGENT_CRON_SCHEDULE || DEFAULT_CRON_SCHEDULE;

// Enable/disable cron job via environment variable
const CRON_ENABLED = process.env.DAILY_AGENT_ENABLED !== 'false';

// ========================================
// MAIN CRON EXECUTION
// ========================================

/**
 * Execute the daily agent for all users
 * This is the main function that runs on the cron schedule
 */
export async function executeDailyAgent(): Promise<CronExecutionResult> {
  const cronJobId = `daily_agent_${Date.now()}`;
  const scheduledTime = new Date().toISOString();
  const startTime = Date.now();

  console.log('\n' + '='.repeat(70));
  console.log('🤖 DAILY AGENT CRON JOB STARTED');
  console.log('='.repeat(70));
  console.log(`Job ID: ${cronJobId}`);
  console.log(`Time: ${scheduledTime}`);
  console.log('');

  const result: CronExecutionResult = {
    cronJobId,
    scheduledTime,
    actualStartTime: scheduledTime,
    actualEndTime: '',
    totalUsers: 0,
    successfulUsers: 0,
    failedUsers: 0,
    totalTasksGenerated: 0,
    totalTasksExecuted: 0,
    totalSuccessfulTasks: 0,
    totalInterestingResults: 0,
    userResults: [],
    duration: 0
  };

  try {
    // Execute tasks for all active users
    console.log('🔄 Processing all active users...\n');

    const executionResult = await executeTasksForAllUsers();

    // Aggregate results
    result.totalUsers = executionResult.results.length;
    result.successfulUsers = executionResult.success;
    result.failedUsers = executionResult.failed;
    result.userResults = executionResult.results;

    // Calculate totals
    executionResult.results.forEach(userResult => {
      result.totalTasksGenerated += userResult.tasksGenerated;
      result.totalTasksExecuted += userResult.tasksExecuted;
      result.totalSuccessfulTasks += userResult.successful;
      result.totalInterestingResults += userResult.interesting;
    });

    const endTime = Date.now();
    result.actualEndTime = new Date(endTime).toISOString();
    result.duration = endTime - startTime;

    console.log('\n' + '='.repeat(70));
    console.log('✅ DAILY AGENT CRON JOB COMPLETED');
    console.log('='.repeat(70));
    console.log(`Duration: ${result.duration}ms (${Math.round(result.duration / 1000)}s)`);
    console.log(`Users: ${result.successfulUsers}/${result.totalUsers} successful`);
    console.log(`Tasks Generated: ${result.totalTasksGenerated}`);
    console.log(`Tasks Executed: ${result.totalSuccessfulTasks}/${result.totalTasksExecuted} successful`);
    console.log(`Interesting Results: ${result.totalInterestingResults}`);
    console.log('='.repeat(70) + '\n');

    // Log to database
    await logCronExecution(result);

    return result;

  } catch (error: any) {
    const endTime = Date.now();
    result.actualEndTime = new Date(endTime).toISOString();
    result.duration = endTime - startTime;

    console.error('\n' + '='.repeat(70));
    console.error('❌ DAILY AGENT CRON JOB FAILED');
    console.error('='.repeat(70));
    console.error('Error:', error.message);
    console.error('='.repeat(70) + '\n');

    // Log failed execution
    await logCronExecution(result, error.message);

    // Report error to debug bridge
    await reportError('daily_cron_failed', error.message, { cronJobId, duration: result.duration });

    throw error;
  }
}

/**
 * Manual trigger for testing (bypasses cron schedule)
 */
export async function triggerDailyAgentManually(): Promise<CronExecutionResult> {
  console.log('🧪 Manual trigger requested - running daily agent immediately...\n');
  return executeDailyAgent();
}

// ========================================
// CRON SCHEDULING
// ========================================

let cronTask: cron.ScheduledTask | null = null;

/**
 * Start the daily cron job
 */
export function startDailyAgentCron(): void {
  if (!CRON_ENABLED) {
    console.log('⏸️  Daily agent cron is DISABLED (set DAILY_AGENT_ENABLED=true to enable)');
    return;
  }

  if (cronTask) {
    console.log('⚠️  Daily agent cron is already running');
    return;
  }

  console.log('🕐 Starting daily agent cron job...');
  console.log(`   Schedule: ${CRON_SCHEDULE} (${describeCronSchedule(CRON_SCHEDULE)})`);
  console.log(`   Next run: ${getNextCronRunTime()}`);

  cronTask = cron.schedule(CRON_SCHEDULE, async () => {
    try {
      await executeDailyAgent();
    } catch (error: any) {
      console.error('❌ Cron execution failed:', error.message);
    }
  }, {
    scheduled: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });

  console.log('✅ Daily agent cron job started successfully\n');
}

/**
 * Stop the daily cron job
 */
export function stopDailyAgentCron(): void {
  if (!cronTask) {
    console.log('⚠️  Daily agent cron is not running');
    return;
  }

  cronTask.stop();
  cronTask = null;
  console.log('⏹️  Daily agent cron job stopped');
}

/**
 * Check if cron job is running
 */
export function isDailyAgentCronRunning(): boolean {
  return cronTask !== null;
}

/**
 * Get next scheduled run time
 */
export function getNextCronRunTime(): string {
  if (!cronTask) {
    return 'Not scheduled';
  }

  // This is a simple estimation based on the cron schedule
  // For "0 9 * * *" (9am daily), calculate next 9am
  const now = new Date();
  const next = new Date(now);
  next.setHours(9, 0, 0, 0);

  // If 9am already passed today, schedule for tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next.toISOString();
}

/**
 * Describe cron schedule in human-readable format
 */
function describeCronSchedule(schedule: string): string {
  const descriptions: Record<string, string> = {
    '0 9 * * *': 'Daily at 9:00 AM',
    '*/5 * * * *': 'Every 5 minutes',
    '*/1 * * * *': 'Every minute',
    '0 */2 * * *': 'Every 2 hours',
    '0 0 * * *': 'Daily at midnight',
    '0 12 * * *': 'Daily at noon'
  };

  return descriptions[schedule] || schedule;
}

// ========================================
// DATABASE LOGGING
// ========================================

/**
 * Log cron execution to database
 */
async function logCronExecution(
  result: CronExecutionResult,
  error?: string
): Promise<void> {
  if (!supabase) {
    console.warn('[DAILY_CRON] Supabase not configured - skipping database logging');
    return;
  }

  try {
    const { error: dbError } = await supabase
      .from('agent_activities')
      .insert({
        user_id: 'system',
        agent_type: 'task_executor',
        activity_type: 'daily_cron',
        input_data: {
          cronJobId: result.cronJobId,
          scheduledTime: result.scheduledTime,
          cronSchedule: CRON_SCHEDULE
        },
        output_data: {
          totalUsers: result.totalUsers,
          successfulUsers: result.successfulUsers,
          failedUsers: result.failedUsers,
          totalTasksGenerated: result.totalTasksGenerated,
          totalTasksExecuted: result.totalTasksExecuted,
          totalSuccessfulTasks: result.totalSuccessfulTasks,
          totalInterestingResults: result.totalInterestingResults,
          userResults: result.userResults
        },
        metadata: {
          duration: result.duration,
          actualStartTime: result.actualStartTime,
          actualEndTime: result.actualEndTime
        },
        status: error ? 'failed' : 'completed',
        error: error || null,
        created_at: Date.now(),
        completed_at: Date.now()
      });

    if (dbError) {
      console.error('[DAILY_CRON] Error logging to database:', dbError);
    } else {
      console.log('[DAILY_CRON] Execution logged to database');
    }

  } catch (err: any) {
    console.error('[DAILY_CRON] Exception logging to database:', err.message);
  }
}

// ========================================
// ERROR REPORTING
// ========================================

/**
 * Report errors to debug bridge
 */
async function reportError(type: string, message: string, data: any = {}): Promise<void> {
  try {
    await fetch('http://localhost:9999/code-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        message,
        repo: 'wyshbone-supervisor',
        timestamp: new Date().toISOString(),
        context: 'daily-cron',
        ...data
      })
    });
  } catch (err) {
    // Debug bridge offline - fail silently
  }
}

// ========================================
// EXPORTS
// ========================================

export default {
  startDailyAgentCron,
  stopDailyAgentCron,
  isDailyAgentCronRunning,
  executeDailyAgent,
  triggerDailyAgentManually,
  getNextCronRunTime
};
