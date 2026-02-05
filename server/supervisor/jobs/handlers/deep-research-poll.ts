/**
 * Deep Research Poll Job Handler
 * 
 * Supervisor's implementation of deep research polling that:
 * 1. Finds pending deep research runs in Supabase
 * 2. Processes them (polls external API for completion status)
 * 3. Updates run status in DB
 * 
 * This migrates the UI's deep research polling logic to run reliably in Supervisor.
 * 
 * AFR Events:
 * - job_started: When the job begins
 * - job_progress: "found N pending runs", "processed X/Y"
 * - job_completed: With resultSummary (counts)
 * - job_failed: With error details
 * 
 * Safety:
 * - Idempotent: Can be run repeatedly without side effects
 * - Already-running guard: Prevents overlapping runs via lock
 */

import { supabase } from '../../../supabase';
import type { Job } from '../../jobs';

export interface DeepResearchPollResult {
  success: boolean;
  pendingFound: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

type PollOutcome = 'completed' | 'failed' | 'still_pending' | 'skipped';

export interface ProgressCallback {
  (progress: number, message: string): Promise<void>;
}

// Lock to prevent concurrent runs
const runningJobs = new Set<string>();

export function isDeepResearchPollRunning(): boolean {
  return runningJobs.has('deep-research-poll');
}

export function acquireDeepResearchPollLock(): boolean {
  if (runningJobs.has('deep-research-poll')) {
    return false;
  }
  runningJobs.add('deep-research-poll');
  return true;
}

export function releaseDeepResearchPollLock(): void {
  runningJobs.delete('deep-research-poll');
}

/**
 * Poll a single deep research run for completion status.
 * This checks the external API and updates the run status accordingly.
 * 
 * Returns an outcome that distinguishes:
 * - 'completed': Run finished successfully and DB was updated
 * - 'failed': Run failed and DB was updated with failure status
 * - 'still_pending': Run is still processing (no DB update needed, will retry next poll)
 * - 'skipped': Could not poll (no API key, API error) - no DB update, not counted as failure
 */
async function pollSingleRun(run: any): Promise<{ outcome: PollOutcome; error?: string }> {
  try {
    // The deep research runs have an external_run_id that we use to check status
    const externalRunId = run.external_run_id;
    const apiKey = process.env.TAVILY_API_KEY || process.env.DEEP_RESEARCH_API_KEY;

    if (!externalRunId) {
      // Mark as failed if no external run ID - this is a data issue
      await supabase?.from('deep_research_runs')
        .update({ 
          status: 'failed', 
          error: 'No external_run_id found',
          updated_at: new Date().toISOString()
        })
        .eq('id', run.id);
      return { outcome: 'failed', error: 'No external_run_id' };
    }

    if (!apiKey) {
      // No API key - skip this run, don't mark as failed
      console.warn('[DEEP_RESEARCH_POLL] No API key configured - skipping run');
      return { outcome: 'skipped', error: 'No API key configured' };
    }

    // Poll the Tavily/deep research API for status
    const response = await fetch(`https://api.tavily.com/extract/status/${externalRunId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      // Transient API error - skip this run, will retry on next poll
      console.warn(`[DEEP_RESEARCH_POLL] API returned ${response.status} for run ${run.id} - will retry`);
      return { outcome: 'skipped', error: `API error: ${response.status}` };
    }

    const data = await response.json();
    
    if (data.status === 'completed') {
      // Update run with results
      await supabase?.from('deep_research_runs')
        .update({ 
          status: 'completed',
          result: data.result || data.data,
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString()
        })
        .eq('id', run.id);
      
      console.log(`[DEEP_RESEARCH_POLL] Run ${run.id} completed successfully`);
      return { outcome: 'completed' };
      
    } else if (data.status === 'failed' || data.status === 'error') {
      // Update run as failed
      await supabase?.from('deep_research_runs')
        .update({ 
          status: 'failed',
          error: data.error || data.message || 'Unknown error',
          updated_at: new Date().toISOString()
        })
        .eq('id', run.id);
      
      console.log(`[DEEP_RESEARCH_POLL] Run ${run.id} failed: ${data.error || 'Unknown'}`);
      return { outcome: 'failed', error: data.error };
      
    } else {
      // Still pending/processing - no update needed, will check again next poll
      console.log(`[DEEP_RESEARCH_POLL] Run ${run.id} still ${data.status}`);
      return { outcome: 'still_pending' };
    }

  } catch (error: any) {
    // Network/parse error - skip, will retry on next poll
    console.error(`[DEEP_RESEARCH_POLL] Error polling run ${run.id}:`, error.message);
    return { outcome: 'skipped', error: error.message };
  }
}

/**
 * Main polling function that processes all pending deep research runs.
 * This is the core logic that can be called by both the job handler and scheduler.
 */
export async function runDeepResearchPoll(
  job: Job,
  onProgress: ProgressCallback
): Promise<DeepResearchPollResult> {
  const startTime = Date.now();
  
  console.log('\n' + '='.repeat(70));
  console.log('[DEEP_RESEARCH_POLL] Starting deep research poll job');
  console.log('='.repeat(70));
  console.log(`Job ID: ${job.jobId}`);
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('');

  const result: DeepResearchPollResult = {
    success: false,
    pendingFound: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0
  };

  try {
    await onProgress(5, 'Initializing deep research poll...');

    if (!supabase) {
      console.warn('[DEEP_RESEARCH_POLL] Supabase not configured - cannot poll deep research');
      await onProgress(100, 'Supabase not configured - no polling possible');
      result.success = true;
      result.durationMs = Date.now() - startTime;
      return result;
    }

    await onProgress(10, 'Querying pending deep research runs...');

    // Find all pending deep research runs
    const { data: pendingRuns, error: queryError } = await supabase
      .from('deep_research_runs')
      .select('*')
      .in('status', ['pending', 'processing', 'running'])
      .order('created_at', { ascending: true })
      .limit(50); // Process up to 50 runs per poll cycle

    if (queryError) {
      // Table might not exist yet - handle gracefully
      if (queryError.code === 'PGRST205' || queryError.code === '42P01') {
        console.log('[DEEP_RESEARCH_POLL] deep_research_runs table not found - nothing to poll');
        await onProgress(100, 'Deep research table not found - no runs to poll');
        result.success = true;
        result.durationMs = Date.now() - startTime;
        return result;
      }
      console.error('[DEEP_RESEARCH_POLL] Error fetching pending runs:', queryError);
      throw new Error(`Failed to fetch pending runs: ${queryError.message}`);
    }

    result.pendingFound = pendingRuns?.length || 0;
    console.log(`[DEEP_RESEARCH_POLL] Found ${result.pendingFound} pending run(s)`);
    
    await onProgress(25, `Found ${result.pendingFound} pending runs`);

    if (result.pendingFound === 0) {
      // No pending runs - that's fine, just complete successfully
      await onProgress(100, 'No pending runs to process');
      result.success = true;
      result.durationMs = Date.now() - startTime;
      
      console.log('\n' + '='.repeat(70));
      console.log('[DEEP_RESEARCH_POLL] Poll completed - no pending runs');
      console.log('='.repeat(70) + '\n');
      
      return result;
    }

    // Process each pending run
    await onProgress(30, 'Processing pending runs...');

    for (let i = 0; i < pendingRuns.length; i++) {
      const run = pendingRuns[i];
      const progressPct = 30 + Math.floor((i / pendingRuns.length) * 60);
      
      await onProgress(progressPct, `Processing ${i + 1}/${pendingRuns.length}`);
      
      const pollResult = await pollSingleRun(run);
      result.processed++;
      
      switch (pollResult.outcome) {
        case 'completed':
          result.succeeded++;
          break;
        case 'failed':
          result.failed++;
          break;
        case 'still_pending':
        case 'skipped':
          result.skipped++;
          break;
      }
    }

    result.durationMs = Date.now() - startTime;
    result.success = true;

    console.log('\n' + '='.repeat(70));
    console.log('[DEEP_RESEARCH_POLL] Deep research poll completed successfully');
    console.log('='.repeat(70));
    console.log(`Pending found: ${result.pendingFound}`);
    console.log(`Processed: ${result.processed}`);
    console.log(`Succeeded: ${result.succeeded}`);
    console.log(`Failed: ${result.failed}`);
    console.log(`Skipped: ${result.skipped}`);
    console.log(`Duration: ${result.durationMs}ms (${Math.round(result.durationMs / 1000)}s)`);
    console.log('='.repeat(70) + '\n');

    return result;

  } catch (error: any) {
    result.durationMs = Date.now() - startTime;
    result.success = false;

    console.error('\n' + '='.repeat(70));
    console.error('[DEEP_RESEARCH_POLL] Deep research poll FAILED');
    console.error('='.repeat(70));
    console.error('Error:', error.message);
    console.error('='.repeat(70) + '\n');

    throw error;
  }
}

/**
 * Lightweight poll function for scheduler use (without Job object).
 * Creates a minimal job object and runs the poll.
 */
export async function pollAllPendingRuns(): Promise<DeepResearchPollResult> {
  const mockJob: Job = {
    jobId: `scheduler_${Date.now()}`,
    jobType: 'deep-research-poll',
    status: 'running',
    payload: {},
    requestedBy: 'scheduler',
    createdAt: new Date().toISOString()
  };

  // No-op progress callback for scheduler use
  const noopProgress = async (_progress: number, _message: string) => {};

  return runDeepResearchPoll(mockJob, noopProgress);
}
