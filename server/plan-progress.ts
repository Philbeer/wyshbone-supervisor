/**
 * Plan Progress Tracking Module
 * 
 * Tracks real-time progress of lead generation plan execution.
 * Progress is stored in-memory, keyed by sessionId.
 */

export interface PlanStepProgress {
  stepId: string;
  title: string;
  index: number;
  totalSteps: number;
  status: "pending" | "running" | "completed" | "failed";
  errorMessage?: string;
  attempts?: number;
}

export interface PlanProgress {
  planId: string;
  sessionId: string;
  overallStatus: "pending" | "executing" | "completed" | "failed";
  currentStepIndex: number;
  steps: PlanStepProgress[];
  updatedAt: string;
}

// In-memory progress store keyed by planId
const progressStore = new Map<string, PlanProgress>();

/**
 * Initialize progress tracking for a new plan execution
 */
export function startPlanProgress(
  planId: string,
  sessionId: string,
  steps: Array<{ id: string; title?: string; label?: string }>
): PlanProgress {
  const progress: PlanProgress = {
    planId,
    sessionId,
    overallStatus: "executing",
    currentStepIndex: 0,
    steps: steps.map((step, index) => ({
      stepId: step.id,
      title: step.title || step.label || `Step ${index + 1}`,
      index,
      totalSteps: steps.length,
      status: "pending",
    })),
    updatedAt: new Date().toISOString(),
  };

  progressStore.set(planId, progress);
  console.log(`[PROGRESS] Started tracking for plan ${planId} (session: ${sessionId})`);
  
  return progress;
}

/**
 * Update the status of a specific step
 */
export function updateStepStatus(
  planId: string,
  stepId: string,
  status: "running" | "completed" | "failed",
  errorMessage?: string,
  attempts?: number
): PlanProgress | null {
  const progress = progressStore.get(planId);
  if (!progress) {
    console.warn(`[PROGRESS] No progress found for plan ${planId}`);
    return null;
  }

  const stepIndex = progress.steps.findIndex(s => s.stepId === stepId);
  if (stepIndex === -1) {
    console.warn(`[PROGRESS] Step ${stepId} not found in progress for plan ${planId}`);
    return progress;
  }

  progress.steps[stepIndex].status = status;
  progress.steps[stepIndex].errorMessage = errorMessage;
  progress.steps[stepIndex].attempts = attempts;
  
  if (status === "running") {
    progress.currentStepIndex = stepIndex;
  }

  progress.updatedAt = new Date().toISOString();
  
  console.log(`[PROGRESS] Plan ${planId} - Step ${stepIndex + 1}/${progress.steps.length}: ${stepId} → ${status}`);
  
  return progress;
}

/**
 * Mark plan as completed successfully
 */
export function completePlan(planId: string): PlanProgress | null {
  const progress = progressStore.get(planId);
  if (!progress) {
    return null;
  }

  progress.overallStatus = "completed";
  progress.updatedAt = new Date().toISOString();
  
  console.log(`[PROGRESS] Plan ${planId} completed successfully`);
  
  return progress;
}

/**
 * Mark plan as failed
 */
export function failPlan(planId: string, errorMessage?: string): PlanProgress | null {
  const progress = progressStore.get(planId);
  if (!progress) {
    return null;
  }

  progress.overallStatus = "failed";
  progress.updatedAt = new Date().toISOString();
  
  console.log(`[PROGRESS] Plan ${planId} failed: ${errorMessage || 'Unknown error'}`);
  
  return progress;
}

/**
 * Get current progress for a plan
 */
export function getProgress(planId: string): PlanProgress | null {
  return progressStore.get(planId) || null;
}

/**
 * Get progress for a specific user's most recent plan
 */
export function getUserProgress(sessionId: string): PlanProgress | null {
  // Find the most recent progress entry for this sessionId
  let latestProgress: PlanProgress | null = null;
  let latestDate = new Date(0);

  for (const progress of progressStore.values()) {
    if (progress.sessionId === sessionId) {
      const progressDate = new Date(progress.updatedAt);
      if (progressDate > latestDate) {
        latestDate = progressDate;
        latestProgress = progress;
      }
    }
  }

  return latestProgress;
}

/**
 * Clear progress for a plan (cleanup after completion/failure)
 */
export function clearProgress(planId: string): void {
  progressStore.delete(planId);
  console.log(`[PROGRESS] Cleared progress for plan ${planId}`);
}

/**
 * Get all active plan IDs (for debugging)
 */
export function getAllActivePlans(): string[] {
  return Array.from(progressStore.keys());
}
