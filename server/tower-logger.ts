/**
 * Tower (Control Tower) Logging Integration
 * 
 * Logs plan executions in a structured format that can be picked up by Control Tower.
 * Uses console.log with a specific format that Tower can ingest.
 */

export interface TowerRunLog {
  source: string;
  userId: string;
  accountId?: string;
  runId: string;
  timestamp: string;
  status: 'running' | 'success' | 'failed' | 'partial';
  request: Record<string, any>;
  response?: Record<string, any>;
  error?: string;
  metadata?: Record<string, any>;
}

/**
 * Log a plan execution to Tower
 */
export function logPlanExecutionToTower(params: {
  planId: string;
  userId: string;
  accountId?: string;
  goal: string;
  status: 'running' | 'success' | 'failed' | 'partial';
  stepsSummary?: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
  duration?: number;
  error?: string;
}): void {
  const log: TowerRunLog = {
    source: 'plan_executor',
    userId: params.userId,
    accountId: params.accountId,
    runId: params.planId,
    timestamp: new Date().toISOString(),
    status: params.status,
    request: {
      goal: params.goal,
      planId: params.planId
    },
    metadata: {
      ...(params.stepsSummary && {
        totalSteps: params.stepsSummary.total,
        succeededSteps: params.stepsSummary.succeeded,
        failedSteps: params.stepsSummary.failed,
        skippedSteps: params.stepsSummary.skipped
      }),
      ...(params.duration && { durationSeconds: params.duration })
    }
  };

  if (params.error) {
    log.error = params.error;
  }

  // Log in a format that Tower can pick up
  console.log(`[TOWER_LOG] ${JSON.stringify(log)}`);
}

/**
 * Log the start of a plan execution
 */
export function logPlanStart(planId: string, userId: string, accountId: string | undefined, goal: string): void {
  logPlanExecutionToTower({
    planId,
    userId,
    accountId,
    goal,
    status: 'running'
  });
}

/**
 * Log the completion of a plan execution
 */
export function logPlanComplete(
  planId: string,
  userId: string,
  accountId: string | undefined,
  goal: string,
  status: 'success' | 'failed' | 'partial',
  stepsSummary: { total: number; succeeded: number; failed: number; skipped: number },
  duration: number,
  error?: string
): void {
  logPlanExecutionToTower({
    planId,
    userId,
    accountId,
    goal,
    status,
    stepsSummary,
    duration,
    error
  });
}
