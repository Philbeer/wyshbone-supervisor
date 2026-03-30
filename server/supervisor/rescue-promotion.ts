/**
 * Rescue Promotion Loop — Global Learning System
 *
 * Promotes successful rescue patterns into the mission extractor prompt.
 * As patterns get promoted, the same failures stop happening — the system
 * literally gets smarter from every failure.
 *
 * Can be run as:
 * - Manual trigger from admin panel
 * - Weekly cron job
 * - On-demand via API endpoint
 *
 * File: server/supervisor/rescue-promotion.ts
 * Repo: wyshbone-supervisor-Post-CC
 */

import { supabase } from '../supabase';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PromotionCandidate {
  id: string;
  original_query: string;
  rewritten_mission: any;
  reasoning: string;
  pattern_category: string;
  pattern_frequency: number;
  confidence: number;
}

interface ExtractorExample {
  category: string;
  userInput: string;
  expectedOutput: any;
  explanation: string;
  frequency: number;
}

interface PromotionReport {
  promoted: number;
  categories: string[];
  examples: ExtractorExample[];
  message: string;
  timestamp: string;
}

// ─── Promoted patterns storage ──────────────────────────────────────────────

// In-memory cache of promoted patterns, refreshed hourly
let _promotedPatterns: ExtractorExample[] | null = null;
let _promotedCacheTime = 0;
const PROMOTED_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get all promoted patterns for injection into the mission extractor prompt.
 * Returns cached data, refreshed hourly.
 */
export async function getPromotedPatterns(): Promise<ExtractorExample[]> {
  if (_promotedPatterns && Date.now() - _promotedCacheTime < PROMOTED_CACHE_TTL_MS) {
    return _promotedPatterns;
  }

  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('rescue_log')
      .select('original_query, rewritten_mission, reasoning, pattern_category, pattern_frequency')
      .eq('rescue_outcome', 'self_healed')
      .eq('rescue_succeeded', true)
      .eq('promoted_to_extractor', true)
      .order('pattern_frequency', { ascending: false })
      .limit(30);

    if (error) {
      console.warn(`[RESCUE_PROMOTION] Failed to load promoted patterns: ${error.message}`);
      return _promotedPatterns || [];
    }

    _promotedPatterns = (data || []).map((row: any) => ({
      category: row.pattern_category || 'uncategorized',
      userInput: row.original_query,
      expectedOutput: row.rewritten_mission,
      explanation: row.reasoning,
      frequency: row.pattern_frequency || 1,
    }));
    _promotedCacheTime = Date.now();

    console.log(`[RESCUE_PROMOTION] Loaded ${_promotedPatterns.length} promoted patterns`);
    return _promotedPatterns;
  } catch (err: any) {
    console.warn(`[RESCUE_PROMOTION] Pattern loading failed (non-fatal): ${err.message}`);
    return _promotedPatterns || [];
  }
}

/**
 * Invalidate the cache so next call to getPromotedPatterns() fetches fresh data.
 */
export function invalidatePromotedCache(): void {
  _promotedPatterns = null;
  _promotedCacheTime = 0;
}

// ─── Dynamic extractor prompt section ───────────────────────────────────────

/**
 * Build the dynamic "learned edge cases" section for the mission extractor prompt.
 * Called by the mission extractor before each extraction.
 */
export async function buildLearnedEdgeCasesSection(): Promise<string> {
  const examples = await getPromotedPatterns();
  if (examples.length === 0) return '';

  const lines = examples.map(ex => {
    const missionStr = typeof ex.expectedOutput === 'string'
      ? ex.expectedOutput
      : JSON.stringify(ex.expectedOutput);

    return `### Pattern: ${ex.category}
User said: "${ex.userInput}"
Correct extraction: ${missionStr}
Why: ${ex.explanation}
(Seen ${ex.frequency} times across users)`;
  });

  return `
## LEARNED EDGE CASES (from real user interactions):
${lines.join('\n\n')}
`;
}

// ─── Promotion job ──────────────────────────────────────────────────────────

function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const k = String(item[key] || 'uncategorized');
    if (!result[k]) result[k] = [];
    result[k].push(item);
  }
  return result;
}

/**
 * Find and promote high-confidence, high-frequency rescue patterns into
 * the mission extractor prompt. Can be run as a cron job or manually.
 *
 * Criteria for promotion:
 * - outcome = 'self_healed'
 * - rescue_succeeded = true (the self-healed mission actually delivered leads)
 * - not already promoted
 * - is_global_pattern = true (seen across multiple users)
 * - pattern_frequency >= 3 (seen at least 3 times)
 * - confidence >= 0.8
 */
export async function promoteLearnedPatterns(): Promise<PromotionReport> {
  const timestamp = new Date().toISOString();

  if (!supabase) {
    return {
      promoted: 0,
      categories: [],
      examples: [],
      message: 'Supabase not available',
      timestamp,
    };
  }

  try {
    // 1. Find high-confidence, high-frequency patterns not yet promoted
    const { data: candidates, error } = await supabase
      .from('rescue_log')
      .select('id, original_query, rewritten_mission, reasoning, pattern_category, pattern_frequency, confidence')
      .eq('rescue_outcome', 'self_healed')
      .eq('rescue_succeeded', true)
      .eq('promoted_to_extractor', false)
      .eq('is_global_pattern', true)
      .gte('pattern_frequency', 3)
      .gte('confidence', 0.8)
      .order('pattern_frequency', { ascending: false })
      .limit(10);

    if (error) {
      console.error(`[RESCUE_PROMOTION] Failed to query candidates: ${error.message}`);
      return {
        promoted: 0,
        categories: [],
        examples: [],
        message: `Query failed: ${error.message}`,
        timestamp,
      };
    }

    if (!candidates || candidates.length === 0) {
      console.log('[RESCUE_PROMOTION] No new patterns ready for promotion');
      return {
        promoted: 0,
        categories: [],
        examples: [],
        message: 'No new patterns ready for promotion',
        timestamp,
      };
    }

    // 2. Group by pattern_category and pick the best example from each
    const grouped = groupBy(candidates as PromotionCandidate[], 'pattern_category');
    const newExamples: ExtractorExample[] = [];

    for (const [category, patterns] of Object.entries(grouped)) {
      // Pick the highest-frequency example from each category
      const bestExample = patterns[0]; // already sorted by frequency desc

      newExamples.push({
        category,
        userInput: bestExample.original_query,
        expectedOutput: bestExample.rewritten_mission,
        explanation: bestExample.reasoning,
        frequency: bestExample.pattern_frequency,
      });
    }

    // 3. Mark patterns as promoted
    const promotedIds = candidates.map((c: any) => c.id);
    const { error: updateErr } = await supabase
      .from('rescue_log')
      .update({
        promoted_to_extractor: true,
        promoted_at: timestamp,
      })
      .in('id', promotedIds);

    if (updateErr) {
      console.error(`[RESCUE_PROMOTION] Failed to mark patterns as promoted: ${updateErr.message}`);
    }

    // 4. Invalidate cache so new patterns are picked up
    invalidatePromotedCache();

    const report: PromotionReport = {
      promoted: newExamples.length,
      categories: Object.keys(grouped),
      examples: newExamples,
      message: `Promoted ${newExamples.length} patterns across ${Object.keys(grouped).length} categories`,
      timestamp,
    };

    console.log(`[RESCUE_PROMOTION] ${report.message}`);
    for (const ex of newExamples) {
      console.log(`[RESCUE_PROMOTION]   ${ex.category}: "${ex.userInput.substring(0, 60)}" → ${JSON.stringify(ex.expectedOutput).substring(0, 100)} (freq=${ex.frequency})`);
    }

    return report;
  } catch (err: any) {
    console.error(`[RESCUE_PROMOTION] Promotion failed: ${err.message}`);
    return {
      promoted: 0,
      categories: [],
      examples: [],
      message: `Promotion failed: ${err.message}`,
      timestamp: new Date().toISOString(),
    };
  }
}

// ─── Stats / admin endpoint ─────────────────────────────────────────────────

export interface RescueDashboardStats {
  total_rescues: number;
  self_healed: number;
  clarifications: number;
  self_heal_success_rate: number;
  promoted_count: number;
  top_categories: Array<{ category: string; count: number }>;
  recent_rescues: Array<{
    created_at: string;
    original_query: string;
    rescue_outcome: string;
    reasoning: string;
    pattern_category: string;
    rescue_succeeded: boolean | null;
  }>;
}

export async function getRescueDashboardStats(): Promise<RescueDashboardStats | null> {
  if (!supabase) return null;

  try {
    // Get all rescue events (last 500)
    const { data: all } = await supabase
      .from('rescue_log')
      .select('rescue_outcome, rescue_succeeded, pattern_category, promoted_to_extractor, created_at, original_query, reasoning')
      .order('created_at', { ascending: false })
      .limit(500);

    if (!all || all.length === 0) {
      return {
        total_rescues: 0,
        self_healed: 0,
        clarifications: 0,
        self_heal_success_rate: 0,
        promoted_count: 0,
        top_categories: [],
        recent_rescues: [],
      };
    }

    const selfHealed = all.filter((r: any) => r.rescue_outcome === 'self_healed');
    const clarifications = all.filter((r: any) => r.rescue_outcome === 'clarification_needed');
    const succeeded = selfHealed.filter((r: any) => r.rescue_succeeded === true);
    const promoted = all.filter((r: any) => r.promoted_to_extractor === true);

    // Count categories
    const catCounts = new Map<string, number>();
    for (const r of all as any[]) {
      const cat = r.pattern_category || 'uncategorized';
      catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
    }
    const topCategories = Array.from(catCounts.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Recent rescues (last 20)
    const recent = all.slice(0, 20).map((r: any) => ({
      created_at: r.created_at,
      original_query: r.original_query?.substring(0, 100) || '',
      rescue_outcome: r.rescue_outcome,
      reasoning: r.reasoning?.substring(0, 150) || '',
      pattern_category: r.pattern_category || 'uncategorized',
      rescue_succeeded: r.rescue_succeeded,
    }));

    return {
      total_rescues: all.length,
      self_healed: selfHealed.length,
      clarifications: clarifications.length,
      self_heal_success_rate: selfHealed.length > 0
        ? Math.round((succeeded.length / selfHealed.length) * 100)
        : 0,
      promoted_count: promoted.length,
      top_categories: topCategories,
      recent_rescues: recent,
    };
  } catch (err: any) {
    console.warn(`[RESCUE_PROMOTION] Dashboard stats failed: ${err.message}`);
    return null;
  }
}