/**
 * Action Executor - Single execution spine for Supervisor
 * 
 * Minimal implementation for Session 1 - only supports SEARCH_PLACES
 * Re-implements equivalent behavior from UI executeAction()
 */

import type { PlanStep } from './types/plan';

export interface ActionResult {
  success: boolean;
  summary: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface ActionInput {
  toolName: string;
  toolArgs: Record<string, unknown>;
  userId: string;
}

export async function executeAction(input: ActionInput): Promise<ActionResult> {
  const { toolName, toolArgs, userId } = input;
  
  console.log(`[ACTION_EXECUTOR] Executing ${toolName} with args:`, JSON.stringify(toolArgs).substring(0, 200));
  
  try {
    switch (toolName) {
      case 'SEARCH_PLACES':
        return await executeSearchPlaces(toolArgs, userId);
      
      default:
        console.warn(`[ACTION_EXECUTOR] Unsupported tool: ${toolName}`);
        return {
          success: false,
          summary: `Unsupported tool: ${toolName}`,
          error: `Tool ${toolName} is not supported in Session 1`
        };
    }
  } catch (error: any) {
    console.error(`[ACTION_EXECUTOR] Error executing ${toolName}:`, error.message);
    return {
      success: false,
      summary: `Execution failed: ${error.message}`,
      error: error.message
    };
  }
}

async function executeSearchPlaces(
  args: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const query = args.query as string || 'businesses';
  const location = args.location as string || 'UK';
  const country = (args.country as string) || 'GB';
  
  console.log(`[ACTION_EXECUTOR] SEARCH_PLACES: ${query} in ${location}, ${country}`);
  
  try {
    const { executeAction: registryExecuteAction } = await import('../actions/registry');
    
    const result = await registryExecuteAction('GLOBAL_DB', {
      query,
      region: location,
      country,
      maxResults: 10,
      userId
    });
    
    return {
      success: result.success,
      summary: result.summary,
      data: result.data as Record<string, unknown>,
      error: result.error
    };
  } catch (error: any) {
    console.error('[ACTION_EXECUTOR] SEARCH_PLACES failed:', error.message);
    return {
      success: false,
      summary: `Search failed: ${error.message}`,
      error: error.message
    };
  }
}

export async function executeStep(
  step: PlanStep,
  toolMetadata: { toolName: string; toolArgs: Record<string, unknown> } | undefined,
  userId: string
): Promise<ActionResult> {
  if (!toolMetadata) {
    return {
      success: false,
      summary: 'No tool metadata provided',
      error: 'Missing toolMetadata for step execution'
    };
  }
  
  return executeAction({
    toolName: toolMetadata.toolName,
    toolArgs: toolMetadata.toolArgs,
    userId
  });
}
