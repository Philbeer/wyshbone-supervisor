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
import { getUserPreferences } from './preference-learner';

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

      // Evaluate if results are interesting using WABS scoring (P3-T1)
      const evaluation = await evaluateResults(task, toolResponse.data, userId);
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
// RESULT EVALUATION (WABS SCORING - P3-T1)
// ========================================

/**
 * Evaluate if task results are "interesting" using WABS scoring engine
 *
 * WABS (What's Actually Been Said) scoring considers:
 * - Relevance to user preferences
 * - Novelty (new vs. seen before)
 * - Actionability (can user do something with this?)
 * - Urgency (time-sensitive?)
 *
 * Returns score 0-100 with explanation
 */
async function evaluateResults(
  task: GeneratedTask,
  data: any,
  userId: string
): Promise<{ interesting: boolean; reason?: string }> {
  if (!data) {
    return { interesting: false };
  }

  try {
    // Get user preferences for context
    const preferences = await getUserPreferences(userId);

    // Build user context for WABS scorer
    const userContext = {
      preferences: {
        industries: preferences.industries,
        regions: preferences.regions,
        contactTypes: preferences.contactTypes
      },
      keywords: preferences.keywords.map(k => k.value),
      goals: {
        primary: task.description // Use task description as goal context
      },
      recentResults: [], // TODO P3-T2: Track recent results to detect novelty
      seenEntities: []   // TODO P3-T2: Track seen entities
    };

    // Import WABS scorer dynamically (from wyshbone-control-tower)
    const wabsScorerPath = '../../wyshbone-control-tower/lib/wabs-scorer.js';
    const { scoreInterestingness } = await import(wabsScorerPath);

    // Score the result
    const scoring = scoreInterestingness(data, userContext);

    // Results scoring >70 are considered interesting (P3-T2 threshold)
    const interesting = scoring.score >= 70;

    console.log(`[WABS] Score: ${scoring.score}/100 | Signals: R=${scoring.signals.relevance} N=${scoring.signals.novelty} A=${scoring.signals.actionability} U=${scoring.signals.urgency}`);

    return {
      interesting,
      reason: interesting ? `WABS Score: ${scoring.score}/100 - ${scoring.explanation}` : undefined
    };

  } catch (scoringError: any) {
    // Fallback to simple heuristics if WABS fails
    console.error(`[WABS] Scoring failed, using fallback heuristics:`, scoringError.message);
    return evaluateResultsFallback(task, data);
  }
}

/**
 * Fallback evaluation using simple heuristics (if WABS fails)
 */
function evaluateResultsFallback(
  task: GeneratedTask,
  data: any
): { interesting: boolean; reason?: string } {
  // Check for new leads or contacts
  if (data.leads && Array.isArray(data.leads) && data.leads.length > 0) {
    return { interesting: true, reason: `Found ${data.leads.length} new leads` };
  }
  if (data.contacts && Array.isArray(data.contacts) && data.contacts.length > 0) {
    return { interesting: true, reason: `Found ${data.contacts.length} new contacts` };
  }

  // Check for opportunities
  if (data.opportunities && Array.isArray(data.opportunities) && data.opportunities.length > 0) {
    return { interesting: true, reason: `Identified ${data.opportunities.length} opportunities` };
  }

  // Check for significant counts
  if (typeof data.count === 'number' && data.count > 0) {
    return { interesting: true, reason: `Found ${data.count} items` };
  }

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
