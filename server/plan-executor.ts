/**
 * Plan Executor - Core execution loop for lead generation plans
 */

import { storage } from './storage';
import { updateStepStatus, completePlan, failPlan } from './plan-progress';
import type { LeadGenPlan, LeadGenPlanStep } from './types/lead-gen-plan';
import { executeAction, type ActionType, type ActionInput } from './actions/registry';

/**
 * Map legacy tool identifiers to canonical action types
 */
function mapToolToActionType(tool: string): ActionType | null {
  const mapping: Record<string, ActionType> = {
    'GOOGLE_PLACES_SEARCH': 'GLOBAL_DB',
    'HUNTER_DOMAIN_LOOKUP': 'EMAIL_FINDER',
    'HUNTER_ENRICH': 'EMAIL_FINDER',
    'EMAIL_SEQUENCE_SETUP': 'EMAIL_FINDER',
    'LEAD_LIST_SAVE': 'GLOBAL_DB',
    'MONITOR_SETUP': 'SCHEDULED_MONITOR'
  };
  
  return mapping[tool] || null;
}

/**
 * Convert legacy step parameters to action input
 */
function convertStepToActionInput(step: LeadGenPlanStep, userId: string): ActionInput {
  // If step has explicit input, use it
  if (step.input) {
    return { ...step.input, userId };
  }

  // Otherwise convert legacy params to input based on tool type
  const params = step.params || {};
  
  switch (step.tool) {
    case 'GOOGLE_PLACES_SEARCH':
      return {
        query: (params as any).query || 'businesses',
        region: (params as any).region || 'UK',
        country: (params as any).country || 'UK',
        maxResults: (params as any).maxResults || 10,
        userId
      };
    
    case 'HUNTER_DOMAIN_LOOKUP':
    case 'HUNTER_ENRICH':
      return {
        leads: [], // Will be populated from previous step results
        userId
      };
    
    case 'MONITOR_SETUP':
      return {
        label: step.label || 'Automated Monitor',
        description: step.note || 'Monitor created by Supervisor',
        monitorType: 'lead_generation',
        userId
      };
    
    default:
      return { ...params, userId };
  }
}

/**
 * Execute a single plan step using the action registry
 */
async function executeStep(
  step: LeadGenPlanStep,
  stepIndex: number,
  userId: string
): Promise<void> {
  console.log(`[PLAN_EXEC] Executing step ${stepIndex + 1}: ${step.label || step.tool}`);
  
  // Determine action type (explicit or mapped from legacy tool)
  const actionType = step.type || mapToolToActionType(step.tool);
  
  if (!actionType) {
    throw new Error(`Unknown action type for tool: ${step.tool}`);
  }

  // Prepare action input
  const input = convertStepToActionInput(step, userId);
  
  console.log(`[PLAN_EXEC] Action type: ${actionType}`);
  
  // Execute the action using the registry
  const result = await executeAction(actionType, input);
  
  // Store result in step (this will be saved to progress)
  step.status = result.success ? 'completed' : 'failed';
  step.result = result;
  
  if (!result.success) {
    throw new Error(result.error || 'Action failed');
  }
  
  console.log(`[PLAN_EXEC] Step completed: ${result.summary}`);
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
    const userId = dbPlan.userId;
    console.log(`PLAN_EXEC_START: Loaded plan with ${plan.steps.length} steps for user ${userId}`);

    // Track results from previous steps to pass to next steps
    const stepResults = new Map<string, any>();

    // Execute each step in sequence
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      
      console.log(`PLAN_EXEC_STEP_RUNNING: Step ${i + 1}/${plan.steps.length} - ${step.label || step.tool}`);
      
      // Update progress to "running"
      updateStepStatus(planId, step.id, "running");
      
      try {
        // Inject results from dependency steps
        if (step.dependsOn && step.dependsOn.length > 0) {
          const dependencyResults = step.dependsOn
            .map(depId => stepResults.get(depId))
            .filter(Boolean);
          
          // If this is an EMAIL_FINDER step, inject leads from previous steps
          if (step.type === 'EMAIL_FINDER' && step.input) {
            const allLeads = dependencyResults
              .flatMap(result => result.data?.leads || []);
            step.input.leads = allLeads;
            console.log(`[PLAN_EXEC] Injected ${allLeads.length} leads from previous steps`);
          }
        }
        
        // Execute the real action
        await executeStep(step, i, userId);
        
        // Store results for downstream steps
        if (step.result?.data) {
          stepResults.set(step.id, step.result);
        }
        
        // Update progress to "completed" with result summary
        const summary = step.result?.summary || 'Step completed';
        updateStepStatus(planId, step.id, "completed", summary);
        console.log(`PLAN_EXEC_STEP_COMPLETED: Step ${i + 1}/${plan.steps.length} - ${summary}`);
        
        // Update the plan in database with step results
        plan.steps[i] = step;
        await storage.updatePlan(planId, { planData: plan as any });
        
      } catch (stepError: any) {
        const errorMsg = stepError.message || 'Step execution failed';
        console.error(`PLAN_EXEC_STEP_FAILED: Step ${i + 1} failed:`, errorMsg);
        updateStepStatus(planId, step.id, "failed", errorMsg);
        
        // Update the plan with failure
        step.status = 'failed';
        step.result = {
          success: false,
          summary: errorMsg,
          error: errorMsg
        };
        plan.steps[i] = step;
        await storage.updatePlan(planId, { planData: plan as any });
        
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
