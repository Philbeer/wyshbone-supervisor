import { logAFREvent, logToolCallStarted, logToolCallCompleted, logToolCallFailed, logRunCompleted } from '../../afr-logger';
import { createResearchProvider } from '../../research-provider';
import type { Job } from '../../jobs';

export interface DeepResearchExecuteResult {
  success: boolean;
  artefactPosted: boolean;
  artefactId?: string;
  status: 'completed' | 'failed';
  durationMs: number;
  reportChars: number;
  sourcesCount: number;
  error?: string;
}

export interface ProgressCallback {
  (progress: number, message: string): Promise<void>;
}

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

export async function runDeepResearchExecute(
  job: Job,
  onProgress: ProgressCallback
): Promise<DeepResearchExecuteResult> {
  const startTime = Date.now();
  const uiRunId = job.sourceRunId;
  const clientRequestId = job.clientRequestId;
  const userId = job.userId || 'system';
  const topic = job.payload?.topic || job.payload?.prompt || 'unknown topic';
  const prompt = job.payload?.prompt || topic;

  const result: DeepResearchExecuteResult = {
    success: false,
    artefactPosted: false,
    status: 'failed',
    durationMs: 0,
    reportChars: 0,
    sourcesCount: 0,
  };

  if (!uiRunId) {
    const errMsg = 'Missing required sourceRunId (UI canonical runId) on job';
    console.error(`[DEEP_RESEARCH] jobId=${job.jobId} ERROR: ${errMsg}`);
    logAFREvent({
      userId, runId: job.jobId,
      ...(clientRequestId ? { clientRequestId } : {}),
      actionTaken: 'artefact_post_failed', status: 'failed',
      taskGenerated: errMsg,
      runType: 'plan', metadata: { errorCode: 'missing_identifiers', jobId: job.jobId },
    }).catch(() => {});
    result.error = errMsg;
    result.durationMs = Date.now() - startTime;
    return result;
  }

  logAFREvent({
    userId, runId: uiRunId,
    ...(clientRequestId ? { clientRequestId } : {}),
    actionTaken: 'deep_research_started', status: 'pending',
    taskGenerated: `Deep research started: "${topic}"`,
    runType: 'plan', metadata: { tool: 'DEEP_RESEARCH', topic, jobId: job.jobId },
  }).catch(() => {});

  const provider = createResearchProvider();
  const providerName = provider.name;

  console.log(`[DEEP_RESEARCH] uiRunId=${uiRunId} crid=${clientRequestId || 'none'} userId=${userId} provider=${providerName} status=started topic="${topic}"`);

  await onProgress(5, `Starting deep research: "${topic}"`);

  let reportMarkdown = '';
  let sources: Array<{ title: string; url: string }> = [];
  let researchError: string | undefined;
  let artefactTitle = '';
  let artefactSummary = '';

  try {
    logToolCallStarted(userId, uiRunId, 'DEEP_RESEARCH', { topic, prompt, provider: providerName }, undefined).catch(() => {});

    await onProgress(10, `Running research via ${providerName}...`);

    const researchResult = await provider.research(topic, prompt);
    reportMarkdown = researchResult.report_markdown;
    sources = researchResult.sources;
    artefactTitle = researchResult.title;
    artefactSummary = researchResult.summary;
    result.reportChars = reportMarkdown.length;
    result.sourcesCount = sources.length;

    logToolCallCompleted(userId, uiRunId, 'DEEP_RESEARCH', {
      summary: `Deep research completed for "${topic}"`,
      provider: providerName,
      reportChars: reportMarkdown.length,
      sourcesCount: sources.length,
    }, undefined).catch(() => {});
  } catch (err: any) {
    researchError = err.message || 'Deep research execution failed';
    console.error(`[DEEP_RESEARCH] uiRunId=${uiRunId} crid=${clientRequestId || 'none'} provider=${providerName} EXCEPTION: ${researchError}`);
    logToolCallFailed(userId, uiRunId, 'DEEP_RESEARCH', researchError!, undefined).catch(() => {});
  }

  await onProgress(80, researchError ? `Research failed: ${researchError}` : 'Posting artefact...');

  const status: 'completed' | 'failed' = researchError ? 'failed' : 'completed';
  result.status = status;

  if (researchError) {
    artefactTitle = `Deep research failed: "${topic}"`;
    artefactSummary = `DEEP_RESEARCH failed: ${researchError}`;
  }

  const postResult = await postArtefact({
    runId: uiRunId,
    clientRequestId,
    type: 'deep_research_result',
    payload: {
      title: artefactTitle,
      summary: artefactSummary,
      report_markdown: reportMarkdown,
      sources,
      status,
      topic,
      tool: 'DEEP_RESEARCH',
      provider: providerName,
      ...(researchError ? { error: researchError } : {}),
    },
    userId,
  });

  result.artefactPosted = postResult.ok;
  result.artefactId = postResult.artefactId;

  console.log(`[DEEP_RESEARCH] uiRunId=${uiRunId} crid=${clientRequestId || 'none'} userId=${userId} provider=${providerName} status=${status} reportChars=${reportMarkdown.length} sourcesCount=${sources.length} posted=${postResult.ok} artefactId=${postResult.artefactId || 'none'}`);

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
        runType: 'plan', metadata: { tool: 'DEEP_RESEARCH', error: researchError, jobId: job.jobId },
      }).catch(() => {});
    } else {
      logAFREvent({
        userId, runId: uiRunId,
        ...(clientRequestId ? { clientRequestId } : {}),
        actionTaken: 'deep_research_completed', status: 'success',
        taskGenerated: `Deep research completed: "${topic}"`,
        runType: 'plan', metadata: { tool: 'DEEP_RESEARCH', artefactId: postResult.artefactId, jobId: job.jobId, reportChars: reportMarkdown.length, sourcesCount: sources.length },
      }).catch(() => {});

      logRunCompleted(
        userId, uiRunId,
        `Deep research complete: "${topic}"`,
        { tool: 'DEEP_RESEARCH', topic, jobId: job.jobId, reportChars: reportMarkdown.length, sourcesCount: sources.length },
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
