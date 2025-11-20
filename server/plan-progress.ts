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

// In-memory progress store keyed by sessionId
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

  progressStore.set(sessionId, progress);
  console.log(`[PROGRESS] Started tracking for plan ${planId} (session: ${sessionId})`);
  
  return progress;
}

/**
 * Update the status of a specific step
 */
export function updateStepStatus(
  sessionId: string,
  stepId: string,
  status: "running" | "completed" | "failed",
  errorMessage?: string,
  attempts?: number
): PlanProgress | null {
  const progress = progressStore.get(sessionId);
  if (!progress) {
    console.warn(`[PROGRESS] No progress found for session ${sessionId}`);
    return null;
  }

  const stepIndex = progress.steps.findIndex(s => s.stepId === stepId);
  if (stepIndex === -1) {
    console.warn(`[PROGRESS] Step ${stepId} not found in progress for session ${sessionId}`);
    return progress;
  }

  progress.steps[stepIndex].status = status;
  progress.steps[stepIndex].errorMessage = errorMessage;
  progress.steps[stepIndex].attempts = attempts;
  
  if (status === "running") {
    progress.currentStepIndex = stepIndex;
  }

  progress.updatedAt = new Date().toISOString();
  
  console.log(`[PROGRESS] ${sessionId} - Step ${stepIndex + 1}/${progress.steps.length}: ${stepId} → ${status}`);
  
  return progress;
}

/**
 * Mark plan as completed successfully
 */
export function completePlan(sessionId: string): PlanProgress | null {
  const progress = progressStore.get(sessionId);
  if (!progress) {
    return null;
  }

  progress.overallStatus = "completed";
  progress.updatedAt = new Date().toISOString();
  
  console.log(`[PROGRESS] Plan ${progress.planId} completed successfully`);
  
  return progress;
}

/**
 * Mark plan as failed
 */
export function failPlan(sessionId: string, errorMessage?: string): PlanProgress | null {
  const progress = progressStore.get(sessionId);
  if (!progress) {
    return null;
  }

  progress.overallStatus = "failed";
  progress.updatedAt = new Date().toISOString();
  
  console.log(`[PROGRESS] Plan ${progress.planId} failed: ${errorMessage || 'Unknown error'}`);
  
  return progress;
}

/**
 * Get current progress for a session
 */
export function getProgress(sessionId: string): PlanProgress | null {
  return progressStore.get(sessionId) || null;
}

/**
 * Clear progress for a session (cleanup after completion/failure)
 */
export function clearProgress(sessionId: string): void {
  progressStore.delete(sessionId);
  console.log(`[PROGRESS] Cleared progress for session ${sessionId}`);
}

/**
 * Get all active sessions (for debugging)
 */
export function getAllActiveSessions(): string[] {
  return Array.from(progressStore.keys());
}
