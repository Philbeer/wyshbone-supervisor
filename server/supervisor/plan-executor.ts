/**
 * Plan Executor - Core execution loop for Supervisor
 * 
 * Iterates steps sequentially, logs AFR events, and calls action executor.
 * Session 1 scope: No retries, stop on first failure.
 * Session 3: Agentic decision loop – calls Tower Judgement API after each step.
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

export interface PlanExecutionResult {
  success: boolean;
  stepsCompleted: number;
  totalSteps: number;
  error?: string;
  haltedByJudgement?: boolean;
  haltReason?: string;
}

export async function executePlan(plan: Plan): Promise<PlanExecutionResult> {
  const { planId, userId, conversationId, goal, steps, toolMetadata } = plan;
  
  console.log(`[PLAN_EXECUTOR] Starting execution of plan ${planId}`);
  console.log(`[PLAN_EXECUTOR] Goal: ${goal}`);
  console.log(`[PLAN_EXECUTOR] Steps: ${steps.length}`);
  
  await logPlanStarted(userId, planId, goal, conversationId);
  
  let stepsCompleted = 0;

  const missionType = 'leadgen';
  const successCriteria: TowerSuccessCriteria = { ...LEADGEN_SUCCESS_DEFAULTS };
  const runSummary = createRunSummary();
  
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      
      console.log(`[PLAN_EXECUTOR] Step ${i + 1}/${steps.length}: ${step.label}`);
      
      await logStepStarted(userId, planId, step.id, step.label, conversationId);
      
      try {
        const result = await executeStep(step, toolMetadata, userId);
        
        if (!result.success) {
          console.error(`[PLAN_EXECUTOR] Step ${step.id} failed:`, result.error);
          await logStepFailed(userId, planId, step.id, step.label, result.error || 'Unknown error', conversationId);

          updateRunSummary(runSummary, {
            success: false,
            leadsFound: 0,
            costUnits: 0.25,
          });

          await logPlanFailed(userId, planId, result.error || 'Step execution failed', conversationId);
          
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

        await logStepCompleted(userId, planId, step.id, step.label, result.summary, conversationId);
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
        
        await logStepFailed(userId, planId, step.id, step.label, errorMessage, conversationId);
        await logPlanFailed(userId, planId, errorMessage, conversationId);
        
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
    await logPlanCompleted(userId, planId, summary, conversationId);
    
    console.log(`[PLAN_EXECUTOR] ${summary}`);
    
    return {
      success: true,
      stepsCompleted,
      totalSteps: steps.length
    };
    
  } catch (error: any) {
    const errorMessage = error.message || 'Plan execution failed unexpectedly';
    console.error(`[PLAN_EXECUTOR] Plan execution error:`, errorMessage);
    
    await logPlanFailed(userId, planId, errorMessage, conversationId);
    
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
