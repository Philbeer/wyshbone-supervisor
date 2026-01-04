/**
 * DAG Mutation Engine
 *
 * Dynamically modifies execution graphs (DAGs) at runtime while maintaining
 * dependency constraints and validity. Tracks all mutations for audit trail.
 *
 * Key Features:
 * - Add/remove/modify nodes in execution DAG
 * - Validate acyclic property and dependencies
 * - Track mutation history
 * - Integration with replanning
 */

import { storage } from './storage';
import type { LeadGenPlan, LeadGenPlanStep } from './types/lead-gen-plan';

// ========================================
// TYPES
// ========================================

export type MutationType =
  | 'ADD_STEP'
  | 'REMOVE_STEP'
  | 'MODIFY_DEPENDENCIES'
  | 'REPLACE_STEP'
  | 'REORDER_STEPS';

export interface DAGMutation {
  id: string;
  planId: string;
  type: MutationType;
  timestamp: number;
  before: any; // Snapshot before mutation
  after: any; // Snapshot after mutation
  reason?: string; // Why this mutation was made
  automatic: boolean; // Was this automatic (e.g., replanning) or manual?
}

export interface MutationResult {
  success: boolean;
  mutationId?: string;
  error?: string;
  warnings?: string[];
}

export interface DAGValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ========================================
// MUTATION HISTORY STORAGE
// ========================================

const mutationHistory = new Map<string, DAGMutation[]>();

/**
 * Store a mutation in history
 */
function recordMutation(mutation: DAGMutation): void {
  if (!mutationHistory.has(mutation.planId)) {
    mutationHistory.set(mutation.planId, []);
  }
  mutationHistory.get(mutation.planId)!.push(mutation);
  console.log(`[DAG_MUTATOR] Recorded mutation ${mutation.id} for plan ${mutation.planId}`);
}

/**
 * Get mutation history for a plan
 */
export function getMutationHistory(planId: string): DAGMutation[] {
  return mutationHistory.get(planId) || [];
}

/**
 * Clear mutation history for a plan
 */
export function clearMutationHistory(planId: string): void {
  mutationHistory.delete(planId);
}

// ========================================
// DAG VALIDATION
// ========================================

/**
 * Validate that a plan forms a valid DAG (Directed Acyclic Graph)
 */
export function validateDAG(plan: LeadGenPlan): DAGValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Check that all steps have unique IDs
  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    if (stepIds.has(step.id)) {
      errors.push(`Duplicate step ID: ${step.id}`);
    }
    stepIds.add(step.id);
  }

  // 2. Check that all dependencies exist
  for (const step of plan.steps) {
    if (step.dependsOn) {
      for (const depId of step.dependsOn) {
        if (!stepIds.has(depId)) {
          errors.push(`Step ${step.id} depends on non-existent step: ${depId}`);
        }
      }
    }
  }

  // 3. Check for cycles using DFS
  const hasCycle = detectCycle(plan);
  if (hasCycle) {
    errors.push('Plan contains a cycle - execution would deadlock');
  }

  // 4. Check for unreachable steps (no path from root)
  const unreachableSteps = findUnreachableSteps(plan);
  if (unreachableSteps.length > 0) {
    warnings.push(`Steps are unreachable: ${unreachableSteps.join(', ')}`);
  }

  // 5. Check for steps with no dependencies and no dependents (orphaned)
  const orphanedSteps = findOrphanedSteps(plan);
  if (orphanedSteps.length > 1) { // More than one root is suspicious
    warnings.push(`Multiple root steps found: ${orphanedSteps.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Detect if the DAG contains a cycle using DFS
 */
function detectCycle(plan: LeadGenPlan): boolean {
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(stepId: string): boolean {
    if (recStack.has(stepId)) {
      return true; // Cycle detected
    }

    if (visited.has(stepId)) {
      return false; // Already fully explored
    }

    visited.add(stepId);
    recStack.add(stepId);

    // Find step and check its dependencies
    const step = plan.steps.find(s => s.id === stepId);
    if (step && step.dependsOn) {
      for (const depId of step.dependsOn) {
        if (dfs(depId)) {
          return true;
        }
      }
    }

    recStack.delete(stepId);
    return false;
  }

  // Check from each step
  for (const step of plan.steps) {
    if (dfs(step.id)) {
      return true;
    }
  }

  return false;
}

/**
 * Find steps that have no path from any root step
 */
function findUnreachableSteps(plan: LeadGenPlan): string[] {
  // Build reverse dependency graph (who depends on each step)
  const dependents = new Map<string, Set<string>>();
  for (const step of plan.steps) {
    if (!dependents.has(step.id)) {
      dependents.set(step.id, new Set());
    }
    if (step.dependsOn) {
      for (const depId of step.dependsOn) {
        if (!dependents.has(depId)) {
          dependents.set(depId, new Set());
        }
        dependents.get(depId)!.add(step.id);
      }
    }
  }

  // Find root steps (no dependencies)
  const roots = plan.steps.filter(s => !s.dependsOn || s.dependsOn.length === 0);

  // BFS from roots to find all reachable steps
  const reachable = new Set<string>();
  const queue = [...roots.map(r => r.id)];

  while (queue.length > 0) {
    const stepId = queue.shift()!;
    if (reachable.has(stepId)) continue;

    reachable.add(stepId);

    // Add all steps that depend on this one
    const deps = dependents.get(stepId);
    if (deps) {
      queue.push(...deps);
    }
  }

  // Return steps that are not reachable
  return plan.steps
    .filter(s => !reachable.has(s.id))
    .map(s => s.id);
}

/**
 * Find orphaned steps (no dependencies and no dependents)
 */
function findOrphanedSteps(plan: LeadGenPlan): string[] {
  // Find steps with no dependencies (potential roots)
  const roots = plan.steps.filter(s => !s.dependsOn || s.dependsOn.length === 0);

  // For each root, check if any other step depends on it
  const orphans: string[] = [];
  for (const root of roots) {
    const hasDependent = plan.steps.some(s =>
      s.dependsOn && s.dependsOn.includes(root.id)
    );
    if (!hasDependent && plan.steps.length > 1) {
      orphans.push(root.id);
    }
  }

  return orphans;
}

// ========================================
// MUTATION OPERATIONS
// ========================================

/**
 * Add a new step to the plan
 *
 * @param planId - ID of the plan to mutate
 * @param newStep - Step to add
 * @param options - Options for adding the step
 */
export async function addStep(
  planId: string,
  newStep: LeadGenPlanStep,
  options: {
    insertAfter?: string; // Insert after this step ID
    insertBefore?: string; // Insert before this step ID
    reason?: string;
    automatic?: boolean;
  } = {}
): Promise<MutationResult> {
  try {
    console.log(`[DAG_MUTATOR] Adding step ${newStep.id} to plan ${planId}`);

    // Load plan
    const dbPlan = await storage.getPlan(planId);
    if (!dbPlan) {
      return { success: false, error: 'Plan not found' };
    }

    const plan = dbPlan.planData as LeadGenPlan;
    const before = JSON.parse(JSON.stringify(plan)); // Deep copy for history

    // Check if step ID already exists
    if (plan.steps.some(s => s.id === newStep.id)) {
      return { success: false, error: `Step with ID ${newStep.id} already exists` };
    }

    // Determine insertion position
    let insertIndex = plan.steps.length; // Default: append to end

    if (options.insertAfter) {
      const afterIndex = plan.steps.findIndex(s => s.id === options.insertAfter);
      if (afterIndex === -1) {
        return { success: false, error: `Step ${options.insertAfter} not found` };
      }
      insertIndex = afterIndex + 1;
    } else if (options.insertBefore) {
      const beforeIndex = plan.steps.findIndex(s => s.id === options.insertBefore);
      if (beforeIndex === -1) {
        return { success: false, error: `Step ${options.insertBefore} not found` };
      }
      insertIndex = beforeIndex;
    }

    // Insert step
    plan.steps.splice(insertIndex, 0, newStep);

    // Validate DAG
    const validation = validateDAG(plan);
    if (!validation.valid) {
      return {
        success: false,
        error: `DAG validation failed: ${validation.errors.join(', ')}`
      };
    }

    // Save updated plan
    await storage.updatePlan(planId, { planData: plan as any });

    // Record mutation
    const mutation: DAGMutation = {
      id: `mut_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      planId,
      type: 'ADD_STEP',
      timestamp: Date.now(),
      before,
      after: JSON.parse(JSON.stringify(plan)),
      reason: options.reason,
      automatic: options.automatic || false
    };
    recordMutation(mutation);

    console.log(`[DAG_MUTATOR] Successfully added step ${newStep.id}`);

    return {
      success: true,
      mutationId: mutation.id,
      warnings: validation.warnings
    };

  } catch (error: any) {
    console.error('[DAG_MUTATOR] Error adding step:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Remove a step from the plan
 */
export async function removeStep(
  planId: string,
  stepId: string,
  options: {
    reason?: string;
    automatic?: boolean;
    updateDependencies?: boolean; // Whether to update steps that depend on this one
  } = {}
): Promise<MutationResult> {
  try {
    console.log(`[DAG_MUTATOR] Removing step ${stepId} from plan ${planId}`);

    // Load plan
    const dbPlan = await storage.getPlan(planId);
    if (!dbPlan) {
      return { success: false, error: 'Plan not found' };
    }

    const plan = dbPlan.planData as LeadGenPlan;
    const before = JSON.parse(JSON.stringify(plan));

    // Check if step exists
    const stepIndex = plan.steps.findIndex(s => s.id === stepId);
    if (stepIndex === -1) {
      return { success: false, error: `Step ${stepId} not found` };
    }

    const removedStep = plan.steps[stepIndex];

    // Check if any other steps depend on this one
    const dependentSteps = plan.steps.filter(s =>
      s.dependsOn && s.dependsOn.includes(stepId)
    );

    if (dependentSteps.length > 0 && !options.updateDependencies) {
      return {
        success: false,
        error: `Cannot remove step ${stepId}: steps ${dependentSteps.map(s => s.id).join(', ')} depend on it`
      };
    }

    // Remove step
    plan.steps.splice(stepIndex, 1);

    // Update dependent steps if requested
    if (options.updateDependencies && dependentSteps.length > 0) {
      for (const depStep of dependentSteps) {
        if (depStep.dependsOn) {
          // Remove this step from dependencies
          depStep.dependsOn = depStep.dependsOn.filter(id => id !== stepId);

          // Add dependencies of removed step to this step (bridge the gap)
          if (removedStep.dependsOn) {
            depStep.dependsOn.push(...removedStep.dependsOn.filter(
              id => !depStep.dependsOn!.includes(id)
            ));
          }
        }
      }
    }

    // Validate DAG
    const validation = validateDAG(plan);
    if (!validation.valid) {
      return {
        success: false,
        error: `DAG validation failed: ${validation.errors.join(', ')}`
      };
    }

    // Save updated plan
    await storage.updatePlan(planId, { planData: plan as any });

    // Record mutation
    const mutation: DAGMutation = {
      id: `mut_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      planId,
      type: 'REMOVE_STEP',
      timestamp: Date.now(),
      before,
      after: JSON.parse(JSON.stringify(plan)),
      reason: options.reason,
      automatic: options.automatic || false
    };
    recordMutation(mutation);

    console.log(`[DAG_MUTATOR] Successfully removed step ${stepId}`);

    return {
      success: true,
      mutationId: mutation.id,
      warnings: validation.warnings
    };

  } catch (error: any) {
    console.error('[DAG_MUTATOR] Error removing step:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Modify dependencies of a step
 */
export async function modifyStepDependencies(
  planId: string,
  stepId: string,
  newDependencies: string[],
  options: {
    reason?: string;
    automatic?: boolean;
  } = {}
): Promise<MutationResult> {
  try {
    console.log(`[DAG_MUTATOR] Modifying dependencies of step ${stepId} in plan ${planId}`);

    // Load plan
    const dbPlan = await storage.getPlan(planId);
    if (!dbPlan) {
      return { success: false, error: 'Plan not found' };
    }

    const plan = dbPlan.planData as LeadGenPlan;
    const before = JSON.parse(JSON.stringify(plan));

    // Find step
    const step = plan.steps.find(s => s.id === stepId);
    if (!step) {
      return { success: false, error: `Step ${stepId} not found` };
    }

    // Check that all new dependencies exist
    for (const depId of newDependencies) {
      if (!plan.steps.some(s => s.id === depId)) {
        return {
          success: false,
          error: `Dependency step ${depId} not found`
        };
      }
    }

    // Update dependencies
    step.dependsOn = newDependencies.length > 0 ? newDependencies : undefined;

    // Validate DAG (especially for cycles)
    const validation = validateDAG(plan);
    if (!validation.valid) {
      return {
        success: false,
        error: `DAG validation failed: ${validation.errors.join(', ')}`
      };
    }

    // Save updated plan
    await storage.updatePlan(planId, { planData: plan as any });

    // Record mutation
    const mutation: DAGMutation = {
      id: `mut_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      planId,
      type: 'MODIFY_DEPENDENCIES',
      timestamp: Date.now(),
      before,
      after: JSON.parse(JSON.stringify(plan)),
      reason: options.reason,
      automatic: options.automatic || false
    };
    recordMutation(mutation);

    console.log(`[DAG_MUTATOR] Successfully modified dependencies of step ${stepId}`);

    return {
      success: true,
      mutationId: mutation.id,
      warnings: validation.warnings
    };

  } catch (error: any) {
    console.error('[DAG_MUTATOR] Error modifying dependencies:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Replace a step with a new one (keeping same ID and position)
 */
export async function replaceStep(
  planId: string,
  stepId: string,
  newStep: LeadGenPlanStep,
  options: {
    reason?: string;
    automatic?: boolean;
  } = {}
): Promise<MutationResult> {
  try {
    console.log(`[DAG_MUTATOR] Replacing step ${stepId} in plan ${planId}`);

    // Load plan
    const dbPlan = await storage.getPlan(planId);
    if (!dbPlan) {
      return { success: false, error: 'Plan not found' };
    }

    const plan = dbPlan.planData as LeadGenPlan;
    const before = JSON.parse(JSON.stringify(plan));

    // Find step
    const stepIndex = plan.steps.findIndex(s => s.id === stepId);
    if (stepIndex === -1) {
      return { success: false, error: `Step ${stepId} not found` };
    }

    // Ensure new step has same ID
    if (newStep.id !== stepId) {
      return {
        success: false,
        error: 'New step must have same ID as step being replaced'
      };
    }

    // Replace step
    plan.steps[stepIndex] = newStep;

    // Validate DAG
    const validation = validateDAG(plan);
    if (!validation.valid) {
      return {
        success: false,
        error: `DAG validation failed: ${validation.errors.join(', ')}`
      };
    }

    // Save updated plan
    await storage.updatePlan(planId, { planData: plan as any });

    // Record mutation
    const mutation: DAGMutation = {
      id: `mut_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      planId,
      type: 'REPLACE_STEP',
      timestamp: Date.now(),
      before,
      after: JSON.parse(JSON.stringify(plan)),
      reason: options.reason,
      automatic: options.automatic || false
    };
    recordMutation(mutation);

    console.log(`[DAG_MUTATOR] Successfully replaced step ${stepId}`);

    return {
      success: true,
      mutationId: mutation.id,
      warnings: validation.warnings
    };

  } catch (error: any) {
    console.error('[DAG_MUTATOR] Error replacing step:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Reorder steps in the plan (maintaining dependencies)
 */
export async function reorderSteps(
  planId: string,
  newOrder: string[], // Array of step IDs in desired order
  options: {
    reason?: string;
    automatic?: boolean;
  } = {}
): Promise<MutationResult> {
  try {
    console.log(`[DAG_MUTATOR] Reordering steps in plan ${planId}`);

    // Load plan
    const dbPlan = await storage.getPlan(planId);
    if (!dbPlan) {
      return { success: false, error: 'Plan not found' };
    }

    const plan = dbPlan.planData as LeadGenPlan;
    const before = JSON.parse(JSON.stringify(plan));

    // Validate that newOrder contains all step IDs
    const currentIds = new Set(plan.steps.map(s => s.id));
    const newIds = new Set(newOrder);

    if (currentIds.size !== newIds.size) {
      return {
        success: false,
        error: 'New order must contain exactly the same steps as current plan'
      };
    }

    for (const id of currentIds) {
      if (!newIds.has(id)) {
        return {
          success: false,
          error: `Missing step ${id} in new order`
        };
      }
    }

    // Reorder steps
    const stepsMap = new Map(plan.steps.map(s => [s.id, s]));
    plan.steps = newOrder.map(id => stepsMap.get(id)!);

    // Validate DAG
    const validation = validateDAG(plan);
    if (!validation.valid) {
      return {
        success: false,
        error: `DAG validation failed: ${validation.errors.join(', ')}`
      };
    }

    // Save updated plan
    await storage.updatePlan(planId, { planData: plan as any });

    // Record mutation
    const mutation: DAGMutation = {
      id: `mut_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      planId,
      type: 'REORDER_STEPS',
      timestamp: Date.now(),
      before,
      after: JSON.parse(JSON.stringify(plan)),
      reason: options.reason,
      automatic: options.automatic || false
    };
    recordMutation(mutation);

    console.log(`[DAG_MUTATOR] Successfully reordered steps`);

    return {
      success: true,
      mutationId: mutation.id,
      warnings: validation.warnings
    };

  } catch (error: any) {
    console.error('[DAG_MUTATOR] Error reordering steps:', error);
    return { success: false, error: error.message };
  }
}

// ========================================
// BATCH MUTATIONS
// ========================================

/**
 * Apply multiple mutations atomically
 */
export async function applyMutations(
  planId: string,
  mutations: Array<{
    type: 'add' | 'remove' | 'modify_deps' | 'replace' | 'reorder';
    params: any;
  }>,
  options: {
    reason?: string;
    automatic?: boolean;
  } = {}
): Promise<MutationResult> {
  // TODO: Implement transactional mutations
  // For now, apply one by one (not atomic)
  const results: MutationResult[] = [];

  for (const mutation of mutations) {
    let result: MutationResult;

    switch (mutation.type) {
      case 'add':
        result = await addStep(planId, mutation.params.step, {
          ...mutation.params.options,
          reason: options.reason,
          automatic: options.automatic
        });
        break;

      case 'remove':
        result = await removeStep(planId, mutation.params.stepId, {
          ...mutation.params.options,
          reason: options.reason,
          automatic: options.automatic
        });
        break;

      case 'modify_deps':
        result = await modifyStepDependencies(
          planId,
          mutation.params.stepId,
          mutation.params.dependencies,
          {
            reason: options.reason,
            automatic: options.automatic
          }
        );
        break;

      case 'replace':
        result = await replaceStep(
          planId,
          mutation.params.stepId,
          mutation.params.newStep,
          {
            reason: options.reason,
            automatic: options.automatic
          }
        );
        break;

      case 'reorder':
        result = await reorderSteps(planId, mutation.params.newOrder, {
          reason: options.reason,
          automatic: options.automatic
        });
        break;

      default:
        result = { success: false, error: `Unknown mutation type: ${mutation.type}` };
    }

    results.push(result);

    if (!result.success) {
      // Rollback would go here in a transactional system
      return {
        success: false,
        error: `Batch mutation failed at step ${results.length}: ${result.error}`
      };
    }
  }

  return {
    success: true,
    mutationId: results[results.length - 1].mutationId
  };
}

// ========================================
// EXPORTS
// ========================================

export default {
  validateDAG,
  addStep,
  removeStep,
  modifyStepDependencies,
  replaceStep,
  reorderSteps,
  applyMutations,
  getMutationHistory,
  clearMutationHistory
};
