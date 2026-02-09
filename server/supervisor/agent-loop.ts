/**
 * Agent Loop v1 — Phase 1 (SEARCH_PLACES only)
 *
 * After a tool run produces an artefact, Tower returns a v1 verdict.
 * Supervisor reacts automatically:
 *   ACCEPT     → emit tower_judgement_received + run_completed, post run_summary artefact
 *   RETRY      → retry same tool once (maxRetry=1). If already retried → STOP.
 *   CHANGE_PLAN→ create plan_update artefact (plan_version=2), rerun with adjusted params.
 *   STOP       → emit run_stopped, post run_summary artefact.
 *
 * Scope: SEARCH_PLACES only. No CRM, email, or multi-run learning.
 */

import { logAFREvent } from './afr-logger';
import { createArtefact } from './artefacts';
import type { ActionResult } from './action-executor';

export interface TowerVerdictV1 {
  verdict: 'ACCEPT' | 'RETRY' | 'CHANGE_PLAN' | 'STOP';
  delivered: number | string;
  requested: number | string;
  gaps: string[];
  confidence: number;
  rationale: string;
}

export interface RunState {
  runId: string;
  userId: string;
  conversationId?: string;
  planVersion: number;
  retryCount: number;
  lastToolArgs: Record<string, unknown>;
  lastVerdict?: TowerVerdictV1;
  status: 'running' | 'accepted' | 'stopped' | 'retrying' | 'replanning';
  createdAt: number;
}

const MAX_RETRIES = 1;
const MAX_PLAN_VERSION = 2;

const runStates = new Map<string, RunState>();

export function getRunState(runId: string): RunState | undefined {
  return runStates.get(runId);
}

export function getAllRunStates(): RunState[] {
  return Array.from(runStates.values());
}

export function initRunState(
  runId: string,
  userId: string,
  toolArgs: Record<string, unknown>,
  conversationId?: string,
): RunState {
  const state: RunState = {
    runId,
    userId,
    conversationId,
    planVersion: 1,
    retryCount: 0,
    lastToolArgs: { ...toolArgs },
    status: 'running',
    createdAt: Date.now(),
  };
  runStates.set(runId, state);
  console.log(`[AGENT_LOOP] RunState initialized: runId=${runId} planVersion=1`);
  return state;
}

export function setSimulatedVerdict(runId: string, verdict: TowerVerdictV1): void {
  const state = runStates.get(runId);
  if (state) {
    state.lastVerdict = verdict;
  }
  simulatedVerdicts.set(runId, verdict);
}

const simulatedVerdicts = new Map<string, TowerVerdictV1>();

export function getSimulatedVerdict(runId: string): TowerVerdictV1 | undefined {
  return simulatedVerdicts.get(runId);
}

export function clearSimulatedVerdict(runId: string): void {
  simulatedVerdicts.delete(runId);
}

function getTowerBaseUrl(): string | null {
  const raw = process.env.TOWER_BASE_URL || process.env.TOWER_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

export async function callTowerJudgeV1(
  goal: string,
  successCriteria: Record<string, unknown>,
  artefactPayload: Record<string, unknown>,
  runId: string,
): Promise<TowerVerdictV1> {
  const simulated = simulatedVerdicts.get(runId);
  if (simulated) {
    console.log(`[AGENT_LOOP] Using simulated verdict for runId=${runId}: ${simulated.verdict}`);
    simulatedVerdicts.delete(runId);
    return simulated;
  }

  if (process.env.TOWER_ARTEFACT_JUDGE_STUB === 'true') {
    const leadsCount = (artefactPayload.leads_count as number) ??
      (Array.isArray(artefactPayload.leads) ? artefactPayload.leads.length : 0) ??
      (artefactPayload.places_count as number) ?? 0;
    const requested = (successCriteria.target_leads as number) || 5;

    console.log(`[AGENT_LOOP] Stub mode: auto-ACCEPTing (delivered=${leadsCount}, requested=${requested})`);
    return {
      verdict: 'ACCEPT',
      delivered: leadsCount,
      requested,
      gaps: [],
      confidence: 80,
      rationale: 'Stub mode: auto-accepting artefact',
    };
  }

  const baseUrl = getTowerBaseUrl();
  if (!baseUrl) {
    console.warn('[AGENT_LOOP] No TOWER_URL configured — defaulting to ACCEPT');
    return {
      verdict: 'ACCEPT',
      delivered: 0,
      requested: 0,
      gaps: ['tower_url_not_configured'],
      confidence: 0,
      rationale: 'No Tower URL configured, defaulting to ACCEPT',
    };
  }

  const endpoint = `${baseUrl}/api/tower/judge-artefact`;
  const apiKey = process.env.TOWER_API_KEY || process.env.EXPORT_KEY || '';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-TOWER-API-KEY': apiKey } : {}),
    },
    body: JSON.stringify({ goal, success_criteria: successCriteria, artefact: artefactPayload, run_id: runId }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Tower judge-artefact HTTP ${response.status}: ${body.substring(0, 200)}`);
  }

  return (await response.json()) as TowerVerdictV1;
}

function buildAdjustedArgs(
  original: Record<string, unknown>,
  verdict: TowerVerdictV1,
): Record<string, unknown> {
  const adjusted = { ...original };
  const gaps = verdict.gaps || [];
  const delivered = typeof verdict.delivered === 'number' ? verdict.delivered : 0;
  const requested = typeof verdict.requested === 'number' ? verdict.requested : 0;

  if (gaps.includes('duplicate_rate_high') || gaps.includes('too_many_duplicates')) {
    const currentQuery = String(adjusted.query || '');
    if (!currentQuery.includes('unique')) {
      adjusted.query = `${currentQuery} unique`;
    }
    adjusted.maxResults = Math.max(Number(adjusted.maxResults || 20) - 5, 5);
    console.log(`[AGENT_LOOP] CHANGE_PLAN: tightened filters — query="${adjusted.query}" maxResults=${adjusted.maxResults}`);
    return adjusted;
  }

  if (delivered < requested) {
    const currentMaxResults = Number(adjusted.maxResults || 20);
    adjusted.maxResults = Math.min(currentMaxResults + 20, 60);
    const currentQuery = String(adjusted.query || '');
    const currentLocation = String(adjusted.location || '');
    if (currentLocation && !currentLocation.includes('nearby')) {
      adjusted.location = `${currentLocation} and nearby areas`;
    }
    console.log(`[AGENT_LOOP] CHANGE_PLAN: broadened — maxResults=${adjusted.maxResults}, location="${adjusted.location}"`);
    return adjusted;
  }

  const currentMaxResults = Number(adjusted.maxResults || 20);
  adjusted.maxResults = Math.min(currentMaxResults + 10, 60);
  console.log(`[AGENT_LOOP] CHANGE_PLAN: default broadening — maxResults=${adjusted.maxResults}`);
  return adjusted;
}

async function postRunSummary(
  runId: string,
  userId: string,
  verdict: TowerVerdictV1,
  planVersion: number,
  conversationId?: string,
): Promise<void> {
  try {
    await createArtefact({
      runId,
      type: 'run_summary',
      title: `Run Summary: ${verdict.verdict}`,
      summary: `Delivered: ${verdict.delivered} | Requested: ${verdict.requested} | Confidence: ${verdict.confidence}% | Gaps: ${verdict.gaps.length}`,
      payload: {
        verdict: verdict.verdict,
        delivered: verdict.delivered,
        requested: verdict.requested,
        gaps: verdict.gaps,
        confidence: verdict.confidence,
        rationale: verdict.rationale,
        plan_version: planVersion,
      },
      userId,
      conversationId,
    });
  } catch (err: any) {
    console.error(`[AGENT_LOOP] Failed to create run_summary artefact: ${err.message}`);
  }
}

export interface AgentLoopReaction {
  action: 'accept' | 'retry' | 'replan' | 'stop';
  verdict: TowerVerdictV1;
  adjustedArgs?: Record<string, unknown>;
  planVersion: number;
  runState: RunState;
}

export async function handleTowerVerdict(
  runId: string,
  goal: string,
  successCriteria: Record<string, unknown>,
  artefactPayload: Record<string, unknown>,
  rerunTool: (args: Record<string, unknown>) => Promise<ActionResult>,
): Promise<AgentLoopReaction> {
  let state = runStates.get(runId);
  if (!state) {
    console.error(`[AGENT_LOOP] No RunState for runId=${runId} — cannot react`);
    throw new Error(`No RunState for runId=${runId}`);
  }

  let verdict: TowerVerdictV1;
  try {
    verdict = await callTowerJudgeV1(goal, successCriteria, artefactPayload, runId);
  } catch (err: any) {
    console.error(`[AGENT_LOOP] Tower call failed: ${err.message} — defaulting to ACCEPT`);
    verdict = {
      verdict: 'ACCEPT',
      delivered: 0,
      requested: 0,
      gaps: ['tower_call_failed'],
      confidence: 0,
      rationale: `Tower call failed: ${err.message}`,
    };
  }

  state.lastVerdict = verdict;

  console.log(`[TOWER_JUDGEMENT] runId=${runId} verdict=${verdict.verdict} confidence=${verdict.confidence} gapsCount=${verdict.gaps.length}`);

  await logAFREvent({
    userId: state.userId,
    runId,
    conversationId: state.conversationId,
    actionTaken: 'tower_judgement_received',
    status: 'success',
    taskGenerated: `Tower v1 verdict: ${verdict.verdict} (confidence=${verdict.confidence}, gaps=${verdict.gaps.length})`,
    runType: 'plan',
    metadata: {
      verdict: verdict.verdict,
      delivered: verdict.delivered,
      requested: verdict.requested,
      gaps: verdict.gaps,
      confidence: verdict.confidence,
      rationale: verdict.rationale,
      plan_version: state.planVersion,
    },
  });

  switch (verdict.verdict) {
    case 'ACCEPT': {
      state.status = 'accepted';
      console.log(`[AGENT_REACT] action=accept runId=${runId} planVersion=${state.planVersion}`);

      await logAFREvent({
        userId: state.userId,
        runId,
        conversationId: state.conversationId,
        actionTaken: 'run_completed',
        status: 'success',
        taskGenerated: `Run accepted by Tower: delivered=${verdict.delivered}, requested=${verdict.requested}, confidence=${verdict.confidence}%`,
        runType: 'plan',
        metadata: {
          verdict: verdict.verdict,
          delivered: verdict.delivered,
          requested: verdict.requested,
          confidence: verdict.confidence,
          plan_version: state.planVersion,
        },
      });

      await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);

      return { action: 'accept', verdict, planVersion: state.planVersion, runState: state };
    }

    case 'RETRY': {
      if (state.retryCount >= MAX_RETRIES) {
        console.log(`[AGENT_REACT] action=stop runId=${runId} planVersion=${state.planVersion} reason=max_retries_exceeded`);
        state.status = 'stopped';

        await logAFREvent({
          userId: state.userId,
          runId,
          conversationId: state.conversationId,
          actionTaken: 'run_stopped',
          status: 'failed',
          taskGenerated: `Run stopped: max retries (${MAX_RETRIES}) exceeded`,
          runType: 'plan',
          metadata: { reason: 'max_retries_exceeded', retryCount: state.retryCount },
        });

        await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);
        return { action: 'stop', verdict, planVersion: state.planVersion, runState: state };
      }

      state.retryCount += 1;
      state.status = 'retrying';
      console.log(`[AGENT_REACT] action=retry runId=${runId} planVersion=${state.planVersion} retryCount=${state.retryCount}`);

      const retryResult = await rerunTool(state.lastToolArgs);
      if (!retryResult.success) {
        console.error(`[AGENT_LOOP] Retry failed: ${retryResult.error}`);
      }

      await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);

      return { action: 'retry', verdict, planVersion: state.planVersion, runState: state };
    }

    case 'CHANGE_PLAN': {
      if (state.planVersion >= MAX_PLAN_VERSION) {
        console.log(`[AGENT_REACT] action=stop runId=${runId} planVersion=${state.planVersion} reason=max_plan_version_reached`);
        state.status = 'stopped';

        await logAFREvent({
          userId: state.userId,
          runId,
          conversationId: state.conversationId,
          actionTaken: 'run_stopped',
          status: 'failed',
          taskGenerated: `Run stopped: max plan version (${MAX_PLAN_VERSION}) reached`,
          runType: 'plan',
          metadata: { reason: 'max_plan_version_reached', planVersion: state.planVersion },
        });

        await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);
        return { action: 'stop', verdict, planVersion: state.planVersion, runState: state };
      }

      state.planVersion += 1;
      state.status = 'replanning';
      const adjustedArgs = buildAdjustedArgs(state.lastToolArgs, verdict);
      state.lastToolArgs = adjustedArgs;

      console.log(`[AGENT_REACT] action=replan runId=${runId} planVersion=${state.planVersion}`);

      try {
        await createArtefact({
          runId,
          type: 'plan_update',
          title: `Plan Update v${state.planVersion}`,
          summary: `Adjusted parameters after CHANGE_PLAN verdict: ${verdict.rationale}`,
          payload: {
            plan_version: state.planVersion,
            adjustments: adjustedArgs,
            original_verdict: verdict,
          },
          userId: state.userId,
          conversationId: state.conversationId,
        });
      } catch (err: any) {
        console.error(`[AGENT_LOOP] Failed to create plan_update artefact: ${err.message}`);
      }

      const replanResult = await rerunTool(adjustedArgs);
      if (!replanResult.success) {
        console.error(`[AGENT_LOOP] Replan execution failed: ${replanResult.error}`);
      }

      await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);

      return { action: 'replan', verdict, adjustedArgs, planVersion: state.planVersion, runState: state };
    }

    case 'STOP': {
      state.status = 'stopped';
      console.log(`[AGENT_REACT] action=stop runId=${runId} planVersion=${state.planVersion}`);

      await logAFREvent({
        userId: state.userId,
        runId,
        conversationId: state.conversationId,
        actionTaken: 'run_stopped',
        status: 'failed',
        taskGenerated: `Run stopped by Tower: ${verdict.rationale}`,
        runType: 'plan',
        metadata: {
          verdict: verdict.verdict,
          rationale: verdict.rationale,
          gaps: verdict.gaps,
        },
      });

      await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);
      return { action: 'stop', verdict, planVersion: state.planVersion, runState: state };
    }

    default: {
      console.error(`[AGENT_LOOP] Unknown verdict: ${(verdict as any).verdict} — treating as ACCEPT`);
      state.status = 'accepted';
      await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);
      return { action: 'accept', verdict, planVersion: state.planVersion, runState: state };
    }
  }
}
