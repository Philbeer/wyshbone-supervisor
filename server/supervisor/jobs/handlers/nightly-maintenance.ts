/**
 * Nightly Maintenance Job Handler
 * 
 * Real implementation of the nightly-maintenance job that:
 * 1. Cleans up stale/expired memories for all users
 * 2. Generates and executes autonomous agent tasks for all active users
 * 
 * This is the Supervisor's authoritative version of the logic
 * previously found in the UI's server/cron/daily-agent.ts
 */

import { supabase } from '../../../supabase';
import { executeTasksForAllUsers } from '../../../autonomous-agent';
import { cleanupMemories } from '../../../services/memory-writer';
import type { Job } from '../../jobs';

export interface NightlyMaintenanceResult {
  success: boolean;
  memoryCleanup: {
    usersProcessed: number;
    totalStale: number;
    totalExpired: number;
  };
  taskExecution: {
    totalUsers: number;
    successfulUsers: number;
    failedUsers: number;
    totalTasksGenerated: number;
    totalTasksExecuted: number;
    totalSuccessfulTasks: number;
    totalInterestingResults: number;
  };
  durationMs: number;
}

export interface ProgressCallback {
  (progress: number, message: string): Promise<void>;
}

export async function runNightlyMaintenance(
  job: Job,
  onProgress: ProgressCallback
): Promise<NightlyMaintenanceResult> {
  const startTime = Date.now();
  
  console.log('\n' + '='.repeat(70));
  console.log('[NIGHTLY_MAINTENANCE] Starting nightly maintenance job');
  console.log('='.repeat(70));
  console.log(`Job ID: ${job.jobId}`);
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('');

  const result: NightlyMaintenanceResult = {
    success: false,
    memoryCleanup: {
      usersProcessed: 0,
      totalStale: 0,
      totalExpired: 0
    },
    taskExecution: {
      totalUsers: 0,
      successfulUsers: 0,
      failedUsers: 0,
      totalTasksGenerated: 0,
      totalTasksExecuted: 0,
      totalSuccessfulTasks: 0,
      totalInterestingResults: 0
    },
    durationMs: 0
  };

  try {
    await onProgress(5, 'Starting memory cleanup phase...');

    if (!supabase) {
      console.warn('[NIGHTLY_MAINTENANCE] Supabase not configured - skipping memory cleanup');
      await onProgress(25, 'Supabase not configured - skipping memory cleanup');
    } else {
      const { data: users, error } = await supabase
        .from('users')
        .select('id')
        .limit(100);

      if (error) {
        console.error('[NIGHTLY_MAINTENANCE] Error fetching users:', error);
        await onProgress(25, `Warning: Could not fetch users for cleanup: ${error.message}`);
      } else if (users && users.length > 0) {
        console.log(`[NIGHTLY_MAINTENANCE] Running memory cleanup for ${users.length} users...`);
        
        for (const user of users) {
          try {
            const { stale, expired } = await cleanupMemories(user.id);
            result.memoryCleanup.usersProcessed++;
            result.memoryCleanup.totalStale += stale;
            result.memoryCleanup.totalExpired += expired;
          } catch (err: any) {
            console.warn(`[NIGHTLY_MAINTENANCE] Cleanup failed for user ${user.id}: ${err.message}`);
          }
        }
        
        await onProgress(25, `Memory cleanup complete: ${result.memoryCleanup.usersProcessed} users, ${result.memoryCleanup.totalStale} stale + ${result.memoryCleanup.totalExpired} expired memories cleaned`);
        console.log(`[NIGHTLY_MAINTENANCE] Memory cleanup complete: ${result.memoryCleanup.usersProcessed} users processed`);
      } else {
        await onProgress(25, 'No users found for memory cleanup');
        console.log('[NIGHTLY_MAINTENANCE] No users found for memory cleanup');
      }
    }

    await onProgress(30, 'Starting autonomous agent task execution...');
    console.log('[NIGHTLY_MAINTENANCE] Starting autonomous agent task execution...');

    try {
      const executionResult = await executeTasksForAllUsers();
      
      result.taskExecution = {
        totalUsers: executionResult.results.length,
        successfulUsers: executionResult.success,
        failedUsers: executionResult.failed,
        totalTasksGenerated: 0,
        totalTasksExecuted: 0,
        totalSuccessfulTasks: 0,
        totalInterestingResults: 0
      };

      executionResult.results.forEach(userResult => {
        result.taskExecution.totalTasksGenerated += userResult.tasksGenerated;
        result.taskExecution.totalTasksExecuted += userResult.tasksExecuted;
        result.taskExecution.totalSuccessfulTasks += userResult.successful;
        result.taskExecution.totalInterestingResults += userResult.interesting;
      });

      await onProgress(90, `Task execution complete: ${result.taskExecution.successfulUsers}/${result.taskExecution.totalUsers} users, ${result.taskExecution.totalSuccessfulTasks}/${result.taskExecution.totalTasksExecuted} tasks succeeded`);
      
      console.log(`[NIGHTLY_MAINTENANCE] Task execution complete:`);
      console.log(`  Users: ${result.taskExecution.successfulUsers}/${result.taskExecution.totalUsers} successful`);
      console.log(`  Tasks: ${result.taskExecution.totalSuccessfulTasks}/${result.taskExecution.totalTasksExecuted} successful`);
      console.log(`  Interesting results: ${result.taskExecution.totalInterestingResults}`);
      
    } catch (err: any) {
      console.error('[NIGHTLY_MAINTENANCE] Task execution failed:', err.message);
      await onProgress(90, `Task execution failed: ${err.message}`);
    }

    result.durationMs = Date.now() - startTime;
    result.success = true;

    console.log('\n' + '='.repeat(70));
    console.log('[NIGHTLY_MAINTENANCE] Nightly maintenance completed successfully');
    console.log('='.repeat(70));
    console.log(`Duration: ${result.durationMs}ms (${Math.round(result.durationMs / 1000)}s)`);
    console.log('='.repeat(70) + '\n');

    return result;

  } catch (error: any) {
    result.durationMs = Date.now() - startTime;
    result.success = false;

    console.error('\n' + '='.repeat(70));
    console.error('[NIGHTLY_MAINTENANCE] Nightly maintenance FAILED');
    console.error('='.repeat(70));
    console.error('Error:', error.message);
    console.error('='.repeat(70) + '\n');

    throw error;
  }
}
