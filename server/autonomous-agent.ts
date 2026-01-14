/**
 * Autonomous Agent - Goal Generator
 *
 * Uses Claude API to autonomously generate daily tasks based on user goals.
 * The agent decides what tasks to do today without human intervention.
 */

import { supabase } from './supabase';
import { storage } from './storage';
import { claudeAPI } from './services/claude-api';
import { executeTasks, type BatchExecutionResult } from './services/task-executor';
import { getMemoryContext, summarizeMemoryContext } from './services/memory-reader';
import { sendAgentFindingsNotification } from './services/agent-email-notifier';

// ========================================
// TYPES
// ========================================

export interface GeneratedTask {
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  estimatedDuration: string;
  actionable: boolean;
  reasoning: string;
}

export interface GoalGenerationResult {
  userId: string;
  tasks: GeneratedTask[];
  contextUsed: {
    goals: string[];
    monitors: string[];
    recentActivity: string;
  };
  model: string;
  tokensUsed: {
    input: number;
    output: number;
  };
  timestamp: number;
}

interface UserGoalsContext {
  userId: string;
  primaryObjective?: string;
  secondaryObjectives?: string[];
  activeMonitors: Array<{
    label: string;
    description: string;
    type: string;
  }>;
  recentResearch: Array<{
    label: string;
    prompt: string;
  }>;
  suggestedLeads: number;
}

// ========================================
// GOAL GENERATION
// ========================================

/**
 * Generate daily tasks for a user based on their goals
 */
export async function generateDailyTasks(userId: string): Promise<GoalGenerationResult> {
  console.log(`[AUTONOMOUS_AGENT] Generating daily tasks for user ${userId}...`);

  // Check if Claude API is available
  if (!claudeAPI.isAvailable()) {
    throw new Error('Claude API not available - check ANTHROPIC_API_KEY');
  }

  try {
    // 1. Gather user context (goals, monitors, recent activity)
    const context = await gatherUserContext(userId);

    if (!context.primaryObjective && context.activeMonitors.length === 0) {
      console.log('[AUTONOMOUS_AGENT] No goals or monitors found for user');
      return {
        userId,
        tasks: [],
        contextUsed: {
          goals: [],
          monitors: [],
          recentActivity: 'No activity'
        },
        model: 'none',
        tokensUsed: { input: 0, output: 0 },
        timestamp: Date.now()
      };
    }

    // 2. Retrieve memory context (P2-T2: Memory-influenced planning)
    let memoryContext = '';
    try {
      const memories = await getMemoryContext(userId);
      memoryContext = summarizeMemoryContext(memories);
      console.log(`[AUTONOMOUS_AGENT] Retrieved memory context (${memories.preferences.length} preferences, ${memories.successPatterns.length} success patterns, ${memories.failurePatterns.length} failure patterns)`);
    } catch (memoryError: any) {
      console.error('[AUTONOMOUS_AGENT] Failed to retrieve memories:', memoryError.message);
      // Continue without memory context
    }

    // 3. Build prompt for Claude
    const prompt = buildTaskGenerationPrompt(context, memoryContext);
    const systemPrompt = buildSystemPrompt();

    // 4. Call Claude API
    console.log('[AUTONOMOUS_AGENT] Calling Claude API...');
    const response = await claudeAPI.chat(prompt, systemPrompt, {
      maxTokens: 2048,
      temperature: 0.7 // Slightly creative but not random
    });

    // 5. Parse tasks from Claude's response
    const tasks = parseGeneratedTasks(response.content);

    console.log(`[AUTONOMOUS_AGENT] Generated ${tasks.length} tasks`);

    // 6. Store in agent_activities table
    await storeAgentActivity({
      userId,
      activityType: 'generate_tasks',
      inputData: {
        context: {
          primaryObjective: context.primaryObjective,
          monitorCount: context.activeMonitors.length,
          researchCount: context.recentResearch.length,
          leadsCount: context.suggestedLeads
        }
      },
      outputData: {
        tasks: tasks.map(t => ({
          title: t.title,
          priority: t.priority
        }))
      },
      metadata: {
        model: response.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        taskCount: tasks.length
      }
    });

    return {
      userId,
      tasks,
      contextUsed: {
        goals: [
          context.primaryObjective || 'None',
          ...(context.secondaryObjectives || [])
        ],
        monitors: context.activeMonitors.map(m => m.label),
        recentActivity: `${context.recentResearch.length} research runs, ${context.suggestedLeads} leads`
      },
      model: response.model,
      tokensUsed: {
        input: response.usage.inputTokens,
        output: response.usage.outputTokens
      },
      timestamp: Date.now()
    };

  } catch (error: any) {
    console.error('[AUTONOMOUS_AGENT] Error generating tasks:', error.message);

    // Store failed activity
    await storeAgentActivity({
      userId,
      activityType: 'generate_tasks',
      inputData: { error: 'Failed to gather context' },
      outputData: {},
      metadata: { error: error.message },
      status: 'failed'
    });

    throw error;
  }
}

/**
 * Generate tasks for all users with active goals
 */
export async function generateTasksForAllUsers(): Promise<{
  success: number;
  failed: number;
  results: Array<{ userId: string; taskCount: number; error?: string }>;
}> {
  console.log('[AUTONOMOUS_AGENT] Generating tasks for all users...');

  if (!supabase) {
    console.warn('[AUTONOMOUS_AGENT] Supabase not configured');
    return { success: 0, failed: 0, results: [] };
  }

  try {
    // Get all users with active monitors or objectives
    const { data: users, error } = await supabase
      .from('scheduled_monitors')
      .select('user_id')
      .eq('is_active', 1);

    if (error) {
      console.error('[AUTONOMOUS_AGENT] Error fetching users:', error);
      return { success: 0, failed: 0, results: [] };
    }

    // Deduplicate user IDs
    const uniqueUserIds = [...new Set(users.map(u => u.user_id))];
    console.log(`[AUTONOMOUS_AGENT] Found ${uniqueUserIds.length} user(s) with active goals`);

    const results: Array<{ userId: string; taskCount: number; error?: string }> = [];
    let successCount = 0;
    let failedCount = 0;

    // Generate tasks for each user
    for (const userId of uniqueUserIds) {
      try {
        const result = await generateDailyTasks(userId);
        results.push({
          userId,
          taskCount: result.tasks.length
        });
        successCount++;

        // Wait between users to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error: any) {
        console.error(`[AUTONOMOUS_AGENT] Failed for user ${userId}:`, error.message);
        results.push({
          userId,
          taskCount: 0,
          error: error.message
        });
        failedCount++;
      }
    }

    console.log(`[AUTONOMOUS_AGENT] Complete: ${successCount} success, ${failedCount} failed`);

    return {
      success: successCount,
      failed: failedCount,
      results
    };

  } catch (error: any) {
    console.error('[AUTONOMOUS_AGENT] Error in bulk generation:', error.message);
    throw error;
  }
}

// ========================================
// HELPER FUNCTIONS
// ========================================

/**
 * Gather all context about a user's goals and activity
 */
async function gatherUserContext(userId: string): Promise<UserGoalsContext> {
  console.log('[AUTONOMOUS_AGENT] Gathering user context...');

  const context: UserGoalsContext = {
    userId,
    activeMonitors: [],
    recentResearch: [],
    suggestedLeads: 0
  };

  if (!supabase) {
    return context;
  }

  try {
    // Get user profile with objectives
    const profile = await storage.getUserProfile(userId);
    if (profile) {
      context.primaryObjective = profile.primaryObjective;
      context.secondaryObjectives = profile.secondaryObjectives;
    }

    // Get active scheduled monitors
    const { data: monitors } = await supabase
      .from('scheduled_monitors')
      .select('label, description, monitor_type')
      .eq('user_id', userId)
      .eq('is_active', 1)
      .limit(10);

    if (monitors) {
      context.activeMonitors = monitors.map(m => ({
        label: m.label,
        description: m.description || '',
        type: m.monitor_type
      }));
    }

    // Get recent research runs
    const { data: research } = await supabase
      .from('background_responses')
      .select('label, prompt')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (research) {
      context.recentResearch = research.map(r => ({
        label: r.label,
        prompt: r.prompt
      }));
    }

    // Get suggested leads count
    const { count } = await supabase
      .from('suggested_leads')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);

    context.suggestedLeads = count || 0;

    console.log('[AUTONOMOUS_AGENT] Context gathered:', {
      objective: context.primaryObjective ? 'yes' : 'no',
      monitors: context.activeMonitors.length,
      research: context.recentResearch.length,
      leads: context.suggestedLeads
    });

  } catch (error: any) {
    console.error('[AUTONOMOUS_AGENT] Error gathering context:', error.message);
  }

  return context;
}

/**
 * Build system prompt for Claude
 */
function buildSystemPrompt(): string {
  return `You are an autonomous AI agent helping a business owner manage their sales and marketing activities.

Your job: Generate 3-5 SPECIFIC, ACTIONABLE tasks for TODAY based on the user's goals and current activity.

Rules:
1. Tasks must be SPECIFIC (not vague like "work on marketing")
2. Tasks must be ACTIONABLE (user can start immediately)
3. Tasks should take 15-60 minutes each
4. Focus on what matters most RIGHT NOW
5. Be realistic about what can be done today
6. Prioritize based on urgency and impact

Output format (JSON):
{
  "tasks": [
    {
      "title": "Brief task title",
      "description": "Detailed description of what to do",
      "priority": "high" | "medium" | "low",
      "estimatedDuration": "15-30 min",
      "actionable": true,
      "reasoning": "Why this task matters today"
    }
  ]
}`;
}

/**
 * Build user-specific prompt
 */
function buildTaskGenerationPrompt(context: UserGoalsContext, memoryContext: string = ''): string {
  let prompt = `Generate 3-5 tasks for today based on this user's context:\n\n`;

  // Primary objective
  if (context.primaryObjective) {
    prompt += `PRIMARY GOAL: ${context.primaryObjective}\n\n`;
  }

  // Secondary objectives
  if (context.secondaryObjectives && context.secondaryObjectives.length > 0) {
    prompt += `SECONDARY GOALS:\n`;
    context.secondaryObjectives.forEach(obj => {
      prompt += `- ${obj}\n`;
    });
    prompt += `\n`;
  }

  // Active monitors
  if (context.activeMonitors.length > 0) {
    prompt += `ACTIVE MONITORS (things they're tracking):\n`;
    context.activeMonitors.forEach(monitor => {
      prompt += `- ${monitor.label}: ${monitor.description}\n`;
    });
    prompt += `\n`;
  }

  // Recent research
  if (context.recentResearch.length > 0) {
    prompt += `RECENT RESEARCH:\n`;
    context.recentResearch.forEach(research => {
      prompt += `- ${research.label}\n`;
    });
    prompt += `\n`;
  }

  // Leads
  if (context.suggestedLeads > 0) {
    prompt += `SUGGESTED LEADS: ${context.suggestedLeads} leads waiting for action\n\n`;
  }

  // Memory context (P2-T2: Past learnings influence planning)
  if (memoryContext) {
    prompt += `AGENT MEMORY (learned from past experiences):\n`;
    prompt += memoryContext;
    prompt += `\n`;
  }

  prompt += `Based on this context and past learnings, what are the 3-5 most important tasks this user should do TODAY?\n\n`;
  prompt += `Remember: Be SPECIFIC and ACTIONABLE. Learn from past successes and avoid past failures. Output JSON only.`;

  return prompt;
}

/**
 * Parse tasks from Claude's JSON response
 */
function parseGeneratedTasks(response: string): GeneratedTask[] {
  try {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = response.trim();

    // Remove markdown code blocks if present
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    }

    const parsed = JSON.parse(jsonStr);

    if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
      throw new Error('Invalid response format - missing tasks array');
    }

    // Validate and clean tasks
    const tasks: GeneratedTask[] = parsed.tasks
      .filter((t: any) => t.title && t.description)
      .map((t: any) => ({
        title: t.title,
        description: t.description,
        priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
        estimatedDuration: t.estimatedDuration || '30 min',
        actionable: t.actionable !== false,
        reasoning: t.reasoning || 'Auto-generated task'
      }))
      .slice(0, 5); // Max 5 tasks

    return tasks;

  } catch (error: any) {
    console.error('[AUTONOMOUS_AGENT] Error parsing tasks:', error.message);
    console.error('[AUTONOMOUS_AGENT] Response was:', response);
    throw new Error(`Failed to parse tasks: ${error.message}`);
  }
}

/**
 * Store agent activity in database
 */
async function storeAgentActivity(params: {
  userId: string;
  activityType: string;
  inputData: any;
  outputData: any;
  metadata: any;
  status?: string;
}): Promise<void> {
  if (!supabase) {
    console.warn('[AUTONOMOUS_AGENT] Supabase not configured - skipping storage');
    return;
  }

  try {
    const { error } = await supabase
      .from('agent_activities')
      .insert({
        user_id: params.userId,
        agent_type: 'goal_generator',
        activity_type: params.activityType,
        input_data: params.inputData,
        output_data: params.outputData,
        metadata: params.metadata,
        status: params.status || 'completed',
        created_at: Date.now(),
        completed_at: params.status === 'completed' ? Date.now() : null
      });

    if (error) {
      console.error('[AUTONOMOUS_AGENT] Error storing activity:', error);
    } else {
      console.log('[AUTONOMOUS_AGENT] Activity stored successfully');
    }

  } catch (error: any) {
    console.error('[AUTONOMOUS_AGENT] Error storing activity:', error.message);
  }
}

// ========================================
// TASK EXECUTION
// ========================================

/**
 * Generate daily tasks for a user and execute them automatically
 */
export async function generateAndExecuteTasks(userId: string): Promise<{
  generation: GoalGenerationResult;
  execution: BatchExecutionResult;
}> {
  console.log(`[AUTONOMOUS_AGENT] Generating and executing tasks for user ${userId}...`);

  // 1. Generate tasks
  const generation = await generateDailyTasks(userId);

  if (generation.tasks.length === 0) {
    console.log('[AUTONOMOUS_AGENT] No tasks to execute');
    return {
      generation,
      execution: {
        totalTasks: 0,
        successful: 0,
        failed: 0,
        interesting: 0,
        results: [],
        totalDuration: 0
      }
    };
  }

  // 2. Execute tasks
  console.log(`[AUTONOMOUS_AGENT] Executing ${generation.tasks.length} generated tasks...`);
  const execution = await executeTasks(generation.tasks, userId);

  // 2.5. Send email notification for interesting findings (P3-T2)
  if (execution.interesting > 0) {
    try {
      // Get user email from database
      const profile = await storage.getUserProfile(userId);
      if (profile && profile.email) {
        await sendAgentFindingsNotification(
          {
            userId,
            email: profile.email,
            name: profile.name
          },
          execution,
          'https://app.wyshbone.ai/dashboard'
        );
      } else {
        console.warn(`[AUTONOMOUS_AGENT] No email found for user ${userId} - skipping notification`);
      }
    } catch (emailError: any) {
      console.error(`[AUTONOMOUS_AGENT] Failed to send email notification:`, emailError.message);
      // Don't fail execution if email fails
    }
  }

  // 3. Log combined activity
  await storeAgentActivity({
    userId,
    activityType: 'generate_and_execute',
    inputData: {
      generationContext: generation.contextUsed
    },
    outputData: {
      tasksGenerated: generation.tasks.length,
      tasksExecuted: execution.totalTasks,
      successful: execution.successful,
      failed: execution.failed,
      interesting: execution.interesting
    },
    metadata: {
      generationModel: generation.model,
      generationTokens: generation.tokensUsed,
      executionDuration: execution.totalDuration
    },
    status: execution.failed === 0 ? 'completed' : 'partial'
  });

  console.log(`[AUTONOMOUS_AGENT] Complete - ${execution.successful}/${execution.totalTasks} successful, ${execution.interesting} interesting`);

  return { generation, execution };
}

/**
 * Execute tasks for all users (generate and execute)
 */
export async function executeTasksForAllUsers(): Promise<{
  success: number;
  failed: number;
  results: Array<{
    userId: string;
    tasksGenerated: number;
    tasksExecuted: number;
    successful: number;
    interesting: number;
    error?: string;
  }>;
}> {
  console.log('[AUTONOMOUS_AGENT] Generating and executing tasks for all users...');

  if (!supabase) {
    console.warn('[AUTONOMOUS_AGENT] Supabase not configured');
    return { success: 0, failed: 0, results: [] };
  }

  try {
    // Get all users with active monitors or objectives
    const { data: users, error } = await supabase
      .from('scheduled_monitors')
      .select('user_id')
      .eq('is_active', 1);

    if (error) {
      console.error('[AUTONOMOUS_AGENT] Error fetching users:', error);
      return { success: 0, failed: 0, results: [] };
    }

    // Deduplicate user IDs
    const uniqueUserIds = [...new Set(users.map(u => u.user_id))];
    console.log(`[AUTONOMOUS_AGENT] Found ${uniqueUserIds.length} user(s) with active goals`);

    const results: Array<{
      userId: string;
      tasksGenerated: number;
      tasksExecuted: number;
      successful: number;
      interesting: number;
      error?: string;
    }> = [];
    let successCount = 0;
    let failedCount = 0;

    // Generate and execute tasks for each user
    for (const userId of uniqueUserIds) {
      try {
        const result = await generateAndExecuteTasks(userId);
        results.push({
          userId,
          tasksGenerated: result.generation.tasks.length,
          tasksExecuted: result.execution.totalTasks,
          successful: result.execution.successful,
          interesting: result.execution.interesting
        });
        successCount++;

        // Wait between users to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error: any) {
        console.error(`[AUTONOMOUS_AGENT] Failed for user ${userId}:`, error.message);
        results.push({
          userId,
          tasksGenerated: 0,
          tasksExecuted: 0,
          successful: 0,
          interesting: 0,
          error: error.message
        });
        failedCount++;
      }
    }

    console.log(`[AUTONOMOUS_AGENT] Complete: ${successCount} success, ${failedCount} failed`);

    return {
      success: successCount,
      failed: failedCount,
      results
    };

  } catch (error: any) {
    console.error('[AUTONOMOUS_AGENT] Error in bulk execution:', error.message);
    throw error;
  }
}

// ========================================
// EXPORTS
// ========================================

export default {
  generateDailyTasks,
  generateTasksForAllUsers,
  generateAndExecuteTasks,
  executeTasksForAllUsers
};
