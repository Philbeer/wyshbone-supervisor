/**
 * Memory Writer Service (Database Version)
 * Creates and updates agent memories using direct database connection
 * Replaces Supabase client with pg Pool for better reliability
 */

import pg from 'pg';
const { Pool } = pg;
import type { MemoryType, AgentMemory } from './memory-reader';
import type { TaskExecutionResult } from './task-executor';

// Database connection (lazy initialization)
let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }
    pool = new Pool({ connectionString: DATABASE_URL });
  }
  return pool;
}

// ========================================
// TYPES
// ========================================

export interface CreateMemoryInput {
  userId: string;
  memoryType: MemoryType;
  title: string;
  description: string;
  tags?: string[];
  relatedTaskIds?: string[];
  relatedConversationId?: string | null;
  confidenceScore?: number;
  relevanceScore?: number;
  source: 'task_success' | 'task_failure' | 'user_feedback' | 'pattern_detection' | 'manual_entry';
  metadata?: any;
  expiresAt?: number | null;
}

export interface UpdateMemoryInput {
  id: string;
  confidenceScore?: number;
  relevanceScore?: number;
  tags?: string[];
  isDeprecated?: boolean;
  deprecatedReason?: string | null;
}

// ========================================
// MEMORY CREATION
// ========================================

/**
 * Create a new memory
 */
export async function createMemory(input: CreateMemoryInput): Promise<string | null> {
  const memoryId = `memory_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const now = Date.now();

  try {
    await getPool().query(`
      INSERT INTO agent_memory (
        id, user_id, memory_type, title, description,
        tags, related_task_ids, related_conversation_id,
        confidence_score, relevance_score, access_count,
        created_at, last_accessed_at, expires_at,
        source, metadata, is_deprecated, deprecated_at, deprecated_reason
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
      )
    `, [
      memoryId,
      input.userId,
      input.memoryType,
      input.title,
      input.description,
      input.tags || [],
      input.relatedTaskIds || [],
      input.relatedConversationId || null,
      input.confidenceScore || 0.5,
      input.relevanceScore || 0.5,
      0, // access_count
      now,
      null, // last_accessed_at
      input.expiresAt || null,
      input.source,
      JSON.stringify(input.metadata || {}),
      false, // is_deprecated
      null, // deprecated_at
      null  // deprecated_reason
    ]);

    console.log(`[MEMORY_WRITER] Created memory: ${memoryId} (${input.memoryType})`);
    return memoryId;

  } catch (error: any) {
    console.error('[MEMORY_WRITER] Exception creating memory:', error.message);
    return null;
  }
}

/**
 * Update an existing memory
 */
export async function updateMemory(input: UpdateMemoryInput): Promise<boolean> {
  try {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (input.confidenceScore !== undefined) {
      updates.push(`confidence_score = $${paramIndex++}`);
      values.push(input.confidenceScore);
    }

    if (input.relevanceScore !== undefined) {
      updates.push(`relevance_score = $${paramIndex++}`);
      values.push(input.relevanceScore);
    }

    if (input.tags !== undefined) {
      updates.push(`tags = $${paramIndex++}`);
      values.push(input.tags);
    }

    if (input.isDeprecated !== undefined) {
      updates.push(`is_deprecated = $${paramIndex++}`);
      values.push(input.isDeprecated);

      if (input.isDeprecated) {
        updates.push(`deprecated_at = $${paramIndex++}`);
        values.push(Date.now());
        updates.push(`deprecated_reason = $${paramIndex++}`);
        values.push(input.deprecatedReason || 'Manually deprecated');
      }
    }

    if (updates.length === 0) {
      return false;
    }

    values.push(input.id);

    await getPool().query(`
      UPDATE agent_memory
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
    `, values);

    console.log(`[MEMORY_WRITER] Updated memory: ${input.id}`);
    return true;

  } catch (error: any) {
    console.error('[MEMORY_WRITER] Exception updating memory:', error.message);
    return false;
  }
}

// ========================================
// MEMORY CREATION FROM TASKS
// ========================================

/**
 * Create memories from successful task execution
 */
export async function createMemoriesFromSuccess(
  userId: string,
  taskResult: TaskExecutionResult
): Promise<string[]> {
  if (!taskResult.interesting || taskResult.status !== 'success') {
    return [];
  }

  const memoryIds: string[] = [];

  // Create success pattern memory
  const successMemoryId = await createMemory({
    userId,
    memoryType: 'success_pattern',
    title: `Successful: ${taskResult.task.title}`,
    description: taskResult.interestingReason || 'This approach worked well',
    tags: extractTags(taskResult.task.title, taskResult.task.description),
    relatedTaskIds: [taskResult.taskId],
    relatedConversationId: taskResult.conversationId || null,
    confidenceScore: 0.7,
    relevanceScore: 0.8,
    source: 'task_success',
    metadata: {
      taskTitle: taskResult.task.title,
      actionTaken: taskResult.task.actionable ? 'executed' : 'skipped',
      executionTime: taskResult.executionTime
    },
    expiresAt: Date.now() + (90 * 24 * 60 * 60 * 1000) // Expires in 90 days
  });

  if (successMemoryId) {
    memoryIds.push(successMemoryId);
  }

  // If there's specific data insight, create an insight memory
  if (taskResult.toolResponse?.data) {
    const data = taskResult.toolResponse.data;
    if (typeof data === 'object' && Object.keys(data).length > 0) {
      const insightMemoryId = await createMemory({
        userId,
        memoryType: 'insight',
        title: `Data insight from ${taskResult.task.title}`,
        description: `Discovered: ${JSON.stringify(data).substring(0, 200)}`,
        tags: extractTags(taskResult.task.title, taskResult.task.description),
        relatedTaskIds: [taskResult.taskId],
        confidenceScore: 0.6,
        relevanceScore: 0.7,
        source: 'task_success',
        metadata: {
          dataSnapshot: data
        },
        expiresAt: Date.now() + (60 * 24 * 60 * 60 * 1000) // Expires in 60 days
      });

      if (insightMemoryId) {
        memoryIds.push(insightMemoryId);
      }
    }
  }

  return memoryIds;
}

/**
 * Create memories from failed task execution
 */
export async function createMemoriesFromFailure(
  userId: string,
  taskResult: TaskExecutionResult
): Promise<string[]> {
  if (taskResult.status !== 'failed' || !taskResult.error) {
    return [];
  }

  const memoryIds: string[] = [];

  // Create failure pattern memory
  const failureMemoryId = await createMemory({
    userId,
    memoryType: 'failure_pattern',
    title: `Failed: ${taskResult.task.title}`,
    description: `Error: ${taskResult.error}`,
    tags: extractTags(taskResult.task.title, taskResult.task.description, taskResult.error),
    relatedTaskIds: [taskResult.taskId],
    relatedConversationId: taskResult.conversationId || null,
    confidenceScore: 0.8,
    relevanceScore: 0.9, // Failures are highly relevant to avoid
    source: 'task_failure',
    metadata: {
      taskTitle: taskResult.task.title,
      errorMessage: taskResult.error,
      executionTime: taskResult.executionTime
    },
    expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000) // Expires in 30 days
  });

  if (failureMemoryId) {
    memoryIds.push(failureMemoryId);
  }

  return memoryIds;
}

/**
 * Create a user preference memory
 */
export async function createPreferenceMemory(
  userId: string,
  title: string,
  description: string,
  tags: string[] = []
): Promise<string | null> {
  return createMemory({
    userId,
    memoryType: 'preference',
    title,
    description,
    tags,
    confidenceScore: 0.9,
    relevanceScore: 1.0, // Preferences are always highly relevant
    source: 'user_feedback',
    expiresAt: null // Preferences don't expire
  });
}

// ========================================
// MEMORY DEPRECATION
// ========================================

/**
 * Deprecate old memories based on age and low usage
 */
export async function deprecateStaleMemories(userId: string): Promise<number> {
  try {
    const now = Date.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

    const result = await getPool().query(`
      UPDATE agent_memory
      SET
        is_deprecated = true,
        deprecated_at = $1,
        deprecated_reason = 'Stale: low usage and old'
      WHERE user_id = $2
        AND is_deprecated = false
        AND created_at < $3
        AND access_count < 3
        AND relevance_score < 0.4
      RETURNING id
    `, [now, userId, thirtyDaysAgo]);

    const count = result.rows.length;
    if (count > 0) {
      console.log(`[MEMORY_WRITER] Deprecated ${count} stale memories for user ${userId}`);
    }

    return count;

  } catch (error: any) {
    console.error('[MEMORY_WRITER] Exception deprecating stale memories:', error.message);
    return 0;
  }
}

/**
 * Deprecate expired memories
 */
export async function deprecateExpiredMemories(userId: string): Promise<number> {
  try {
    const now = Date.now();

    const result = await getPool().query(`
      UPDATE agent_memory
      SET
        is_deprecated = true,
        deprecated_at = $1,
        deprecated_reason = 'Expired'
      WHERE user_id = $2
        AND is_deprecated = false
        AND expires_at IS NOT NULL
        AND expires_at < $1
      RETURNING id
    `, [now, userId]);

    const count = result.rows.length;
    if (count > 0) {
      console.log(`[MEMORY_WRITER] Deprecated ${count} expired memories for user ${userId}`);
    }

    return count;

  } catch (error: any) {
    console.error('[MEMORY_WRITER] Exception deprecating expired memories:', error.message);
    return 0;
  }
}

/**
 * Run memory cleanup for a user
 */
export async function cleanupMemories(userId: string): Promise<{ stale: number; expired: number }> {
  const stale = await deprecateStaleMemories(userId);
  const expired = await deprecateExpiredMemories(userId);

  console.log(`[MEMORY_WRITER] Cleanup complete for user ${userId}: ${stale} stale, ${expired} expired`);

  return { stale, expired };
}

// ========================================
// HELPER FUNCTIONS
// ========================================

/**
 * Extract relevant tags from text
 */
function extractTags(title: string, description: string, error?: string): string[] {
  const text = `${title} ${description} ${error || ''}`.toLowerCase();
  const tags: Set<string> = new Set();

  // Common keywords to extract as tags
  const keywords = [
    'search', 'find', 'email', 'brewery', 'pub', 'restaurant',
    'craft', 'beer', 'wine', 'spirits', 'contact', 'phone',
    'address', 'review', 'rating', 'schedule', 'monitor',
    'batch', 'job', 'nudge', 'research', 'data', 'report'
  ];

  keywords.forEach(keyword => {
    if (text.includes(keyword)) {
      tags.add(keyword);
    }
  });

  // Add error-related tags
  if (error) {
    if (error.includes('timeout')) tags.add('timeout');
    if (error.includes('rate limit')) tags.add('rate-limit');
    if (error.includes('auth')) tags.add('auth-error');
    if (error.includes('not found')) tags.add('not-found');
  }

  return Array.from(tags).slice(0, 10); // Limit to 10 tags
}

// ========================================
// EXPORTS
// ========================================

export default {
  createMemory,
  updateMemory,
  createMemoriesFromSuccess,
  createMemoriesFromFailure,
  createPreferenceMemory,
  deprecateStaleMemories,
  deprecateExpiredMemories,
  cleanupMemories
};
