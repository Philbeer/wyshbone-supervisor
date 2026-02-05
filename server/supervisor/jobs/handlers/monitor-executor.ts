/**
 * Monitor Executor Job Handler
 * 
 * Supervisor's authoritative implementation of the monitor-executor job that:
 * 1. Loads all active scheduled monitors from Supabase
 * 2. For each monitor, creates a lead generation plan using the monitor's goal
 * 3. Executes the plan using SUP-001 (planner) + SUP-002 (executor)
 * 4. Tracks results and creates leads
 * 
 * This replaces the UI's monitor-executor logic.
 * 
 * AFR Events:
 * - job_started: When the job begins
 * - job_progress: "loaded monitors", "executing X", "completed Y plans"
 * - job_completed: With resultSummary (counts)
 * - job_failed: With error details
 * 
 * Safety:
 * - Already-running guard: Prevents overlapping runs of the same jobType
 */

import { supabase } from '../../../supabase';
import { storage } from '../../../storage';
import { planLeadGenerationWithHistory, type LeadGenGoal, type LeadGenContext } from '../../../types/lead-gen-plan';
import { executeLeadGenerationPlan } from '../../../plan-executor';
import type { Job } from '../../jobs';

export interface MonitorExecutorResult {
  success: boolean;
  monitorsLoaded: number;
  monitorsExecuted: number;
  plansCreated: number;
  plansSucceeded: number;
  plansFailed: number;
  leadsGenerated: number;
  durationMs: number;
  executionDetails: Array<{
    monitorId: string;
    monitorLabel: string;
    userId: string;
    planId?: string;
    status: 'succeeded' | 'failed' | 'skipped';
    error?: string;
    leadsCount?: number;
  }>;
}

export interface ProgressCallback {
  (progress: number, message: string): Promise<void>;
}

const runningJobs = new Set<string>();

export function isMonitorExecutorRunning(): boolean {
  return runningJobs.has('monitor-executor');
}

export function acquireMonitorExecutorLock(): boolean {
  if (runningJobs.has('monitor-executor')) {
    return false;
  }
  runningJobs.add('monitor-executor');
  return true;
}

export function releaseMonitorExecutorLock(): void {
  runningJobs.delete('monitor-executor');
}

export async function runMonitorExecutor(
  job: Job,
  onProgress: ProgressCallback
): Promise<MonitorExecutorResult> {
  const startTime = Date.now();
  
  console.log('\n' + '='.repeat(70));
  console.log('[MONITOR_EXECUTOR] Starting monitor executor job');
  console.log('='.repeat(70));
  console.log(`Job ID: ${job.jobId}`);
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('');

  const result: MonitorExecutorResult = {
    success: false,
    monitorsLoaded: 0,
    monitorsExecuted: 0,
    plansCreated: 0,
    plansSucceeded: 0,
    plansFailed: 0,
    leadsGenerated: 0,
    durationMs: 0,
    executionDetails: []
  };

  try {
    await onProgress(5, 'Initializing monitor executor...');

    if (!supabase) {
      console.warn('[MONITOR_EXECUTOR] Supabase not configured - cannot execute monitors');
      await onProgress(100, 'Supabase not configured - no execution possible');
      result.success = true;
      result.durationMs = Date.now() - startTime;
      return result;
    }

    await onProgress(10, 'Loading active monitors...');

    const { data: monitors, error: monitorsError } = await supabase
      .from('scheduled_monitors')
      .select('id, user_id, label, description, monitor_type, created_at, last_execution_at')
      .eq('is_active', 1);

    if (monitorsError) {
      console.error('[MONITOR_EXECUTOR] Error fetching monitors:', monitorsError);
      throw new Error(`Failed to fetch monitors: ${monitorsError.message}`);
    }

    result.monitorsLoaded = monitors?.length || 0;
    console.log(`[MONITOR_EXECUTOR] Loaded ${result.monitorsLoaded} active monitor(s)`);
    
    await onProgress(20, `Loaded ${result.monitorsLoaded} active monitor(s)`);

    if (!monitors || monitors.length === 0) {
      console.log('[MONITOR_EXECUTOR] No active monitors to execute');
      await onProgress(100, 'No active monitors to execute');
      result.success = true;
      result.durationMs = Date.now() - startTime;
      return result;
    }

    await onProgress(25, `Starting execution of ${result.monitorsLoaded} monitors...`);

    const totalMonitors = monitors.length;
    let completedMonitors = 0;

    for (const monitor of monitors) {
      const monitorId = monitor.id?.toString() || 'unknown';
      const monitorLabel = monitor.label || 'Unnamed monitor';
      const userId = monitor.user_id;

      console.log(`\n[MONITOR_EXECUTOR] Processing monitor: ${monitorLabel} (${monitorId})`);
      console.log(`  User: ${userId}`);
      console.log(`  Type: ${monitor.monitor_type}`);

      const executionDetail: MonitorExecutorResult['executionDetails'][0] = {
        monitorId,
        monitorLabel,
        userId,
        status: 'skipped'
      };

      try {
        const goal: LeadGenGoal = {
          rawGoal: monitorLabel,
          targetPersona: extractPersonaFromDescription(monitor.description || monitorLabel),
          targetRegion: extractRegionFromDescription(monitor.description || monitorLabel),
          volume: 20,
          timing: 'asap',
          preferredChannels: ['email'],
          includeMonitoring: false
        };

        const context: LeadGenContext = {
          userId,
          defaultRegion: 'UK',
          defaultCountry: 'GB'
        };

        console.log(`[MONITOR_EXECUTOR] Creating plan for: ${goal.rawGoal}`);

        const plan = await planLeadGenerationWithHistory(goal, context);
        result.plansCreated++;
        executionDetail.planId = plan.id;

        console.log(`[MONITOR_EXECUTOR] Plan created: ${plan.id} with ${plan.steps.length} steps`);

        await storage.createPlan({
          id: plan.id,
          userId,
          status: 'pending_approval',
          planData: plan as any,
          goalText: goal.rawGoal
        });

        await storage.updatePlanStatus(plan.id, 'executing');

        console.log(`[MONITOR_EXECUTOR] Executing plan: ${plan.id}`);
        await executeLeadGenerationPlan(plan.id);

        const updatedPlan = await storage.getPlan(plan.id);
        const planStatus = updatedPlan?.status;

        if (planStatus === 'completed') {
          result.plansSucceeded++;
          executionDetail.status = 'succeeded';
          
          const leads = await storage.getSuggestedLeads(userId);
          const recentLeads = leads.filter(l => 
            new Date(l.createdAt).getTime() > startTime
          );
          executionDetail.leadsCount = recentLeads.length;
          result.leadsGenerated += recentLeads.length;
          
          console.log(`[MONITOR_EXECUTOR] Plan succeeded, ${recentLeads.length} leads generated`);
        } else {
          result.plansFailed++;
          executionDetail.status = 'failed';
          executionDetail.error = 'Plan did not complete successfully';
          console.log(`[MONITOR_EXECUTOR] Plan status: ${planStatus}`);
        }

        await supabase
          .from('scheduled_monitors')
          .update({ last_execution_at: new Date().toISOString() })
          .eq('id', monitor.id);

        result.monitorsExecuted++;

      } catch (execError: any) {
        result.plansFailed++;
        executionDetail.status = 'failed';
        executionDetail.error = execError.message || 'Execution failed';
        console.error(`[MONITOR_EXECUTOR] Error executing monitor ${monitorId}:`, execError.message);
      }

      result.executionDetails.push(executionDetail);

      completedMonitors++;
      const progressPercent = 25 + Math.round((completedMonitors / totalMonitors) * 65);
      await onProgress(
        progressPercent, 
        `Executed ${completedMonitors}/${totalMonitors} monitors (${result.plansSucceeded} succeeded, ${result.plansFailed} failed)`
      );
    }

    await onProgress(95, `Completed execution of ${result.monitorsExecuted} monitors`);

    result.durationMs = Date.now() - startTime;
    result.success = true;

    console.log('\n' + '='.repeat(70));
    console.log('[MONITOR_EXECUTOR] Monitor executor completed successfully');
    console.log('='.repeat(70));
    console.log(`Monitors loaded: ${result.monitorsLoaded}`);
    console.log(`Monitors executed: ${result.monitorsExecuted}`);
    console.log(`Plans created: ${result.plansCreated}`);
    console.log(`Plans succeeded: ${result.plansSucceeded}`);
    console.log(`Plans failed: ${result.plansFailed}`);
    console.log(`Leads generated: ${result.leadsGenerated}`);
    console.log(`Duration: ${result.durationMs}ms (${Math.round(result.durationMs / 1000)}s)`);
    console.log('='.repeat(70) + '\n');

    return result;

  } catch (error: any) {
    result.durationMs = Date.now() - startTime;
    result.success = false;

    console.error('\n' + '='.repeat(70));
    console.error('[MONITOR_EXECUTOR] Monitor executor FAILED');
    console.error('='.repeat(70));
    console.error('Error:', error.message);
    console.error('='.repeat(70) + '\n');

    throw error;
  }
}

function extractPersonaFromDescription(description: string): string {
  const lowerDesc = description.toLowerCase();
  
  if (lowerDesc.includes('owner') || lowerDesc.includes('manager')) {
    return 'business owners';
  }
  if (lowerDesc.includes('restaurant') || lowerDesc.includes('cafe') || lowerDesc.includes('pub')) {
    return 'hospitality business owners';
  }
  if (lowerDesc.includes('shop') || lowerDesc.includes('retail') || lowerDesc.includes('store')) {
    return 'retail business owners';
  }
  
  return 'business decision makers';
}

function extractRegionFromDescription(description: string): string | undefined {
  const regionPatterns = [
    /\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\bnear\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\baround\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/
  ];
  
  for (const pattern of regionPatterns) {
    const match = description.match(pattern);
    if (match) {
      return match[1];
    }
  }
  
  return undefined;
}
