/**
 * Deep Research Execute Job Handler
 *
 * Full deep-research flow for jobs started via /api/supervisor/jobs/start:
 * 1. Calls UI /api/tools/execute with topic/prompt
 * 2. Polls deep_research_runs table until completed/failed/timeout
 * 3. POSTs deep_research_result artefact to UI (runId = uiRunId)
 * 4. Emits gated AFR events (deep_research_completed only after artefact 2xx)
 *
 * Does NOT depend on ENABLE_DEEP_RESEARCH_POLLER or any scheduler.
 */

import { supabase } from '../../../supabase';
import { logAFREvent, logToolCallStarted, logToolCallCompleted, logToolCallFailed, logRunCompleted } from '../../afr-logger';
import type { Job } from '../../jobs';

export interface DeepResearchExecuteResult {
  success: boolean;
  deepResearchRunId?: string;
  artefactPosted: boolean;
  artefactId?: string;
  status: 'completed' | 'failed' | 'timeout';
  durationMs: number;
  error?: string;
}

export interface ProgressCallback {
  (progress: number, message: string): Promise<void>;
}

const POLL_INTERVAL = 5000;
const MAX_POLL_TIME = 5 * 60 * 1000;

async function postArtefact(params: {
  runId: string;
  clientRequestId?: string;
  type: string;
  payload: Record<string, unknown>;
  userId?: string;
}): Promise<{ ok: boolean; artefactId?: string; httpStatus?: number }> {
  const uiBaseUrl = (process.env.UI_URL || '').replace(/\/+$/, '');
  if (!uiBaseUrl) {
    console.error(`[ARTEFACT_POST] runId=${params.runId} clientRequestId=${params.clientRequestId || 'none'} UI_URL not configured`);
    if (params.userId) {
      logAFREvent({
        userId: params.userId, runId: params.runId,
        ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
        actionTaken: 'artefact_post_failed', status: 'failed',
        taskGenerated: 'Artefact POST failed: UI_URL not configured',
        runType: 'plan', metadata: { runId: params.runId, status: 0, hasBody: false, errorCode: 'ui_url_missing' },
      }).catch(() => {});
    }
    return { ok: false };
  }

  try {
    const resp = await fetch(`${uiBaseUrl}/api/afr/artefacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: params.runId,
        ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
        type: params.type,
        payload: params.payload,
        createdAt: new Date().toISOString(),
      }),
    });
    const rawBody = await resp.text();
    let json: any = {};
    let hasBody = false;
    try { json = JSON.parse(rawBody); hasBody = true; } catch { hasBody = rawBody.length > 0; }
    const artefactId = json?.artefactId || json?.id || undefined;
    const hasArtefactId = !!artefactId;

    console.log(`[ARTEFACT_POST] runId=${params.runId} clientRequestId=${params.clientRequestId || 'none'} status=${resp.status} hasArtefactId=${hasArtefactId}${hasArtefactId ? ` artefactId=${artefactId}` : ''}`);

    if (!resp.ok || !hasArtefactId) {
      if (params.userId) {
        logAFREvent({
          userId: params.userId, runId: params.runId,
          ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
          actionTaken: 'artefact_post_failed', status: 'failed',
          taskGenerated: `Artefact POST failed: HTTP ${resp.status}${!hasArtefactId ? ' (no artefactId)' : ''}`,
          runType: 'plan', metadata: { runId: params.runId, status: resp.status, hasBody, errorCode: json?.error || json?.code || null },
        }).catch(() => {});
      }
      return { ok: false, httpStatus: resp.status };
    }

    if (params.userId) {
      logAFREvent({
        userId: params.userId, runId: params.runId,
        ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
        actionTaken: 'artefact_post_succeeded', status: 'success',
        taskGenerated: `Artefact POST succeeded: artefactId=${artefactId}`,
        runType: 'plan', metadata: { runId: params.runId, artefactId },
      }).catch(() => {});
    }

    return { ok: true, artefactId, httpStatus: resp.status };
  } catch (e: any) {
    console.error(`[ARTEFACT_POST] runId=${params.runId} clientRequestId=${params.clientRequestId || 'none'} NETWORK_ERROR: ${e.message}`);
    if (params.userId) {
      logAFREvent({
        userId: params.userId, runId: params.runId,
        ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
        actionTaken: 'artefact_post_failed', status: 'failed',
        taskGenerated: 'Artefact POST failed: network error',
        runType: 'plan', metadata: { runId: params.runId, status: 0, hasBody: false, errorCode: 'network_error' },
      }).catch(() => {});
    }
    return { ok: false };
  }
}

async function bridgeRun(uiRunId: string, supervisorRunId: string, clientRequestId?: string): Promise<void> {
  const uiBaseUrl = (process.env.UI_URL || '').replace(/\/+$/, '');
  if (!uiBaseUrl) return;
  try {
    const resp = await fetch(`${uiBaseUrl}/api/afr/run-bridge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: uiRunId,
        supervisorRunId,
        ...(clientRequestId ? { clientRequestId } : {}),
      }),
    });
    console.log(`[RUN_BRIDGE] uiRunId=${uiRunId} supervisorRunId=${supervisorRunId} status=${resp.status}`);
  } catch (e: any) {
    console.error(`[RUN_BRIDGE] uiRunId=${uiRunId} supervisorRunId=${supervisorRunId} NETWORK_ERROR: ${e.message}`);
  }
}

export async function runDeepResearchExecute(
  job: Job,
  onProgress: ProgressCallback
): Promise<DeepResearchExecuteResult> {
  const startTime = Date.now();
  const uiRunId = job.sourceRunId || job.jobId;
  const clientRequestId = job.clientRequestId;
  const userId = job.userId || 'system';
  const topic = job.payload?.topic || job.payload?.prompt || 'unknown topic';
  const prompt = job.payload?.prompt || topic;

  const result: DeepResearchExecuteResult = {
    success: false,
    artefactPosted: false,
    status: 'failed',
    durationMs: 0,
  };

  logAFREvent({
    userId, runId: uiRunId,
    ...(clientRequestId ? { clientRequestId } : {}),
    actionTaken: 'deep_research_started', status: 'pending',
    taskGenerated: `Deep research started: "${topic}"`,
    runType: 'plan', metadata: { tool: 'DEEP_RESEARCH', topic, jobId: job.jobId },
  }).catch(() => {});

  console.log(`[DEEP_RESEARCH] uiRunId=${uiRunId} crid=${clientRequestId || 'none'} userId=${userId} status=started topic="${topic}"`);

  await onProgress(5, `Starting deep research: "${topic}"`);

  let deepResearchRunId: string | undefined;
  let researchResult: any = null;
  let researchError: string | undefined;

  try {
    logToolCallStarted(userId, uiRunId, 'DEEP_RESEARCH', { topic, prompt }, undefined).catch(() => {});

    await onProgress(10, 'Calling UI /api/tools/execute...');

    const uiBaseUrl = (process.env.UI_URL || '').replace(/\/+$/, '');
    if (!uiBaseUrl) {
      researchError = 'UI_URL not configured for deep research';
    } else {
      const toolResp = await fetch(`${uiBaseUrl}/api/tools/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'deep_research',
          params: { topic, prompt },
          userId,
          sessionId: `supervisor_job_${job.jobId}`,
        }),
      });

      const toolData = await toolResp.json().catch(() => ({}));
      deepResearchRunId = toolData?.data?.runId || toolData?.data?.id || toolData?.runId || undefined;
      result.deepResearchRunId = deepResearchRunId;

      if (deepResearchRunId) {
        console.log(`[DEEP_RESEARCH] uiRunId=${uiRunId} crid=${clientRequestId || 'none'} deepResearchRunId=${deepResearchRunId} — polling`);

        await onProgress(15, `Deep research triggered (runId: ${deepResearchRunId}), polling...`);

        bridgeRun(uiRunId, deepResearchRunId, clientRequestId).catch(() => {});

        if (!supabase) {
          researchError = 'Supabase not configured — cannot poll deep_research_runs';
        } else {
          const pollStart = Date.now();
          let pollCount = 0;

          while (Date.now() - pollStart < MAX_POLL_TIME) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));
            pollCount++;

            const elapsed = Math.round((Date.now() - pollStart) / 1000);
            const pct = Math.min(15 + Math.floor((elapsed / (MAX_POLL_TIME / 1000)) * 70), 85);
            await onProgress(pct, `Polling deep_research_runs (${elapsed}s elapsed, poll #${pollCount})`);

            const { data: runRow, error: pollErr } = await supabase
              .from('deep_research_runs')
              .select('*')
              .eq('id', deepResearchRunId)
              .single();

            if (pollErr) {
              console.warn(`[DEEP_RESEARCH] poll error for ${deepResearchRunId}: ${pollErr.message}`);
              continue;
            }

            if (runRow?.status === 'completed') {
              researchResult = runRow.result || runRow.data;
              console.log(`[DEEP_RESEARCH] uiRunId=${uiRunId} deepResearchRunId=${deepResearchRunId} completed`);
              break;
            } else if (runRow?.status === 'failed' || runRow?.status === 'error') {
              researchError = runRow.error || 'Deep research failed';
              console.log(`[DEEP_RESEARCH] uiRunId=${uiRunId} deepResearchRunId=${deepResearchRunId} failed: ${researchError}`);
              break;
            }
          }

          if (!researchResult && !researchError) {
            researchError = `Deep research timed out after ${MAX_POLL_TIME / 1000}s`;
            result.status = 'timeout';
            console.log(`[DEEP_RESEARCH] uiRunId=${uiRunId} deepResearchRunId=${deepResearchRunId} TIMEOUT`);
          }
        }
      } else if (toolData?.ok || toolData?.success) {
        researchResult = toolData?.data || toolData;
      } else {
        researchError = toolData?.error || `UI tool returned: ${JSON.stringify(toolData).substring(0, 200)}`;
      }
    }
  } catch (err: any) {
    researchError = err.message || 'Deep research execution failed';
    console.error(`[DEEP_RESEARCH] uiRunId=${uiRunId} crid=${clientRequestId || 'none'} EXCEPTION: ${researchError}`);
  }

  await onProgress(90, researchError ? `Research failed: ${researchError}` : 'Posting artefact...');

  if (researchError) {
    logToolCallFailed(userId, uiRunId, 'DEEP_RESEARCH', researchError, undefined).catch(() => {});
  } else {
    logToolCallCompleted(userId, uiRunId, 'DEEP_RESEARCH', { summary: `Deep research completed for "${topic}"`, hasResult: !!researchResult }, undefined).catch(() => {});
  }

  const report = researchResult
    ? (typeof researchResult === 'string' ? researchResult : (researchResult.report || researchResult.summary || JSON.stringify(researchResult).substring(0, 2000)))
    : '';
  const sources = researchResult?.sources || researchResult?.references || [];
  const status: 'completed' | 'failed' | 'timeout' = researchError
    ? (result.status === 'timeout' ? 'timeout' : 'failed')
    : 'completed';
  result.status = status;

  const artefactTitle = researchError
    ? `Deep research failed: "${topic}"`
    : `Deep research: "${topic}"`;
  const artefactSummary = researchError
    ? `DEEP_RESEARCH ${status}: ${researchError}`
    : `Deep research completed for "${topic}"`;

  const postResult = await postArtefact({
    runId: uiRunId,
    clientRequestId,
    type: 'deep_research_result',
    payload: {
      title: artefactTitle,
      summary: artefactSummary,
      report,
      sources: Array.isArray(sources) ? sources : [],
      status,
      topic,
      tool: 'DEEP_RESEARCH',
      ...(deepResearchRunId ? { deep_research_run_id: deepResearchRunId } : {}),
      ...(researchError ? { error: researchError } : {}),
    },
    userId,
  });

  result.artefactPosted = postResult.ok;
  result.artefactId = postResult.artefactId;

  console.log(`[DEEP_RESEARCH] uiRunId=${uiRunId} crid=${clientRequestId || 'none'} userId=${userId} status=${status} posted=${postResult.ok} artefactId=${postResult.artefactId || 'none'} deepResearchRunId=${deepResearchRunId || 'none'}`);

  if (postResult.ok) {
    logAFREvent({
      userId, runId: uiRunId,
      ...(clientRequestId ? { clientRequestId } : {}),
      actionTaken: 'artefact_created', status: 'success',
      taskGenerated: `Artefact created: ${artefactTitle}`,
      runType: 'plan', metadata: { artefactType: 'deep_research_result', title: artefactTitle, artefactId: postResult.artefactId },
    }).catch(() => {});

    if (researchError) {
      logAFREvent({
        userId, runId: uiRunId,
        ...(clientRequestId ? { clientRequestId } : {}),
        actionTaken: 'deep_research_failed', status: 'failed',
        taskGenerated: `Deep research failed: ${researchError}`,
        runType: 'plan', metadata: { tool: 'DEEP_RESEARCH', error: researchError, deepResearchRunId, jobId: job.jobId },
      }).catch(() => {});
    } else {
      logAFREvent({
        userId, runId: uiRunId,
        ...(clientRequestId ? { clientRequestId } : {}),
        actionTaken: 'deep_research_completed', status: 'success',
        taskGenerated: `Deep research completed: "${topic}"`,
        runType: 'plan', metadata: { tool: 'DEEP_RESEARCH', artefactId: postResult.artefactId, deepResearchRunId, jobId: job.jobId },
      }).catch(() => {});

      logRunCompleted(
        userId, uiRunId,
        `Deep research complete: "${topic}"`,
        { tool: 'DEEP_RESEARCH', topic, deepResearchRunId, jobId: job.jobId },
        undefined
      ).catch(() => {});
    }
  }

  await onProgress(100, postResult.ok ? `Artefact posted (${status})` : `Artefact post failed (${status})`);

  result.success = !researchError;
  result.durationMs = Date.now() - startTime;
  if (researchError) result.error = researchError;

  return result;
}
