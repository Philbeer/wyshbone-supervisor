/**
 * Plan Executor - Core execution loop for Supervisor
 * 
 * Iterates steps sequentially, logs AFR events, and calls action executor.
 * Session 1 scope: No retries, stop on first failure.
 * Session 3: Agentic decision loop – calls Tower Judgement API after each step.
 *            Persists plan status and progress to the same stores the UI reads.
 */

import type { Plan } from './types/plan';
import { executeStep, createRunToolTracker } from './action-executor';
import {
  logPlanStarted,
  logStepStarted,
  logStepCompleted,
  logStepFailed,
  logPlanCompleted,
  logPlanFailed,
  logToolsUpdate
} from './afr-logger';
import {
  LEADGEN_SUCCESS_DEFAULTS,
  createRunSummary,
  updateRunSummary,
  buildSnapshot,
  requestJudgement,
  type TowerSuccessCriteria,
} from './tower-judgement';
import { storage } from '../storage';
import {
  updateStepStatus,
  completePlan as completeProgress,
  failPlan as failProgress,
} from '../plan-progress';
import { createArtefact } from './artefacts';
import { judgeArtefact } from './tower-artefact-judge';

function compactInputs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null && v !== '') {
      result[k] = typeof v === 'string' && v.length > 200 ? v.substring(0, 200) : v;
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

export async function executePlan(plan: Plan): Promise<PlanExecutionResult> {
  const { planId, userId, conversationId, clientRequestId, goal, steps, skipJudgement, toolMetadata } = plan;
  
  console.log(`[PLAN_EXECUTOR] Starting execution of plan ${planId}`);
  console.log(`[PLAN_EXECUTOR] Goal: ${goal}`);
  console.log(`[PLAN_EXECUTOR] Steps: ${steps.length}`);
  if (clientRequestId) console.log(`[PLAN_EXECUTOR] clientRequestId: ${clientRequestId}`);
  if (skipJudgement) console.log(`[PLAN_EXECUTOR] Tower judgement: SKIPPED (skipJudgement=true)`);
  
  await logPlanStarted(userId, planId, goal, conversationId, clientRequestId);
  await safeUpdatePlanStatus(planId, 'executing');
  
  let stepsCompleted = 0;
  const leadsMap = new Map<string, Record<string, unknown>>();
  const leadsFilters: Record<string, string> = {};
  const toolTracker = createRunToolTracker();

  const missionType = 'leadgen';
  const successCriteria: TowerSuccessCriteria = { ...LEADGEN_SUCCESS_DEFAULTS };
  const runSummary = createRunSummary();
  
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      
      console.log(`[PLAN_EXECUTOR] Step ${i + 1}/${steps.length}: ${step.label}`);
      
      await logStepStarted(userId, planId, step.id, step.label, conversationId, clientRequestId);
      updateStepStatus(planId, step.id, 'running');
      
      try {
        const result = await executeStep(step, toolMetadata, userId, toolTracker);
        
        if (!result.success) {
          console.error(`[PLAN_EXECUTOR] Step ${step.id} failed:`, result.error);
          await logStepFailed(userId, planId, step.id, step.label, result.error || 'Unknown error', conversationId, clientRequestId);
          updateStepStatus(planId, step.id, 'failed', result.error);

          try {
            const stepType = step.toolName || toolMetadata?.toolName || 'UNKNOWN';
            const stepArgs = step.toolArgs || toolMetadata?.toolArgs;
            const stepInputs = stepArgs ? compactInputs(stepArgs) : {};
            await createArtefact({
              runId: planId,
              type: 'step_result',
              title: `Step result: ${step.label}`,
              summary: `Failed: ${result.error || 'Unknown error'}`,
              payload: {
                step_index: i,
                step_title: step.label,
                step_type: stepType,
                step_status: 'fail',
                inputs: stepInputs,
                outputs: {},
                metrics: {},
                errors: [result.error || 'Unknown error'],
              },
              userId,
              conversationId,
            });
          } catch (artefactErr: any) {
            console.error(`[PLAN_EXECUTOR] Failed step artefact creation failed (continuing): ${artefactErr.message}`);
          }

          updateRunSummary(runSummary, {
            success: false,
            leadsFound: 0,
            costUnits: 0.25,
          });

          await logPlanFailed(userId, planId, result.error || 'Step execution failed', conversationId, clientRequestId);
          failProgress(planId, result.error);
          await safeUpdatePlanStatus(planId, 'failed');
          
          return {
            success: false,
            stepsCompleted,
            totalSteps: steps.length,
            error: result.error
          };
        }
        
        const leadsFound = (result.data?.places as any[])?.length
          ?? (result.data?.leads as any[])?.length
          ?? (result.data?.count as number)
          ?? 0;

        updateRunSummary(runSummary, {
          success: true,
          leadsFound,
          costUnits: 0.25,
          validLeads: leadsFound,
        });

        await logStepCompleted(userId, planId, step.id, step.label, result.summary, conversationId, clientRequestId);
        updateStepStatus(planId, step.id, 'completed', result.summary);
        stepsCompleted++;
        
        console.log(`[PLAN_EXECUTOR] Step ${i + 1} completed: ${result.summary}`);

        try {
          const stepType = step.toolName || toolMetadata?.toolName || 'UNKNOWN';
          const stepArgs = step.toolArgs || toolMetadata?.toolArgs;
          const stepInputs = stepArgs ? compactInputs(stepArgs) : {};
          const stepOutputs = result.data ? compactOutputs(result.data) : {};
          const stepMetrics = result.data ? extractMetrics(stepType, result.data) : {};

          const stepArtefact = await createArtefact({
            runId: planId,
            type: 'step_result',
            title: `Step result: ${step.label}`,
            summary: result.summary || `Step ${step.id} completed successfully`,
            payload: {
              step_index: i,
              step_title: step.label,
              step_type: stepType,
              step_status: 'pass',
              inputs: stepInputs,
              outputs: stepOutputs,
              metrics: stepMetrics,
              errors: [],
            },
            userId,
            conversationId,
          });

          const judgeResult = await judgeArtefact({
            artefact: stepArtefact,
            runId: planId,
            goal,
            userId,
            conversationId,
          });

          if (judgeResult.shouldStop) {
            const haltReason = `Tower judgement: ${judgeResult.judgement.verdict} — ${judgeResult.judgement.reasons[0] || 'artefact rejected'}`;
            console.log(`[PLAN_EXECUTOR] Halted by artefact judgement after step ${i + 1}: ${haltReason}`);

            failProgress(planId, `Halted: ${haltReason}`);
            await safeUpdatePlanStatus(planId, 'halted');

            return {
              success: false,
              stepsCompleted,
              totalSteps: steps.length,
              error: `Halted by artefact judgement: ${haltReason}`,
              haltedByJudgement: true,
              haltReason,
            };
          }
        } catch (artefactErr: any) {
          console.error(`[PLAN_EXECUTOR] Step artefact/judgement failed (continuing): ${artefactErr.message}`);
        }

        accumulateLeads(step, result.data, leadsMap, leadsFilters);

        try {
          await logToolsUpdate(
            userId, planId,
            [...toolTracker.tools_used],
            [...toolTracker.tools_rejected],
            [...toolTracker.replans],
            i,
            conversationId, clientRequestId,
          );
        } catch (tuErr: any) {
          console.warn(`[PLAN_EXECUTOR] tools_update event failed (continuing): ${tuErr.message}`);
        }

      } catch (stepError: any) {
        const errorMessage = stepError.message || 'Step execution threw an exception';
        console.error(`[PLAN_EXECUTOR] Step ${step.id} threw error:`, errorMessage);

        updateRunSummary(runSummary, {
          success: false,
          leadsFound: 0,
          costUnits: 0.25,
        });
        
        await logStepFailed(userId, planId, step.id, step.label, errorMessage, conversationId, clientRequestId);
        updateStepStatus(planId, step.id, 'failed', errorMessage);
        await logPlanFailed(userId, planId, errorMessage, conversationId, clientRequestId);
        failProgress(planId, errorMessage);
        await safeUpdatePlanStatus(planId, 'failed');
        
        return {
          success: false,
          stepsCompleted,
          totalSteps: steps.length,
          error: errorMessage
        };
      }

      // ----- Tower Judgement: after each step (unless skipped) -----
      if (!skipJudgement) {
        const snapshot = buildSnapshot(runSummary, successCriteria.stall_window_steps);
        const judgement = await requestJudgement(
          planId,
          userId,
          missionType,
          successCriteria,
          snapshot,
          conversationId,
        );

        if (judgement.shouldStop) {
          const haltReason = judgement.verdict
            ? `${judgement.verdict.reason_code}: ${judgement.verdict.explanation}`
            : 'Tower issued STOP';

          console.log(`[PLAN_EXECUTOR] Halted by Tower judgement after step ${i + 1}: ${haltReason}`);

          failProgress(planId, `Halted: ${haltReason}`);
          await safeUpdatePlanStatus(planId, 'halted');

          return {
            success: false,
            stepsCompleted,
            totalSteps: steps.length,
            error: `Halted by judgement: ${haltReason}`,
            haltedByJudgement: true,
            haltReason,
          };
        }
      }
    }
    
    const summary = `Plan completed successfully - ${stepsCompleted}/${steps.length} steps`;
    await logPlanCompleted(userId, planId, summary, conversationId, clientRequestId);
    completeProgress(planId);
    await safeUpdatePlanStatus(planId, 'completed');

    if (leadsMap.size > 0) {
      try {
        const leadsList = buildLeadsList(leadsMap, leadsFilters);
        await createArtefact({
          runId: planId,
          type: 'leads_list',
          title: `Leads: ${goal}`,
          summary: `${leadsList.total} leads collected${leadsList.capped ? ` (capped to ${LEADS_LIST_CAP})` : ''}`,
          payload: {
            items: leadsList.items,
            total: leadsList.total,
            capped: leadsList.capped,
            filters: leadsList.filters,
          },
          userId,
          conversationId,
        });
        console.log(`[PLAN_EXECUTOR] leads_list artefact created: ${leadsList.total} leads`);
      } catch (leadsErr: any) {
        console.error(`[PLAN_EXECUTOR] leads_list artefact creation failed (continuing): ${leadsErr.message}`);
      }
    }

    try {
      const stepSummaries = steps.map((s, i) => ({
        stepId: s.id,
        label: s.label,
        type: s.type,
        index: i,
      }));

      const artefactTitle = `Result: ${goal}`;
      const artefactSummary = `${stepsCompleted}/${steps.length} steps completed.`;

      await createArtefact({
        runId: planId,
        type: 'plan_result',
        title: artefactTitle,
        summary: artefactSummary,
        payload: {
          goal,
          stepsCompleted,
          totalSteps: steps.length,
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
        },
        userId,
        conversationId,
      });
    } catch (artefactError: any) {
      console.error(`[PLAN_EXECUTOR] Failed to create artefact for plan ${planId}:`, artefactError.message);
    }
    
    console.log(`[PLAN_EXECUTOR] ${summary}`);
    
    return {
      success: true,
      stepsCompleted,
      totalSteps: steps.length
    };
    
  } catch (error: any) {
    const errorMessage = error.message || 'Plan execution failed unexpectedly';
    console.error(`[PLAN_EXECUTOR] Plan execution error:`, errorMessage);
    
    await logPlanFailed(userId, planId, errorMessage, conversationId, clientRequestId);
    failProgress(planId, errorMessage);
    await safeUpdatePlanStatus(planId, 'failed');
    
    return {
      success: false,
      stepsCompleted,
      totalSteps: steps.length,
      error: errorMessage
    };
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
