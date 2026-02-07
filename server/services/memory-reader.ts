/**
 * Memory Reader Service (Database Version)
 * Retrieves relevant memories using direct database connection
 * Replaces Supabase client with pg Pool for better reliability
 */

import pg from 'pg';
const { Pool } = pg;

// Database connection (lazy initialization)
let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    // Supabase-only: no DATABASE_URL fallback permitted
    const connStr = process.env.SUPABASE_DATABASE_URL;
    if (!connStr) {
      throw new Error('SUPABASE_DATABASE_URL not configured');
    }
    pool = new Pool({ connectionString: connStr });
  }
  return pool;
}

// ========================================
// TYPES
// ========================================

export type MemoryType = 'preference' | 'success_pattern' | 'failure_pattern' | 'insight' | 'context';

export interface AgentMemory {
  id: string;
  userId: string;
  memoryType: MemoryType;
  title: string;
  description: string;
  tags: string[];
  relatedTaskIds: string[];
  relatedConversationId: string | null;
  confidenceScore: number;
  relevanceScore: number;
  accessCount: number;
  createdAt: number;
  lastAccessedAt: number | null;
  expiresAt: number | null;
  source: string;
  metadata: any;
  isDeprecated: boolean;
  deprecatedAt: number | null;
  deprecatedReason: string | null;
}

export interface MemoryQuery {
  userId: string;
  types?: MemoryType[];
  tags?: string[];
  minConfidence?: number;
  minRelevance?: number;
  limit?: number;
  includeExpired?: boolean;
  includeDeprecated?: boolean;
}

export interface MemoryContext {
  preferences: AgentMemory[];
  successPatterns: AgentMemory[];
  failurePatterns: AgentMemory[];
  insights: AgentMemory[];
  contextual: AgentMemory[];
}

// ========================================
// MEMORY RETRIEVAL
// ========================================

/**
 * Get active memories for a user
 */
export async function getActiveMemories(query: MemoryQuery): Promise<AgentMemory[]> {
  const {
    userId,
    types,
    tags,
    minConfidence = 0.3,
    minRelevance = 0.3,
    limit = 50,
    includeExpired = false,
    includeDeprecated = false
  } = query;

  try {
    const conditions: string[] = ['user_id = $1'];
    const params: any[] = [userId];
    let paramIndex = 2;

    // Filter by memory types
    if (types && types.length > 0) {
      conditions.push(`memory_type = ANY($${paramIndex})`);
      params.push(types);
      paramIndex++;
    }

    // Filter by confidence and relevance
    conditions.push(`confidence_score >= $${paramIndex}`);
    params.push(minConfidence);
    paramIndex++;

    conditions.push(`relevance_score >= $${paramIndex}`);
    params.push(minRelevance);
    paramIndex++;

    // Exclude deprecated unless explicitly requested
    if (!includeDeprecated) {
      conditions.push('is_deprecated = false');
    }

    // Exclude expired unless explicitly requested
    if (!includeExpired) {
      const now = Date.now();
      conditions.push(`(expires_at IS NULL OR expires_at > ${now})`);
    }

    const sql = `
      SELECT * FROM agent_memory
      WHERE ${conditions.join(' AND ')}
      ORDER BY relevance_score DESC, confidence_score DESC
      LIMIT $${paramIndex}
    `;

    params.push(limit);

    const result = await getPool().query(sql, params);

    // Update access tracking for retrieved memories
    if (result.rows.length > 0) {
      await updateAccessTracking(result.rows.map(m => m.id));
    }

    return result.rows.map(mapMemoryFromDb);

  } catch (error: any) {
    console.error('[MEMORY_READER] Exception fetching memories:', error.message);
    return [];
  }
}

/**
 * Get memory context organized by type
 */
export async function getMemoryContext(userId: string): Promise<MemoryContext> {
  const memories = await getActiveMemories({
    userId,
    limit: 100
  });

  const context: MemoryContext = {
    preferences: memories.filter(m => m.memoryType === 'preference'),
    successPatterns: memories.filter(m => m.memoryType === 'success_pattern'),
    failurePatterns: memories.filter(m => m.memoryType === 'failure_pattern'),
    insights: memories.filter(m => m.memoryType === 'insight'),
    contextual: memories.filter(m => m.memoryType === 'context')
  };

  return context;
}

/**
 * Get memories relevant to specific tags
 */
export async function getMemoriesByTags(userId: string, tags: string[]): Promise<AgentMemory[]> {
  if (tags.length === 0) {
    return [];
  }

  try {
    const result = await getPool().query(`
      SELECT * FROM agent_memory
      WHERE user_id = $1
        AND is_deprecated = false
        AND tags && $2::text[]
      ORDER BY relevance_score DESC
      LIMIT 20
    `, [userId, tags]);

    if (result.rows.length > 0) {
      await updateAccessTracking(result.rows.map(m => m.id));
    }

    return result.rows.map(mapMemoryFromDb);

  } catch (error: any) {
    console.error('[MEMORY_READER] Exception fetching memories by tags:', error.message);
    return [];
  }
}

/**
 * Get a single memory by ID
 */
export async function getMemoryById(memoryId: string): Promise<AgentMemory | null> {
  try {
    const result = await getPool().query(`
      SELECT * FROM agent_memory
      WHERE id = $1
    `, [memoryId]);

    if (result.rows.length === 0) {
      return null;
    }

    await updateAccessTracking([memoryId]);

    return mapMemoryFromDb(result.rows[0]);

  } catch (error: any) {
    console.error('[MEMORY_READER] Exception fetching memory by ID:', error.message);
    return null;
  }
}

// ========================================
// MEMORY RANKING
// ========================================

/**
 * Rank memories by relevance to current context
 */
export function rankMemoriesByRelevance(
  memories: AgentMemory[],
  contextTags: string[],
  recentTaskIds: string[]
): AgentMemory[] {
  return memories
    .map(memory => {
      let score = memory.relevanceScore * memory.confidenceScore;

      // Boost for matching tags
      const matchingTags = memory.tags.filter(tag => contextTags.includes(tag)).length;
      score += matchingTags * 0.1;

      // Boost for related to recent tasks
      const relatedToRecent = memory.relatedTaskIds.some(id => recentTaskIds.includes(id));
      if (relatedToRecent) {
        score += 0.2;
      }

      // Boost for recently accessed
      if (memory.lastAccessedAt) {
        const daysSinceAccess = (Date.now() - memory.lastAccessedAt) / (1000 * 60 * 60 * 24);
        if (daysSinceAccess < 7) {
          score += 0.1;
        }
      }

      // Penalty for low access count (untested memories)
      if (memory.accessCount < 3) {
        score *= 0.8;
      }

      return { ...memory, computedScore: score };
    })
    .sort((a: any, b: any) => b.computedScore - a.computedScore);
}

// ========================================
// MEMORY SUMMARIZATION
// ========================================

/**
 * Summarize memory context for prompts
 */
export function summarizeMemoryContext(context: MemoryContext): string {
  const parts: string[] = [];

  if (context.preferences.length > 0) {
    parts.push('**User Preferences:**');
    context.preferences.slice(0, 5).forEach(m => {
      parts.push(`- ${m.title}: ${m.description}`);
    });
    parts.push('');
  }

  if (context.successPatterns.length > 0) {
    parts.push('**Successful Patterns:**');
    context.successPatterns.slice(0, 3).forEach(m => {
      parts.push(`- ${m.title}: ${m.description}`);
    });
    parts.push('');
  }

  if (context.failurePatterns.length > 0) {
    parts.push('**Patterns to Avoid:**');
    context.failurePatterns.slice(0, 3).forEach(m => {
      parts.push(`- ${m.title}: ${m.description}`);
    });
    parts.push('');
  }

  if (context.insights.length > 0) {
    parts.push('**Key Insights:**');
    context.insights.slice(0, 3).forEach(m => {
      parts.push(`- ${m.description}`);
    });
    parts.push('');
  }

  return parts.join('\n');
}

// ========================================
// HELPER FUNCTIONS
// ========================================

/**
 * Update access tracking for memories
 */
async function updateAccessTracking(memoryIds: string[]): Promise<void> {
  if (memoryIds.length === 0) {
    return;
  }

  try {
    const now = Date.now();

    await getPool().query(`
      UPDATE agent_memory
      SET
        access_count = access_count + 1,
        last_accessed_at = $1
      WHERE id = ANY($2)
    `, [now, memoryIds]);

  } catch (error: any) {
    console.error('[MEMORY_READER] Error updating access tracking:', error.message);
  }
}

/**
 * Map database row to AgentMemory type
 */
function mapMemoryFromDb(row: any): AgentMemory {
  return {
    id: row.id,
    userId: row.user_id,
    memoryType: row.memory_type,
    title: row.title,
    description: row.description,
    tags: row.tags || [],
    relatedTaskIds: row.related_task_ids || [],
    relatedConversationId: row.related_conversation_id,
    confidenceScore: row.confidence_score,
    relevanceScore: row.relevance_score,
    accessCount: row.access_count,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    expiresAt: row.expires_at,
    source: row.source,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}),
    isDeprecated: row.is_deprecated,
    deprecatedAt: row.deprecated_at,
    deprecatedReason: row.deprecated_reason
  };
}

// ========================================
// EXPORTS
// ========================================

export default {
  getActiveMemories,
  getMemoryContext,
  getMemoriesByTags,
  getMemoryById,
  rankMemoriesByRelevance,
  summarizeMemoryContext
};
