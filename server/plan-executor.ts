/**
 * Plan Executor - Core execution loop for lead generation plans
 */

import { storage } from './storage';
import { updateStepStatus, completePlan, failPlan } from './plan-progress';
import type { LeadGenPlan, LeadGenPlanStep } from './types/lead-gen-plan';

/**
 * Stub function that simulates step execution
 * In production, this would call actual tools (Google Places, Hunter.io, etc.)
 */
async function runStepStub(step: LeadGenPlanStep, stepIndex: number): Promise<string> {
  console.log(`PLAN_EXEC_STUB: starting step ${stepIndex + 1}:`, step.title || step.label || step.tool);
  
  // Simulate work with 1-2 second delay
  const delayMs = 1000 + Math.random() * 1000;
  await new Promise(res => setTimeout(res, delayMs));
  
  console.log(`PLAN_EXEC_STUB: completed step ${stepIndex + 1}`);
  return "success";
}

/**
 * Execute a lead generation plan - loops through steps and runs them
 */
export async function executeLeadGenerationPlan(planId: string): Promise<void> {
  console.log(`PLAN_EXEC_START: Beginning execution for plan ${planId}`);
  
  try {
    // Load plan from database
    const dbPlan = await storage.getPlan(planId);
    if (!dbPlan) {
      throw new Error(`Plan ${planId} not found`);
    }

    const plan = dbPlan.planData as LeadGenPlan;
    console.log(`PLAN_EXEC_START: Loaded plan with ${plan.steps.length} steps`);

    // Execute each step in sequence
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      
      console.log(`PLAN_EXEC_STEP_RUNNING: Step ${i + 1}/${plan.steps.length} - ${step.title || step.label || step.tool}`);
      
      // Update progress to "running"
      updateStepStatus(planId, step.id, "running");
      
      try {
        // Run the step (stub implementation)
        await runStepStub(step, i);
        
        // Update progress to "completed"
        updateStepStatus(planId, step.id, "completed");
        console.log(`PLAN_EXEC_STEP_COMPLETED: Step ${i + 1}/${plan.steps.length} - ${step.title || step.label || step.tool}`);
      } catch (stepError: any) {
        console.error(`PLAN_EXEC_STEP_FAILED: Step ${i + 1} failed:`, stepError.message);
        updateStepStatus(planId, step.id, "failed", stepError.message);
        throw stepError; // Fail the whole plan if a step fails
      }
    }

    // Mark plan as complete
    completePlan(planId);
    await storage.updatePlanStatus(planId, "completed");
    console.log(`PLAN_EXEC_COMPLETE: Plan ${planId} finished successfully`);

  } catch (error: any) {
    console.error(`PLAN_EXEC_FAILED: Plan ${planId} execution failed:`, error.message);
    failPlan(planId, error.message);
    await storage.updatePlanStatus(planId, "failed");
    throw error;
  }
}

/**
 * Start plan execution in the background (fire-and-forget)
 */
export function startPlanExecution(planId: string): void {
  console.log(`Starting background execution for plan ${planId}`);
  
  // Execute in background without awaiting
  executeLeadGenerationPlan(planId).catch(err => {
    console.error(`Background execution error for plan ${planId}:`, err);
  });
}
