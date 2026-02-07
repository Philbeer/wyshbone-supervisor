/**
 * Tower Judgement API Client
 * 
 * Calls the Tower evaluate endpoint after each plan step to get
 * CONTINUE/STOP verdicts. Emits AFR events for the full judgement lifecycle.
 * 
 * Session 3: Agentic decision loop integration.
 */

import { logAFREvent, logTowerEvaluationCompleted, logTowerDecisionStop, logTowerDecisionChangePlan } from './afr-logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TowerSuccessCriteria {
  target_leads: number;
  max_cost_per_lead_gbp: number;
  max_cost_gbp: number;
  max_steps: number;
  min_quality_score: number;
  stall_window_steps: number;
  stall_min_delta_leads: number;
  max_failures: number;
}

export interface TowerSnapshot {
  steps_completed: number;
  leads_found: number;
  leads_new_last_window: number;
  failures_count: number;
  total_cost_gbp: number;
  avg_quality_score: number;
}

export interface TowerEvaluateRequest {
  run_id: string;
  mission_type: string;
  success: TowerSuccessCriteria;
  snapshot: TowerSnapshot;
}

export interface TowerEvaluateResponse {
  verdict: 'CONTINUE' | 'STOP' | 'CHANGE_PLAN';
  reason_code: string;
  explanation: string;
  evaluated_at: string;
}

export type TowerVerdict = TowerEvaluateResponse;

// ---------------------------------------------------------------------------
// Default success thresholds (demo-friendly: strict enough to trigger STOP)
// ---------------------------------------------------------------------------

export const LEADGEN_SUCCESS_DEFAULTS: TowerSuccessCriteria = {
  target_leads: 5,
  max_cost_per_lead_gbp: 0.50,
  max_cost_gbp: 2.00,
  max_steps: 8,
  min_quality_score: 0.6,
  stall_window_steps: 3,
  stall_min_delta_leads: 1,
  max_failures: 3,
};

// ---------------------------------------------------------------------------
// Run summary – mutable state updated after each step
// ---------------------------------------------------------------------------

export interface RunSummary {
  steps_completed: number;
  leads_found: number;
  leads_per_step: number[];   // rolling record for stall detection
  failures_count: number;
  total_cost_gbp: number;
  quality_scores: number[];   // per-lead: 1 = valid, 0 = invalid
}

export function createRunSummary(): RunSummary {
  return {
    steps_completed: 0,
    leads_found: 0,
    leads_per_step: [],
    failures_count: 0,
    total_cost_gbp: 0,
    quality_scores: [],
  };
}

export function updateRunSummary(
  summary: RunSummary,
  stepResult: { success: boolean; leadsFound?: number; costUnits?: number; validLeads?: number; invalidLeads?: number }
): void {
  summary.steps_completed += 1;

  const newLeads = stepResult.leadsFound ?? 0;
  summary.leads_found += newLeads;
  summary.leads_per_step.push(newLeads);

  if (!stepResult.success) {
    summary.failures_count += 1;
  }

  summary.total_cost_gbp += stepResult.costUnits ?? 0.25;

  const valid = stepResult.validLeads ?? (stepResult.success ? newLeads : 0);
  const invalid = stepResult.invalidLeads ?? 0;
  for (let i = 0; i < valid; i++) summary.quality_scores.push(1);
  for (let i = 0; i < invalid; i++) summary.quality_scores.push(0);
}

export function buildSnapshot(summary: RunSummary, stallWindow: number): TowerSnapshot {
  const window = summary.leads_per_step.slice(-stallWindow);
  const leadsNewLastWindow = window.reduce((a, b) => a + b, 0);

  const avgQuality =
    summary.quality_scores.length > 0
      ? summary.quality_scores.reduce((a, b) => a + b, 0) / summary.quality_scores.length
      : 0;

  return {
    steps_completed: summary.steps_completed,
    leads_found: summary.leads_found,
    leads_new_last_window: leadsNewLastWindow,
    failures_count: summary.failures_count,
    total_cost_gbp: summary.total_cost_gbp,
    avg_quality_score: parseFloat(avgQuality.toFixed(3)),
  };
}

// ---------------------------------------------------------------------------
// Tower API call
// ---------------------------------------------------------------------------

function getTowerEndpoint(): string | null {
  const raw = process.env.TOWER_URL;
  if (!raw) return null;
  const towerBase = raw.replace(/\/+$/, '');
  return `${towerBase}/api/tower/evaluate`;
}

export async function callTowerEvaluate(
  request: TowerEvaluateRequest
): Promise<TowerEvaluateResponse> {
  const endpoint = getTowerEndpoint();
  if (!endpoint) {
    throw new Error('TOWER_URL not configured');
  }

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
    throw new Error(`Tower responded HTTP ${response.status}: ${body.substring(0, 200)}`);
  }

  const data = (await response.json()) as TowerEvaluateResponse;
  return data;
}

// ---------------------------------------------------------------------------
// Judgement loop helper (called after each step in plan-executor)
// ---------------------------------------------------------------------------

export interface JudgementResult {
  shouldStop: boolean;
  verdict?: TowerEvaluateResponse;
  error?: string;
}

export async function requestJudgement(
  runId: string,
  userId: string,
  missionType: string,
  successCriteria: TowerSuccessCriteria,
  snapshot: TowerSnapshot,
  conversationId?: string,
): Promise<JudgementResult> {
  const towerEndpoint = getTowerEndpoint();
  if (!towerEndpoint) {
    console.log('[TOWER_JUDGEMENT] TOWER_URL not set – skipping judgement');
    return { shouldStop: false };
  }

  const request: TowerEvaluateRequest = {
    run_id: runId,
    mission_type: missionType,
    success: successCriteria,
    snapshot,
  };

  // AFR: judgement_requested
  await logAFREvent({
    userId,
    runId,
    conversationId,
    actionTaken: 'judgement_requested',
    status: 'pending',
    taskGenerated: `Requesting Tower judgement (step ${snapshot.steps_completed}, leads ${snapshot.leads_found})`,
    runType: 'tool',
    metadata: {
      missionType,
      success: successCriteria,
      snapshot,
    },
  });

  try {
    const verdict = await callTowerEvaluate(request);

    // AFR: judgement_received (legacy)
    await logAFREvent({
      userId,
      runId,
      conversationId,
      actionTaken: 'judgement_received',
      status: 'success',
      taskGenerated: `Tower verdict: ${verdict.verdict} (${verdict.reason_code})`,
      runType: 'tool',
      metadata: {
        verdict: verdict.verdict,
        reason_code: verdict.reason_code,
        explanation: verdict.explanation,
        evaluated_at: verdict.evaluated_at,
        snapshot,
      },
    });

    const towerMetrics: Record<string, unknown> = {
      steps_completed: snapshot.steps_completed,
      leads_found: snapshot.leads_found,
      leads_new_last_window: snapshot.leads_new_last_window,
      avg_quality_score: snapshot.avg_quality_score,
      total_cost_gbp: snapshot.total_cost_gbp,
      failures_count: snapshot.failures_count,
      reason_code: verdict.reason_code,
      evaluated_at: verdict.evaluated_at,
    };

    await logTowerEvaluationCompleted(
      userId,
      runId,
      verdict.verdict,
      verdict.explanation,
      towerMetrics,
      conversationId,
    );

    console.log(
      `[TOWER_JUDGEMENT] Verdict: ${verdict.verdict} | reason: ${verdict.reason_code} | ${verdict.explanation}`
    );

    if (verdict.verdict === 'STOP' || verdict.verdict === 'CHANGE_PLAN') {
      // AFR: job_halted_by_judgement (legacy)
      await logAFREvent({
        userId,
        runId,
        conversationId,
        actionTaken: 'job_halted_by_judgement',
        status: 'failed',
        taskGenerated: `Job halted by Tower: ${verdict.reason_code} – ${verdict.explanation}`,
        runType: 'plan',
        metadata: {
          reason_code: verdict.reason_code,
          explanation: verdict.explanation,
          snapshot,
        },
      });

      if (verdict.verdict === 'CHANGE_PLAN') {
        await logTowerDecisionChangePlan(
          userId,
          runId,
          verdict.explanation,
          towerMetrics,
          conversationId,
        );
      } else {
        await logTowerDecisionStop(
          userId,
          runId,
          verdict.explanation,
          towerMetrics,
          conversationId,
        );
      }

      return { shouldStop: true, verdict };
    }

    return { shouldStop: false, verdict };
  } catch (err: any) {
    const errorMsg = err.message || 'Tower call failed';
    console.error(`[TOWER_JUDGEMENT] Call failed (defaulting to CONTINUE): ${errorMsg}`);

    // AFR: judgement_failed
    await logAFREvent({
      userId,
      runId,
      conversationId,
      actionTaken: 'judgement_failed',
      status: 'failed',
      taskGenerated: `Tower judgement call failed: ${errorMsg}`,
      runType: 'tool',
      metadata: {
        error: errorMsg,
        snapshot,
      },
    });

    return { shouldStop: false, error: errorMsg };
  }
}
