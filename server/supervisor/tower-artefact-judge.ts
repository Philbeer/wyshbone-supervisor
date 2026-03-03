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
  gaps?: Array<{ type: string; severity?: string; detail?: string } | string>;
  suggested_changes?: Array<{
    field: string;
    action: string;
    reason?: string;
    current_value?: unknown;
    suggested_value?: unknown;
  }>;
  learning_update?: {
    query_shape_key: string;
    updates: Record<string, unknown>;
  };
}

function getTowerBaseUrl(): string | null {
  const raw = process.env.TOWER_BASE_URL || process.env.TOWER_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function isStubMode(): boolean {
  if (process.env.TOWER_ARTEFACT_JUDGE_STUB === 'true') {
    return true;
  }
  return false;
}

export function assertTowerConfig(): void {
  const stub = process.env.TOWER_ARTEFACT_JUDGE_STUB === 'true';
  const baseUrl = getTowerBaseUrl();
  const masked = baseUrl ? baseUrl.replace(/(:\/\/[^:]+:)[^@]+@/, '$1***@').substring(0, 60) + '...' : '(not set)';

  console.log('============================================================');
  console.log('[TOWER] Tower Artefact Judge Configuration');
  console.log('============================================================');
  console.log(`   TOWER_BASE_URL / TOWER_URL: ${masked}`);
  console.log(`   TOWER_ARTEFACT_JUDGE_STUB:  ${stub ? 'ON (stub mode)' : 'OFF (real calls)'}`);

  if (!stub && !baseUrl) {
    console.error('   FATAL: Stub mode is OFF but no TOWER_BASE_URL or TOWER_URL is set.');
    console.error('   Tower judgement calls will fail at runtime.');
    console.error('   Set TOWER_BASE_URL / TOWER_URL, or set TOWER_ARTEFACT_JUDGE_STUB=true');
    console.log('============================================================');
    throw new Error('[TOWER] Cannot start: TOWER_BASE_URL / TOWER_URL required when stub mode is OFF');
  }

  console.log(`   Status: ${stub ? 'STUB MODE — auto-passing all judgements' : 'LIVE — real HTTP calls to Tower'}`);
  console.log('============================================================');
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

  if (process.env.DEBUG_TOWER_PAYLOAD === 'true') {
    const sc = (request.successCriteria || {}) as Record<string, unknown>;
    console.log(`[DEBUG_TOWER_PAYLOAD] Outbound judge-artefact request:`, JSON.stringify({
      runId: request.runId,
      artefactId: request.artefactId,
      artefactType: request.artefactType,
      target_count: sc.target_count,
      requested_count: (sc.plan_constraints as any)?.requested_count,
      constraints: sc.constraints,
      hard_constraints: sc.hard_constraints,
      soft_constraints: sc.soft_constraints,
      prefix: sc.prefix,
      location: (sc.plan_constraints as any)?.location,
      plan_version: sc.plan_version,
    }, null, 2));
  }

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
  governanceStatus?: 'governed' | 'tower_unavailable';
}

export async function judgeArtefact(params: {
  artefact: Artefact;
  runId: string;
  goal: string;
  userId: string;
  conversationId?: string;
  successCriteria?: Record<string, unknown>;
  stepIndex?: number;
  planVersion?: number;
}): Promise<JudgeArtefactResult> {
  const { artefact, runId, goal, userId, conversationId, successCriteria, stepIndex, planVersion } = params;

  const request: ArtefactJudgementRequest = {
    runId,
    artefactId: artefact.id,
    goal,
    successCriteria,
    artefactType: artefact.type,
  };

  const idempotencyKey = `${runId}:${artefact.id}:${stepIndex ?? 0}:${planVersion ?? 1}`;

  let judgement: ArtefactJudgementResponse;
  let stubbed = false;
  let towerAvailable = true;
  let governanceStatus: 'governed' | 'tower_unavailable' = 'governed';

  if (isStubMode()) {
    judgement = stubJudgement(request);
    stubbed = true;
  } else {
    const baseUrl = getTowerBaseUrl();
    if (!baseUrl) {
      const errorMsg = 'TOWER_BASE_URL / TOWER_URL not configured and stub mode is OFF -- refusing to silently bypass Tower';
      console.error(`[TOWER_JUDGE] ${errorMsg}`);
      towerAvailable = false;
      governanceStatus = 'tower_unavailable';

      await logAFREvent({
        userId,
        runId,
        conversationId,
        actionTaken: 'tower_judgement_failed',
        status: 'failed',
        taskGenerated: `Tower artefact judgement blocked: ${errorMsg}`,
        runType: 'plan',
        metadata: { artefactId: artefact.id, error: errorMsg, governance_status: governanceStatus },
      });

      return {
        judgement: { verdict: 'error', reasons: [errorMsg], metrics: {}, action: 'stop' },
        shouldStop: true,
        stubbed: false,
        governanceStatus,
      };
    }

    try {
      judgement = await callTowerJudgeArtefact(request);
    } catch (err: any) {
      const errorMsg = err.message || 'Tower judge-artefact call failed';
      console.error(`[TOWER_JUDGE] Tower unreachable -- STOPPING run (honest governance): ${errorMsg}`);
      towerAvailable = false;
      governanceStatus = 'tower_unavailable';

      await logAFREvent({
        userId,
        runId,
        conversationId,
        actionTaken: 'tower_judgement_failed',
        status: 'failed',
        taskGenerated: `Tower unreachable -- run stopped (governance_status=tower_unavailable): ${errorMsg}`,
        runType: 'plan',
        metadata: { artefactId: artefact.id, error: errorMsg, governance_status: governanceStatus },
      });

      return {
        judgement: { verdict: 'error', reasons: [errorMsg], metrics: {}, action: 'stop' },
        shouldStop: true,
        stubbed: false,
        governanceStatus,
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
      idempotencyKey,
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
    status: judgement.action === 'stop' || judgement.verdict === 'error' || (judgement.verdict === 'fail' && judgement.action !== 'change_plan') ? 'failed' : 'success',
    taskGenerated: `[Tower] ${judgement.verdict}: ${shortReason}`,
    runType: 'plan',
    metadata: {
      artefactId: artefact.id,
      verdict: judgement.verdict,
      action: judgement.action,
      shortReason,
      stubbed,
      governance_status: governanceStatus,
      idempotency_key: idempotencyKey,
    },
  });

  console.log(`[TOWER_JUDGE] Verdict: ${judgement.verdict} | Action: ${judgement.action} | Artefact: ${artefact.id}${stubbed ? ' (stub)' : ''} | ikey=${idempotencyKey}`);

  const shouldStop = judgement.action === 'stop' || judgement.verdict === 'error' || (judgement.verdict === 'fail' && judgement.action !== 'change_plan');

  return { judgement, shouldStop, stubbed, governanceStatus };
}
