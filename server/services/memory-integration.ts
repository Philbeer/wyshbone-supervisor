/**
 * Memory Integration for Autonomous Agent
 * Shows how to integrate memory system with goal generation
 *
 * INTEGRATION POINTS:
 * 1. Import memory services in autonomous-agent.ts
 * 2. Retrieve memories before task generation
 * 3. Include memory context in prompt
 * 4. Create memories after task execution
 * 5. Cleanup old memories periodically
 */

import type { MemoryContext } from './memory-reader';
import type { UserGoalsContext, GeneratedTask } from '../autonomous-agent';

// ========================================
// STEP 1: Enhanced Context Type
// ========================================

export interface EnhancedUserContext extends UserGoalsContext {
  memoryContext?: MemoryContext;
  memorySummary?: string;
}

// ========================================
// STEP 2: Build Enhanced Prompt with Memories
// ========================================

/**
 * Enhanced prompt builder that includes memory context
 *
 * TO INTEGRATE: Replace buildTaskGenerationPrompt in autonomous-agent.ts
 */
export function buildMemoryEnhancedPrompt(context: EnhancedUserContext): string {
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

  // **NEW: Memory Context**
  if (context.memorySummary) {
    prompt += `AGENT MEMORY (learned from past experiences):\n`;
    prompt += context.memorySummary;
    prompt += `\n`;
  }

  prompt += `Based on this context and past learnings, what are the 3-5 most important tasks this user should do TODAY?\n\n`;
  prompt += `Consider:\n`;
  prompt += `- User preferences and patterns\n`;
  prompt += `- What worked well before (success patterns)\n`;
  prompt += `- What to avoid (failure patterns)\n`;
  prompt += `- Insights from previous tasks\n\n`;
  prompt += `Remember: Be SPECIFIC and ACTIONABLE. Output JSON only.`;

  return prompt;
}

// ========================================
// STEP 3: Integration Example
// ========================================

/**
 * Example of enhanced generateDailyTasks with memory integration
 *
 * TO INTEGRATE: Update generateDailyTasks in autonomous-agent.ts to follow this pattern
 */
export async function exampleMemoryIntegratedTaskGeneration(userId: string) {
  // Import at top of autonomous-agent.ts:
  // import { getMemoryContext, summarizeMemoryContext } from './services/memory-reader';
  // import { createMemoriesFromSuccess, createMemoriesFromFailure, cleanupMemories } from './services/memory-writer';

  // In generateDailyTasks function, after gatherUserContext:

  // 1. Retrieve memory context
  // const memoryContext = await getMemoryContext(userId);
  // const memorySummary = summarizeMemoryContext(memoryContext);

  // 2. Add to context
  // const enhancedContext = {
  //   ...context,
  //   memoryContext,
  //   memorySummary
  // };

  // 3. Build prompt with memories
  // const prompt = buildMemoryEnhancedPrompt(enhancedContext);

  // 4. After task execution, create memories
  // for (const taskResult of execution.results) {
  //   if (taskResult.status === 'success' && taskResult.interesting) {
  //     await createMemoriesFromSuccess(userId, taskResult);
  //   } else if (taskResult.status === 'failed') {
  //     await createMemoriesFromFailure(userId, taskResult);
  //   }
  // }

  // 5. Cleanup old memories (do this in daily cron)
  // await cleanupMemories(userId);
}

// ========================================
// STEP 4: Memory-Aware Task Execution Wrapper
// ========================================

/**
 * Wrapper that executes tasks and creates memories from results
 *
 * TO INTEGRATE: Use this in place of plain executeTasks
 */
export async function executeTasksWithMemory(
  userId: string,
  tasks: GeneratedTask[]
) {
  // Import executeTasks from task-executor
  // const execution = await executeTasks(tasks, userId);

  // Create memories from results
  // for (const taskResult of execution.results) {
  //   if (taskResult.status === 'success' && taskResult.interesting) {
  //     const memoryIds = await createMemoriesFromSuccess(userId, taskResult);
  //     console.log(`[MEMORY] Created ${memoryIds.length} success memories`);
  //   } else if (taskResult.status === 'failed' && taskResult.error) {
  //     const memoryIds = await createMemoriesFromFailure(userId, taskResult);
  //     console.log(`[MEMORY] Created ${memoryIds.length} failure memories`);
  //   }
  // }

  // return execution;
}

// ========================================
// STEP 5: Daily Memory Maintenance
// ========================================

/**
 * Daily memory cleanup routine
 *
 * TO INTEGRATE: Add to daily cron job (daily-agent.ts)
 */
export async function dailyMemoryMaintenance(userId: string) {
  // Import cleanupMemories from memory-writer
  // const cleanup = await cleanupMemories(userId);
  // console.log(`[MEMORY] Maintenance complete: ${cleanup.stale} stale, ${cleanup.expired} expired`);
}

// ========================================
// INTEGRATION CHECKLIST
// ========================================

/*
INTEGRATION CHECKLIST:

autonomous-agent.ts:
  [ ] Add imports for memory-reader and memory-writer
  [ ] Retrieve memory context in generateDailyTasks (after gatherUserContext)
  [ ] Enhance prompt with memory summary
  [ ] Create memories after task execution

daily-agent.ts:
  [ ] Add memory cleanup to daily cron execution
  [ ] Call cleanupMemories for each user

task-executor.ts:
  [ ] Optionally enhance interesting evaluation with memory context
  [ ] Consider past patterns when scoring results

wyshbone-ui:
  [ ] Run migration: migrations/0002_create_agent_memory.sql
  [ ] Verify agent_memory table created
  [ ] Check indexes created
*/

export default {
  buildMemoryEnhancedPrompt,
  exampleMemoryIntegratedTaskGeneration,
  executeTasksWithMemory,
  dailyMemoryMaintenance
};
