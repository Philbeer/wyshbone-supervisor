/**
 * Plan Executor - Core execution loop for Supervisor
 * 
 * Iterates steps sequentially, logs AFR events, and calls action executor.
 * Session 1 scope: No retries, stop on first failure.
 * Session 3: Agentic decision loop – calls Tower Judgement API after each step.
 *            Persists plan status and progress to the same stores the UI reads.
 */

import type { Plan } from './types/plan';
import { executeStep } from './action-executor';
import {
  logPlanStarted,
  logStepStarted,
  logStepCompleted,
  logStepFailed,
  logPlanCompleted,
  logPlanFailed
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
  const { planId, userId, conversationId, clientRequestId, goal, steps, toolMetadata } = plan;
  
  console.log(`[PLAN_EXECUTOR] Starting execution of plan ${planId}`);
  console.log(`[PLAN_EXECUTOR] Goal: ${goal}`);
  console.log(`[PLAN_EXECUTOR] Steps: ${steps.length}`);
  if (clientRequestId) console.log(`[PLAN_EXECUTOR] clientRequestId: ${clientRequestId}`);
  
  await logPlanStarted(userId, planId, goal, conversationId, clientRequestId);
  await safeUpdatePlanStatus(planId, 'executing');
  
  let stepsCompleted = 0;

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
        const result = await executeStep(step, toolMetadata, userId);
        
        if (!result.success) {
          console.error(`[PLAN_EXECUTOR] Step ${step.id} failed:`, result.error);
          await logStepFailed(userId, planId, step.id, step.label, result.error || 'Unknown error', conversationId, clientRequestId);
          updateStepStatus(planId, step.id, 'failed', result.error);

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

      // ----- Tower Judgement: after each step -----
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
    
    const summary = `Plan completed successfully - ${stepsCompleted}/${steps.length} steps`;
    await logPlanCompleted(userId, planId, summary, conversationId, clientRequestId);
    completeProgress(planId);
    await safeUpdatePlanStatus(planId, 'completed');
    
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
