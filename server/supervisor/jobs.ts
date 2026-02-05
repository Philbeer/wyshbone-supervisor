/**
 * Jobs API - In-memory job store and runner
 * 
 * Provides job lifecycle management with AFR event logging.
 * Jobs run asynchronously in the background.
 */

import { randomUUID } from 'crypto';
import { logAFREvent } from './afr-logger';

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

async function runJobAsync(job: Job): Promise<void> {
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

export async function startJob(request: StartJobRequest): Promise<string> {
  const jobId = `job_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
  const now = new Date().toISOString();
  
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
