/**
 * Tower (Control Tower) Logging Integration
 * 
 * Logs plan executions to Tower via HTTP POST.
 * Configure with TOWER_URL and TOWER_API_KEY environment variables.
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
 * Check if Tower logging is enabled
 */
function isTowerLoggingEnabled(): boolean {
  return !!(process.env.TOWER_URL && (process.env.TOWER_API_KEY || process.env.EXPORT_KEY));
}

/**
 * Send a log entry to Tower via HTTP POST
 */
async function sendToTower(log: TowerRunLog): Promise<void> {
  const towerUrl = process.env.TOWER_URL;
  const apiKey = process.env.TOWER_API_KEY || process.env.EXPORT_KEY;

  if (!towerUrl || !apiKey) {
    // Fallback to console logging if Tower is not configured
    console.log(`[TOWER_LOG] ${JSON.stringify(log)}`);
    return;
  }

  const endpoint = `${towerUrl.replace(/\/$/, '')}/tower/runs/log`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TOWER-API-KEY': apiKey,
      },
      body: JSON.stringify({
        runId: log.runId,
        source: 'supervisor',
        userId: log.userId,
        status: log.status === 'running' ? 'started' : log.status,
        request: log.request,
        response: log.response,
        meta: {
          ...log.metadata,
          accountId: log.accountId,
          originalSource: log.source,
          error: log.error,
        },
      }),
    });

    if (!response.ok) {
      console.warn(`[Tower] Failed to log run ${log.runId}: HTTP ${response.status}`);
    } else {
      console.log(`[Tower] Logged run ${log.runId} (${log.status})`);
    }
  } catch (error) {
    console.warn(`[Tower] Failed to log run ${log.runId}:`, error instanceof Error ? error.message : error);
    // Fallback to console logging
    console.log(`[TOWER_LOG] ${JSON.stringify(log)}`);
  }
}

/**
 * Log a plan execution to Tower
 */
export async function logPlanExecutionToTower(params: {
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
}): Promise<void> {
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

  // Send to Tower via HTTP (or fallback to console.log)
  await sendToTower(log);
}

/**
 * Log the start of a plan execution
 */
export async function logPlanStart(planId: string, userId: string, accountId: string | undefined, goal: string): Promise<void> {
  await logPlanExecutionToTower({
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
export async function logPlanComplete(
  planId: string,
  userId: string,
  accountId: string | undefined,
  goal: string,
  status: 'success' | 'failed' | 'partial',
  stepsSummary: { total: number; succeeded: number; failed: number; skipped: number },
  duration: number,
  error?: string
): Promise<void> {
  await logPlanExecutionToTower({
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

/**
 * Export the check function for external use
 */
export { isTowerLoggingEnabled };
