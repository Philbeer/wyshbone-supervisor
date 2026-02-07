import { storage } from '../storage';
import { logAFREvent } from './afr-logger';
import type { Artefact } from '../schema';

export interface ArtefactJudgementRequest {
  runId: string;
  artefactId: string;
  goal: string;
  successCriteria?: Record<string, unknown>;
  artefactType: string;
}

export interface ArtefactJudgementResponse {
  verdict: string;
  reasons: string[];
  metrics: Record<string, unknown>;
  action: 'continue' | 'stop' | 'retry' | 'change_plan';
}

function getTowerBaseUrl(): string | null {
  const raw = process.env.TOWER_BASE_URL || process.env.TOWER_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function isStubMode(): boolean {
  return process.env.TOWER_ARTEFACT_JUDGE_STUB === 'true' || !getTowerBaseUrl();
}

async function callTowerJudgeArtefact(
  request: ArtefactJudgementRequest
): Promise<ArtefactJudgementResponse> {
  const baseUrl = getTowerBaseUrl();
  if (!baseUrl) {
    throw new Error('TOWER_BASE_URL / TOWER_URL not configured');
  }

  const endpoint = `${baseUrl}/api/tower/judge-artefact`;
  const apiKey = process.env.TOWER_API_KEY || process.env.EXPORT_KEY || '';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-TOWER-API-KEY': apiKey } : {}),
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Tower judge-artefact HTTP ${response.status}: ${body.substring(0, 200)}`);
  }

  return (await response.json()) as ArtefactJudgementResponse;
}

function stubJudgement(request: ArtefactJudgementRequest): ArtefactJudgementResponse {
  console.log(`[TOWER_JUDGE] Stub mode: returning pass/continue for artefact ${request.artefactId}`);
  return {
    verdict: 'pass',
    reasons: ['Stub mode: auto-passing artefact judgement'],
    metrics: {},
    action: 'continue',
  };
}

export interface JudgeArtefactResult {
  judgement: ArtefactJudgementResponse;
  shouldStop: boolean;
  stubbed: boolean;
}

export async function judgeArtefact(params: {
  artefact: Artefact;
  runId: string;
  goal: string;
  userId: string;
  conversationId?: string;
  successCriteria?: Record<string, unknown>;
}): Promise<JudgeArtefactResult> {
  const { artefact, runId, goal, userId, conversationId, successCriteria } = params;

  const request: ArtefactJudgementRequest = {
    runId,
    artefactId: artefact.id,
    goal,
    successCriteria,
    artefactType: artefact.type,
  };

  let judgement: ArtefactJudgementResponse;
  let stubbed = false;

  if (isStubMode()) {
    judgement = stubJudgement(request);
    stubbed = true;
  } else {
    try {
      judgement = await callTowerJudgeArtefact(request);
    } catch (err: any) {
      const errorMsg = err.message || 'Tower judge-artefact call failed';
      console.error(`[TOWER_JUDGE] Call failed (defaulting to continue): ${errorMsg}`);

      await logAFREvent({
        userId,
        runId,
        conversationId,
        actionTaken: 'tower_judgement_failed',
        status: 'failed',
        taskGenerated: `Tower artefact judgement failed: ${errorMsg}`,
        runType: 'plan',
        metadata: { artefactId: artefact.id, error: errorMsg },
      });

      return {
        judgement: { verdict: 'error', reasons: [errorMsg], metrics: {}, action: 'continue' },
        shouldStop: false,
        stubbed: false,
      };
    }
  }

  try {
    await storage.createTowerJudgement({
      runId,
      artefactId: artefact.id,
      verdict: judgement.verdict,
      action: judgement.action,
      reasonsJson: judgement.reasons,
      metricsJson: judgement.metrics,
    });
  } catch (err: any) {
    console.error(`[TOWER_JUDGE] Failed to persist judgement: ${err.message}`);
  }

  const shortReason = judgement.reasons[0] || judgement.verdict;

  await logAFREvent({
    userId,
    runId,
    conversationId,
    actionTaken: 'tower_judgement',
    status: judgement.action === 'stop' || judgement.verdict === 'fail' ? 'failed' : 'success',
    taskGenerated: `[Tower] ${judgement.verdict}: ${shortReason}`,
    runType: 'plan',
    metadata: {
      artefactId: artefact.id,
      verdict: judgement.verdict,
      action: judgement.action,
      shortReason,
      stubbed,
    },
  });

  console.log(`[TOWER_JUDGE] Verdict: ${judgement.verdict} | Action: ${judgement.action} | Artefact: ${artefact.id}${stubbed ? ' (stub)' : ''}`);

  const shouldStop = judgement.action === 'stop' || judgement.verdict === 'fail';

  return { judgement, shouldStop, stubbed };
}
