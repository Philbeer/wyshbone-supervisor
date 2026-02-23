/**
 * Jobs API - In-memory job store and runner
 * 
 * Provides job lifecycle management with AFR event logging.
 * Jobs run asynchronously in the background.
 * 
 * Handler routing:
 * - "nightly-maintenance" -> real handler
 * - "xero-sync" -> real handler (safely no-ops if no Xero integrations)
 * - "monitor-worker" -> real handler (checks monitors for issues, creates alerts)
 * - "monitor-executor" -> real handler (executes scheduled monitors, generates leads)
 * - "deep-research-poll" -> real handler (polls pending deep research runs)
 * - "deep_research" -> real handler (executes deep research: trigger → poll → artefact → events)
 * - other job types -> stub runner (2 second placeholder)
 */

import { randomUUID } from 'crypto';
import { logAFREvent } from './afr-logger';
import { supabase } from '../supabase';
import { runNightlyMaintenance } from './jobs/handlers/nightly-maintenance';
import { runXeroSync } from './jobs/handlers/xero-sync';
import { runMonitorWorker, acquireMonitorWorkerLock, releaseMonitorWorkerLock, isMonitorWorkerRunning } from './jobs/handlers/monitor-worker';
import { runMonitorExecutor, acquireMonitorExecutorLock, releaseMonitorExecutorLock, isMonitorExecutorRunning } from './jobs/handlers/monitor-executor';
import { runDeepResearchPoll, acquireDeepResearchPollLock, releaseDeepResearchPollLock, isDeepResearchPollRunning } from './jobs/handlers/deep-research-poll';
import { runDeepResearchExecute } from './jobs/handlers/deep-research-execute';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  jobId: string;
  jobType: string;
  status: JobStatus;
  payload: any;
  requestedBy: string;
  sourceRunId?: string;
  userId?: string;
  clientRequestId?: string;
  progress?: number;
  message?: string;
  startedAt?: string;
  endedAt?: string;
  resultSummary?: any;
  createdAt: string;
}

export interface StartJobRequest {
  jobType: string;
  payload: any;
  requestedBy: string;
  sourceRunId?: string;
  userId?: string;
  clientRequestId?: string;
}

export interface JobStatusResponse {
  jobId: string;
  jobType: string;
  status: JobStatus;
  progress?: number;
  message?: string;
  startedAt?: string;
  endedAt?: string;
  resultSummary?: any;
}

const jobStore: Map<string, Job> = new Map();

async function emitJobEvent(
  eventType: string,
  job: Job,
  extra?: Record<string, unknown>
): Promise<void> {
  const userId = job.userId || 'system';
  
  await logAFREvent({
    userId,
    runId: job.jobId,
    conversationId: undefined,
    actionTaken: eventType,
    status: job.status === 'failed' ? 'failed' : 
            job.status === 'completed' ? 'success' : 'pending',
    taskGenerated: `${eventType}: ${job.jobType}`,
    runType: 'tool',
    metadata: {
      jobType: job.jobType,
      jobStatus: job.status,
      requestedBy: job.requestedBy,
      sourceRunId: job.sourceRunId,
      clientRequestId: job.clientRequestId,
      ...extra
    }
  });
  
  console.log(`[JOBS] Event: ${eventType} | jobId: ${job.jobId} | status: ${job.status}`);
}

async function emitProgressEvent(job: Job, progress: number, message: string): Promise<void> {
  job.progress = progress;
  job.message = message;
  jobStore.set(job.jobId, job);
  
  await logAFREvent({
    userId: job.userId || 'system',
    runId: job.jobId,
    conversationId: undefined,
    actionTaken: 'job_progress',
    status: 'pending',
    taskGenerated: `job_progress: ${job.jobType} (${progress}%)`,
    runType: 'tool',
    metadata: {
      jobType: job.jobType,
      jobStatus: job.status,
      requestedBy: job.requestedBy,
      progress,
      message
    }
  });
  
  console.log(`[JOBS] Progress: ${job.jobId} | ${progress}% | ${message}`);
}

async function runNightlyMaintenanceJob(job: Job): Promise<void> {
  try {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.message = 'Starting nightly maintenance...';
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_started', job);
    
    const result = await runNightlyMaintenance(job, async (progress, message) => {
      const currentJob = jobStore.get(job.jobId);
      if (currentJob?.status === 'cancelled') {
        throw new Error('Job cancelled by user');
      }
      await emitProgressEvent(job, progress, message);
    });
    
    const currentJob = jobStore.get(job.jobId);
    if (currentJob?.status === 'cancelled') {
      return;
    }
    
    job.status = 'completed';
    job.endedAt = new Date().toISOString();
    job.progress = 100;
    job.message = 'Nightly maintenance completed successfully';
    job.resultSummary = {
      success: result.success,
      jobType: job.jobType,
      durationMs: result.durationMs,
      memoryCleanup: result.memoryCleanup,
      taskExecution: result.taskExecution
    };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_completed', job, { resultSummary: job.resultSummary });
    
  } catch (error: any) {
    job.status = 'failed';
    job.endedAt = new Date().toISOString();
    job.message = `Failed: ${error.message}`;
    job.resultSummary = { success: false, error: error.message };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_failed', job, { error: error.message });
  }
}

async function runStubJob(job: Job): Promise<void> {
  try {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.message = `Running ${job.jobType}...`;
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_started', job);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const currentJob = jobStore.get(job.jobId);
    if (currentJob?.status === 'cancelled') {
      return;
    }
    
    job.status = 'completed';
    job.endedAt = new Date().toISOString();
    job.progress = 100;
    job.message = `${job.jobType} completed successfully`;
    job.resultSummary = {
      success: true,
      jobType: job.jobType,
      durationMs: new Date(job.endedAt).getTime() - new Date(job.startedAt!).getTime()
    };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_completed', job, { resultSummary: job.resultSummary });
    
  } catch (error: any) {
    job.status = 'failed';
    job.endedAt = new Date().toISOString();
    job.message = `Failed: ${error.message}`;
    job.resultSummary = { success: false, error: error.message };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_failed', job, { error: error.message });
  }
}

async function runXeroSyncJob(job: Job): Promise<void> {
  try {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.message = 'Starting Xero sync...';
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_started', job);
    
    const result = await runXeroSync(job, async (progress, message) => {
      const currentJob = jobStore.get(job.jobId);
      if (currentJob?.status === 'cancelled') {
        throw new Error('Job cancelled by user');
      }
      await emitProgressEvent(job, progress, message);
    });
    
    const currentJob = jobStore.get(job.jobId);
    if (currentJob?.status === 'cancelled') {
      return;
    }
    
    job.status = 'completed';
    job.endedAt = new Date().toISOString();
    job.progress = 100;
    job.message = result.usersWithXero === 0 
      ? 'Xero sync completed (no integrations configured)'
      : `Xero sync completed: ${result.usersSynced} users synced`;
    job.resultSummary = {
      success: result.success,
      jobType: job.jobType,
      durationMs: result.durationMs,
      usersWithXero: result.usersWithXero,
      usersSynced: result.usersSynced,
      usersSkipped: result.usersSkipped,
      usersFailed: result.usersFailed,
      totalContactsSynced: result.totalContactsSynced,
      totalInvoicesSynced: result.totalInvoicesSynced
    };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_completed', job, { resultSummary: job.resultSummary });
    
  } catch (error: any) {
    job.status = 'failed';
    job.endedAt = new Date().toISOString();
    job.message = `Failed: ${error.message}`;
    job.resultSummary = { success: false, error: error.message };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_failed', job, { error: error.message });
  }
}

async function runMonitorWorkerJob(job: Job): Promise<void> {
  if (!acquireMonitorWorkerLock()) {
    console.log(`[JOBS] monitor-worker job already running - refusing to start duplicate`);
    job.status = 'failed';
    job.endedAt = new Date().toISOString();
    job.message = 'Job already running - refused to start duplicate';
    job.resultSummary = { success: false, error: 'A monitor-worker job is already in progress' };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_failed', job, { 
      error: 'A monitor-worker job is already in progress',
      reason: 'already_running'
    });
    return;
  }

  try {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.message = 'Starting monitor worker...';
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_started', job);
    
    const result = await runMonitorWorker(job, async (progress, message) => {
      const currentJob = jobStore.get(job.jobId);
      if (currentJob?.status === 'cancelled') {
        throw new Error('Job cancelled by user');
      }
      await emitProgressEvent(job, progress, message);
    });
    
    const currentJob = jobStore.get(job.jobId);
    if (currentJob?.status === 'cancelled') {
      return;
    }
    
    job.status = 'completed';
    job.endedAt = new Date().toISOString();
    job.progress = 100;
    job.message = result.issuesFound === 0
      ? 'Monitor worker completed (no issues found)'
      : `Monitor worker completed: ${result.issuesFound} issues found, ${result.alertsCreated} alerts created`;
    job.resultSummary = {
      success: result.success,
      jobType: job.jobType,
      durationMs: result.durationMs,
      monitorsLoaded: result.monitorsLoaded,
      monitorsChecked: result.monitorsChecked,
      issuesFound: result.issuesFound,
      alertsCreated: result.alertsCreated,
      eventsByStatus: result.eventsByStatus
    };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_completed', job, { resultSummary: job.resultSummary });
    
  } catch (error: any) {
    job.status = 'failed';
    job.endedAt = new Date().toISOString();
    job.message = `Failed: ${error.message}`;
    job.resultSummary = { success: false, error: error.message };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_failed', job, { error: error.message });
  } finally {
    releaseMonitorWorkerLock();
  }
}

async function runMonitorExecutorJob(job: Job): Promise<void> {
  if (!acquireMonitorExecutorLock()) {
    console.log(`[JOBS] monitor-executor job already running - refusing to start duplicate`);
    job.status = 'failed';
    job.endedAt = new Date().toISOString();
    job.message = 'Job already running - refused to start duplicate';
    job.resultSummary = { success: false, error: 'A monitor-executor job is already in progress' };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_failed', job, { 
      error: 'A monitor-executor job is already in progress',
      reason: 'already_running'
    });
    return;
  }

  try {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.message = 'Starting monitor executor...';
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_started', job);
    
    const result = await runMonitorExecutor(job, async (progress, message) => {
      const currentJob = jobStore.get(job.jobId);
      if (currentJob?.status === 'cancelled') {
        throw new Error('Job cancelled by user');
      }
      await emitProgressEvent(job, progress, message);
    });
    
    const currentJob = jobStore.get(job.jobId);
    if (currentJob?.status === 'cancelled') {
      return;
    }
    
    job.status = 'completed';
    job.endedAt = new Date().toISOString();
    job.progress = 100;
    job.message = result.monitorsExecuted === 0
      ? 'Monitor executor completed (no monitors to execute)'
      : `Monitor executor completed: ${result.plansSucceeded} succeeded, ${result.plansFailed} failed, ${result.leadsGenerated} leads`;
    job.resultSummary = {
      success: result.success,
      jobType: job.jobType,
      durationMs: result.durationMs,
      monitorsLoaded: result.monitorsLoaded,
      monitorsExecuted: result.monitorsExecuted,
      plansCreated: result.plansCreated,
      plansSucceeded: result.plansSucceeded,
      plansFailed: result.plansFailed,
      leadsGenerated: result.leadsGenerated
    };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_completed', job, { resultSummary: job.resultSummary });
    
  } catch (error: any) {
    job.status = 'failed';
    job.endedAt = new Date().toISOString();
    job.message = `Failed: ${error.message}`;
    job.resultSummary = { success: false, error: error.message };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_failed', job, { error: error.message });
  } finally {
    releaseMonitorExecutorLock();
  }
}

async function runDeepResearchPollJob(job: Job): Promise<void> {
  if (!acquireDeepResearchPollLock()) {
    console.log(`[JOBS] deep-research-poll job already running - refusing to start duplicate`);
    job.status = 'failed';
    job.endedAt = new Date().toISOString();
    job.message = 'Job already running - refused to start duplicate';
    job.resultSummary = { success: false, error: 'A deep-research-poll job is already in progress' };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_failed', job, { 
      error: 'A deep-research-poll job is already in progress',
      reason: 'already_running'
    });
    return;
  }

  try {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.message = 'Starting deep research poll...';
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_started', job);
    
    const result = await runDeepResearchPoll(job, async (progress, message) => {
      const currentJob = jobStore.get(job.jobId);
      if (currentJob?.status === 'cancelled') {
        throw new Error('Job cancelled by user');
      }
      await emitProgressEvent(job, progress, message);
    });
    
    const currentJob = jobStore.get(job.jobId);
    if (currentJob?.status === 'cancelled') {
      return;
    }
    
    job.status = 'completed';
    job.endedAt = new Date().toISOString();
    job.progress = 100;
    job.message = result.pendingFound === 0
      ? 'Deep research poll completed (no pending runs)'
      : `Deep research poll completed: ${result.processed} processed (${result.succeeded} succeeded, ${result.failed} failed)`;
    job.resultSummary = {
      success: result.success,
      jobType: job.jobType,
      durationMs: result.durationMs,
      pendingFound: result.pendingFound,
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
      skipped: result.skipped
    };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_completed', job, { resultSummary: job.resultSummary });
    
  } catch (error: any) {
    job.status = 'failed';
    job.endedAt = new Date().toISOString();
    job.message = `Failed: ${error.message}`;
    job.resultSummary = { success: false, error: error.message };
    jobStore.set(job.jobId, job);
    
    await emitJobEvent('job_failed', job, { error: error.message });
  } finally {
    releaseDeepResearchPollLock();
  }
}

async function runDeepResearchExecuteJob(job: Job): Promise<void> {
  try {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.message = 'Starting deep research execution...';
    jobStore.set(job.jobId, job);

    await emitJobEvent('job_started', job);

    const result = await runDeepResearchExecute(job, async (progress, message) => {
      const currentJob = jobStore.get(job.jobId);
      if (currentJob?.status === 'cancelled') {
        throw new Error('Job cancelled by user');
      }
      await emitProgressEvent(job, progress, message);
    });

    const currentJob = jobStore.get(job.jobId);
    if (currentJob?.status === 'cancelled') {
      return;
    }

    job.status = result.success ? 'completed' : 'failed';
    job.endedAt = new Date().toISOString();
    job.progress = 100;
    job.message = result.success
      ? `Deep research completed: artefact posted=${result.artefactPosted}`
      : `Deep research ${result.status}: ${result.error || 'unknown error'}`;
    job.resultSummary = {
      success: result.success,
      jobType: job.jobType,
      durationMs: result.durationMs,
      deepResearchRunId: result.deepResearchRunId,
      artefactPosted: result.artefactPosted,
      artefactId: result.artefactId,
      status: result.status,
      error: result.error,
    };
    jobStore.set(job.jobId, job);

    await emitJobEvent(result.success ? 'job_completed' : 'job_failed', job, { resultSummary: job.resultSummary });

  } catch (error: any) {
    job.status = 'failed';
    job.endedAt = new Date().toISOString();
    job.message = `Failed: ${error.message}`;
    job.resultSummary = { success: false, error: error.message };
    jobStore.set(job.jobId, job);

    await emitJobEvent('job_failed', job, { error: error.message });
  }
}

async function runJobAsync(job: Job): Promise<void> {
  if (job.jobType === 'nightly-maintenance') {
    return runNightlyMaintenanceJob(job);
  }
  
  if (job.jobType === 'xero-sync') {
    return runXeroSyncJob(job);
  }
  
  if (job.jobType === 'monitor-worker') {
    return runMonitorWorkerJob(job);
  }
  
  if (job.jobType === 'monitor-executor') {
    return runMonitorExecutorJob(job);
  }
  
  if (job.jobType === 'deep-research-poll') {
    return runDeepResearchPollJob(job);
  }
  
  if (job.jobType === 'deep_research') {
    return runDeepResearchExecuteJob(job);
  }
  
  return runStubJob(job);
}

export function generateJobId(): string {
  return `job_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
}

export async function startJob(request: StartJobRequest): Promise<string> {
  const jobId = generateJobId();
  const now = new Date().toISOString();

  if (request.jobType === 'deep_research') {
    const userText = String(request.payload?.topic || request.payload?.prompt || request.payload?.user_message || '');
    const userId = request.userId || 'system';

    console.log(`[SUPERVISOR_REDIRECT] deep_research → supervisor_task — jobId=${jobId} text="${userText.substring(0, 80)}"`);

    if (supabase) {
      const taskId = randomUUID();
      const canonicalRunId = request.payload?.run_id || jobId;
      const fullUserMessage = String(request.payload?.user_message || request.payload?.topic || request.payload?.prompt || userText);
      const { error: insertErr } = await supabase.from('supervisor_tasks').insert({
        id: taskId,
        conversation_id: request.payload?.conversation_id || null,
        user_id: userId,
        task_type: 'generate_leads',
        run_id: canonicalRunId,
        client_request_id: request.clientRequestId || null,
        request_data: {
          user_message: fullUserMessage,
          run_id: canonicalRunId,
          client_request_id: request.clientRequestId || null,
        },
        status: 'pending',
        created_at: Date.now(),
      });
      if (insertErr) {
        console.warn(`[SUPERVISOR_REDIRECT] Failed to insert supervisor_task: ${insertErr.message}`);
      } else {
        console.log(`[SUPERVISOR_REDIRECT] Created supervisor_task ${taskId} run_id=${canonicalRunId}`);
      }
    }

    const job: Job = {
      jobId,
      jobType: request.jobType,
      status: 'completed',
      payload: request.payload,
      requestedBy: request.requestedBy,
      sourceRunId: request.sourceRunId,
      userId: request.userId,
      clientRequestId: request.clientRequestId,
      progress: 100,
      message: `Redirected to supervisor.`,
      createdAt: now,
      endedAt: now,
      resultSummary: {
        success: true,
        jobType: request.jobType,
        redirected: true,
      },
    };
    jobStore.set(jobId, job);
    await emitJobEvent('job_queued', job);
    await emitJobEvent('job_completed', job, { resultSummary: job.resultSummary });
    return jobId;
  }
  
  const job: Job = {
    jobId,
    jobType: request.jobType,
    status: 'queued',
    payload: request.payload,
    requestedBy: request.requestedBy,
    sourceRunId: request.sourceRunId,
    userId: request.userId,
    clientRequestId: request.clientRequestId,
    progress: 0,
    message: `Job ${request.jobType} queued`,
    createdAt: now
  };
  
  jobStore.set(jobId, job);
  
  await emitJobEvent('job_queued', job);
  
  setImmediate(() => {
    runJobAsync(job).catch(err => {
      console.error(`[JOBS] Unhandled error in job ${jobId}:`, err);
    });
  });
  
  return jobId;
}

export function getJob(jobId: string): Job | undefined {
  return jobStore.get(jobId);
}

export function getJobStatus(jobId: string): JobStatusResponse | undefined {
  const job = jobStore.get(jobId);
  if (!job) return undefined;
  
  return {
    jobId: job.jobId,
    jobType: job.jobType,
    status: job.status,
    progress: job.progress,
    message: job.message,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    resultSummary: job.resultSummary
  };
}

export async function cancelJob(jobId: string): Promise<boolean> {
  const job = jobStore.get(jobId);
  if (!job) return false;
  
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return false;
  }
  
  job.status = 'cancelled';
  job.endedAt = new Date().toISOString();
  job.message = 'Job cancelled by user';
  jobStore.set(jobId, job);
  
  await emitJobEvent('job_cancelled', job);
  
  return true;
}

export function listJobs(): Job[] {
  return Array.from(jobStore.values());
}
