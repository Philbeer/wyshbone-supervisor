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
import { emitDeliverySummary } from './delivery-summary';
import { storage } from '../storage';
import type { ActionResult } from './action-executor';

export interface TowerVerdictV1 {
  verdict: 'ACCEPT' | 'RETRY' | 'CHANGE_PLAN' | 'STOP';
  delivered: number | string;
  requested: number | string;
  gaps: string[];
  confidence: number;
  rationale: string;
}

export interface AccumulatedCandidate {
  place_id?: string;
  name: string;
  address?: string;
  phone?: string | null;
  website?: string | null;
  source?: string;
  lat?: number | null;
  lng?: number | null;
  found_in_plan_version: number;
  found_at_radius_km: number;
  dedupe_key: string;
}

export interface RunState {
  runId: string;
  userId: string;
  conversationId?: string;
  clientRequestId?: string;
  planVersion: number;
  retryCount: number;
  lastToolArgs: Record<string, unknown>;
  lastVerdict?: TowerVerdictV1;
  status: 'running' | 'accepted' | 'stopped' | 'retrying' | 'replanning';
  createdAt: number;
  requestedCountUser: number | null;
  searchBudgetCount: number;
  originalUserGoal: string;
  accumulatedCandidates: Map<string, AccumulatedCandidate>;
  perPlanCandidates: Map<number, AccumulatedCandidate[]>;
  currentRadiusRung: number;
  hardConstraints: string[];
  softConstraints: string[];
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

export const RADIUS_LADDER_KM = [0, 5, 10, 25, 50, 100];

export function makeDedupeKey(lead: { placeId?: string; place_id?: string; name?: string; address?: string }): string {
  const pid = lead.placeId || lead.place_id;
  if (pid) return `pid:${pid}`;
  const norm = `${(lead.name || '').toLowerCase().trim()}|${(lead.address || '').toLowerCase().trim()}`;
  return `hash:${norm}`;
}

export function mergeCandidate(
  acc: Map<string, AccumulatedCandidate>,
  key: string,
  lead: { name: string; address?: string; phone?: string | null; website?: string | null; placeId?: string; place_id?: string; source?: string; lat?: number | null; lng?: number | null },
  planVersion: number,
  radiusKm?: number,
): boolean {
  if (acc.has(key)) return false;
  acc.set(key, {
    place_id: lead.placeId || lead.place_id,
    name: lead.name,
    address: lead.address,
    phone: lead.phone,
    website: lead.website,
    source: lead.source,
    lat: lead.lat ?? null,
    lng: lead.lng ?? null,
    found_in_plan_version: planVersion,
    found_at_radius_km: radiusKm ?? 0,
    dedupe_key: key,
  });
  return true;
}

export function initRunState(
  runId: string,
  userId: string,
  toolArgs: Record<string, unknown>,
  conversationId?: string,
  clientRequestId?: string,
  opts?: {
    requestedCountUser?: number | null;
    searchBudgetCount?: number;
    originalUserGoal?: string;
    hardConstraints?: string[];
    softConstraints?: string[];
  },
): RunState {
  const state: RunState = {
    runId,
    userId,
    conversationId,
    clientRequestId,
    planVersion: 1,
    retryCount: 0,
    lastToolArgs: { ...toolArgs },
    status: 'running',
    createdAt: Date.now(),
    requestedCountUser: opts?.requestedCountUser !== undefined ? opts.requestedCountUser : null,
    searchBudgetCount: opts?.searchBudgetCount ?? 20,
    originalUserGoal: opts?.originalUserGoal ?? '',
    accumulatedCandidates: new Map(),
    perPlanCandidates: new Map(),
    currentRadiusRung: 0,
    hardConstraints: opts?.hardConstraints ?? ['business_type', 'requested_count'],
    softConstraints: opts?.softConstraints ?? ['location'],
  };
  runStates.set(runId, state);
  console.log(`[AGENT_LOOP] RunState initialized: runId=${runId} planVersion=1 crid=${clientRequestId || 'none'} requestedCountUser=${state.requestedCountUser ?? 'unspecified'} searchBudgetCount=${state.searchBudgetCount}`);
  return state;
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
  intent_narrative?: Record<string, unknown> | null,
): Promise<TowerVerdictV1> {
  if (process.env.TOWER_ARTEFACT_JUDGE_STUB === 'true') {
    const leadsCount = (artefactPayload.leads_count as number) ??
      (artefactPayload.delivered_count as number) ??
      (Array.isArray(artefactPayload.leads) ? artefactPayload.leads.length : 0) ??
      (artefactPayload.places_count as number) ?? 0;
    const rawRequested = successCriteria.target_leads ?? artefactPayload.target_count;
    const requested = rawRequested != null ? Number(rawRequested) : 0;

    console.log(`[AGENT_LOOP] Stub mode: auto-ACCEPTing (delivered=${leadsCount}, requested=${requested || 'unspecified'})`);
    console.log(`[TOWER_TELEMETRY] tower_call_started runId=${runId} mode=stub`);
    console.log(`[TOWER_TELEMETRY] tower_call_finished runId=${runId} verdict=ACCEPT mode=stub`);
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
    console.warn('[AGENT_LOOP] No TOWER_URL configured — defaulting to STOP (hard gate)');
    console.log(`[TOWER_TELEMETRY] tower_call_started runId=${runId} mode=no_url`);
    console.log(`[TOWER_TELEMETRY] tower_call_finished runId=${runId} verdict=STOP mode=no_url_hard_gate`);
    return {
      verdict: 'STOP',
      delivered: 0,
      requested: 0,
      gaps: ['tower_url_not_configured'],
      confidence: 0,
      rationale: 'No Tower URL configured — hard gate prevents ACCEPT without Tower',
    };
  }

  const endpoint = `${baseUrl}/api/tower/judge-artefact`;
  const apiKey = process.env.TOWER_API_KEY || process.env.EXPORT_KEY || '';
  const TOWER_TIMEOUT_MS = 30_000;

  console.log(`[TOWER_CALL] url=${endpoint} runId=${runId}`);
  console.log(`[TOWER_TELEMETRY] tower_call_started runId=${runId}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TOWER_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'X-TOWER-API-KEY': apiKey } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        runId,
        goal,
        success_criteria: successCriteria,
        artefact: artefactPayload,
        artefactId: (artefactPayload.artefact_id as string) || runId,
        artefactType: (artefactPayload.artefact_type as string) || 'leads_list',
        run_id: runId,
        intent_narrative: intent_narrative ?? null,
      }),
    });
  } finally {
    clearTimeout(timeoutId);
  }

  console.log(`[TOWER_CALL] url=${endpoint} ok=${response.ok} status=${response.status}`);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.log(`[TOWER_TELEMETRY] tower_call_finished runId=${runId} verdict=ERROR status=${response.status}`);
    throw new Error(`Tower judge-artefact HTTP ${response.status}: ${body.substring(0, 200)}`);
  }

  const raw = await response.json();
  const verdictMap: Record<string, string> = { pass: 'ACCEPT', fail: 'STOP', retry: 'RETRY', replan: 'CHANGE_PLAN' };
  const normalizedVerdict = (verdictMap[(raw.verdict || '').toLowerCase()] || (raw.verdict || 'STOP').toUpperCase()) as TowerVerdictV1['verdict'];
  const verdict: TowerVerdictV1 = {
    verdict: normalizedVerdict,
    delivered: raw.delivered ?? raw.delivered_count ?? 0,
    requested: raw.requested ?? raw.requested_count ?? 0,
    gaps: raw.gaps ?? [],
    confidence: raw.confidence ?? 0,
    rationale: raw.rationale ?? raw.reason ?? `Tower verdict: ${raw.verdict}`,
  };
  console.log(`[TOWER_VERDICT] raw=${raw.verdict} normalized=${verdict.verdict} delivered=${verdict.delivered} requested=${verdict.requested} confidence=${verdict.confidence}`);
  console.log(`[TOWER_TELEMETRY] tower_call_finished runId=${runId} verdict=${verdict.verdict}`);
  return verdict;
}

interface PlanAdjustment {
  strategy: string;
  description: string;
  args: Record<string, unknown>;
}

function buildAdjustedArgs(
  original: Record<string, unknown>,
  verdict: TowerVerdictV1,
  planVersion: number,
): PlanAdjustment {
  const adjusted = { ...original };
  const gaps = verdict.gaps || [];
  const delivered = typeof verdict.delivered === 'number' ? verdict.delivered : 0;
  const requested = typeof verdict.requested === 'number' ? verdict.requested : 0;
  const currentLocation = String(adjusted.location || '');
  const currentQuery = String(adjusted.query || '');

  adjusted.maxResults = Math.min(60, Math.max(Number(adjusted.maxResults || 20), 40));

  if (delivered < requested && currentLocation) {
    const alreadyExpanded = currentLocation.includes('within');
    if (!alreadyExpanded) {
      adjusted.location = `${currentLocation} within 10km`;
      const desc = `Expanded search radius: "${currentLocation}" → "${adjusted.location}" (within 10km)`;
      console.log(`[AGENT_LOOP] CHANGE_PLAN: ${desc}`);
      return { strategy: 'expand_radius_10km', description: desc, args: adjusted };
    } else if (currentLocation.includes('10km') && planVersion <= 2) {
      adjusted.location = currentLocation.replace('within 10km', 'within 25km');
      const desc = `Expanded search radius: "${currentLocation}" → "${adjusted.location}" (within 25km)`;
      console.log(`[AGENT_LOOP] CHANGE_PLAN: ${desc}`);
      return { strategy: 'expand_radius_25km', description: desc, args: adjusted };
    }
  }

  if (delivered < requested && currentQuery) {
    const broadenedQuery = currentQuery.includes(' OR ') ? currentQuery : `${currentQuery} OR bar`;
    adjusted.query = broadenedQuery;
    const desc = `Broadened query: "${currentQuery}" → "${broadenedQuery}"`;
    console.log(`[AGENT_LOOP] CHANGE_PLAN: ${desc}`);
    return { strategy: 'broaden_query', description: desc, args: adjusted };
  }

  const desc = `Default: increased maxResults to ${adjusted.maxResults}`;
  console.log(`[AGENT_LOOP] CHANGE_PLAN: ${desc}`);
  return { strategy: 'increase_max_results', description: desc, args: adjusted };
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

async function emitAgentLoopDeliverySummary(
  state: RunState,
  verdict: TowerVerdictV1,
  stopped: boolean,
  stopReason?: string,
): Promise<void> {
  const requested = typeof verdict.requested === 'number' ? verdict.requested : (state.requestedCountUser ?? 0);
  const candidates = Array.from(state.accumulatedCandidates.values());
  const leads = candidates.map(c => ({
    entity_id: c.place_id || c.dedupe_key,
    name: c.name,
    address: c.address || '',
    found_in_plan_version: c.found_in_plan_version,
  }));

  await emitDeliverySummary({
    runId: state.runId,
    userId: state.userId,
    conversationId: state.conversationId,
    originalUserGoal: state.originalUserGoal,
    requestedCount: requested,
    hardConstraints: state.hardConstraints,
    softConstraints: state.softConstraints,
    planVersions: Array.from({ length: state.planVersion }, (_, i) => ({
      version: i + 1,
      changes_made: i === 0 ? ['Initial plan'] : [`Plan v${i + 1}`],
    })),
    softRelaxations: [],
    leads,
    finalVerdict: stopped ? (verdict.verdict || 'STOP') : 'pass',
    stopReason: stopped ? (stopReason || `Tower verdict: ${verdict.verdict}`) : null,
  });
}

async function postTowerJudgementArtefact(runId: string, state: RunState, verdict: TowerVerdictV1, artefactId?: string): Promise<void> {
  try {
    await createArtefact({
      runId,
      type: 'tower_judgement',
      title: `Tower Judgement: ${verdict.verdict}`,
      summary: `Verdict: ${verdict.verdict} | Delivered: ${verdict.delivered} | Requested: ${verdict.requested} | Confidence: ${verdict.confidence}%`,
      payload: {
        verdict: verdict.verdict,
        delivered: verdict.delivered,
        requested: verdict.requested,
        gaps: verdict.gaps,
        confidence: verdict.confidence,
        rationale: verdict.rationale,
        plan_version: state.planVersion,
      },
      userId: state.userId,
      conversationId: state.conversationId,
    });
  } catch (err: any) {
    console.error(`[AGENT_LOOP] Failed to create tower_judgement artefact: ${err.message}`);
  }
}

async function persistTowerJudgementToDb(
  runId: string,
  artefactId: string,
  verdict: TowerVerdictV1,
  state: RunState,
): Promise<void> {
  const actionMap: Record<string, string> = { ACCEPT: 'continue', RETRY: 'retry', CHANGE_PLAN: 'change_plan', STOP: 'stop' };
  try {
    await storage.createTowerJudgement({
      runId,
      artefactId,
      verdict: verdict.verdict,
      action: actionMap[verdict.verdict] || 'stop',
      reasonsJson: verdict.gaps.length > 0 ? verdict.gaps : [verdict.rationale],
      metricsJson: {
        delivered: verdict.delivered,
        requested: verdict.requested,
        confidence: verdict.confidence,
        plan_version: state.planVersion,
      },
    });
    console.log(`[TOWER_DB] Persisted judgement: runId=${runId} artefactId=${artefactId} verdict=${verdict.verdict}`);
  } catch (err: any) {
    console.error(`[TOWER_DB] Failed to persist judgement: ${err.message}`);
  }
}

export interface AgentLoopReaction {
  action: 'accept' | 'retry' | 'replan' | 'stop';
  verdict: TowerVerdictV1;
  adjustedArgs?: Record<string, unknown>;
  planVersion: number;
  runState: RunState;
}

async function obtainVerdict(
  runId: string,
  goal: string,
  successCriteria: Record<string, unknown>,
  artefactPayload: Record<string, unknown>,
  state?: RunState,
): Promise<TowerVerdictV1> {
  const userId = state?.userId || 'unknown';
  const conversationId = state?.conversationId;
  const clientRequestId = state?.clientRequestId;

  await logAFREvent({
    userId,
    runId,
    conversationId,
    clientRequestId,
    actionTaken: 'tower_call_started',
    status: 'pending',
    taskGenerated: `Calling Tower judge for run ${runId}`,
    runType: 'plan',
    metadata: { goal, run_id: runId },
  });

  const startMs = Date.now();

  try {
    const verdict = await callTowerJudgeV1(goal, successCriteria, artefactPayload, runId, null /* intent_narrative not in scope at obtainVerdict — pass null */);
    const durationMs = Date.now() - startMs;

    await logAFREvent({
      userId,
      runId,
      conversationId,
      clientRequestId,
      actionTaken: 'tower_call_completed',
      status: 'success',
      taskGenerated: `Tower responded in ${durationMs}ms — verdict: ${verdict.verdict}`,
      runType: 'plan',
      metadata: { run_id: runId, duration_ms: durationMs, verdict: verdict.verdict, http_ok: true },
    });

    return verdict;
  } catch (err: any) {
    const durationMs = Date.now() - startMs;
    const isTimeout = err.name === 'AbortError';
    const errorLabel = isTimeout ? 'Tower call timed out (30s)' : err.message;
    console.error(`[AGENT_LOOP] Tower call failed: ${errorLabel} — defaulting to STOP (hard gate)`);
    console.log(`[TOWER_TELEMETRY] tower_call_finished runId=${runId} verdict=STOP mode=error_fallback_hard_gate error=${errorLabel.substring(0, 100)}`);

    await logAFREvent({
      userId,
      runId,
      conversationId,
      clientRequestId,
      actionTaken: 'tower_call_completed',
      status: 'failed',
      taskGenerated: `Tower call failed after ${durationMs}ms — defaulting to STOP`,
      runType: 'plan',
      metadata: { run_id: runId, duration_ms: durationMs, error: errorLabel, http_ok: false, timed_out: isTimeout },
    });

    return {
      verdict: 'STOP',
      delivered: 0,
      requested: 0,
      gaps: [isTimeout ? 'tower_call_timed_out' : 'tower_call_failed'],
      confidence: 0,
      rationale: isTimeout
        ? `Tower unavailable (timed out after 30s) — hard gate prevents ACCEPT without Tower`
        : `Tower call failed (hard gate — no ACCEPT without valid Tower response): ${err.message}`,
    };
  }
}

async function logVerdictReceived(state: RunState, runId: string, verdict: TowerVerdictV1): Promise<void> {
  console.log(`[TOWER_JUDGEMENT] runId=${runId} verdict=${verdict.verdict} delivered=${verdict.delivered} requested=${verdict.requested} confidence=${verdict.confidence} gapsCount=${verdict.gaps.length}`);

  await logAFREvent({
    userId: state.userId,
    runId,
    conversationId: state.conversationId,
    clientRequestId: state.clientRequestId,
    actionTaken: 'tower_verdict',
    status: 'success',
    taskGenerated: `Tower v1 verdict: ${verdict.verdict} (confidence=${verdict.confidence}, delivered=${verdict.delivered}, requested=${verdict.requested})`,
    runType: 'plan',
    metadata: {
      verdict: verdict.verdict,
      delivered: verdict.delivered,
      requested: verdict.requested,
      gaps: verdict.gaps,
      confidence: verdict.confidence,
      rationale: verdict.rationale,
      plan_version: state.planVersion,
      run_id: runId,
    },
  });
}

function emitFinalLog(state: RunState, verdict: TowerVerdictV1, stopped: boolean): void {
  const target = typeof verdict.requested === 'number' ? verdict.requested : Number(state.lastToolArgs.target_count || 0);
  const delivered = typeof verdict.delivered === 'number' ? verdict.delivered : 0;
  console.log(`[AGENT_LOOP] runId=${state.runId} target=${target} delivered=${delivered} verdict=${verdict.verdict} planVersion=${state.planVersion} retries=${state.retryCount} stopped=${stopped}`);
}

async function emitRunCompleted(state: RunState, runId: string, verdict: TowerVerdictV1): Promise<void> {
  await logAFREvent({
    userId: state.userId,
    runId,
    conversationId: state.conversationId,
    clientRequestId: state.clientRequestId,
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
}

async function emitRunStopped(state: RunState, runId: string, reason: string, metadata: Record<string, unknown>): Promise<void> {
  await logAFREvent({
    userId: state.userId,
    runId,
    conversationId: state.conversationId,
    clientRequestId: state.clientRequestId,
    actionTaken: 'run_stopped',
    status: 'failed',
    taskGenerated: `Run stopped: ${reason}`,
    runType: 'plan',
    metadata,
  });
}

async function createRerunLeadsListArtefact(
  state: RunState,
  rerunResult: ActionResult,
  label: string,
): Promise<Record<string, unknown>> {
  const deliveredCount = rerunResult.data?.delivered_count ?? rerunResult.data?.count ?? 0;
  const rawRerunTarget = rerunResult.data?.target_count ?? state.lastToolArgs.target_count;
  const targetCount = rawRerunTarget != null ? Number(rawRerunTarget) : null;
  const targetLabel = targetCount != null ? ` of ${targetCount} requested` : '';
  const payload: Record<string, unknown> = {
    delivered_count: deliveredCount,
    target_count: targetCount,
    leads_count: deliveredCount,
    places_count: Array.isArray(rerunResult.data?.places) ? rerunResult.data!.places.length : 0,
    success_criteria: { target_count: targetCount },
    query: state.lastToolArgs.query,
    location: state.lastToolArgs.location,
    country: state.lastToolArgs.country,
    plan_version: state.planVersion,
  };

  try {
    await createArtefact({
      runId: state.runId,
      type: 'leads_list',
      title: `Leads list (${label}): SEARCH_PLACES v${state.planVersion}`,
      summary: `Delivered ${deliveredCount}${targetLabel} (${label})`,
      payload,
      userId: state.userId,
      conversationId: state.conversationId,
    });
  } catch (err: any) {
    console.error(`[AGENT_LOOP] Failed to create leads_list artefact after ${label}: ${err.message}`);
  }

  return payload;
}

export async function handleTowerVerdict(
  runId: string,
  goal: string,
  successCriteria: Record<string, unknown>,
  artefactPayload: Record<string, unknown>,
  rerunTool: (args: Record<string, unknown>) => Promise<ActionResult>,
): Promise<AgentLoopReaction> {
  const state = runStates.get(runId);
  if (!state) {
    console.error(`[AGENT_LOOP] No RunState for runId=${runId} — cannot react`);
    throw new Error(`No RunState for runId=${runId}`);
  }

  const artefactId = (artefactPayload.artefact_id as string) || runId;
  const requested = artefactPayload.target_count ?? artefactPayload.requested ?? successCriteria.target_leads ?? 0;
  const delivered = artefactPayload.delivered_count ?? artefactPayload.leads_count ?? 0;
  console.log(`[TOWER_CALL] run_id=${runId} url=${process.env.TOWER_BASE_URL || process.env.TOWER_URL || 'NOT_SET'}/api/tower/judge-artefact requested=${requested} delivered=${delivered}`);

  const verdict = await obtainVerdict(runId, goal, successCriteria, artefactPayload, state);
  state.lastVerdict = verdict;

  console.log(`[TOWER_VERDICT] run_id=${runId} verdict=${verdict.verdict} confidence=${verdict.confidence} delivered=${verdict.delivered} requested=${verdict.requested} gaps=${verdict.gaps.length}`);

  await logVerdictReceived(state, runId, verdict);
  await postTowerJudgementArtefact(runId, state, verdict, artefactId);
  await persistTowerJudgementToDb(runId, artefactId, verdict, state);

  switch (verdict.verdict) {
    case 'ACCEPT': {
      state.status = 'accepted';
      console.log(`[AGENT_REACT] action=accept runId=${runId} planVersion=${state.planVersion}`);
      await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);
      await emitAgentLoopDeliverySummary(state, verdict, false);
      await emitRunCompleted(state, runId, verdict);
      emitFinalLog(state, verdict, false);
      return { action: 'accept', verdict, planVersion: state.planVersion, runState: state };
    }

    case 'RETRY': {
      if (state.retryCount >= MAX_RETRIES) {
        console.log(`[AGENT_REACT] action=stop runId=${runId} planVersion=${state.planVersion} reason=max_retries_exceeded`);
        state.status = 'stopped';
        await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);
        await emitAgentLoopDeliverySummary(state, verdict, true, `max retries (${MAX_RETRIES}) exceeded`);
        await emitRunStopped(state, runId, `max retries (${MAX_RETRIES}) exceeded`, { reason: 'max_retries_exceeded', retryCount: state.retryCount });
        emitFinalLog(state, verdict, true);
        return { action: 'stop', verdict, planVersion: state.planVersion, runState: state };
      }

      state.retryCount += 1;
      state.status = 'retrying';
      console.log(`[AGENT_REACT] action=retry runId=${runId} planVersion=${state.planVersion} retryCount=${state.retryCount}`);

      const retryResult = await rerunTool(state.lastToolArgs);
      if (!retryResult.success) {
        console.error(`[AGENT_LOOP] Retry failed: ${retryResult.error}`);
        state.status = 'stopped';
        await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);
        await emitAgentLoopDeliverySummary(state, verdict, true, `retry execution failed: ${retryResult.error}`);
        await emitRunStopped(state, runId, `retry execution failed: ${retryResult.error}`, { reason: 'retry_failed' });
        emitFinalLog(state, verdict, true);
        return { action: 'stop', verdict, planVersion: state.planVersion, runState: state };
      }

      const retryPayload = await createRerunLeadsListArtefact(state, retryResult, 'retry');
      console.log(`[TOWER_CALL] run_id=${runId} url=${process.env.TOWER_BASE_URL || process.env.TOWER_URL || 'NOT_SET'}/api/tower/judge-artefact requested=${retryPayload.target_count} delivered=${retryPayload.delivered_count} (retry)`);
      const retryVerdict = await obtainVerdict(runId, goal, successCriteria, retryPayload, state);
      console.log(`[TOWER_VERDICT] run_id=${runId} verdict=${retryVerdict.verdict} confidence=${retryVerdict.confidence} delivered=${retryVerdict.delivered} requested=${retryVerdict.requested} gaps=${retryVerdict.gaps.length} (retry)`);
      state.lastVerdict = retryVerdict;
      await logVerdictReceived(state, runId, retryVerdict);
      await postTowerJudgementArtefact(runId, state, retryVerdict, artefactId);
      await persistTowerJudgementToDb(runId, artefactId, retryVerdict, state);

      const retryDelivered = typeof retryVerdict.delivered === 'number' ? retryVerdict.delivered : 0;
      const retryRequested = typeof retryVerdict.requested === 'number' ? retryVerdict.requested : 1;

      if (retryVerdict.verdict === 'ACCEPT') {
        state.status = 'accepted';
        console.log(`[AGENT_REACT] action=accept runId=${runId} planVersion=${state.planVersion} (after retry)`);
        await postRunSummary(runId, state.userId, retryVerdict, state.planVersion, state.conversationId);
        await emitAgentLoopDeliverySummary(state, retryVerdict, false);
        await emitRunCompleted(state, runId, retryVerdict);
        emitFinalLog(state, retryVerdict, false);
        return { action: 'accept', verdict: retryVerdict, planVersion: state.planVersion, runState: state };
      }

      if (retryVerdict.verdict === 'RETRY' || retryDelivered < retryRequested * 0.5) {
        state.status = 'stopped';
        const reason = retryDelivered < retryRequested * 0.5
          ? `delivered (${retryDelivered}) < 50% of target (${retryRequested}) after retry`
          : 'still RETRY after retry — stopping';
        console.log(`[AGENT_REACT] action=stop runId=${runId} reason="${reason}"`);
        await postRunSummary(runId, state.userId, retryVerdict, state.planVersion, state.conversationId);
        await emitAgentLoopDeliverySummary(state, retryVerdict, true, reason);
        await emitRunStopped(state, runId, reason, { reason: 'retry_insufficient', delivered: retryDelivered, requested: retryRequested });
        emitFinalLog(state, retryVerdict, true);
        return { action: 'stop', verdict: retryVerdict, planVersion: state.planVersion, runState: state };
      }

      state.status = 'accepted';
      await postRunSummary(runId, state.userId, retryVerdict, state.planVersion, state.conversationId);
      await emitAgentLoopDeliverySummary(state, retryVerdict, false);
      await emitRunCompleted(state, runId, retryVerdict);
      emitFinalLog(state, retryVerdict, false);
      return { action: 'accept', verdict: retryVerdict, planVersion: state.planVersion, runState: state };
    }

    case 'CHANGE_PLAN': {
      if (state.planVersion >= MAX_PLAN_VERSION) {
        console.log(`[AGENT_REACT] action=stop runId=${runId} planVersion=${state.planVersion} reason=max_plan_version_reached`);
        state.status = 'stopped';
        await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);
        await emitAgentLoopDeliverySummary(state, verdict, true, `max plan version (${MAX_PLAN_VERSION}) reached`);
        await emitRunStopped(state, runId, `max plan version (${MAX_PLAN_VERSION}) reached`, { reason: 'max_plan_version_reached', planVersion: state.planVersion });
        emitFinalLog(state, verdict, true);
        return { action: 'stop', verdict, planVersion: state.planVersion, runState: state };
      }

      state.planVersion += 1;
      state.status = 'replanning';
      const adjustment = buildAdjustedArgs(state.lastToolArgs, verdict, state.planVersion);
      state.lastToolArgs = adjustment.args;

      console.log(`[AGENT_REACT] action=replan runId=${runId} planVersion=${state.planVersion} strategy=${adjustment.strategy}`);

      try {
        await createArtefact({
          runId,
          type: 'plan_update',
          title: `Plan Update v${state.planVersion}`,
          summary: adjustment.description,
          payload: {
            plan_version: state.planVersion,
            strategy: adjustment.strategy,
            description: adjustment.description,
            adjusted_args: adjustment.args,
            original_verdict: verdict,
          },
          userId: state.userId,
          conversationId: state.conversationId,
        });
      } catch (err: any) {
        console.error(`[AGENT_LOOP] Failed to create plan_update artefact: ${err.message}`);
      }

      const replanResult = await rerunTool(adjustment.args);
      if (!replanResult.success) {
        console.error(`[AGENT_LOOP] Replan execution failed: ${replanResult.error}`);
        state.status = 'stopped';
        await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);
        await emitAgentLoopDeliverySummary(state, verdict, true, `replan execution failed: ${replanResult.error}`);
        await emitRunStopped(state, runId, `replan execution failed: ${replanResult.error}`, { reason: 'replan_failed' });
        emitFinalLog(state, verdict, true);
        return { action: 'stop', verdict, planVersion: state.planVersion, runState: state };
      }

      const replanPayload = await createRerunLeadsListArtefact(state, replanResult, 'replan');
      console.log(`[TOWER_CALL] run_id=${runId} url=${process.env.TOWER_BASE_URL || process.env.TOWER_URL || 'NOT_SET'}/api/tower/judge-artefact requested=${replanPayload.target_count} delivered=${replanPayload.delivered_count} (replan)`);
      const replanVerdict = await obtainVerdict(runId, goal, successCriteria, replanPayload, state);
      console.log(`[TOWER_VERDICT] run_id=${runId} verdict=${replanVerdict.verdict} confidence=${replanVerdict.confidence} delivered=${replanVerdict.delivered} requested=${replanVerdict.requested} gaps=${replanVerdict.gaps.length} (replan)`);
      state.lastVerdict = replanVerdict;
      await logVerdictReceived(state, runId, replanVerdict);
      await postTowerJudgementArtefact(runId, state, replanVerdict, artefactId);
      await persistTowerJudgementToDb(runId, artefactId, replanVerdict, state);

      if (replanVerdict.verdict === 'ACCEPT') {
        state.status = 'accepted';
        console.log(`[AGENT_REACT] action=accept runId=${runId} planVersion=${state.planVersion} (after replan)`);
        await postRunSummary(runId, state.userId, replanVerdict, state.planVersion, state.conversationId);
        await emitAgentLoopDeliverySummary(state, replanVerdict, false);
        await emitRunCompleted(state, runId, replanVerdict);
        emitFinalLog(state, replanVerdict, false);
        return { action: 'accept', verdict: replanVerdict, adjustedArgs: adjustment.args, planVersion: state.planVersion, runState: state };
      }

      state.status = 'stopped';
      const stopReason = replanVerdict.verdict === 'CHANGE_PLAN'
        ? 'still CHANGE_PLAN after replan — stopping'
        : `${replanVerdict.verdict} after replan — stopping`;
      console.log(`[AGENT_REACT] action=stop runId=${runId} reason="${stopReason}"`);
      await postRunSummary(runId, state.userId, replanVerdict, state.planVersion, state.conversationId);
      await emitAgentLoopDeliverySummary(state, replanVerdict, true, stopReason);
      await emitRunStopped(state, runId, stopReason, {
        reason: 'replan_insufficient',
        delivered: replanVerdict.delivered,
        requested: replanVerdict.requested,
        final_verdict: replanVerdict.verdict,
      });
      emitFinalLog(state, replanVerdict, true);
      return { action: 'stop', verdict: replanVerdict, adjustedArgs: adjustment.args, planVersion: state.planVersion, runState: state };
    }

    case 'STOP': {
      state.status = 'stopped';
      console.log(`[AGENT_REACT] action=stop runId=${runId} planVersion=${state.planVersion}`);
      await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);
      await emitAgentLoopDeliverySummary(state, verdict, true, `Tower verdict: ${verdict.rationale}`);
      await emitRunStopped(state, runId, `Tower verdict: ${verdict.rationale}`, {
        verdict: verdict.verdict,
        rationale: verdict.rationale,
        gaps: verdict.gaps,
      });
      emitFinalLog(state, verdict, true);
      return { action: 'stop', verdict, planVersion: state.planVersion, runState: state };
    }

    default: {
      console.error(`[AGENT_LOOP] Unknown verdict: ${(verdict as any).verdict} — treating as ACCEPT`);
      state.status = 'accepted';
      await postRunSummary(runId, state.userId, verdict, state.planVersion, state.conversationId);
      await emitAgentLoopDeliverySummary(state, verdict, false);
      emitFinalLog(state, verdict, false);
      return { action: 'accept', verdict, planVersion: state.planVersion, runState: state };
    }
  }
}
