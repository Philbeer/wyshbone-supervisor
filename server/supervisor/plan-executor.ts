/**
 * Plan Executor - Core execution loop.
 * Tower judgement is mandatory after every step. No backfill, no polling.
 * Strict sequence: STEP_RESULT_WRITTEN -> TOWER_CALLED -> TOWER_JUDGEMENT_WRITTEN -> REACTION_TAKEN
 *
 * Bounded retries: MAX_RETRIES_PER_STEP (2) and MAX_PLAN_VERSIONS (2).
 */

import type { Plan } from './types/plan';
import { executeAction, createRunToolTracker, type ActionResult } from './action-executor';
import {
  logPlanStarted,
  logStepStarted,
  logStepCompleted,
  logStepFailed,
  logPlanCompleted,
  logPlanFailed,
  logToolsUpdate,
  logRouterDecision,
  logAFREvent,
} from './afr-logger';
import {
  LEADGEN_SUCCESS_DEFAULTS,
  createRunSummary,
  updateRunSummary,
  type TowerSuccessCriteria,
} from './tower-judgement';
import { storage } from '../storage';
import {
  updateStepStatus,
  completePlan as completeProgress,
  failPlan as failProgress,
} from '../plan-progress';
import { createArtefact } from './artefacts';
import { emitDeliverySummary } from './delivery-summary';
import { judgeArtefact } from './tower-artefact-judge';
import { buildToolPlan, persistToolPlanExplainer, type LeadContext } from './tool-planning-policy';

const MAX_RETRIES_PER_STEP = 2;
const MAX_PLAN_VERSIONS = 2;

function deriveConstraintsFromFilters(filters: Record<string, string>): { hard: string[]; soft: string[] } {
  const hard: string[] = [];
  const soft: string[] = [];
  if (filters.query) hard.push(`query=${filters.query}`);
  if (filters.location) soft.push(`location=${filters.location}`);
  if (filters.radius) soft.push(`radius=${filters.radius}`);
  if (filters.type) soft.push(`type=${filters.type}`);
  if (filters.keyword) soft.push(`keyword=${filters.keyword}`);
  return { hard, soft };
}

export function isStepArtefactsEnabled(): boolean {
  const val = process.env.ENABLE_STEP_ARTEFACTS;
  return val === undefined || val === '' || val === 'true';
}

function ts(): string {
  return new Date().toISOString();
}

const SECRET_KEYS_RE = /^(auth|authorization|cookie|token|secret|api[_-]?key|password|credential|session|bearer)/i;
const SUMMARY_CAP = 2000;
const OUTPUTS_RAW_CAP = 50_000;

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEYS_RE.test(key)) return '[REDACTED]';
  if (typeof value === 'string' && value.length > SUMMARY_CAP) return value.substring(0, SUMMARY_CAP) + '…[truncated]';
  return value;
}

export function redactRecord(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = redactValue(k, v);
  }
  return result;
}

export function safeOutputsRaw(data: Record<string, unknown> | undefined): { outputs_raw?: Record<string, unknown>; outputs_raw_omitted?: boolean } {
  if (!data) return {};
  const redacted = redactRecord(data);
  const serialized = JSON.stringify(redacted);
  if (serialized.length <= OUTPUTS_RAW_CAP) {
    return { outputs_raw: redacted };
  }
  return { outputs_raw_omitted: true };
}

export function compactInputs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null && v !== '') {
      result[k] = redactValue(k, typeof v === 'string' && v.length > 200 ? v.substring(0, 200) : v);
    }
  }
  return result;
}

function compactOutputs(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      result[`${k}_count`] = v.length;
    } else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
      result[k] = v;
    }
  }
  return result;
}

function extractMetrics(stepType: string, data: Record<string, unknown>): Record<string, number> {
  const m: Record<string, number> = {};
  switch (stepType) {
    case 'SEARCH_PLACES':
      if (typeof data.count === 'number') m.places_found = data.count;
      else if (Array.isArray(data.places)) m.places_found = data.places.length;
      break;
    case 'ENRICH_LEADS':
      if (typeof data.count === 'number') m.leads_enriched = data.count;
      else if (Array.isArray(data.leads)) m.leads_enriched = data.leads.length;
      break;
    case 'SCORE_LEADS':
      if (typeof data.count === 'number') m.leads_scored = data.count;
      else if (Array.isArray(data.leads)) m.leads_scored = data.leads.length;
      if (typeof data.avgScore === 'number') m.avg_score = data.avgScore;
      if (typeof data.aboveThreshold === 'number') m.above_threshold = data.aboveThreshold;
      break;
    case 'EVALUATE_RESULTS':
      if (typeof data.overallQuality === 'number') m.overall_quality = data.overallQuality;
      if (typeof data.coverageRate === 'number') m.coverage_rate = data.coverageRate;
      if (typeof data.scoringRate === 'number') m.scoring_rate = data.scoringRate;
      if (typeof data.totalSearched === 'number') m.total_searched = data.totalSearched;
      if (typeof data.totalEnriched === 'number') m.total_enriched = data.totalEnriched;
      if (typeof data.totalScored === 'number') m.total_scored = data.totalScored;
      break;
    default:
      if (typeof data.count === 'number') m.count = data.count;
      break;
  }
  return m;
}

const LEADS_LIST_CAP = 200;

interface LeadItem {
  place_id: string;
  name: string;
  address?: string;
  postcode?: string;
  phone?: string;
  website?: string;
  score?: number;
}

function extractPostcode(address: string): string | undefined {
  const match = address.match(/[A-Z]{1,2}\d[\dA-Z]?\s*\d[A-Z]{2}/i);
  return match ? match[0].toUpperCase() : undefined;
}

function accumulateLeads(
  step: { toolName?: string; toolArgs?: Record<string, unknown> },
  data: Record<string, unknown> | undefined,
  leadsMap: Map<string, Record<string, unknown>>,
  filters: Record<string, string>,
): void {
  if (!data) return;
  const toolName = step.toolName || '';

  if (step.toolArgs) {
    if (step.toolArgs.query) filters.query = String(step.toolArgs.query);
    if (step.toolArgs.location) filters.location = String(step.toolArgs.location);
    if (step.toolArgs.country) filters.country = String(step.toolArgs.country);
  }

  if (toolName === 'SEARCH_PLACES' && Array.isArray(data.places)) {
    for (const p of data.places as any[]) {
      if (!p.place_id) continue;
      const existing = leadsMap.get(p.place_id) || {};
      leadsMap.set(p.place_id, {
        ...existing,
        place_id: p.place_id,
        name: p.name || existing.name,
        address: p.formatted_address || existing.address,
        postcode: extractPostcode(p.formatted_address || '') || existing.postcode,
      });
    }
  }

  if (toolName === 'ENRICH_LEADS' && Array.isArray(data.leads)) {
    for (const l of data.leads as any[]) {
      if (!l.place_id) continue;
      const existing = leadsMap.get(l.place_id) || {};
      leadsMap.set(l.place_id, {
        ...existing,
        place_id: l.place_id,
        name: l.name || existing.name,
        address: l.address || existing.address,
        postcode: extractPostcode(l.address || '') || existing.postcode,
        phone: l.phone || existing.phone,
        website: l.website || existing.website,
      });
    }
  }

  if (toolName === 'SCORE_LEADS' && Array.isArray(data.leads)) {
    for (const s of data.leads as any[]) {
      if (!s.place_id) continue;
      const existing = leadsMap.get(s.place_id) || {};
      leadsMap.set(s.place_id, {
        ...existing,
        place_id: s.place_id,
        name: s.name || existing.name,
        score: typeof s.score === 'number' ? s.score : existing.score,
      });
    }
  }
}

function buildLeadsList(
  leadsMap: Map<string, Record<string, unknown>>,
  filters: Record<string, string>,
): { items: LeadItem[]; total: number; capped: boolean; filters: Record<string, string> } {
  const all: LeadItem[] = [];
  for (const raw of Array.from(leadsMap.values())) {
    all.push({
      place_id: String(raw.place_id || ''),
      name: String(raw.name || ''),
      address: raw.address ? String(raw.address) : undefined,
      postcode: raw.postcode ? String(raw.postcode) : undefined,
      phone: raw.phone ? String(raw.phone) : undefined,
      website: raw.website ? String(raw.website) : undefined,
      score: typeof raw.score === 'number' ? raw.score : undefined,
    });
  }
  all.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const capped = all.length > LEADS_LIST_CAP;
  const items = capped ? all.slice(0, LEADS_LIST_CAP) : all;
  return { items, total: all.length, capped, filters };
}

function buildAdjustedArgs(
  original: Record<string, unknown>,
  reasons: string[],
  planVersion: number,
): { strategy: string; description: string; args: Record<string, unknown> } {
  const adjusted = { ...original };
  const currentLocation = String(adjusted.location || '');
  const currentQuery = String(adjusted.query || '');

  adjusted.maxResults = Math.min(60, Math.max(Number(adjusted.maxResults || 20), 40));

  if (currentLocation) {
    const alreadyExpanded = currentLocation.includes('within');
    if (!alreadyExpanded) {
      adjusted.location = `${currentLocation} within 10km`;
      const desc = `Expanded search radius: "${currentLocation}" -> "${adjusted.location}"`;
      return { strategy: 'expand_radius_10km', description: desc, args: adjusted };
    } else if (currentLocation.includes('10km') && planVersion <= MAX_PLAN_VERSIONS) {
      adjusted.location = currentLocation.replace('within 10km', 'within 25km');
      const desc = `Expanded search radius further: "${currentLocation}" -> "${adjusted.location}"`;
      return { strategy: 'expand_radius_25km', description: desc, args: adjusted };
    }
  }

  if (currentQuery) {
    const broadenedQuery = currentQuery.includes(' OR ') ? currentQuery : `${currentQuery} OR bar`;
    adjusted.query = broadenedQuery;
    const desc = `Broadened query: "${currentQuery}" -> "${broadenedQuery}"`;
    return { strategy: 'broaden_query', description: desc, args: adjusted };
  }

  const desc = `Default adjustment: increased maxResults to ${adjusted.maxResults}`;
  return { strategy: 'increase_max_results', description: desc, args: adjusted };
}

export interface PlanExecutionResult {
  success: boolean;
  stepsCompleted: number;
  totalSteps: number;
  error?: string;
  haltedByJudgement?: boolean;
  haltReason?: string;
}

async function safeUpdatePlanStatus(planId: string, status: string): Promise<void> {
  try {
    await storage.updatePlanStatus(planId, status);
  } catch (err: any) {
    console.warn(`[PLAN_EXECUTOR] Could not update plan status to '${status}': ${err.message}`);
  }
}

type StepReaction = 'continue' | 'retry' | 'change_plan' | 'stop';

interface StepJudgementResult {
  reaction: StepReaction;
  verdict: string;
  action: string;
  reasons: string[];
  artefactId?: string;
  shouldStop: boolean;
  stubbed: boolean;
}

async function judgeStepResultSync(
  stepArtefact: Awaited<ReturnType<typeof createArtefact>>,
  runId: string,
  goal: string,
  userId: string,
  conversationId: string | undefined,
  clientRequestId: string | undefined,
  stepIndex: number,
  stepLabel: string,
  successCriteria?: Record<string, unknown>,
): Promise<StepJudgementResult> {
  console.log(`[TOWER_SEQ] ${ts()} TOWER_CALLED runId=${runId} step=${stepIndex + 1} artefactId=${stepArtefact.id} type=${stepArtefact.type}`);

  await logAFREvent({
    userId, runId, conversationId, clientRequestId,
    actionTaken: 'tower_call_started', status: 'pending',
    taskGenerated: `Calling Tower to judge ${stepArtefact.type} artefact ${stepArtefact.id} (step ${stepIndex + 1}: ${stepLabel})`,
    runType: 'plan',
    metadata: { artefactId: stepArtefact.id, goal, step_index: stepIndex, step_label: stepLabel, artefact_type: stepArtefact.type },
  }).catch(() => {});

  let towerResult;
  try {
    towerResult = await judgeArtefact({
      artefact: stepArtefact,
      runId,
      goal,
      userId,
      conversationId,
      successCriteria,
    });
  } catch (towerErr: any) {
    const errMsg = towerErr.message || 'Tower call threw an exception';
    console.error(`[TOWER_SEQ] ${ts()} TOWER_CALL_FAILED runId=${runId} step=${stepIndex + 1} error=${errMsg}`);

    const errorArtefact = await createArtefact({
      runId,
      type: 'tower_judgement',
      title: `Tower Judgement: error (step ${stepIndex + 1})`,
      summary: `Tower unreachable/failed: ${errMsg}`,
      payload: {
        verdict: 'error', action: 'stop',
        reasons: [errMsg], metrics: {},
        step_index: stepIndex, step_label: stepLabel,
        judged_artefact_id: stepArtefact.id,
        error: errMsg,
      },
      userId, conversationId,
    });

    console.log(`[TOWER_SEQ] ${ts()} TOWER_JUDGEMENT_WRITTEN runId=${runId} step=${stepIndex + 1} verdict=error artefactId=${errorArtefact.id}`);

    await logAFREvent({
      userId, runId, conversationId, clientRequestId,
      actionTaken: 'tower_verdict', status: 'failed',
      taskGenerated: `Tower error at step ${stepIndex + 1}: ${errMsg}`,
      runType: 'plan',
      metadata: { artefactId: stepArtefact.id, verdict: 'error', error: errMsg, step_index: stepIndex },
    }).catch(() => {});

    return { reaction: 'stop', verdict: 'error', action: 'stop', reasons: [errMsg], shouldStop: true, stubbed: false };
  }

  const verdict = towerResult.judgement.verdict;
  const action = towerResult.judgement.action;
  const reasons = towerResult.judgement.reasons || [];

  const judgementArtefact = await createArtefact({
    runId,
    type: 'tower_judgement',
    title: `Tower Judgement: ${verdict} (step ${stepIndex + 1})`,
    summary: `Verdict: ${verdict} | Action: ${action} | Step: ${stepLabel}`,
    payload: {
      verdict, action,
      reasons,
      metrics: towerResult.judgement.metrics,
      step_index: stepIndex,
      step_label: stepLabel,
      judged_artefact_id: stepArtefact.id,
      stubbed: towerResult.stubbed,
    },
    userId, conversationId,
  });

  console.log(`[TOWER_SEQ] ${ts()} TOWER_JUDGEMENT_WRITTEN runId=${runId} step=${stepIndex + 1} verdict=${verdict} action=${action} artefactId=${judgementArtefact.id} stubbed=${towerResult.stubbed}`);

  await logAFREvent({
    userId, runId, conversationId, clientRequestId,
    actionTaken: 'tower_verdict', status: towerResult.shouldStop ? 'failed' : 'success',
    taskGenerated: `Tower verdict at step ${stepIndex + 1}: ${verdict} -> ${action}`,
    runType: 'plan',
    metadata: {
      verdict, action, reasons,
      artefactId: stepArtefact.id,
      judgementArtefactId: judgementArtefact.id,
      step_index: stepIndex, step_label: stepLabel,
      stubbed: towerResult.stubbed,
    },
  }).catch(() => {});

  let reaction: StepReaction;
  if (action === 'continue') reaction = 'continue';
  else if (action === 'retry') reaction = 'retry';
  else if (action === 'change_plan') reaction = 'change_plan';
  else if (action === 'stop' || verdict === 'fail') reaction = 'stop';
  else reaction = 'continue';

  return {
    reaction,
    verdict,
    action,
    reasons,
    artefactId: judgementArtefact.id,
    shouldStop: towerResult.shouldStop,
    stubbed: towerResult.stubbed,
  };
}

export async function executePlan(plan: Plan): Promise<PlanExecutionResult> {
  const { planId, userId, conversationId, clientRequestId, goal, steps, skipJudgement, toolMetadata } = plan;
  if (!plan.jobId) {
    const errMsg = `[PLAN_EXECUTOR] FATAL: No jobId provided — plan executor must receive a canonical runId. All execution must flow through the Supervisor with a pre-assigned runId.`;
    console.error(errMsg);
    throw new Error(errMsg);
  }
  const runId = plan.jobId;

  console.log(`[ID_MAP] jobId=${runId} planId=${planId} crid=${clientRequestId || 'none'} entry=executePlan`);
  console.log(`[PLAN_EXECUTOR] Starting execution of plan ${planId} (runId=${runId})`);
  console.log(`[PLAN_EXECUTOR] Goal: ${goal}`);
  console.log(`[PLAN_EXECUTOR] Steps: ${steps.length}`);
  if (clientRequestId) console.log(`[PLAN_EXECUTOR] clientRequestId: ${clientRequestId}`);
  if (skipJudgement) console.log(`[PLAN_EXECUTOR] Tower judgement: SKIPPED (skipJudgement=true)`);

  await logPlanStarted(userId, runId, goal, conversationId, clientRequestId);
  await safeUpdatePlanStatus(planId, 'executing');

  const primaryTool = steps[0]?.toolName || steps[0]?.type || 'SEARCH_PLACES';
  logRouterDecision(
    userId, runId, primaryTool,
    `Supervisor executing ${steps.length}-step plan via ${primaryTool}`,
    conversationId, clientRequestId,
  ).catch(() => {});

  let stepsCompleted = 0;
  let isLeadRun = false;
  let lastLeadsListArtefact: Awaited<ReturnType<typeof createArtefact>> | undefined;
  let towerCalledForLeadRun = false;
  const leadsMap = new Map<string, Record<string, unknown>>();
  const leadsFilters: Record<string, string> = {};
  const toolTracker = createRunToolTracker();

  const successCriteria: TowerSuccessCriteria = { ...LEADGEN_SUCCESS_DEFAULTS };
  const runSummary = createRunSummary();
  let currentPlanVersion = 1;

  const shouldJudge = !skipJudgement;

  try {
    const firstStepArgs = steps[0]?.toolArgs || toolMetadata?.toolArgs || {};
    const leadCtx: LeadContext = {
      business_name: typeof firstStepArgs.query === 'string' ? firstStepArgs.query : goal,
      website: typeof firstStepArgs.website === 'string' ? firstStepArgs.website : null,
      phone: typeof firstStepArgs.phone === 'string' ? firstStepArgs.phone : null,
      address: typeof firstStepArgs.location === 'string' ? firstStepArgs.location : null,
      town: typeof firstStepArgs.location === 'string' ? firstStepArgs.location : null,
    };
    const toolPlan = buildToolPlan(leadCtx);
    persistToolPlanExplainer(toolPlan, runId, userId, conversationId).catch((err) => {
      console.error(`[PLAN_EXECUTOR] tool_plan_explainer write failed: ${err}`);
    });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepType = step.toolName || toolMetadata?.toolName || 'UNKNOWN';
      const isSearchPlaces = stepType === 'SEARCH_PLACES';

      let currentStepArgs = step.toolArgs || toolMetadata?.toolArgs || {};
      let stepRetryCount = 0;
      let stepCompleted = false;

      while (!stepCompleted) {
        const attemptLabel = stepRetryCount > 0 ? ` (retry ${stepRetryCount})` : currentPlanVersion > 1 ? ` (plan v${currentPlanVersion})` : '';
        console.log(`[PLAN_EXECUTOR] Step ${i + 1}/${steps.length}: ${step.label}${attemptLabel}`);

        await logAFREvent({
          userId, runId, conversationId, clientRequestId,
          actionTaken: 'step_started', status: 'success',
          taskGenerated: `Step ${i + 1}/${steps.length}: ${step.label}${attemptLabel}`,
          runType: 'plan',
          metadata: { step_index: i, step_label: step.label, step_type: stepType, retry_count: stepRetryCount, plan_version: currentPlanVersion },
        }).catch(() => {});

        await logStepStarted(userId, runId, step.id, step.label, conversationId, clientRequestId);
        updateStepStatus(planId, step.id, 'running');

        const stepStartedAt = new Date();
        let result: ActionResult;
        try {
          result = await executeAction({
            toolName: stepType,
            toolArgs: currentStepArgs,
            userId,
            tracker: toolTracker,
            runId,
            conversationId,
            clientRequestId,
          });
        } catch (stepError: any) {
          const stepFinishedAt = new Date();
          const errorMessage = stepError.message || 'Step execution threw an exception';
          console.error(`[PLAN_EXECUTOR] Step ${step.id} threw error:`, errorMessage);

          let exceptionStepArtefact: Awaited<ReturnType<typeof createArtefact>> | undefined;
          try {
            const exSummary = `fail – ${errorMessage.substring(0, SUMMARY_CAP)}`;
            exceptionStepArtefact = await createArtefact({
              runId,
              type: 'step_result',
              title: `Step result: ${i + 1}/${steps.length} - ${step.label}`,
              summary: exSummary,
              payload: {
                run_id: runId,
                client_request_id: clientRequestId || null,
                goal,
                plan_version: currentPlanVersion,
                step_id: step.id,
                step_title: step.label,
                step_index: i,
                step_status: 'fail',
                inputs_summary: redactRecord(compactInputs(currentStepArgs)),
                outputs_summary: {},
                outputs_raw_omitted: true,
                timings: {
                  started_at: stepStartedAt.toISOString(),
                  finished_at: stepFinishedAt.toISOString(),
                  duration_ms: stepFinishedAt.getTime() - stepStartedAt.getTime(),
                },
                step_type: stepType,
                errors: [errorMessage],
                retry_count: stepRetryCount,
                metrics: {},
              },
              userId, conversationId,
            });
          } catch (artefactErr: any) {
            console.warn(`[PLAN_EXECUTOR] step_result artefact write failed (continuing): ${artefactErr.message}`);
          }

          // Step-level judgement (observation only)
          // Unconditionally call Tower after tool completes. No branching on verdict.
          if (exceptionStepArtefact) {
            try {
              const obsResult = await judgeArtefact({
                artefact: exceptionStepArtefact,
                runId, goal, userId, conversationId,
              });
              await createArtefact({
                runId,
                type: 'tower_judgement',
                title: `Tower Judgement: ${obsResult.judgement.verdict} (step ${i + 1})`,
                summary: `Observation: ${obsResult.judgement.verdict} | ${obsResult.judgement.action} | ${step.label}`,
                payload: {
                  verdict: obsResult.judgement.verdict,
                  action: obsResult.judgement.action,
                  reasons: obsResult.judgement.reasons,
                  metrics: obsResult.judgement.metrics,
                  step_index: i,
                  step_label: step.label,
                  judged_artefact_id: exceptionStepArtefact.id,
                  stubbed: obsResult.stubbed,
                  observation_only: true,
                },
                userId, conversationId,
              });
              console.log(`[STEP_OBSERVATION] ${ts()} step=${i + 1} verdict=${obsResult.judgement.verdict} action=${obsResult.judgement.action} (observation only, no branching)`);
            } catch (obsErr: any) {
              console.warn(`[STEP_OBSERVATION] Tower observation failed for step ${i + 1} (continuing): ${obsErr.message}`);
            }
          }

          updateRunSummary(runSummary, { success: false, leadsFound: 0, costUnits: 0.25 });
          await logStepFailed(userId, runId, step.id, step.label, errorMessage, conversationId, clientRequestId);
          updateStepStatus(planId, step.id, 'failed', errorMessage);
          await logPlanFailed(userId, runId, errorMessage, conversationId, clientRequestId);
          failProgress(planId, errorMessage);
          await safeUpdatePlanStatus(planId, 'failed');

          return { success: false, stepsCompleted, totalSteps: steps.length, error: errorMessage };
        }

        if (!result.success) {
          const stepFinishedAt = new Date();
          console.error(`[PLAN_EXECUTOR] Step ${step.id} failed:`, result.error);
          await logStepFailed(userId, runId, step.id, step.label, result.error || 'Unknown error', conversationId, clientRequestId);
          updateStepStatus(planId, step.id, 'failed', result.error);

          let failStepArtefact: Awaited<ReturnType<typeof createArtefact>> | undefined;
          try {
            const failSummary = `fail – ${(result.error || 'Unknown error').substring(0, SUMMARY_CAP)}`;
            failStepArtefact = await createArtefact({
              runId,
              type: 'step_result',
              title: `Step result: ${i + 1}/${steps.length} - ${step.label}`,
              summary: failSummary,
              payload: {
                run_id: runId,
                client_request_id: clientRequestId || null,
                goal,
                plan_version: currentPlanVersion,
                step_id: step.id,
                step_title: step.label,
                step_index: i,
                step_status: 'fail',
                inputs_summary: redactRecord(compactInputs(currentStepArgs)),
                outputs_summary: {},
                ...safeOutputsRaw(result.data as Record<string, unknown> | undefined),
                timings: {
                  started_at: stepStartedAt.toISOString(),
                  finished_at: stepFinishedAt.toISOString(),
                  duration_ms: stepFinishedAt.getTime() - stepStartedAt.getTime(),
                },
                step_type: stepType,
                errors: [result.error || 'Unknown error'],
                retry_count: stepRetryCount,
                metrics: {},
              },
              userId, conversationId,
            });
          } catch (artefactErr: any) {
            console.warn(`[PLAN_EXECUTOR] step_result artefact write failed (continuing): ${artefactErr.message}`);
          }

          // Step-level judgement (observation only)
          // Unconditionally call Tower after tool completes. No branching on verdict.
          if (failStepArtefact) {
            try {
              const obsResult = await judgeArtefact({
                artefact: failStepArtefact,
                runId, goal, userId, conversationId,
              });
              await createArtefact({
                runId,
                type: 'tower_judgement',
                title: `Tower Judgement: ${obsResult.judgement.verdict} (step ${i + 1})`,
                summary: `Observation: ${obsResult.judgement.verdict} | ${obsResult.judgement.action} | ${step.label}`,
                payload: {
                  verdict: obsResult.judgement.verdict,
                  action: obsResult.judgement.action,
                  reasons: obsResult.judgement.reasons,
                  metrics: obsResult.judgement.metrics,
                  step_index: i,
                  step_label: step.label,
                  judged_artefact_id: failStepArtefact.id,
                  stubbed: obsResult.stubbed,
                  observation_only: true,
                },
                userId, conversationId,
              });
              console.log(`[STEP_OBSERVATION] ${ts()} step=${i + 1} verdict=${obsResult.judgement.verdict} action=${obsResult.judgement.action} (observation only, no branching)`);
            } catch (obsErr: any) {
              console.warn(`[STEP_OBSERVATION] Tower observation failed for step ${i + 1} (continuing): ${obsErr.message}`);
            }
          }

          updateRunSummary(runSummary, { success: false, leadsFound: 0, costUnits: 0.25 });
          await logPlanFailed(userId, runId, result.error || 'Step execution failed', conversationId, clientRequestId);
          failProgress(planId, result.error);
          await safeUpdatePlanStatus(planId, 'failed');

          return { success: false, stepsCompleted, totalSteps: steps.length, error: result.error };
        }

        const leadsFound = (result.data?.places as any[])?.length
          ?? (result.data?.leads as any[])?.length
          ?? (result.data?.count as number)
          ?? 0;

        updateRunSummary(runSummary, { success: true, leadsFound, costUnits: 0.25, validLeads: leadsFound });

        console.log(`[PLAN_EXECUTOR] Step ${i + 1} execution succeeded: ${result.summary}`);

        const stepFinishedAt = new Date();
        const stepInputs = compactInputs(currentStepArgs);
        const stepOutputs = result.data ? compactOutputs(result.data) : {};
        const stepMetrics = result.data ? extractMetrics(stepType, result.data) : {};

        let stepArtefact: Awaited<ReturnType<typeof createArtefact>> | undefined;
        try {
          const successSummary = `success – ${(result.summary || `Step ${step.id} completed`).substring(0, SUMMARY_CAP)}`;
          stepArtefact = await createArtefact({
            runId,
            type: 'step_result',
            title: `Step result: ${i + 1}/${steps.length} - ${step.label}`,
            summary: successSummary,
            payload: {
              run_id: runId,
              client_request_id: clientRequestId || null,
              goal,
              plan_version: currentPlanVersion,
              step_id: step.id,
              step_title: step.label,
              step_index: i,
              step_status: 'success',
              inputs_summary: redactRecord(stepInputs),
              outputs_summary: stepOutputs,
              ...safeOutputsRaw(result.data as Record<string, unknown> | undefined),
              timings: {
                started_at: stepStartedAt.toISOString(),
                finished_at: stepFinishedAt.toISOString(),
                duration_ms: stepFinishedAt.getTime() - stepStartedAt.getTime(),
              },
              step_type: stepType,
              metrics: stepMetrics,
              errors: [],
              retry_count: stepRetryCount,
            },
            userId, conversationId,
          });

          console.log(`[TOWER_SEQ] ${ts()} STEP_RESULT_WRITTEN runId=${runId} step=${i + 1} artefactId=${stepArtefact.id} type=step_result`);

          await logAFREvent({
            userId, runId, conversationId, clientRequestId,
            actionTaken: 'artefact_created', status: 'success',
            taskGenerated: `step_result artefact created for step ${i + 1}: ${step.label}`,
            runType: 'plan',
            metadata: { artefactId: stepArtefact.id, artefact_type: 'step_result', step_index: i },
          }).catch(() => {});
        } catch (artefactErr: any) {
          console.warn(`[PLAN_EXECUTOR] step_result artefact write failed (continuing): ${artefactErr.message}`);
          const errMsg = `step_result artefact write failed: ${artefactErr.message}`;
          await createArtefact({
            runId, type: 'error', title: `Error: artefact write failed (step ${i + 1})`,
            summary: errMsg, payload: { step_index: i, error: errMsg }, userId, conversationId,
          }).catch(() => {});
          failProgress(planId, errMsg);
          await safeUpdatePlanStatus(planId, 'failed');
          return { success: false, stepsCompleted, totalSteps: steps.length, error: errMsg };
        }

        let artefactToJudge = stepArtefact;
        if (isSearchPlaces) {
          const toolArgs = currentStepArgs;
          const rawTarget = result.data?.target_count ?? toolArgs.target_count;
          const targetCount = rawTarget != null ? Number(rawTarget) : null;
          const deliveredCount = Number(result.data?.delivered_count || result.data?.count) || 0;
          const targetLabel = targetCount != null ? ` of ${targetCount} requested` : '';

          try {
            const leadsListArtefact = await createArtefact({
              runId,
              type: 'leads_list',
              title: `Leads list: ${step.label}${attemptLabel}`,
              summary: `Delivered ${deliveredCount}${targetLabel} for "${toolArgs.query || ''}" in ${toolArgs.location || ''}`,
              payload: {
                ...stepOutputs, ...stepMetrics,
                delivered_count: deliveredCount, target_count: targetCount,
                success_criteria: { target_count: targetCount },
                query: toolArgs.query, location: toolArgs.location, country: toolArgs.country,
                retry_count: stepRetryCount, plan_version: currentPlanVersion,
              },
              userId, conversationId,
            });

            console.log(`[TOWER_SEQ] ${ts()} STEP_RESULT_WRITTEN runId=${runId} step=${i + 1} artefactId=${leadsListArtefact.id} type=leads_list`);

            await logAFREvent({
              userId, runId, conversationId, clientRequestId,
              actionTaken: 'artefact_created', status: 'success',
              taskGenerated: `leads_list artefact created for step ${i + 1}: ${deliveredCount} leads`,
              runType: 'plan',
              metadata: { artefactId: leadsListArtefact.id, artefact_type: 'leads_list', step_index: i, delivered_count: deliveredCount, target_count: targetCount },
            }).catch(() => {});

            isLeadRun = true;
            lastLeadsListArtefact = leadsListArtefact;
            artefactToJudge = leadsListArtefact;
          } catch (artefactErr: any) {
            console.error(`[PLAN_EXECUTOR] leads_list artefact creation failed: ${artefactErr.message}`);
            const errMsg = `leads_list artefact write failed: ${artefactErr.message}`;
            await createArtefact({
              runId, type: 'error', title: `Error: leads_list write failed (step ${i + 1})`,
              summary: errMsg, payload: { step_index: i, error: errMsg }, userId, conversationId,
            }).catch(() => {});
            failProgress(planId, errMsg);
            await safeUpdatePlanStatus(planId, 'failed');
            return { success: false, stepsCompleted, totalSteps: steps.length, error: errMsg };
          }
        }

        accumulateLeads({ toolName: stepType, toolArgs: currentStepArgs }, result.data, leadsMap, leadsFilters);

        // Step-level judgement (observation only)
        // Unconditionally call Tower after tool completes. No branching on verdict.
        if (stepArtefact) {
          try {
            const obsResult = await judgeArtefact({
              artefact: stepArtefact,
              runId, goal, userId, conversationId,
            });
            await createArtefact({
              runId,
              type: 'tower_judgement',
              title: `Tower Judgement: ${obsResult.judgement.verdict} (step ${i + 1})`,
              summary: `Observation: ${obsResult.judgement.verdict} | ${obsResult.judgement.action} | ${step.label}`,
              payload: {
                verdict: obsResult.judgement.verdict,
                action: obsResult.judgement.action,
                reasons: obsResult.judgement.reasons,
                metrics: obsResult.judgement.metrics,
                step_index: i,
                step_label: step.label,
                judged_artefact_id: stepArtefact.id,
                stubbed: obsResult.stubbed,
                observation_only: true,
              },
              userId, conversationId,
            });
            console.log(`[STEP_OBSERVATION] ${ts()} step=${i + 1} verdict=${obsResult.judgement.verdict} action=${obsResult.judgement.action} (observation only, no branching)`);
          } catch (obsErr: any) {
            console.warn(`[STEP_OBSERVATION] Tower observation failed for step ${i + 1} (continuing): ${obsErr.message}`);
          }
        }

        if (!shouldJudge || !artefactToJudge) {
          await logStepCompleted(userId, runId, step.id, step.label, result.summary, conversationId, clientRequestId);
          updateStepStatus(planId, step.id, 'completed', result.summary);
          stepsCompleted++;
          console.log(`[PLAN_EXECUTOR] Step ${i + 1} completed (judgement skipped): ${result.summary}`);
          stepCompleted = true;
          continue;
        }

        const rawStepTarget = currentStepArgs.target_count;
        const towerSuccessCriteria = isSearchPlaces
          ? { ...successCriteria, target_leads: rawStepTarget != null ? Number(rawStepTarget) : null }
          : undefined;

        const judgement = await judgeStepResultSync(
          artefactToJudge, runId, goal, userId, conversationId, clientRequestId,
          i, step.label, towerSuccessCriteria,
        );

        if (isSearchPlaces) towerCalledForLeadRun = true;

        console.log(`[TOWER_SEQ] ${ts()} REACTION_TAKEN runId=${runId} step=${i + 1} reaction=${judgement.reaction} verdict=${judgement.verdict}`);

        switch (judgement.reaction) {
          case 'continue': {
            console.log(`[PLAN_EXECUTOR] [reaction] CONTINUE after step ${i + 1}`);

            await logStepCompleted(userId, runId, step.id, step.label, result.summary, conversationId, clientRequestId);
            updateStepStatus(planId, step.id, 'completed', result.summary);
            stepsCompleted++;

            await logAFREvent({
              userId, runId, conversationId, clientRequestId,
              actionTaken: 'supervisor_reaction', status: 'success',
              taskGenerated: `Tower: CONTINUE after step ${i + 1} (${step.label}) — step completed`,
              runType: 'plan',
              metadata: { reaction: 'continue', step_index: i, verdict: judgement.verdict, steps_completed: stepsCompleted },
            }).catch(() => {});
            stepCompleted = true;
            break;
          }

          case 'retry': {
            if (stepRetryCount >= MAX_RETRIES_PER_STEP) {
              console.log(`[PLAN_EXECUTOR] [reaction] RETRY requested but max retries (${MAX_RETRIES_PER_STEP}) exceeded at step ${i + 1} — stopping`);
              await logAFREvent({
                userId, runId, conversationId, clientRequestId,
                actionTaken: 'supervisor_reaction', status: 'failed',
                taskGenerated: `Tower: RETRY rejected — max retries (${MAX_RETRIES_PER_STEP}) exceeded at step ${i + 1}`,
                runType: 'plan',
                metadata: { reaction: 'retry_rejected', step_index: i, retry_count: stepRetryCount, max_retries: MAX_RETRIES_PER_STEP },
              }).catch(() => {});

              const haltReason = `Max retries (${MAX_RETRIES_PER_STEP}) exceeded at step ${i + 1}: ${step.label}`;

              await createArtefact({
                runId, type: 'run_stopped',
                title: `Run stopped: max retries exceeded`,
                summary: haltReason,
                payload: { reason: haltReason, step_index: i, retry_count: stepRetryCount, plan_version: currentPlanVersion },
                userId, conversationId,
              }).catch((err: any) => console.error(`[PLAN_EXECUTOR] run_stopped artefact failed: ${err.message}`));

              failProgress(planId, `Halted: ${haltReason}`);
              await safeUpdatePlanStatus(planId, 'failed');
              const peRetryConstraints = deriveConstraintsFromFilters(leadsFilters);
              await emitDeliverySummary({
                runId, userId, conversationId, originalUserGoal: goal,
                requestedCount: Number(successCriteria.target_leads ?? 0),
                hardConstraints: peRetryConstraints.hard, softConstraints: peRetryConstraints.soft,
                planVersions: Array.from({ length: currentPlanVersion }, (_, vi) => ({ version: vi + 1, changes_made: vi === 0 ? ['Initial plan'] : [`Plan v${vi + 1}`] })),
                softRelaxations: [],
                leads: Array.from(leadsMap.values()).map(l => ({ entity_id: String(l.place_id || ''), name: String(l.name || ''), address: String(l.address || '') })),
                finalVerdict: 'STOP', stopReason: haltReason,
              }).catch((dsErr: any) => console.error(`[PLAN_EXECUTOR] delivery_summary failed: ${dsErr.message}`));
              return { success: false, stepsCompleted, totalSteps: steps.length, error: haltReason, haltedByJudgement: true, haltReason };
            }

            stepRetryCount++;
            console.log(`[PLAN_EXECUTOR] [reaction] RETRY step ${i + 1} (attempt ${stepRetryCount + 1}/${MAX_RETRIES_PER_STEP + 1})`);
            await logAFREvent({
              userId, runId, conversationId, clientRequestId,
              actionTaken: 'supervisor_reaction', status: 'success',
              taskGenerated: `Tower: RETRY step ${i + 1} (attempt ${stepRetryCount + 1})`,
              runType: 'plan',
              metadata: { reaction: 'retry', step_index: i, retry_count: stepRetryCount, reasons: judgement.reasons },
            }).catch(() => {});

            updateStepStatus(planId, step.id, 'running');
            break;
          }

          case 'change_plan': {
            if (currentPlanVersion >= MAX_PLAN_VERSIONS) {
              console.log(`[PLAN_EXECUTOR] [reaction] CHANGE_PLAN requested but max plan versions (${MAX_PLAN_VERSIONS}) exceeded — stopping`);
              await logAFREvent({
                userId, runId, conversationId, clientRequestId,
                actionTaken: 'supervisor_reaction', status: 'failed',
                taskGenerated: `Tower: CHANGE_PLAN rejected — max plan versions (${MAX_PLAN_VERSIONS}) exceeded`,
                runType: 'plan',
                metadata: { reaction: 'change_plan_rejected', step_index: i, plan_version: currentPlanVersion, max_plan_versions: MAX_PLAN_VERSIONS },
              }).catch(() => {});

              const haltReason = `Max plan versions (${MAX_PLAN_VERSIONS}) exceeded at step ${i + 1}: ${step.label}`;

              await createArtefact({
                runId, type: 'run_stopped',
                title: `Run stopped: max plan versions exceeded`,
                summary: haltReason,
                payload: { reason: haltReason, step_index: i, plan_version: currentPlanVersion },
                userId, conversationId,
              }).catch((err: any) => console.error(`[PLAN_EXECUTOR] run_stopped artefact failed: ${err.message}`));

              failProgress(planId, `Halted: ${haltReason}`);
              await safeUpdatePlanStatus(planId, 'failed');
              const peCpConstraints = deriveConstraintsFromFilters(leadsFilters);
              await emitDeliverySummary({
                runId, userId, conversationId, originalUserGoal: goal,
                requestedCount: Number(successCriteria.target_leads ?? 0),
                hardConstraints: peCpConstraints.hard, softConstraints: peCpConstraints.soft,
                planVersions: Array.from({ length: currentPlanVersion }, (_, vi) => ({ version: vi + 1, changes_made: vi === 0 ? ['Initial plan'] : [`Plan v${vi + 1}`] })),
                softRelaxations: [],
                leads: Array.from(leadsMap.values()).map(l => ({ entity_id: String(l.place_id || ''), name: String(l.name || ''), address: String(l.address || '') })),
                finalVerdict: 'STOP', stopReason: haltReason,
              }).catch((dsErr: any) => console.error(`[PLAN_EXECUTOR] delivery_summary failed: ${dsErr.message}`));
              return { success: false, stepsCompleted, totalSteps: steps.length, error: haltReason, haltedByJudgement: true, haltReason };
            }

            currentPlanVersion++;
            stepRetryCount = 0;

            const adjustment = buildAdjustedArgs(currentStepArgs, judgement.reasons, currentPlanVersion);
            currentStepArgs = adjustment.args;

            console.log(`[PLAN_EXECUTOR] [reaction] CHANGE_PLAN step ${i + 1} -> plan v${currentPlanVersion}: ${adjustment.description}`);

            await createArtefact({
              runId,
              type: 'plan_update',
              title: `Plan update v${currentPlanVersion}: ${adjustment.strategy}`,
              summary: adjustment.description,
              payload: {
                plan_version: currentPlanVersion,
                strategy: adjustment.strategy,
                description: adjustment.description,
                adjusted_args: adjustment.args,
                step_index: i, step_label: step.label,
                reasons: judgement.reasons,
              },
              userId, conversationId,
            }).catch((err: any) => console.error(`[PLAN_EXECUTOR] plan_update artefact failed: ${err.message}`));

            await logAFREvent({
              userId, runId, conversationId, clientRequestId,
              actionTaken: 'supervisor_reaction', status: 'success',
              taskGenerated: `Tower: CHANGE_PLAN step ${i + 1} -> plan v${currentPlanVersion}: ${adjustment.strategy}`,
              runType: 'plan',
              metadata: {
                reaction: 'change_plan', step_index: i,
                plan_version: currentPlanVersion, strategy: adjustment.strategy,
                adjusted_args: adjustment.args, reasons: judgement.reasons,
              },
            }).catch(() => {});

            updateStepStatus(planId, step.id, 'running');
            break;
          }

          case 'stop': {
            const haltReason = `Tower: ${judgement.verdict} at step ${i + 1} — ${judgement.reasons?.[0] || judgement.action}`;
            console.log(`[PLAN_EXECUTOR] [reaction] STOP after step ${i + 1}: ${haltReason}`);

            await logAFREvent({
              userId, runId, conversationId, clientRequestId,
              actionTaken: 'supervisor_reaction', status: 'failed',
              taskGenerated: `Tower: STOP at step ${i + 1}: ${haltReason}`,
              runType: 'plan',
              metadata: { reaction: 'stop', step_index: i, verdict: judgement.verdict, reasons: judgement.reasons },
            }).catch(() => {});

            await createArtefact({
              runId, type: 'run_stopped',
              title: `Run stopped: Tower STOP verdict`,
              summary: haltReason,
              payload: {
                reason: haltReason, step_index: i,
                verdict: judgement.verdict, reasons: judgement.reasons,
                plan_version: currentPlanVersion,
              },
              userId, conversationId,
            }).catch((err: any) => console.error(`[PLAN_EXECUTOR] run_stopped artefact failed: ${err.message}`));

            failProgress(planId, `Halted: ${haltReason}`);
            await safeUpdatePlanStatus(planId, 'failed');
            const peStopConstraints = deriveConstraintsFromFilters(leadsFilters);
            await emitDeliverySummary({
              runId, userId, conversationId, originalUserGoal: goal,
              requestedCount: Number(successCriteria.target_leads ?? 0),
              hardConstraints: peStopConstraints.hard, softConstraints: peStopConstraints.soft,
              planVersions: Array.from({ length: currentPlanVersion }, (_, vi) => ({ version: vi + 1, changes_made: vi === 0 ? ['Initial plan'] : [`Plan v${vi + 1}`] })),
              softRelaxations: [],
              leads: Array.from(leadsMap.values()).map(l => ({ entity_id: String(l.place_id || ''), name: String(l.name || ''), address: String(l.address || '') })),
              finalVerdict: 'STOP', stopReason: haltReason,
            }).catch((dsErr: any) => console.error(`[PLAN_EXECUTOR] delivery_summary failed: ${dsErr.message}`));
            return { success: false, stepsCompleted, totalSteps: steps.length, error: haltReason, haltedByJudgement: true, haltReason };
          }
        }

        try {
          await logToolsUpdate(
            userId, runId,
            [...toolTracker.tools_used],
            [...toolTracker.tools_rejected],
            [...toolTracker.replans],
            i,
            conversationId, clientRequestId,
          );
        } catch (tuErr: any) {
          console.warn(`[PLAN_EXECUTOR] tools_update event failed (continuing): ${tuErr.message}`);
        }
      }
    }

    if (leadsMap.size > 0) {
      try {
        const leadsList = buildLeadsList(leadsMap, leadsFilters);
        const accumulatedArtefact = await createArtefact({
          runId,
          type: 'leads_list',
          title: `Leads: ${goal}`,
          summary: `${leadsList.total} leads collected${leadsList.capped ? ` (capped to ${LEADS_LIST_CAP})` : ''}`,
          payload: {
            items: leadsList.items,
            total: leadsList.total,
            capped: leadsList.capped,
            filters: leadsList.filters,
          },
          userId, conversationId,
        });
        console.log(`[PLAN_EXECUTOR] leads_list artefact created: ${leadsList.total} leads`);
        isLeadRun = true;
        lastLeadsListArtefact = accumulatedArtefact;
      } catch (leadsErr: any) {
        console.error(`[PLAN_EXECUTOR] leads_list artefact creation failed (continuing): ${leadsErr.message}`);
      }
    }

    const summary = `Plan completed successfully - ${stepsCompleted}/${steps.length} steps`;
    await logPlanCompleted(userId, runId, summary, conversationId, clientRequestId);
    completeProgress(planId);
    await safeUpdatePlanStatus(planId, 'completed');

    try {
      const stepSummaries = steps.map((s, idx) => ({
        stepId: s.id,
        label: s.label,
        type: s.type,
        index: idx,
      }));

      const artefactTitle = `Result: ${goal}`;
      const artefactSummary = `${stepsCompleted}/${steps.length} steps completed.`;

      await createArtefact({
        runId,
        type: 'plan_result',
        title: artefactTitle,
        summary: artefactSummary,
        payload: {
          goal, stepsCompleted, totalSteps: steps.length,
          runStats: {
            itemsFound: runSummary.leads_found,
            costUnits: runSummary.total_cost_gbp,
            stepsExecuted: runSummary.steps_completed,
            failuresCount: runSummary.failures_count,
          },
          steps: stepSummaries,
          tools_used: toolTracker.tools_used,
          tools_rejected: toolTracker.tools_rejected,
          replans: toolTracker.replans,
          plan_version: currentPlanVersion,
        },
        userId, conversationId,
      });
    } catch (artefactError: any) {
      console.error(`[PLAN_EXECUTOR] Failed to create artefact for plan ${planId}:`, artefactError.message);
    }

    console.log(`[PLAN_EXECUTOR] ${summary}`);

    const peLeads = Array.from(leadsMap.values()).map(l => ({
      entity_id: String(l.place_id || ''),
      name: String(l.name || ''),
      address: String(l.address || ''),
    }));
    const peSuccessConstraints = deriveConstraintsFromFilters(leadsFilters);
    await emitDeliverySummary({
      runId,
      userId,
      conversationId,
      originalUserGoal: goal,
      requestedCount: Number(successCriteria.target_leads ?? 0),
      hardConstraints: peSuccessConstraints.hard,
      softConstraints: peSuccessConstraints.soft,
      planVersions: Array.from({ length: currentPlanVersion }, (_, i) => ({
        version: i + 1,
        changes_made: i === 0 ? ['Initial plan'] : [`Plan v${i + 1}`],
      })),
      softRelaxations: [],
      leads: peLeads,
      finalVerdict: 'pass',
      stopReason: null,
    });

    return { success: true, stepsCompleted, totalSteps: steps.length };

  } catch (error: any) {
    const errorMessage = error.message || 'Plan execution failed unexpectedly';
    console.error(`[PLAN_EXECUTOR] Plan execution error:`, errorMessage);

    await logPlanFailed(userId, runId, errorMessage, conversationId, clientRequestId);
    failProgress(planId, errorMessage);
    await safeUpdatePlanStatus(planId, 'failed');

    const peLeadsFail = Array.from(leadsMap.values()).map(l => ({
      entity_id: String(l.place_id || ''),
      name: String(l.name || ''),
      address: String(l.address || ''),
    }));
    const peFailConstraints = deriveConstraintsFromFilters(leadsFilters);
    await emitDeliverySummary({
      runId,
      userId,
      conversationId,
      originalUserGoal: goal,
      requestedCount: Number(successCriteria.target_leads ?? 0),
      hardConstraints: peFailConstraints.hard,
      softConstraints: peFailConstraints.soft,
      planVersions: Array.from({ length: currentPlanVersion }, (_, i) => ({
        version: i + 1,
        changes_made: i === 0 ? ['Initial plan'] : [`Plan v${i + 1}`],
      })),
      softRelaxations: [],
      leads: peLeadsFail,
      finalVerdict: 'STOP',
      stopReason: errorMessage,
    }).catch((dsErr: any) => console.error(`[PLAN_EXECUTOR] delivery_summary emission failed: ${dsErr.message}`));

    return { success: false, stepsCompleted, totalSteps: steps.length, error: errorMessage };
  }
}

export function startPlanExecutionAsync(plan: Plan): void {
  console.log(`[PLAN_EXECUTOR] Starting async execution for plan ${plan.planId}`);

  executePlan(plan).then(result => {
    if (result.haltedByJudgement) {
      console.log(`[PLAN_EXECUTOR] Plan ${plan.planId} halted by Tower judgement: ${result.haltReason}`);
    } else if (result.success) {
      console.log(`[PLAN_EXECUTOR] Async execution completed for plan ${plan.planId}`);
    } else {
      console.error(`[PLAN_EXECUTOR] Async execution failed for plan ${plan.planId}:`, result.error);
    }
  }).catch(error => {
    console.error(`[PLAN_EXECUTOR] Async execution threw for plan ${plan.planId}:`, error);
  });
}
