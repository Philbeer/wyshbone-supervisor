/**
 * Canonical Action Registry
 * 
 * Defines the core capabilities that both Wyshbone-UI and Supervisor can execute.
 * Each action has a unique type and an executor function that performs the real work.
 */

export type ActionType = 
  | 'DEEP_RESEARCH'
  | 'GLOBAL_DB'
  | 'SCHEDULED_MONITOR'
  | 'EMAIL_FINDER';

export interface ActionInput {
  [key: string]: any;
}

export interface ActionResult {
  success: boolean;
  summary: string;
  data?: any;
  error?: string;
}

export type ActionExecutor = (input: ActionInput) => Promise<ActionResult>;

/**
 * Execute an action by type
 * 
 * Uses dynamic import to avoid circular dependencies
 */
export async function executeAction(type: ActionType, input: ActionInput): Promise<ActionResult> {
  try {
    console.log(`[ACTION_REGISTRY] Executing ${type} with input:`, JSON.stringify(input).substring(0, 200));
    
    // Dynamically import executors to avoid circular dependency
    const { executors } = await import('./executors');
    
    let executor: ActionExecutor;
    switch (type) {
      case 'DEEP_RESEARCH':
        executor = executors.runDeepResearch;
        break;
      case 'GLOBAL_DB':
        executor = executors.runGlobalDatabaseSearch;
        break;
      case 'SCHEDULED_MONITOR':
        executor = executors.createScheduledMonitor;
        break;
      case 'EMAIL_FINDER':
        executor = executors.runEmailFinderBatch;
        break;
      default:
        return {
          success: false,
          summary: `Unknown action type: ${type}`,
          error: `No executor found for action type: ${type}`
        };
    }
    
    const result = await executor(input);
    console.log(`[ACTION_REGISTRY] ${type} completed - success: ${result.success}`);
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[ACTION_REGISTRY] ${type} failed:`, errorMessage);
    return {
      success: false,
      summary: `Action failed: ${errorMessage}`,
      error: errorMessage
    };
  }
}
