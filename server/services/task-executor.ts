/**
 * Task Executor Service
 *
 * Executes generated tasks by calling the unified tool endpoint from wyshbone-ui.
 * Evaluates results, logs to database, and handles errors gracefully.
 */

import { supabase } from '../supabase';
import type { GeneratedTask } from '../autonomous-agent';
import { createMemoriesFromSuccess, createMemoriesFromFailure } from './memory-writer';
import { learnFromFeedback } from './preference-learner';

// ========================================
// TYPES
// ========================================

export interface TaskExecutionResult {
  taskId: string;
  task: GeneratedTask;
  status: 'success' | 'failed' | 'partial';
  executionTime: number;
  toolResponse?: any;
  interesting: boolean;
  interestingReason?: string;
  error?: string;
}

export interface BatchExecutionResult {
  totalTasks: number;
  successful: number;
  failed: number;
  interesting: number;
  results: TaskExecutionResult[];
  totalDuration: number;
}

interface ToolEndpointRequest {
  task: GeneratedTask;
  userId: string;
  taskId: string;
}

interface ToolEndpointResponse {
  success: boolean;
  data?: any;
  error?: string;
  executionTime?: number;
}

// ========================================
// CONFIGURATION
// ========================================

const UI_BASE_URL = process.env.UI_URL || 'http://localhost:5173';
const TOOL_ENDPOINT = `${UI_BASE_URL}/api/tools/execute`;
const RATE_LIMIT_DELAY_MS = 2000; // 2 seconds between tasks
const EXECUTION_TIMEOUT_MS = 30000; // 30 second timeout per task

// ========================================
// MAIN EXECUTOR
// ========================================

/**
 * Execute a single generated task using the unified tool endpoint
 */
export async function executeTask(
  task: GeneratedTask,
  userId: string,
  taskId: string
): Promise<TaskExecutionResult> {
  const startTime = Date.now();

  console.log(`[TASK_EXECUTOR] Executing task: ${task.title}`);

  const result: TaskExecutionResult = {
    taskId,
    task,
    status: 'failed',
    executionTime: 0,
    interesting: false
  };

  try {
    // Call unified tool endpoint
    const toolResponse = await callToolEndpoint({
      task,
      userId,
      taskId
    });

    result.executionTime = Date.now() - startTime;
    result.toolResponse = toolResponse;

    if (toolResponse.success) {
      result.status = 'success';

      // Evaluate if results are interesting
      const evaluation = evaluateResults(task, toolResponse.data);
      result.interesting = evaluation.interesting;
      result.interestingReason = evaluation.reason;

      console.log(`[TASK_EXECUTOR] ✅ Task completed successfully (${result.executionTime}ms)`);
      if (result.interesting) {
        console.log(`[TASK_EXECUTOR] 🌟 Interesting result: ${result.interestingReason}`);
      }
    } else {
      result.status = 'failed';
      result.error = toolResponse.error || 'Unknown error';
      console.error(`[TASK_EXECUTOR] ❌ Task failed: ${result.error}`);
    }

  } catch (error: any) {
    result.executionTime = Date.now() - startTime;
    result.status = 'failed';
    result.error = error.message || 'Unexpected error during execution';
    console.error(`[TASK_EXECUTOR] ❌ Exception during execution:`, error.message);
  }

  // Log activity to database
  await logTaskActivity(userId, result);

  // Store outcome in memory for learning (P2-T2)
  try {
    if (result.status === 'success' && result.interesting) {
      const memoryIds = await createMemoriesFromSuccess(userId, result);
      console.log(`[MEMORY] Created ${memoryIds.length} success memories from task`);
    } else if (result.status === 'failed' && result.error) {
      const memoryIds = await createMemoriesFromFailure(userId, result);
      console.log(`[MEMORY] Created ${memoryIds.length} failure memories from task`);
    }
  } catch (memoryError: any) {
    // Don't fail task if memory storage fails
    console.error(`[MEMORY] Failed to store memories:`, memoryError.message);
  }

  // Learn user preferences from outcome (P2-T4)
  try {
    await learnFromFeedback({
      userId,
      taskId,
      result: result.toolResponse?.data || result.toolResponse,
      interesting: result.interesting
    });
  } catch (prefError: any) {
    // Don't fail task if preference learning fails
    console.error(`[PREFERENCE_LEARNER] Failed to learn preferences:`, prefError.message);
  }

  return result;
}

/**
 * Execute multiple tasks with rate limiting
 */
export async function executeTasks(
  tasks: GeneratedTask[],
  userId: string
): Promise<BatchExecutionResult> {
  console.log(`[TASK_EXECUTOR] Starting batch execution of ${tasks.length} tasks...`);

  const batchStartTime = Date.now();
  const results: TaskExecutionResult[] = [];
  let successful = 0;
  let failed = 0;
  let interesting = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const taskId = `task_${userId}_${Date.now()}_${i}`;

    // Execute task
    const result = await executeTask(task, userId, taskId);
    results.push(result);

    // Update counters
    if (result.status === 'success') {
      successful++;
      if (result.interesting) {
        interesting++;
      }
    } else {
      failed++;
    }

    // Rate limiting: wait between tasks (except after last task)
    if (i < tasks.length - 1) {
      console.log(`[TASK_EXECUTOR] Waiting ${RATE_LIMIT_DELAY_MS}ms before next task...`);
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  const totalDuration = Date.now() - batchStartTime;

  console.log(`[TASK_EXECUTOR] Batch execution complete:`);
  console.log(`  - Total: ${tasks.length}`);
  console.log(`  - Successful: ${successful}`);
  console.log(`  - Failed: ${failed}`);
  console.log(`  - Interesting: ${interesting}`);
  console.log(`  - Duration: ${totalDuration}ms`);

  return {
    totalTasks: tasks.length,
    successful,
    failed,
    interesting,
    results,
    totalDuration
  };
}

// ========================================
// TOOL ENDPOINT COMMUNICATION
// ========================================

/**
 * Call the unified tool endpoint in wyshbone-ui
 */
async function callToolEndpoint(request: ToolEndpointRequest): Promise<ToolEndpointResponse> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EXECUTION_TIMEOUT_MS);

    const response = await fetch(TOOL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      // Handle HTTP errors
      const errorText = await response.text().catch(() => 'Unable to read error');
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`
      };
    }

    const data = await response.json();
    return data;

  } catch (error: any) {
    if (error.name === 'AbortError') {
      return {
        success: false,
        error: `Execution timeout (>${EXECUTION_TIMEOUT_MS}ms)`
      };
    }

    // Check if this is a connection error (UI not running)
    if (error.code === 'ECONNREFUSED' || error.message.includes('fetch failed')) {
      return {
        success: false,
        error: `Unable to connect to UI at ${UI_BASE_URL} - is wyshbone-ui running?`
      };
    }

    return {
      success: false,
      error: error.message || 'Unknown error calling tool endpoint'
    };
  }
}

// ========================================
// RESULT EVALUATION
// ========================================

/**
 * Evaluate if task results are "interesting" using simple heuristics
 *
 * Interesting results include:
 * - Found new leads/contacts
 * - Discovered opportunities
 * - Identified issues that need attention
 * - Generated actionable insights
 */
function evaluateResults(
  task: GeneratedTask,
  data: any
): { interesting: boolean; reason?: string } {
  if (!data) {
    return { interesting: false };
  }

  // Heuristic 1: Check for new leads or contacts
  if (data.leads && Array.isArray(data.leads) && data.leads.length > 0) {
    return {
      interesting: true,
      reason: `Found ${data.leads.length} new leads`
    };
  }

  if (data.contacts && Array.isArray(data.contacts) && data.contacts.length > 0) {
    return {
      interesting: true,
      reason: `Found ${data.contacts.length} new contacts`
    };
  }

  // Heuristic 2: Check for opportunities
  if (data.opportunities && Array.isArray(data.opportunities) && data.opportunities.length > 0) {
    return {
      interesting: true,
      reason: `Identified ${data.opportunities.length} opportunities`
    };
  }

  // Heuristic 3: Check for alerts or issues
  if (data.alerts && Array.isArray(data.alerts) && data.alerts.length > 0) {
    return {
      interesting: true,
      reason: `Found ${data.alerts.length} alerts requiring attention`
    };
  }

  if (data.issues && Array.isArray(data.issues) && data.issues.length > 0) {
    return {
      interesting: true,
      reason: `Detected ${data.issues.length} issues`
    };
  }

  // Heuristic 4: Check for significant counts
  if (typeof data.count === 'number' && data.count > 0) {
    return {
      interesting: true,
      reason: `Found ${data.count} items`
    };
  }

  // Heuristic 5: Check for changes or updates
  if (data.changes && Array.isArray(data.changes) && data.changes.length > 0) {
    return {
      interesting: true,
      reason: `Detected ${data.changes.length} changes`
    };
  }

  if (data.updated && typeof data.updated === 'number' && data.updated > 0) {
    return {
      interesting: true,
      reason: `Updated ${data.updated} items`
    };
  }

  // Heuristic 6: Check for insights or recommendations
  if (data.insights && Array.isArray(data.insights) && data.insights.length > 0) {
    return {
      interesting: true,
      reason: `Generated ${data.insights.length} insights`
    };
  }

  if (data.recommendations && Array.isArray(data.recommendations) && data.recommendations.length > 0) {
    return {
      interesting: true,
      reason: `Provided ${data.recommendations.length} recommendations`
    };
  }

  // Heuristic 7: Check for success indicators
  if (data.success === true && data.message) {
    return {
      interesting: true,
      reason: data.message
    };
  }

  // Heuristic 8: High priority based on task priority
  if (task.priority === 'high' && data.result) {
    return {
      interesting: true,
      reason: 'High priority task completed with results'
    };
  }

  // Default: not interesting
  return { interesting: false };
}

// ========================================
// DATABASE LOGGING
// ========================================

/**
 * Log task execution activity to agent_activities table
 */
async function logTaskActivity(
  userId: string,
  result: TaskExecutionResult
): Promise<void> {
  if (!supabase) {
    console.warn('[TASK_EXECUTOR] Supabase not configured - skipping database logging');
    return;
  }

  try {
    const { error } = await supabase
      .from('agent_activities')
      .insert({
        user_id: userId,
        agent_type: 'task_executor',
        activity_type: 'execute_task',
        input_data: {
          task: {
            title: result.task.title,
            description: result.task.description,
            priority: result.task.priority,
            estimatedDuration: result.task.estimatedDuration
          }
        },
        output_data: {
          status: result.status,
          interesting: result.interesting,
          interestingReason: result.interestingReason,
          toolResponse: result.toolResponse
        },
        metadata: {
          taskId: result.taskId,
          executionTime: result.executionTime,
          error: result.error
        },
        status: result.status === 'success' ? 'completed' : 'failed',
        error: result.error,
        created_at: Date.now(),
        completed_at: Date.now()
      });

    if (error) {
      console.error('[TASK_EXECUTOR] Error logging activity:', error);
    } else {
      console.log('[TASK_EXECUTOR] Activity logged to database');
    }

  } catch (error: any) {
    console.error('[TASK_EXECUTOR] Exception logging activity:', error.message);
  }
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========================================
// ERROR REPORTING (DEBUG BRIDGE)
// ========================================

/**
 * Report errors to debug bridge
 */
async function reportError(type: string, message: string, data: any = {}): Promise<void> {
  try {
    await fetch('http://localhost:9999/code-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        message,
        repo: 'wyshbone-supervisor',
        timestamp: new Date().toISOString(),
        context: 'task-executor',
        ...data
      })
    });
  } catch (err) {
    // Debug bridge offline - fail silently
  }
}

// ========================================
// EXPORTS
// ========================================

export default {
  executeTask,
  executeTasks
};
