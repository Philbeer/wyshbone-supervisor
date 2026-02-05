/**
 * Monitor Worker Job Handler
 * 
 * Supervisor's authoritative implementation of the monitor-worker job that:
 * 1. Checks all active scheduled monitors for issues (stalled, no_plan, repeated_failures)
 * 2. Checks users with objectives but no active monitors
 * 3. Publishes monitoring events for alerting
 * 
 * This replaces the UI's server/monitor-worker.ts logic.
 * 
 * AFR Events:
 * - job_started: When the job begins
 * - job_progress: "loaded monitors", "checked X items", "created Y alerts"
 * - job_completed: With resultSummary (counts)
 * - job_failed: With error details
 * 
 * Safety:
 * - Idempotent: Can be run repeatedly without side effects
 * - Already-running guard: Prevents overlapping runs of the same jobType
 */

import { supabase } from '../../../supabase';
import { monitorGoalsOnce, publishGoalMonitorEvents, type GoalMonitorEvent } from '../../../goal-monitoring';
import type { Job } from '../../jobs';

export interface MonitorWorkerResult {
  success: boolean;
  monitorsLoaded: number;
  monitorsChecked: number;
  issuesFound: number;
  alertsCreated: number;
  eventsByStatus: {
    no_plan: number;
    stalled: number;
    repeated_failures: number;
  };
  durationMs: number;
}

export interface ProgressCallback {
  (progress: number, message: string): Promise<void>;
}

const runningJobs = new Set<string>();

export function isMonitorWorkerRunning(): boolean {
  return runningJobs.has('monitor-worker');
}

export async function runMonitorWorker(
  job: Job,
  onProgress: ProgressCallback
): Promise<MonitorWorkerResult> {
  const startTime = Date.now();
  
  console.log('\n' + '='.repeat(70));
  console.log('[MONITOR_WORKER] Starting monitor worker job');
  console.log('='.repeat(70));
  console.log(`Job ID: ${job.jobId}`);
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('');

  const result: MonitorWorkerResult = {
    success: false,
    monitorsLoaded: 0,
    monitorsChecked: 0,
    issuesFound: 0,
    alertsCreated: 0,
    eventsByStatus: {
      no_plan: 0,
      stalled: 0,
      repeated_failures: 0
    },
    durationMs: 0
  };

  try {
    await onProgress(5, 'Initializing monitor worker...');

    if (!supabase) {
      console.warn('[MONITOR_WORKER] Supabase not configured - cannot run monitors');
      await onProgress(100, 'Supabase not configured - no monitoring possible');
      result.success = true;
      result.durationMs = Date.now() - startTime;
      return result;
    }

    await onProgress(10, 'Loading active monitors...');

    const { data: monitors, error: monitorsError } = await supabase
      .from('scheduled_monitors')
      .select('id')
      .eq('is_active', 1);

    if (monitorsError) {
      console.error('[MONITOR_WORKER] Error fetching monitors:', monitorsError);
      throw new Error(`Failed to fetch monitors: ${monitorsError.message}`);
    }

    result.monitorsLoaded = monitors?.length || 0;
    console.log(`[MONITOR_WORKER] Loaded ${result.monitorsLoaded} active monitor(s)`);
    
    await onProgress(25, `Loaded ${result.monitorsLoaded} active monitor(s)`);

    await onProgress(30, 'Checking monitors for issues...');

    const events: GoalMonitorEvent[] = await monitorGoalsOnce();
    
    result.monitorsChecked = result.monitorsLoaded;
    result.issuesFound = events.length;

    for (const event of events) {
      if (event.status === 'no_plan') {
        result.eventsByStatus.no_plan++;
      } else if (event.status === 'stalled') {
        result.eventsByStatus.stalled++;
      } else if (event.status === 'repeated_failures') {
        result.eventsByStatus.repeated_failures++;
      }
    }

    console.log(`[MONITOR_WORKER] Found ${result.issuesFound} issue(s):`);
    console.log(`  - no_plan: ${result.eventsByStatus.no_plan}`);
    console.log(`  - stalled: ${result.eventsByStatus.stalled}`);
    console.log(`  - repeated_failures: ${result.eventsByStatus.repeated_failures}`);

    await onProgress(60, `Checked ${result.monitorsChecked} monitors, found ${result.issuesFound} issues`);

    await onProgress(70, 'Publishing monitoring events...');

    await publishGoalMonitorEvents(events);
    result.alertsCreated = events.length;

    console.log(`[MONITOR_WORKER] Published ${result.alertsCreated} alert event(s)`);
    
    await onProgress(90, `Created ${result.alertsCreated} alert(s) for issues`);

    result.durationMs = Date.now() - startTime;
    result.success = true;

    console.log('\n' + '='.repeat(70));
    console.log('[MONITOR_WORKER] Monitor worker completed successfully');
    console.log('='.repeat(70));
    console.log(`Monitors loaded: ${result.monitorsLoaded}`);
    console.log(`Monitors checked: ${result.monitorsChecked}`);
    console.log(`Issues found: ${result.issuesFound}`);
    console.log(`Alerts created: ${result.alertsCreated}`);
    console.log(`Duration: ${result.durationMs}ms (${Math.round(result.durationMs / 1000)}s)`);
    console.log('='.repeat(70) + '\n');

    return result;

  } catch (error: any) {
    result.durationMs = Date.now() - startTime;
    result.success = false;

    console.error('\n' + '='.repeat(70));
    console.error('[MONITOR_WORKER] Monitor worker FAILED');
    console.error('='.repeat(70));
    console.error('Error:', error.message);
    console.error('='.repeat(70) + '\n');

    throw error;
  }
}

export function acquireMonitorWorkerLock(): boolean {
  if (runningJobs.has('monitor-worker')) {
    return false;
  }
  runningJobs.add('monitor-worker');
  return true;
}

export function releaseMonitorWorkerLock(): void {
  runningJobs.delete('monitor-worker');
}
