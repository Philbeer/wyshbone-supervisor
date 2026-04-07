/**
 * Rescue LLM — Emergency recovery for failed mission extractions
 *
 * When the mission extractor fails (e.g. user says "anywhere" to a location
 * clarification), this module either:
 *   A) Self-heals the query by rewriting it as a valid mission (70%+ of cases)
 *   B) Asks ONE specific clarifying question (30% fallback)
 *
 * The user NEVER sees "I can't help" again.
 *
 * Also includes logging to rescue_log table and learned-pattern loading
 * from the global learning loop.
 *
 * File: server/supervisor/rescue-llm.ts
 * Repo: wyshbone-supervisor-Post-CC
 */

import { supabase } from '../supabase';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RescueResult {
  outcome: 'self_healed' | 'clarification_needed';
  reasoning: string;
  /** Present when outcome === 'self_healed' */
  rewrittenMission?: {
    business_type: string;
    location: string;
    criteria?: string;
  };
  confidence?: number;
  /** Present when outcome === 'clarification_needed' */
  clarificationQuestion?: string;
  missingFields?: string[];
}

export interface RescueParams {
  originalQuery: string;
  conversationHistory: Array<{ role: string; content: string }>;
  failureReason: string;
  extractedGoal: any;
  canonicalIntent: string | null;
  userId: string;
  jobId: string;
  clientRequestId: string;
  conversationId?: string;
}

interface LearnedPattern {
  trigger: string;
  resolution: string;
  mission: any;
  category: string;
}

interface RescueLogParams {
  outcome: string;
  reasoning: string;
  originalQuery: string;
  failureReason: string;
  rewrittenMission?: any;
  clarificationQuestion?: string;
  missingFields?: string[];
  confidence?: number;
  userId: string;
  conversationId?: string;
  runId: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  partialExtraction?: any;
}

// ─── Circuit breaker — prevent runaway rescue calls ─────────────────────────

const _rescueCallTimestamps: number[] = [];
const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const CIRCUIT_BREAKER_MAX_CALLS = 20;

function isCircuitBroken(): boolean {
  const cutoff = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;
  // Evict old entries
  while (_rescueCallTimestamps.length > 0 && _rescueCallTimestamps[0] < cutoff) {
    _rescueCallTimestamps.shift();
  }
  return _rescueCallTimestamps.length >= CIRCUIT_BREAKER_MAX_CALLS;
}

function recordRescueCall(): void {
  _rescueCallTimestamps.push(Date.now());
}

// ─── Max 1 self-heal per conversation turn ──────────────────────────────────

const _rescueAttemptsPerRun = new Map<string, number>();

function hasAlreadyRescued(runId: string): boolean {
  return (_rescueAttemptsPerRun.get(runId) ?? 0) >= 1;
}

function recordRescueAttempt(runId: string): void {
  _rescueAttemptsPerRun.set(runId, (_rescueAttemptsPerRun.get(runId) ?? 0) + 1);
}

// Cleanup old entries every 10 minutes to prevent memory leaks
setInterval(() => {
  if (_rescueAttemptsPerRun.size > 1000) {
    _rescueAttemptsPerRun.clear();
  }
}, 10 * 60 * 1000);

// ─── LLM call (Haiku — cheap + fast, only fires on failures) ───────────────

async function callAnthropicHaiku(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot call rescue LLM');
  }

  const model = process.env.RESCUE_LLM_MODEL || 'claude-3-haiku-20240307';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${body.substring(0, 200)}`);
  }

  const data = await resp.json() as { content: Array<{ type: string; text?: string }> };
  const textBlock = data.content?.find((b) => b.type === 'text');
  return textBlock?.text || '';
}

// ─── Learned patterns loader ────────────────────────────────────────────────

let _cachedPatterns: LearnedPattern[] | null = null;
let _patternsCacheTime = 0;
const PATTERNS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getLearnedRescuePatterns(): Promise<LearnedPattern[]> {
  // Return cached if fresh
  if (_cachedPatterns && Date.now() - _patternsCacheTime < PATTERNS_CACHE_TTL_MS) {
    return _cachedPatterns;
  }

  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('rescue_log')
      .select('original_query, rewritten_mission, reasoning, pattern_category')
      .eq('rescue_outcome', 'self_healed')
      .eq('rescue_succeeded', true)
      .eq('is_global_pattern', true)
      .order('pattern_frequency', { ascending: false })
      .limit(20);

    if (error) {
      console.warn(`[RESCUE_LLM] Failed to load learned patterns: ${error.message}`);
      return _cachedPatterns || [];
    }

    _cachedPatterns = (data || []).map((row: any) => ({
      trigger: row.original_query,
      resolution: row.reasoning,
      mission: row.rewritten_mission,
      category: row.pattern_category,
    }));
    _patternsCacheTime = Date.now();

    console.log(`[RESCUE_LLM] Loaded ${_cachedPatterns.length} learned patterns from rescue_log`);
    return _cachedPatterns;
  } catch (err: any) {
    console.warn(`[RESCUE_LLM] Pattern loading failed (non-fatal): ${err.message}`);
    return _cachedPatterns || [];
  }
}

// ─── Pattern categorisation ─────────────────────────────────────────────────

function categorizePattern(
  failureReason: string,
  missingFields?: string[],
  originalQuery?: string,
): string {
  const q = (originalQuery || '').toLowerCase();

  // Location patterns
  if (/\b(anywhere|everywhere|nationwide|all over|whole country|uk\s*wide)\b/i.test(q)) {
    return 'location_ambiguity';
  }
  if (/\b(near me|local|around here|my area|nearby)\b/i.test(q)) {
    return 'location_too_vague';
  }
  if (failureReason.includes('location') || (missingFields && missingFields.includes('location'))) {
    return 'location_too_vague';
  }

  // Business type patterns
  if (failureReason.includes('business_type') || (missingFields && missingFields.includes('business_type'))) {
    return 'missing_business_type';
  }

  // Clarification mismatch
  if (failureReason.includes('clarification') || failureReason.includes('pass2_sch')) {
    return 'clarification_mismatch';
  }

  // Compound queries
  if (/\band\b/.test(q) && /\bin\b/.test(q)) {
    return 'compound_query';
  }

  // Slang
  if (/\b(peeps|places|spots|joints|gafs|gaffs)\b/i.test(q)) {
    return 'slang_or_shorthand';
  }

  return 'uncategorized';
}

// ─── Similar pattern finder (for frequency counting) ────────────────────────

async function findSimilarRescuePattern(
  failureReason: string,
  outcome: string,
  rewrittenMission?: any,
): Promise<{ id: string; pattern_frequency: number } | null> {
  if (!supabase) return null;

  try {
    const category = categorizePattern(failureReason);

    const { data } = await supabase
      .from('rescue_log')
      .select('id, pattern_frequency')
      .eq('rescue_outcome', outcome)
      .eq('pattern_category', category)
      .order('created_at', { ascending: false })
      .limit(1);

    if (data && data.length > 0) {
      return data[0] as { id: string; pattern_frequency: number };
    }
  } catch (err: any) {
    console.warn(`[RESCUE_LLM] findSimilarRescuePattern failed (non-fatal): ${err.message}`);
  }

  return null;
}

// ─── Core rescue function ───────────────────────────────────────────────────

export async function attemptRescueLLM(params: RescueParams): Promise<RescueResult> {
  const startTime = Date.now();

  // Circuit breaker check
  if (isCircuitBroken()) {
    console.error(`[RESCUE_LLM] Circuit breaker OPEN — ${CIRCUIT_BREAKER_MAX_CALLS} rescue calls in ${CIRCUIT_BREAKER_WINDOW_MS / 1000}s. Falling back to generic clarification.`);
    return buildGenericClarification('Circuit breaker triggered — too many rescue calls');
  }

  // Max 1 self-heal per run
  if (hasAlreadyRescued(params.jobId)) {
    console.warn(`[RESCUE_LLM] Already rescued runId=${params.jobId} — returning clarification instead of second self-heal`);
    return buildGenericClarification('Already attempted rescue for this conversation turn');
  }

  recordRescueCall();
  recordRescueAttempt(params.jobId);

  // Load learned patterns from DB
  let learnedPatterns: LearnedPattern[] = [];
  try {
    learnedPatterns = await getLearnedRescuePatterns();
  } catch (e: any) {
    console.warn(`[RESCUE_LLM] Pattern loading failed (non-fatal): ${e.message}`);
  }

  const learnedPatternsBlock = learnedPatterns.length > 0
    ? `\nLEARNED PATTERNS FROM PAST RESCUES:\n${learnedPatterns.map(p => `- When user says "${p.trigger}", it means: ${p.resolution}`).join('\n')}\n`
    : '';

  const conversationSnippet = params.conversationHistory
    .slice(-6)
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.substring(0, 200) : ''}`)
    .join('\n');

  const rescueSystemPrompt = `You are a rescue system for a sales lead generation AI called Wyshbone.

A user's query failed mission extraction. Your job is to either:
A) Figure out what they meant and rewrite it as a valid mission (SELF-HEAL)
B) Ask ONE specific clarifying question if you genuinely cannot infer the answer

BIAS STRONGLY TOWARD SELF-HEALING. Only ask for clarification if you truly cannot figure out what the user wants. Users hate being asked unnecessary questions.

MISSION REQUIREMENTS:
A valid mission needs:
- business_type: what kind of businesses to find (e.g. "pubs", "cardboard recycling companies")
- location: where to search (can be a city, county, region, or "United Kingdom" for nationwide)
- criteria: optional filters (e.g. "that buy wholesale", "with live music")

COMMON INFERENCE PATTERNS:
- "anywhere" / "everywhere" / "nationwide" / "all over" / "whole country" / "uk wide" → location = "United Kingdom"
- Vague locations like "near me" without prior context → ASK for specific location
- If the user gave a business type in an earlier message but location failed → keep the business type, fix the location
- If the conversation history contains enough info to build a complete mission → SELF-HEAL, don't ask
- If someone answers a clarification with just a location word → combine with the original query context
${learnedPatternsBlock}
RESPONSE FORMAT (JSON only, no other text):

For self-heal:
{
  "outcome": "self_healed",
  "reasoning": "Brief explanation of what was inferred",
  "rewrittenMission": {
    "business_type": "the kind of business",
    "location": "the location",
    "criteria": "any filters or criteria (optional)"
  },
  "confidence": 0.9
}

For clarification:
{
  "outcome": "clarification_needed",
  "reasoning": "Brief explanation of what is missing",
  "clarificationQuestion": "A friendly, specific question for the user",
  "missingFields": ["business_type", "location"]
}`;

  const rescueUserPrompt = `CONTEXT:
- Original user query: "${params.originalQuery}"
- Why extraction failed: ${params.failureReason}
- Partial extraction (if any): ${JSON.stringify(params.extractedGoal)}
- Detected intent: ${params.canonicalIntent || 'none'}

CONVERSATION HISTORY (last 6 messages):
${conversationSnippet}

Rescue this query — either self-heal or ask a specific clarification question.`;

  try {
    const rawResponse = await callAnthropicHaiku(rescueSystemPrompt, rescueUserPrompt);
    const duration = Date.now() - startTime;
    console.log(`[RESCUE_LLM] LLM call completed in ${duration}ms`);

    // Parse JSON response
    const cleaned = rawResponse.trim()
      .replace(/^```json\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();

    const parsed = JSON.parse(cleaned) as RescueResult;

    // Validate the response shape
    if (parsed.outcome === 'self_healed') {
      if (!parsed.rewrittenMission?.business_type || !parsed.rewrittenMission?.location) {
        console.warn(`[RESCUE_LLM] Self-heal missing required fields — falling back to clarification`);
        return buildGenericClarification('Self-heal response was incomplete');
      }
    } else if (parsed.outcome === 'clarification_needed') {
      if (!parsed.clarificationQuestion) {
        return buildGenericClarification('Clarification response was empty');
      }
    } else {
      console.warn(`[RESCUE_LLM] Unknown outcome "${parsed.outcome}" — falling back to clarification`);
      return buildGenericClarification('Unknown rescue outcome');
    }

    return parsed;
  } catch (err: any) {
    const duration = Date.now() - startTime;
    console.error(`[RESCUE_LLM] Rescue LLM call failed after ${duration}ms: ${err.message}`);
    // Fall back to a generic clarification — never let the user see an error
    return buildGenericClarification(`LLM call failed: ${err.message}`);
  }
}

// ─── Generic clarification fallback ─────────────────────────────────────────

function buildGenericClarification(reason: string): RescueResult {
  return {
    outcome: 'clarification_needed',
    reasoning: reason,
    clarificationQuestion:
      "I want to make sure I find exactly the right leads for you. Could you tell me a bit more about what you're looking for — specifically, what type of business and where?",
    missingFields: ['business_type', 'location'],
  };
}

// ─── Rescue event logging ───────────────────────────────────────────────────

export async function logRescueEvent(params: RescueLogParams): Promise<void> {
  if (!supabase) {
    console.warn(`[RESCUE_LOG] Supabase not available — skipping rescue log`);
    return;
  }

  try {
    const category = categorizePattern(
      params.failureReason,
      params.missingFields,
      params.originalQuery,
    );

    // Check for existing similar pattern (for frequency counting)
    const existingPattern = await findSimilarRescuePattern(
      params.failureReason,
      params.outcome,
      params.rewrittenMission,
    );

    if (existingPattern) {
      // Increment frequency counter on existing pattern
      const newFreq = existingPattern.pattern_frequency + 1;
      await supabase
        .from('rescue_log')
        .update({
          pattern_frequency: newFreq,
          is_global_pattern: newFreq >= 3, // auto-flag after 3 occurrences
        })
        .eq('id', existingPattern.id);
      console.log(`[RESCUE_LOG] Incremented frequency on existing pattern ${existingPattern.id} → ${newFreq}`);
    }

    // Always log the individual event
    const { error } = await supabase.from('rescue_log').insert({
      original_query: params.originalQuery,
      conversation_history: params.conversationHistory
        ? JSON.stringify(params.conversationHistory.slice(-6))
        : null,
      failure_reason: params.failureReason,
      partial_extraction: params.partialExtraction
        ? JSON.stringify(params.partialExtraction)
        : null,
      rescue_outcome: params.outcome,
      reasoning: params.reasoning,
      rewritten_mission: params.rewrittenMission
        ? JSON.stringify(params.rewrittenMission)
        : null,
      clarification_question: params.clarificationQuestion ?? null,
      missing_fields: params.missingFields ?? null,
      confidence: params.confidence ?? null,
      user_id: params.userId,
      conversation_id: params.conversationId ?? null,
      run_id: params.runId,
      pattern_category: category,
    });

    if (error) {
      console.error(`[RESCUE_LOG] Insert failed: ${error.message}`);
    } else {
      console.log(`[RESCUE_LOG] Logged rescue event: outcome=${params.outcome} category=${category} runId=${params.runId}`);
    }
  } catch (err: any) {
    console.error(`[RESCUE_LOG] logRescueEvent failed (non-fatal): ${err.message}`);
  }
}

// ─── Success tracking (called after a rescued mission completes) ────────────

export async function updateRescueSuccess(
  runId: string,
  succeeded: boolean,
  leadsDelivered: number,
): Promise<void> {
  if (!supabase) return;

  try {
    const { error } = await supabase
      .from('rescue_log')
      .update({
        rescue_succeeded: succeeded,
        leads_delivered: leadsDelivered,
      })
      .eq('run_id', runId)
      .eq('rescue_outcome', 'self_healed');

    if (error) {
      console.warn(`[RESCUE_LOG] Success update failed for runId=${runId}: ${error.message}`);
    } else {
      console.log(`[RESCUE_LOG] Updated rescue success: runId=${runId} succeeded=${succeeded} leads=${leadsDelivered}`);
    }
  } catch (err: any) {
    console.warn(`[RESCUE_LOG] updateRescueSuccess failed (non-fatal): ${err.message}`);
  }
}

// ─── Get rescue stats (for admin/diagnostics) ──────────────────────────────

export async function getRescueStats(): Promise<{
  total_rescues: number;
  self_healed: number;
  clarifications: number;
  self_heal_success_rate: number;
  top_categories: Array<{ category: string; count: number }>;
} | null> {
  if (!supabase) return null;

  try {
    const { data: all } = await supabase
      .from('rescue_log')
      .select('rescue_outcome, rescue_succeeded, pattern_category')
      .order('created_at', { ascending: false })
      .limit(500);

    if (!all || all.length === 0) {
      return {
        total_rescues: 0,
        self_healed: 0,
        clarifications: 0,
        self_heal_success_rate: 0,
        top_categories: [],
      };
    }

    const selfHealed = all.filter((r: any) => r.rescue_outcome === 'self_healed');
    const clarifications = all.filter((r: any) => r.rescue_outcome === 'clarification_needed');
    const succeeded = selfHealed.filter((r: any) => r.rescue_succeeded === true);

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

    return {
      total_rescues: all.length,
      self_healed: selfHealed.length,
      clarifications: clarifications.length,
      self_heal_success_rate: selfHealed.length > 0
        ? Math.round((succeeded.length / selfHealed.length) * 100)
        : 0,
      top_categories: topCategories,
    };
  } catch (err: any) {
    console.warn(`[RESCUE_LOG] getRescueStats failed: ${err.message}`);
    return null;
  }
}