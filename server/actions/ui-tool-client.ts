/**
 * UI Tool Client
 *
 * Calls the unified tool execution endpoint in wyshbone-ui
 * This eliminates tool duplication - single source of truth in UI
 */

import { ActionInput, ActionResult } from './registry';

// UI endpoint configuration
const UI_BASE_URL = process.env.WYSHBONE_UI_URL || 'http://localhost:5001';
const TOOLS_EXECUTE_ENDPOINT = `${UI_BASE_URL}/api/tools/execute`;

/**
 * Execute a tool via the unified UI endpoint
 *
 * @param toolName - Name of the tool (e.g., "search_google_places", "deep_research")
 * @param params - Tool parameters
 * @param userId - User ID for authentication
 * @param sessionId - Optional session ID for tracking
 */
export async function executeToolViaUI(
  toolName: string,
  params: Record<string, any>,
  userId?: string,
  sessionId?: string
): Promise<ActionResult> {
  try {
    console.log(`🔧 Calling UI tool endpoint: ${toolName}`);

    const response = await fetch(TOOLS_EXECUTE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tool: toolName,
        params,
        userId,
        sessionId: sessionId || `supervisor_${Date.now()}`
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        summary: `UI tool endpoint returned ${response.status}: ${errorText}`,
        error: `HTTP ${response.status}: ${errorText}`
      };
    }

    const result = await response.json();

    // Convert UI's ActionResult format to Supervisor's format
    return {
      success: result.ok === true,
      summary: result.note || (result.ok ? 'Tool executed successfully' : result.error || 'Tool execution failed'),
      data: result.data,
      error: result.error
    };

  } catch (error) {
    console.error(`❌ Failed to call UI tool endpoint:`, error);
    return {
      success: false,
      summary: `Failed to call UI tool endpoint: ${error instanceof Error ? error.message : String(error)}`,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Updated executors that call the UI endpoint instead of duplicating logic
 */

export async function runDeepResearch(input: ActionInput): Promise<ActionResult> {
  const { topic, prompt, userId } = input;

  if (!topic) {
    return {
      success: false,
      summary: 'Missing required field: topic',
      error: 'topic is required'
    };
  }

  return executeToolViaUI('deep_research', {
    prompt: prompt || topic,
    topic
  }, userId);
}

export async function runGlobalDatabaseSearch(input: ActionInput): Promise<ActionResult> {
  const { query, region, country = 'GB', maxResults = 30, userId } = input;

  if (!query || !region) {
    return {
      success: false,
      summary: 'Missing required fields: query and region',
      error: 'query and region are required'
    };
  }

  return executeToolViaUI('search_google_places', {
    query,
    locationText: region,
    location: region,
    country,
    maxResults
  }, userId);
}

export async function createScheduledMonitor(input: ActionInput): Promise<ActionResult> {
  const { label, description, monitorType, userId } = input;

  if (!label || !userId) {
    return {
      success: false,
      summary: 'Missing required fields: label and userId',
      error: 'label and userId are required'
    };
  }

  return executeToolViaUI('create_scheduled_monitor', {
    label,
    description,
    monitorType: monitorType || 'deep_research'
  }, userId);
}

export async function runEmailFinderBatch(input: ActionInput): Promise<ActionResult> {
  const { query, location, country = 'GB', targetRole = 'General Manager', limit = 30, userId } = input;

  if (!query || !location) {
    return {
      success: false,
      summary: 'Missing required fields: query and location',
      error: 'query and location are required'
    };
  }

  return executeToolViaUI('batch_contact_finder', {
    query,
    location,
    country,
    targetRole,
    limit
  }, userId);
}

/**
 * Export unified executors
 */
export const executors = {
  runDeepResearch,
  runGlobalDatabaseSearch,
  createScheduledMonitor,
  runEmailFinderBatch
};
