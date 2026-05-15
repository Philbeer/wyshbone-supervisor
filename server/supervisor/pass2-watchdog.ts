import type { StructuredMission } from './mission-schema';
import { callLLMText } from './llm-failover';
import { logAFREvent } from './afr-logger';

export type WatchdogVerdict = 'pass' | 'retry' | 'block';
export type WatchdogMode = 'off' | 'shadow' | 'retry' | 'full';

export interface WatchdogDroppedConcept {
  category: 'relationship' | 'time' | 'status' | 'website_evidence' | 'scoping' | 'exclusion' | 'ranking' | 'other';
  matched_phrase: string;
  expected_constraint_type: string;
  severity: 'hard' | 'soft';
  reasoning: string;
}

export interface WatchdogResult {
  verdict: WatchdogVerdict;
  ok: boolean;
  dropped_concepts: WatchdogDroppedConcept[];
  reasoning: string;
  latency_ms: number;
  provider_used: string | null;
  parse_ok: boolean;
  raw_response: string;
  failure_reason: string | null;
}

export function getPass2WatchdogMode(): WatchdogMode {
  const m = (process.env.PASS2_WATCHDOG_MODE || 'off').toLowerCase();
  if (m === 'shadow' || m === 'retry' || m === 'full') return m;
  return 'off';
}

const WATCHDOG_SYSTEM_PROMPT = `You are a Pass 2 mission watchdog for a B2B lead-generation pipeline. Given a raw user query, a Pass 1 semantic interpretation, and a Pass 2 structured mission, you decide whether the structured mission faithfully preserves the meaning of the raw query.

You are looking for DROPPED MEANING — things the user asked for that the structured mission no longer represents.

Categories to check:
1. RELATIONSHIP — verbs like "works with", "partners with", "supplies", "managed by", "accredited by", "owned by", "supplied by", "funded by", "endorsed by", "registered with" require a relationship_check constraint. Not attribute_check.
2. SCOPING — geographic, organisational, or membership scoping the mission omits.
3. EXCLUSION — "not", "excluding", "other than" phrasing the mission doesn't honour.
4. TIME — "recently opened", "established before 2020", "in the last 6 months" require time_constraint.
5. STATUS — "currently trading", "still operating", "for sale" require status_check.
6. WEBSITE_EVIDENCE — "mentions X on their website", "their site says Y" require website_evidence.
7. RANKING — "best", "top 10", "highest rated" require ranking.

Critical distinction between attribute_check and relationship_check:
- "restaurants that serve food in Bath" → attribute_check (serving food is an inherent attribute of being a restaurant — no other entity involved)
- "organisations that work with the local authority in Sussex" → relationship_check (the org has a relationship with another distinct entity — the local authority)
- "solicitors that work with the NHS" → relationship_check (relationship with NHS)
- "suppliers that supply Tesco" → relationship_check (relationship with Tesco)
- "pubs in Arundel" → no relationship verb at all → no relationship_check needed

Verdict rules:
- "pass" — the structured mission preserves all meaningful constraints from the raw query.
- "retry" — one or more SOFT concepts dropped; re-running Pass 2 with feedback would likely fix it.
- "block" — one or more HARD concepts dropped (relational verb, exclusion, hard time/status); the mission would produce wrong results.

Output STRICT JSON ONLY. No preamble, no commentary, no markdown fences. Schema:
{
  "verdict": "pass" | "retry" | "block",
  "dropped_concepts": [
    {
      "category": "relationship" | "time" | "status" | "website_evidence" | "scoping" | "exclusion" | "ranking" | "other",
      "matched_phrase": "exact phrase from raw query",
      "expected_constraint_type": "relationship_check | time_constraint | status_check | website_evidence | ranking | location_constraint",
      "severity": "hard" | "soft",
      "reasoning": "one sentence why this was dropped"
    }
  ],
  "reasoning": "one or two sentences explaining the overall verdict"
}`;

function buildUserPrompt(rawInput: string, pass1: string | null, mission: StructuredMission): string {
  return `RAW QUERY:
${rawInput}

PASS 1 SEMANTIC INTERPRETATION:
${pass1 || '(not available)'}

PASS 2 STRUCTURED MISSION:
${JSON.stringify(mission, null, 2)}`;
}

function stripJsonFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

function safeParseJson(text: string): { ok: boolean; parsed: any; error: string | null } {
  try {
    const cleaned = stripJsonFences(text);
    return { ok: true, parsed: JSON.parse(cleaned), error: null };
  } catch (e: any) {
    return { ok: false, parsed: null, error: e.message };
  }
}

function validateAndCoerce(raw: any): { result: Omit<WatchdogResult, 'latency_ms' | 'provider_used' | 'raw_response' | 'parse_ok' | 'failure_reason'>; error: string | null } {
  const fallback = {
    result: {
      verdict: 'pass' as WatchdogVerdict,
      ok: true,
      dropped_concepts: [],
      reasoning: 'watchdog output failed validation — defaulted to pass',
    },
    error: null as string | null,
  };

  if (!raw || typeof raw !== 'object') {
    return { ...fallback, error: 'response not an object' };
  }

  const verdictRaw = raw.verdict;
  const validVerdicts: WatchdogVerdict[] = ['pass', 'retry', 'block'];
  if (!validVerdicts.includes(verdictRaw)) {
    return { ...fallback, error: `invalid verdict: ${verdictRaw}` };
  }

  const droppedRaw = Array.isArray(raw.dropped_concepts) ? raw.dropped_concepts : [];
  const dropped: WatchdogDroppedConcept[] = droppedRaw.map((d: any) => ({
    category: typeof d?.category === 'string' ? d.category : 'other',
    matched_phrase: typeof d?.matched_phrase === 'string' ? d.matched_phrase : '',
    expected_constraint_type: typeof d?.expected_constraint_type === 'string' ? d.expected_constraint_type : 'unknown',
    severity: d?.severity === 'soft' ? 'soft' : 'hard',
    reasoning: typeof d?.reasoning === 'string' ? d.reasoning : '',
  }));

  return {
    result: {
      verdict: verdictRaw,
      ok: verdictRaw === 'pass',
      dropped_concepts: dropped,
      reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
    },
    error: null,
  };
}

export async function runPass2Watchdog(
  rawInput: string,
  pass1SemanticInterpretation: string | null,
  mission: StructuredMission,
  ctx: { runId: string; userId: string; conversationId?: string }
): Promise<WatchdogResult> {
  const started = Date.now();
  const userPrompt = buildUserPrompt(rawInput, pass1SemanticInterpretation, mission);

  let rawText = '';
  let providerUsed: string | null = null;
  let failureReason: string | null = null;

  try {
    rawText = await callLLMText(
      WATCHDOG_SYSTEM_PROMPT,
      userPrompt,
      'pass2_watchdog',
      {
        maxTokens: 1000,
        temperature: 0,
        timeoutMs: 8000,
        providerChain: ['groq', 'anthropic', 'openai'],
      }
    );
    // We don't get provider back from callLLMText — leave as null. Switch to callLLM if needed for telemetry.
  } catch (e: any) {
    failureReason = `llm_call_failed: ${e.message}`;
  }

  const latencyMs = Date.now() - started;

  if (failureReason) {
    const fallbackResult: WatchdogResult = {
      verdict: 'pass',
      ok: true,
      dropped_concepts: [],
      reasoning: 'watchdog LLM call failed — failing open',
      latency_ms: latencyMs,
      provider_used: null,
      parse_ok: false,
      raw_response: '',
      failure_reason: failureReason,
    };
    logAFREvent({
      userId: ctx.userId,
      runId: ctx.runId,
      conversationId: ctx.conversationId,
      actionTaken: 'pass2_watchdog',
      status: 'failed',
      taskGenerated: `Pass 2 watchdog failed — failing open. ${failureReason}`,
      runType: 'plan',
      metadata: { verdict: 'pass', dropped_count: 0, parse_ok: false, latency_ms: latencyMs, failure_reason: failureReason },
    }).catch(() => {});
    return fallbackResult;
  }

  const parse = safeParseJson(rawText);
  if (!parse.ok) {
    const fallbackResult: WatchdogResult = {
      verdict: 'pass',
      ok: true,
      dropped_concepts: [],
      reasoning: 'watchdog JSON parse failed — failing open',
      latency_ms: latencyMs,
      provider_used: providerUsed,
      parse_ok: false,
      raw_response: rawText.slice(0, 2000),
      failure_reason: `json_parse_failed: ${parse.error}`,
    };
    logAFREvent({
      userId: ctx.userId,
      runId: ctx.runId,
      conversationId: ctx.conversationId,
      actionTaken: 'pass2_watchdog',
      status: 'failed',
      taskGenerated: `Pass 2 watchdog JSON parse failed — failing open`,
      runType: 'plan',
      metadata: { verdict: 'pass', dropped_count: 0, parse_ok: false, latency_ms: latencyMs, failure_reason: fallbackResult.failure_reason },
    }).catch(() => {});
    return fallbackResult;
  }

  const validated = validateAndCoerce(parse.parsed);
  const result: WatchdogResult = {
    ...validated.result,
    latency_ms: latencyMs,
    provider_used: providerUsed,
    parse_ok: true,
    raw_response: rawText.slice(0, 2000),
    failure_reason: validated.error,
  };

  logAFREvent({
    userId: ctx.userId,
    runId: ctx.runId,
    conversationId: ctx.conversationId,
    actionTaken: 'pass2_watchdog',
    status: 'success',
    taskGenerated: `Pass 2 watchdog: ${result.verdict} (${result.dropped_concepts.length} dropped)`,
    runType: 'plan',
    metadata: {
      verdict: result.verdict,
      dropped_count: result.dropped_concepts.length,
      parse_ok: true,
      latency_ms: latencyMs,
      reasoning: result.reasoning.slice(0, 300),
      categories: result.dropped_concepts.map(d => d.category),
    },
  }).catch(() => {});

  return result;
}

/**
 * Build a user-facing clarify question from watchdog-dropped concepts.
 * Template-based so it's deterministic and zero-latency. Can be upgraded
 * to LLM-generated in a future iteration if the templated message feels
 * robotic.
 */
export function buildWatchdogClarifyMessage(droppedConcepts: WatchdogDroppedConcept[]): string {
  if (!droppedConcepts || droppedConcepts.length === 0) {
    return "I want to make sure I understand your request correctly. Could you rephrase it?";
  }

  const intros = [
    "I want to make sure I capture your request correctly.",
  ];

  const lines: string[] = [intros[0]];

  for (const d of droppedConcepts) {
    const phrase = d.matched_phrase || '(unspecified phrase)';
    switch (d.category) {
      case 'relationship':
        lines.push(`When you said "${phrase}", do you mean an actual relationship between the entity and another party — or just a mention on a website?`);
        break;
      case 'exclusion':
        lines.push(`When you said "${phrase}", should I strictly exclude that category from the results?`);
        break;
      case 'time':
        lines.push(`When you said "${phrase}", what time range do you want me to apply?`);
        break;
      case 'status':
        lines.push(`When you said "${phrase}", how would you like me to verify current status?`);
        break;
      case 'scoping':
        lines.push(`When you said "${phrase}", how strict should that scoping be?`);
        break;
      case 'website_evidence':
        lines.push(`When you said "${phrase}", should I look for evidence on the entity's own website?`);
        break;
      case 'ranking':
        lines.push(`When you said "${phrase}", what ranking criteria should I use?`);
        break;
      default:
        lines.push(`I'm not sure how to handle "${phrase}" — could you clarify what you mean?`);
    }
  }

  lines.push("Could you confirm or rephrase?");

  return lines.join("\n\n");
}
