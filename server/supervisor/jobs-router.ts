/**
 * Jobs Router - REST API for Supervisor job management
 * 
 * Endpoints:
 * - POST /api/supervisor/jobs/start - Start a new job
 * - GET /api/supervisor/jobs/:jobId - Get job status
 * - POST /api/supervisor/jobs/:jobId/cancel - Cancel a job
 */

import { Router } from 'express';
import { startJob, getJobStatus, cancelJob, type StartJobRequest } from './jobs';

export const jobsRouter = Router();

jobsRouter.post('/start', async (req, res) => {
  console.log(`\n${'='.repeat(60)}`);
  console.log('[JOBS_API] POST /start - Request received');
  console.log(`${'='.repeat(60)}\n`);
  
  try {
    const body = req.body as StartJobRequest;
    
    if (!body.jobType) {
      console.error('[JOBS_API] Missing jobType');
      return res.status(400).json({
        error: 'Missing required field: jobType'
      });
    }
    
    if (!body.requestedBy) {
      console.error('[JOBS_API] Missing requestedBy');
      return res.status(400).json({
        error: 'Missing required field: requestedBy'
      });
    }
    
    console.log('[JOBS_API] Starting job:');
    console.log(`  jobType: ${body.jobType}`);
    console.log(`  requestedBy: ${body.requestedBy}`);
    console.log(`  userId: ${body.userId || 'N/A'}`);
    console.log(`  sourceRunId: ${body.sourceRunId || 'N/A'}`);
    console.log(`  clientRequestId: ${body.clientRequestId || 'N/A'}`);
    
    const jobId = await startJob({
      jobType: body.jobType,
      payload: body.payload || {},
      requestedBy: body.requestedBy,
      sourceRunId: body.sourceRunId,
      userId: body.userId,
      clientRequestId: body.clientRequestId
    });
    
    console.log(`[JOBS_API] Job started - jobId: ${jobId}`);
    
    return res.status(200).json({ jobId });
    
  } catch (error: any) {
    console.error('[JOBS_API] Error starting job:', error.message);
    return res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
});

jobsRouter.get('/:jobId', async (req, res) => {
  const { jobId } = req.params;
  
  console.log(`[JOBS_API] GET /${jobId} - Request received`);
  
  try {
    const status = getJobStatus(jobId);
    
    if (!status) {
      console.log(`[JOBS_API] Job not found: ${jobId}`);
      return res.status(404).json({
        error: 'Job not found'
      });
    }
    
    console.log(`[JOBS_API] Job ${jobId} status: ${status.status}`);
    
    return res.status(200).json(status);
    
  } catch (error: any) {
    console.error('[JOBS_API] Error getting job status:', error.message);
    return res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
});

jobsRouter.post('/:jobId/cancel', async (req, res) => {
  const { jobId } = req.params;
  
  console.log(`[JOBS_API] POST /${jobId}/cancel - Request received`);
  
  try {
    const cancelled = await cancelJob(jobId);
    
    if (!cancelled) {
      const status = getJobStatus(jobId);
      if (!status) {
        console.log(`[JOBS_API] Job not found: ${jobId}`);
        return res.status(404).json({
          error: 'Job not found'
        });
      }
      console.log(`[JOBS_API] Job ${jobId} cannot be cancelled - status: ${status.status}`);
      return res.status(400).json({
        error: `Job cannot be cancelled - current status: ${status.status}`
      });
    }
    
    console.log(`[JOBS_API] Job ${jobId} cancelled`);
    
    return res.status(200).json({ ok: true });
    
  } catch (error: any) {
    console.error('[JOBS_API] Error cancelling job:', error.message);
    return res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
});
