/**
 * GPT-4o Primary Search Execution Path
 *
 * An alternative execution path where GPT-4o web search handles discovery AND
 * verification in a single call. Triggered when execution_path === "gpt4o_primary".
 *
 * This module is self-contained. It does NOT modify any existing GP cascade code.
 */

import { createArtefact } from './artefacts';
import { getCurrentDatePreamble } from './current-context';
import { judgeArtefact } from './tower-artefact-judge';
import {
  emitDeliverySummary,
  buildDeliverySummaryPayload,
  type DeliverySummaryPayload,
  type DeliverySummaryInput,
  type DeliverySummaryLeadInput,
  type PlanVersionEntry,
  type SoftRelaxation,
} from './delivery-summary';
import { logAFREvent } from './afr-logger';
import { storage } from '../storage';
import type { IntentNarrative } from './mission-schema';
import type { VerificationPolicy } from './verification-policy';
import type { StructuredConstraintPayload, EvidenceResult, ConstraintResult, VerificationSummary } from './mission-executor';
import { buildVerificationSummary } from './mission-executor';
import { requestSemanticVerification, type TowerSemanticStatus } from './tower-semantic-verify';
import { renderConstraintAsClaim } from './constraint-to-claim';
import {
  finalizeDelivery,
  type RawLeadInput,
  type PerConstraintVerification,
  type EvidenceVerificationStatus,
} from './finalize-delivery';

const MAX_SEARCH_ROUNDS = 3;
const LOW_RESULT_THRESHOLD = 5;

export interface Gpt4oSearchContext {
  runId: string;
  userId: string;
  conversationId?: string;
  clientRequestId?: string;
  rawUserInput: string;
  normalizedGoal: string;
  businessType: string;
  location: string;
  country: string;
  requestedCount: number | null;
  hardConstraints: string[];
  softConstraints: string[];
  structuredConstraints: StructuredConstraintPayload[];
  intentNarrative: IntentNarrative | null;
  verificationPolicy: VerificationPolicy;
  verificationPolicyReason: string;
  queryId?: string | null;
  suppressDeliverySummary?: boolean;
}

export interface Gpt4oPrimaryResult {
  response: string;
  leadIds: string[];
  deliverySummary: DeliverySummaryPayload | null;
  towerVerdict: string | null;
  leads: Array<{
    name: string;
    address: string;
    phone: string | null;
    website: string | null;
    placeId: string;
  }>;
}

interface Gpt4oLead {
  name: string;
  description: string;
  evidence: string;
  source_url: string;
  website?: string;
  location: string;
  confidence: 'high' | 'medium' | 'low';
}

interface Gpt4oSearchResponse {
  results: Gpt4oLead[];
  search_summary: string;
  coverage_assessment: string;
}

/**
 * Convert a structured constraint into a natural-language instruction
 * suitable for a web search prompt.
 *
 * The real constraint VALUE (e.g. "swan", "local authority", "vegan") is
 * injected directly — not hidden inside a narrative phrase or stripped to a
 * type label like "name_contains".
 */
function formatConstraintForSearch(c: StructuredConstraintPayload): string {
  const valueRaw = c.value === null || c.value === undefined ? '' : String(c.value).trim();
  if (!valueRaw) return '';

  const valuePretty = valueRaw.length > 0
    ? valueRaw[0].toUpperCase() + valueRaw.slice(1)
    : valueRaw;

  switch (c.type) {
    case 'text_compare': {
      const fieldLabel = c.field === 'name' ? 'business name' : c.field;
      switch (c.operator) {
        case 'contains':
          return `The ${fieldLabel} must contain the word "${valuePretty}".`;
        case 'starts_with':
          return `The ${fieldLabel} must start with "${valuePretty}".`;
        case 'ends_with':
          return `The ${fieldLabel} must end with "${valuePretty}".`;
        case 'equals':
          return `The ${fieldLabel} must be exactly "${valuePretty}".`;
        case 'not_contains':
          return `The ${fieldLabel} must NOT contain "${valuePretty}".`;
        default:
          return `The ${fieldLabel} ${c.operator} "${valuePretty}".`;
      }
    }

    case 'relationship_check': {
      switch (c.operator) {
        case 'not_has':
          return `They must NOT have ${valueRaw}.`;
        case 'not_serves':
          return `They must NOT serve ${valueRaw}.`;
        case 'not_owned_by':
          return `They must NOT be owned by ${valueRaw}.`;
        case 'not_managed_by':
          return `They must NOT be managed by ${valueRaw}.`;
        case 'not_partners_with':
          return `They must NOT partner with ${valueRaw}.`;
        case 'serves':
          return `They must have evidence of working with ${valueRaw}.`;
        default:
          return `They must have evidence of ${c.operator} ${valueRaw}.`;
      }
    }

    case 'website_evidence': {
      switch (c.operator) {
        case 'not_contains':
          return `Their website must NOT contain evidence of "${valueRaw}".`;
        case 'not_mentions':
          return `Their website must NOT mention "${valueRaw}".`;
        case 'mentions':
          return `Their website must mention "${valueRaw}".`;
        default:
          return `Their website must contain evidence of "${valueRaw}".`;
      }
    }

    case 'attribute_check': {
      if (c.operator === 'not_has') {
        return `They must NOT have ${valueRaw}.`;
      }
      if (valueRaw === 'true' || valueRaw === 'yes') {
        return `They must be ${c.field.replace(/_/g, ' ')}.`;
      }
      if (valueRaw === 'false' || valueRaw === 'no') {
        return `They must NOT be ${c.field.replace(/_/g, ' ')}.`;
      }
      return `Their ${c.field.replace(/_/g, ' ')} must be "${valueRaw}".`;
    }

    case 'status_check':
      return c.operator === 'not_equals'
        ? `They must NOT currently be ${valueRaw}.`
        : `They must currently be ${valueRaw}.`;

    case 'numeric_range': {
      const fieldLabel = c.field.replace(/_/g, ' ');
      switch (c.operator) {
        case 'gte':
        case '>=':
          return `Their ${fieldLabel} must be at least ${valueRaw}.`;
        case 'lte':
        case '<=':
          return `Their ${fieldLabel} must be at most ${valueRaw}.`;
        case 'gt':
        case '>':
          return `Their ${fieldLabel} must be greater than ${valueRaw}.`;
        case 'lt':
        case '<':
          return `Their ${fieldLabel} must be less than ${valueRaw}.`;
        case 'equals':
        case '=':
          return `Their ${fieldLabel} must equal ${valueRaw}.`;
        default:
          return `Their ${fieldLabel} ${c.operator} ${valueRaw}.`;
      }
    }

    case 'time_constraint':
    case 'time_predicate': {
      if (c.operator === 'between_dates') {
        let dateRange: { start: string; end: string } | null = null;
        if (c.value && typeof c.value === 'object' && 'start' in (c.value as object)) {
          dateRange = c.value as { start: string; end: string };
        } else if (typeof c.value === 'string') {
          try { dateRange = JSON.parse(c.value); } catch {}
        }
        if (dateRange) {
          return `They must have ${c.field} between ${dateRange.start} and ${dateRange.end}.`;
        }
        return `Their ${c.field} must satisfy: between_dates ${valueRaw}.`;
      }
      if (c.operator === 'within_next') {
        return `They must have ${c.field} within the next ${valueRaw}.`;
      }
      if (c.operator === 'within_last' || c.operator === 'since') {
        return `They must have ${c.field === 'opened' ? 'opened' : c.field} ${c.operator === 'within_last' ? 'within the last' : 'since'} ${valueRaw}.`;
      }
      return `Their ${c.field} must satisfy: ${c.operator} ${valueRaw}.`;
    }

    case 'location_constraint':
      return '';

    case 'ranking':
      return `Rank results by ${valueRaw}.`;

    default:
      return `They must match: ${c.field} ${c.operator} "${valueRaw}".`;
  }
}

function buildSearchPrompt(ctx: Gpt4oSearchContext, angle: string): string {
  const entityDesc = ctx.intentNarrative?.entity_description ?? ctx.businessType;
  const angleNote = angle !== 'primary'
    ? `\nSearch angle: ${angle}\n`
    : '';

  const useStructured = (process.env.GPT4O_STRUCTURED_PROMPT ?? 'true').toLowerCase() === 'true';

  let constraintText = '';
  if (useStructured && ctx.structuredConstraints.length > 0) {
    const hardInstructions = ctx.structuredConstraints
      .filter(c => c.hardness === 'hard')
      .map(c => formatConstraintForSearch(c))
      .filter(s => s.length > 0);

    if (hardInstructions.length > 0) {
      constraintText = `\n\nCONSTRAINTS — these must be true for a result to qualify:\n${hardInstructions.map(s => `- ${s}`).join('\n')}\n`;
    }
  } else if (ctx.hardConstraints.length > 0) {
    constraintText = `They must: ${ctx.hardConstraints.join(', ')}.`;
  }

  const _tcEntry = ctx.structuredConstraints.find(c =>
    (c.type === 'time_constraint' || c.type === 'time_predicate') &&
    c.hardness === 'hard' &&
    c.value !== null && c.value !== undefined,
  );

  const _daysPerUnit: Record<string, number> = {
    day: 1, days: 1,
    week: 7, weeks: 7,
    month: 30, months: 30,
    year: 365, years: 365,
  };

  type _TemporalParams =
    | { direction: 'backward'; cutoffDate: string }
    | { direction: 'forward'; forwardWindowEnd: string }
    | { direction: 'between'; start: string; end: string }
    | { direction: 'none' };

  const _temporalParams = ((): _TemporalParams => {
    if (!_tcEntry) return { direction: 'none' };
    const op = _tcEntry.operator;

    if (op === 'between_dates') {
      const rawVal = _tcEntry.value;
      let dateRange: { start: string; end: string } | null = null;
      if (rawVal && typeof rawVal === 'object' && 'start' in (rawVal as object)) {
        dateRange = rawVal as { start: string; end: string };
      } else if (typeof rawVal === 'string') {
        try { dateRange = JSON.parse(rawVal); } catch {}
      }
      if (dateRange) return { direction: 'between', start: dateRange.start, end: dateRange.end };
      return { direction: 'none' };
    }

    if (op === 'within_next') {
      const value = String(_tcEntry.value).trim().toLowerCase();
      const match = value.match(/^(\d+)\s*(day|days|week|weeks|month|months|year|years)$/);
      if (match) {
        const days = parseInt(match[1], 10) * (_daysPerUnit[match[2]] ?? 1);
        const forwardWindowEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        console.log(`[GPT4O_SEARCH] Forward temporal window from constraint "${value}" → end=${forwardWindowEnd}`);
        return { direction: 'forward', forwardWindowEnd };
      }
      return { direction: 'none' };
    }

    const value = String(_tcEntry.value).trim().toLowerCase();
    const match = value.match(/^(\d+)\s*(day|days|week|weeks|month|months|year|years)$/);
    if (match) {
      const days = parseInt(match[1], 10) * (_daysPerUnit[match[2]] ?? 1);
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      console.log(`[GPT4O_SEARCH] Derived temporal cutoff from constraint "${value}" → ${days} days back`);
      return { direction: 'backward', cutoffDate };
    }
    console.warn(`[GPT4O_SEARCH] Could not parse time_constraint value "${value}" — falling back to 365-day cutoff`);
    return { direction: 'backward', cutoffDate: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] };
  })();

  const hasTemporalConstraint = _temporalParams.direction !== 'none' ||
    ctx.hardConstraints.some(c => /\b(recent|opened|established|new|last\s+\d+\s+months?|within\s+\d+)\b/i.test(c)) ||
    /\b(recent|opened|new|last\s+\d+)\b/i.test(ctx.rawUserInput);

  const cutoffDate = _temporalParams.direction === 'backward'
    ? _temporalParams.cutoffDate
    : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const temporalRules = hasTemporalConstraint ? (() => {
    if (_temporalParams.direction === 'between') {
      return `

CRITICAL TEMPORAL RULES — READ CAREFULLY:
You are looking for ${entityDesc} with events or activities scheduled between ${_temporalParams.start} and ${_temporalParams.end}.
- Only include results where you find evidence of an event, occurrence, or activity with a specific date WITHIN this date range.
- An explicit future date on the page (e.g. "23-25 May 2026") that falls within ${_temporalParams.start} to ${_temporalParams.end} is valid evidence.
- "Tickets on sale" / "book now" / "register" paired with a date in this range is valid.
- "Annual" or "yearly" alone is NOT valid — the event must show a specific date within the range.
- A historical page about past editions with no current date in range is NOT valid.
- Today's date appearing on the page alone is NOT evidence of a scheduled event.
- Do NOT include results with no future date explicitly within ${_temporalParams.start} to ${_temporalParams.end}.
`;
    }
    if (_temporalParams.direction === 'forward') {
      return `

CRITICAL TEMPORAL RULES — READ CAREFULLY:
You are looking for ${entityDesc} with events or activities scheduled before or on ${_temporalParams.forwardWindowEnd}.
- Only include results where you find evidence of something happening before ${_temporalParams.forwardWindowEnd}.
- An explicit future date on the page that falls before ${_temporalParams.forwardWindowEnd} is valid evidence.
- "Tickets on sale" / "book now" / "register" paired with a future date before ${_temporalParams.forwardWindowEnd} is valid.
- "Annual" or "yearly" alone is NOT valid — the event must show a specific upcoming date.
- A historical page about past editions with no upcoming date is NOT valid.
- Today's date appearing on the page alone is NOT evidence of a scheduled event.
- Do NOT include results with no evidence of an upcoming event before ${_temporalParams.forwardWindowEnd}.
`;
    }
    return `

CRITICAL TEMPORAL RULES — READ CAREFULLY:
You are looking for businesses that OPENED (were first established/founded) after ${cutoffDate}.
- ONLY the original OPENING or ESTABLISHMENT date matters.
- A business founded in 2020 that opened a new branch/taproom in 2026 does NOT qualify — it was founded in 2020.
- A business that MOVED to new premises recently does NOT qualify unless it was also FOUNDED recently.
- "Operating for over 12 months" means the business is OLD, not new.
- Recent website updates, recent Companies House filings, or recent Google reviews do NOT prove recent opening.
- If you cannot find a clear opening/establishment date AFTER ${cutoffDate}, do NOT include the business.
- ONLY include businesses where you find evidence they were FIRST established after ${cutoffDate}.
`;
  })() : '';

  return `${getCurrentDatePreamble()}

You are a research assistant finding specific entities. Search the web thoroughly.${angleNote}
TASK: Find ${entityDesc} in ${ctx.location}.${constraintText}${temporalRules}
Location: ${ctx.location}, ${ctx.country}

For EACH result you find, provide:
- name: The entity/business name
- description: Brief description of what they do
- evidence: The specific evidence that they match the search criteria (quote or paraphrase from your source)
- source_url: The URL where you found this information
- website: The entity's own website URL (their .com or .co.uk homepage). This is NOT the same as source_url. If you found them via a LinkedIn job listing, news article, or directory, look up their actual company website separately. Never use linkedin.com, indeed.com, glassdoor.com, or news sites as the website.
- location: Their address or location if available
- confidence: "high" if evidence is direct and clear, "medium" if inferred or from secondary source, "low" if uncertain

Return results as a JSON array. Be thorough — search multiple angles if needed. Only include results where you found genuine evidence. Do not fabricate or assume.

Respond with ONLY a JSON object in this exact format:
{
  "results": [
    {
      "name": "...",
      "description": "...",
      "evidence": "...",
      "source_url": "...",
      "website": "...",
      "location": "...",
      "confidence": "high|medium|low"
    }
  ],
  "search_summary": "Brief description of what you searched for and how many results you found",
  "coverage_assessment": "How comprehensive do you think these results are? Are there likely more to find?"
}`;
}

async function callGpt4oWebSearch(
  prompt: string,
): Promise<{ parsed: Gpt4oSearchResponse | null; raw: string; error?: string }> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return { parsed: null, raw: '', error: 'OPENAI_API_KEY not configured' };
  }

  try {
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: openaiKey });

    const primaryModel = process.env.GPT4O_PRIMARY_MODEL ?? 'gpt-4o';
    console.log(`[GPT4O_SEARCH] Using model: ${primaryModel}`);
    const response = await (openai as any).responses.create({
      model: primaryModel,
      tools: [{ type: 'web_search_preview' }],
      input: prompt,
    });

    let rawText = '';

    if (response.output && Array.isArray(response.output)) {
      for (const item of response.output) {
        if (item.type === 'message' && item.content && Array.isArray(item.content)) {
          for (const contentItem of item.content) {
            if (contentItem.type === 'output_text' && typeof contentItem.text === 'string') {
              rawText += contentItem.text;
            }
          }
        }
      }
    }

    if (!rawText && typeof response.output_text === 'string') {
      rawText = response.output_text;
    }

    if (!rawText) {
      return { parsed: null, raw: '', error: 'No text output received from GPT-4o Responses API' };
    }

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { parsed: null, raw: rawText, error: 'No JSON object found in GPT-4o response' };
    }

    const parsed = JSON.parse(jsonMatch[0]) as Gpt4oSearchResponse;
    if (!parsed.results || !Array.isArray(parsed.results)) {
      return { parsed: null, raw: rawText, error: 'GPT-4o response missing results array' };
    }

    const REJECTED_WEBSITE_DOMAINS = ['linkedin.com', 'indeed.com', 'glassdoor.com', 'reed.co.uk', 'totaljobs.com', 'monster.com', 'bbc.co.uk', 'bbc.com', 'theguardian.com', 'reuters.com'];

    for (const result of parsed.results) {
      // Use explicit website field if GPT-4o provided one
      if ((result as any).website) {
        result.source_url = (result as any).website;
      }
      // Filter out job boards and news sites from source_url
      try {
        const urlHost = new URL(result.source_url).hostname.toLowerCase();
        if (REJECTED_WEBSITE_DOMAINS.some(d => urlHost.includes(d))) {
          console.log(`[GPT4O_SEARCH] Rejected website URL for "${result.name}": ${result.source_url} (job board/news site)`);
          result.source_url = '';
        }
      } catch {}
    }

    return { parsed, raw: rawText };
  } catch (err: any) {
    return { parsed: null, raw: '', error: err.message || String(err) };
  }
}

function deduplicateLeads(existing: Gpt4oLead[], incoming: Gpt4oLead[]): Gpt4oLead[] {
  const seen = new Set(existing.map(l => l.name.toLowerCase().trim()));
  return incoming.filter(l => !seen.has(l.name.toLowerCase().trim()));
}

function toDeliveryLead(
  lead: Gpt4oLead,
  index: number,
): {
  name: string;
  address: string;
  phone: string | null;
  website: string | null;
  placeId: string;
} {
  return {
    name: lead.name,
    address: lead.location || '',
    phone: null,
    website: lead.source_url || null,
    placeId: `gpt4o_${index}_${lead.name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 30)}`,
  };
}

export async function executeGpt4oPrimaryPath(ctx: Gpt4oSearchContext): Promise<Gpt4oPrimaryResult> {
  const {
    runId, userId, conversationId, clientRequestId,
    rawUserInput, normalizedGoal, businessType, location, country,
    requestedCount, hardConstraints, softConstraints, structuredConstraints,
    intentNarrative, verificationPolicy, verificationPolicyReason, queryId,
  } = ctx;

  const runStartTime = Date.now();
  console.log(`[GPT4O_SEARCH] ===== GPT-4o primary execution starting =====`);
  console.log(`[GPT4O_SEARCH] runId=${runId} entity="${businessType}" location="${location}"`);

  const entityDesc = intentNarrative?.entity_description ?? businessType;

  await logAFREvent({
    userId, runId, conversationId, clientRequestId,
    actionTaken: 'gpt4o_search_started',
    status: 'pending',
    taskGenerated: `Searching with GPT-4o web search for: ${entityDesc} in ${location}`,
    runType: 'plan',
    metadata: { execution_source: 'gpt4o_primary', entity: entityDesc, location },
  });

  const primaryConstraintValue = (() => {
    const firstHardStructural = ctx.structuredConstraints.find(
      c => c.hardness === 'hard' && c.value !== null && c.value !== undefined && String(c.value).trim().length > 0,
    );
    if (firstHardStructural) {
      const v = String(firstHardStructural.value).trim();
      return v.includes(' ') ? `"${v}"` : v;
    }
    return '';
  })();

  console.log(`[GPT4O_SEARCH] Prompt format: ${(process.env.GPT4O_STRUCTURED_PROMPT ?? 'true').toLowerCase() === 'true' ? 'structured' : 'legacy'} | hard_constraints=${ctx.structuredConstraints.filter(c => c.hardness === 'hard').length}`);

  const searchAngles = [
    'primary',
    primaryConstraintValue
      ? `${businessType} ${location} ${primaryConstraintValue} site listings`.trim()
      : `${businessType} ${location} site listings`,
    `${location} ${businessType} directory listings`,
  ];

  let allLeads: Gpt4oLead[] = [];
  const searchSummaries: string[] = [];
  const coverageAssessments: string[] = [];
  let roundsPerformed = 0;

  for (let round = 0; round < MAX_SEARCH_ROUNDS; round++) {
    const angle = searchAngles[round] || `additional search for ${businessType} in ${location}`;

    if (round > 0) {
      await logAFREvent({
        userId, runId, conversationId, clientRequestId,
        actionTaken: 'gpt4o_search_round',
        status: 'pending',
        taskGenerated: `Searching from a different angle...`,
        runType: 'plan',
        metadata: { execution_source: 'gpt4o_primary', round: round + 1, angle },
      });
    }

    const prompt = buildSearchPrompt(ctx, angle);
    console.log(`[GPT4O_SEARCH] Round ${round + 1}: calling GPT-4o web search (angle="${angle.substring(0, 60)}")`);

    const { parsed, raw, error } = await callGpt4oWebSearch(prompt);
    roundsPerformed++;

    if (error || !parsed) {
      console.error(`[GPT4O_SEARCH] Round ${round + 1} failed: ${error}`);
      await createArtefact({
        runId,
        type: 'diagnostic',
        title: `GPT-4o search round ${round + 1} failed`,
        summary: error || 'Unknown error during GPT-4o web search',
        payload: { round: round + 1, error: error ?? 'unknown', raw_excerpt: (raw ?? '').substring(0, 500) },
        userId,
        conversationId,
      }).catch(() => {});
      break;
    }

    const newLeads = deduplicateLeads(allLeads, parsed.results);
    allLeads = [...allLeads, ...newLeads];
    searchSummaries.push(parsed.search_summary);
    coverageAssessments.push(parsed.coverage_assessment);

    console.log(`[GPT4O_SEARCH] Round ${round + 1}: ${parsed.results.length} results, ${newLeads.length} new after dedup. Total: ${allLeads.length}`);

    const hasMoreRounds = round + 1 < MAX_SEARCH_ROUNDS;
    const coverageText = (parsed.coverage_assessment || '').toLowerCase();
    const suggestsMore = coverageText.includes('more') || coverageText.includes('additional') || coverageText.includes('likely');
    const shouldContinue = hasMoreRounds && allLeads.length < LOW_RESULT_THRESHOLD && suggestsMore;

    await logAFREvent({
      userId, runId, conversationId, clientRequestId,
      actionTaken: 'gpt4o_search_round_complete',
      status: 'success',
      taskGenerated: `Found ${allLeads.length} result${allLeads.length === 1 ? '' : 's'}. ${shouldContinue ? 'Searching from another angle...' : 'Moving to final review...'}`,
      runType: 'plan',
      metadata: { execution_source: 'gpt4o_primary', round: round + 1, total_leads: allLeads.length },
    });

    if (!shouldContinue) {
      break;
    }
  }

  await createArtefact({
    runId,
    type: 'step_result',
    title: `Step 1: GPT4O_WEB_SEARCH — ${allLeads.length} results (${roundsPerformed} round${roundsPerformed === 1 ? '' : 's'})`,
    summary: `${allLeads.length > 0 ? 'success' : 'fail'} — ${allLeads.length} ${businessType} found in ${location} via GPT-4o web search`,
    payload: {
      execution_source: 'gpt4o_primary',
      step_index: 0,
      step_tool: 'GPT4O_WEB_SEARCH',
      step_status: allLeads.length > 0 ? 'success' : 'fail',
      results_count: allLeads.length,
      rounds_performed: roundsPerformed,
      search_summaries: searchSummaries,
      coverage_assessments: coverageAssessments,
      leads: allLeads,
    },
    userId,
    conversationId,
  }).catch(() => {});

  // Per-(lead × hard constraint) Tower semantic verification.
  // Mirrors mission-executor.ts gp_cascade pattern exactly.
  //
  // We loop over structuredConstraints (which have real values and types),
  // not hardConstraints (which are label strings like "time_constraint").
  //
  // Skip constraint types that don't need evidence judgement —
  // location/numeric/ranking are handled structurally upstream.

  const TOWER_JUDGED_TYPES = new Set([
    'attribute_check',
    'website_evidence',
    'relationship_check',
    'time_constraint',
    'time_predicate',
    'status_check',
  ]);

  const hardEvidenceConstraints = ctx.structuredConstraints.filter(
    c => c.hardness === 'hard' && TOWER_JUDGED_TYPES.has(c.type),
  );

  // Track per-lead aggregated Tower status (for delivery rollup).
  interface PerLeadAgg {
    anyVerified: boolean;
    anyWeak: boolean;
    anyNoEvidence: boolean;
    perConstraint: Array<{
      constraintValue: string;
      towerStatus: TowerSemanticStatus | null;
      towerConfidence: number | null;
      towerReasoning: string | null;
    }>;
  }
  const perLeadAgg = new Map<string, PerLeadAgg>();

  for (let li = 0; li < allLeads.length; li++) {
    const lead = allLeads[li];
    const leadPlaceId = `gpt4o_${li}_${lead.name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 30)}`;
    const agg: PerLeadAgg = {
      anyVerified: false,
      anyWeak: false,
      anyNoEvidence: false,
      perConstraint: [],
    };

    for (const constraint of hardEvidenceConstraints) {
      const constraintValue = constraint.value === null || constraint.value === undefined
        ? ''
        : String(constraint.value).trim();
      if (!constraintValue) continue;

      let towerStatus: TowerSemanticStatus | null = null;
      let towerConfidence: number | null = null;
      let towerReasoning: string | null = null;

      try {
        const verifyResult = await requestSemanticVerification({
          request: {
            run_id: runId,
            original_user_goal: rawUserInput,
            lead_name: lead.name,
            lead_place_id: leadPlaceId,
            constraint_to_check: renderConstraintAsClaim(constraint, new Date()),
            source_url: lead.source_url || lead.website || 'gpt4o_web_search',
            evidence_text: (lead.evidence || lead.description || '').substring(0, 5000),
            extracted_quotes: lead.evidence ? [lead.evidence] : [],
            page_title: null,
          },
          userId,
          conversationId,
          clientRequestId,
        });
        towerStatus = verifyResult.towerResponse.status;
        towerConfidence = verifyResult.towerResponse.confidence;
        towerReasoning = verifyResult.towerResponse.reasoning;
        console.log(`[GPT4O_SEARCH] Tower semantic: "${lead.name}" + "${constraintValue}" → ${towerStatus} (confidence=${towerConfidence})`);
      } catch (towerErr: any) {
        console.warn(`[GPT4O_SEARCH] Tower semantic verify failed for "${lead.name}" + "${constraintValue}" (non-fatal): ${towerErr.message}`);
      }

      // Aggregate
      if (towerStatus === 'verified') agg.anyVerified = true;
      else if (towerStatus === 'weak_match') agg.anyWeak = true;
      else if (towerStatus === 'no_evidence' || towerStatus === 'insufficient_evidence') agg.anyNoEvidence = true;

      agg.perConstraint.push({
        constraintValue,
        towerStatus,
        towerConfidence,
        towerReasoning,
      });

      // Emit one constraint_led_evidence artefact per (lead × constraint) —
      // same shape gp_cascade uses, with Tower verdict stamped honestly.
      await createArtefact({
        runId,
        type: 'constraint_led_evidence',
        title: `Evidence: "${lead.name}" — ${constraint.type}: "${constraintValue}"`,
        summary: lead.evidence
          ? `Tower ${towerStatus ?? 'unjudged'} for "${constraintValue}" on "${lead.name}" via GPT-4o web search`
          : `No evidence for "${constraintValue}" on "${lead.name}"`,
        payload: {
          lead_name: lead.name,
          lead_place_id: leadPlaceId,
          constraint: {
            type: constraint.type,
            field: constraint.field,
            operator: constraint.operator,
            value: constraintValue,
            hardness: 'hard',
          },
          pages_scanned: 0,
          extraction_method: 'gpt4o_web_search',
          no_evidence: !lead.evidence,
          phrase_targets: [],
          fallback_used: false,
          evidence_items: lead.evidence ? [{
            quote: lead.evidence.substring(0, 300),
            url: lead.source_url || null,
            page_title: null,
            match_reason: `GPT-4o web search returned evidence (gpt4o_confidence: ${lead.confidence})`,
            confidence: lead.confidence === 'high' ? 0.85 : lead.confidence === 'medium' ? 0.65 : 0.4,
            keyword_matched: true,
            source_url: lead.source_url || null,
            constraint_type: constraint.type,
            constraint_value: constraintValue,
            matched_phrase: constraintValue,
            direct_quote: lead.evidence.substring(0, 300),
            context_snippet: lead.description || null,
            constraint_match_reason: lead.evidence.substring(0, 200),
            source_type: 'gpt4o_web_search',
            source_tier: 'search_snippet',
            confidence_score: lead.confidence === 'high' ? 0.85 : lead.confidence === 'medium' ? 0.65 : 0.4,
          }] : [],
          tower_status: towerStatus,
          tower_confidence: towerConfidence,
          tower_reasoning: towerReasoning,
        },
        userId,
        conversationId,
      }).catch((e: any) => console.warn(`[GPT4O_SEARCH] Per-constraint evidence artefact failed for "${lead.name}" + "${constraintValue}" (non-fatal): ${e.message}`));
    }

    perLeadAgg.set(leadPlaceId, agg);
  }

  console.log(`[GPT4O_SEARCH] Per-constraint Tower semantic verification complete for ${allLeads.length} leads × ${hardEvidenceConstraints.length} hard evidence constraints`);

  const deliveryLeads = allLeads.map((lead, i) => toDeliveryLead(lead, i));

  // Build raw lead inputs for the gateway (from ALL leads, not capped — gateway applies the cap)
  const rawLeadInputs: RawLeadInput[] = allLeads.map((lead, li) => {
    const leadPlaceId = `gpt4o_${li}_${lead.name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 30)}`;
    const agg = perLeadAgg.get(leadPlaceId);

    const verifications: PerConstraintVerification[] = (agg?.perConstraint ?? []).map(pc => {
      const matchingConstraint = hardEvidenceConstraints.find(c => String(c.value).trim() === pc.constraintValue);
      return {
        constraint_type: matchingConstraint?.type ?? 'unknown',
        constraint_value: pc.constraintValue,
        tower_status: pc.towerStatus as EvidenceVerificationStatus | null,
        tower_confidence: pc.towerConfidence,
        tower_reasoning: pc.towerReasoning,
        source_url: lead.source_url || lead.website || null,
        quote: lead.evidence || null,
      };
    });

    return {
      name: lead.name,
      address: lead.location || '',
      phone: null,
      website: lead.source_url || null,
      placeId: leadPlaceId,
      source: 'gpt4o_web_search',
      executor_confidence: lead.confidence,
      verifications,
    };
  });

  // THE GATEWAY: single source of truth for verified delivery
  const finalized = finalizeDelivery({
    leads: rawLeadInputs,
    structuredConstraints,
    requestedCount,
  });

  console.log(`[GPT4O_SEARCH] Gateway result: ${finalized.count} verified leads, ${finalized.dropped.length} dropped`);

  // Re-derive cappedLeads from gateway output so all downstream artefacts
  // and Tower judgements see the same set the user sees.
  const cappedLeads = finalized.verifiedLeads.map(fl => ({
    name: fl.name,
    address: fl.address,
    phone: fl.phone,
    website: fl.website,
    placeId: fl.placeId,
  }));
  const cappedGpt4oLeads = allLeads.filter(l =>
    finalized.verifiedLeads.some(fl => fl.name === l.name),
  );

  if (finalized.dropped.length > 0) {
    await createArtefact({
      runId,
      type: 'leads_dropped_at_gateway',
      title: `Gateway dropped ${finalized.dropped.length} unverified leads`,
      summary: finalized.dropped.map(d => `${d.name} (${d.rollup_status})`).join('; '),
      payload: {
        execution_source: 'gpt4o_primary',
        dropped: finalized.dropped,
        total_candidates: finalized.totalCandidates,
        verified_count: finalized.count,
      },
      userId,
      conversationId,
    }).catch(() => {});
  }

  // The final_delivery artefact uses the same canonical FinalizedLeads
  const deliveredLeadsWithEvidence = finalized.verifiedLeads.map(fl => ({
    name: fl.name,
    address: fl.address,
    phone: fl.phone,
    website: fl.website,
    placeId: fl.placeId,
    source: fl.source,
    verified: true,
    verification_status: 'verified' as const,
    constraint_verdicts: fl.match_evidence.map(me => ({
      constraint: me.constraint_value,
      verdict: 'verified' as const,
    })),
    evidence: fl.match_evidence.map(me => ({
      source_url: me.source_url,
      text: me.quote,
      snippet: me.quote,
      quote: me.quote,
      confidence: me.confidence > 0.75 ? 'high' : me.confidence > 0.5 ? 'medium' : 'low',
    })),
    match_valid: true,
    match_summary: fl.match_summary,
    match_basis: [] as Record<string, unknown>[],
    supporting_evidence: fl.supporting_evidence,
    match_evidence: fl.match_evidence,
  }));

  const gpt4oEvidenceResults: EvidenceResult[] = [];
  for (let li = 0; li < cappedLeads.length; li++) {
    const lead = cappedGpt4oLeads[li];
    const placeId = cappedLeads[li].placeId;
    const agg = perLeadAgg.get(placeId);
    for (const constraint of hardEvidenceConstraints) {
      const constraintValue = String(constraint.value ?? '').trim();
      if (!constraintValue) continue;
      const perCon = agg?.perConstraint.find(pc => pc.constraintValue === constraintValue);
      const towerStatus = perCon?.towerStatus ?? null;
      const evidenceFound = !!lead.evidence && towerStatus !== 'no_evidence' && towerStatus !== 'insufficient_evidence';
      gpt4oEvidenceResults.push({
        leadIndex: li,
        leadName: lead.name,
        leadPlaceId: placeId,
        constraintField: constraint.field,
        constraintValue,
        constraintType: constraint.type,
        evidenceFound,
        evidenceStrength: towerStatus === 'verified' ? 'strong' : towerStatus === 'weak_match' ? 'weak' : 'none',
        isBotBlocked: false,
        towerStatus,
        towerConfidence: perCon?.towerConfidence ?? null,
        towerReasoning: perCon?.towerReasoning ?? null,
        sourceUrl: lead.source_url || null,
        snippets: lead.evidence ? [lead.evidence.substring(0, 300)] : [],
        verdict: towerStatus === 'verified' ? 'verified' : towerStatus === 'weak_match' ? 'plausible' : 'no_evidence',
      });
    }
  }

  const verificationSummary = buildVerificationSummary(
    gpt4oEvidenceResults,
    structuredConstraints,
    cappedLeads.map(l => ({ name: l.name, placeId: l.placeId })),
  );
  console.log(`[GPT4O_SEARCH] Verification summary: ${verificationSummary.verified_exact_count} leads with all hard constraints verified, ${verificationSummary.hard_constraints_satisfied}/${verificationSummary.hard_constraints_total} hard constraints met`);

  const finalDeliveryArtefact = await createArtefact({
    runId,
    type: 'final_delivery',
    title: `Final delivery: ${cappedLeads.length} leads (GPT-4o web search)`,
    summary: `${cappedLeads.length} leads delivered via GPT-4o web search | rounds=${roundsPerformed}`,
    payload: {
      execution_source: 'gpt4o_primary',
      original_user_goal: rawUserInput,
      normalized_goal: normalizedGoal,
      hard_constraints: hardConstraints,
      soft_constraints: softConstraints,
      structured_constraints: structuredConstraints,
      search_method: 'gpt4o_web_search',
      rounds_performed: roundsPerformed,
      delivered_count: cappedLeads.length,
      target_count: requestedCount,
      verification_policy: verificationPolicy,
      verification_policy_reason: verificationPolicyReason,
      leads: deliveredLeadsWithEvidence,
      behaviour_judge: {
        scarcity_accepted_shortfall: false,
        wrong_type_excluded_pre_delivery: 0,
        wrong_type_candidates: [],
        narrative_search_used: intentNarrative !== null,
        findability: intentNarrative?.findability ?? null,
        supplementary_search_fired: roundsPerformed > 1,
      },
      verification_summary: verificationSummary,
      // Include delivered count and requested count at top level for Tower resolution
      delivered_count: cappedLeads.length,
      accumulated_count: cappedLeads.length,
      requested_count: requestedCount,
      requested_count_user: requestedCount !== null ? requestedCount : undefined,
    },
    userId,
    conversationId,
  });

  let finalVerdict = 'pending';
  let finalAction = 'accept';

  try {
    await logAFREvent({
      userId, runId, conversationId, clientRequestId,
      actionTaken: 'tower_evaluation_started',
      status: 'pending',
      taskGenerated: 'Running final quality check...',
      runType: 'plan',
      metadata: { execution_source: 'gpt4o_primary', delivered_count: cappedLeads.length },
    });

    const finalSuccessCriteria = {
      mission_type: 'leadgen',
      target_count: requestedCount ?? 20,
      requested_count_user: requestedCount !== null ? requestedCount : 'implicit',
      requested_count_value: requestedCount,
      hard_constraints: hardConstraints,
      soft_constraints: softConstraints,
      structured_constraints: structuredConstraints,
      plan_constraints: {
        business_type: businessType,
        location,
        country,
        search_count: roundsPerformed,
        requested_count: requestedCount ?? 20,
      },
      max_replan_versions: 1,
      requires_relationship_evidence: false,
      run_deadline_exceeded: false,
      verification_policy: verificationPolicy,
      verification_policy_reason: verificationPolicyReason,
      intent_narrative: intentNarrative ?? null,
    };

    const towerResult = await judgeArtefact({
      artefact: finalDeliveryArtefact,
      runId,
      goal: normalizedGoal,
      userId,
      conversationId,
      successCriteria: finalSuccessCriteria,
      intent_narrative: intentNarrative ?? null,
      queryId: queryId ?? null,
    });

    finalVerdict = towerResult.judgement.verdict;
    finalAction = towerResult.judgement.action;
    console.log(`[GPT4O_SEARCH] Tower final verdict=${finalVerdict} action=${finalAction} stubbed=${towerResult.stubbed}`);

    await createArtefact({
      runId,
      type: 'tower_judgement',
      title: `Tower Judgement (final_delivery): ${finalVerdict}`,
      summary: `Final verdict: ${finalVerdict} | Action: ${finalAction} | Delivered: ${cappedLeads.length}`,
      payload: {
        verdict: finalVerdict,
        action: finalAction,
        reasons: towerResult.judgement.reasons,
        metrics: towerResult.judgement.metrics,
        delivered: cappedLeads.length,
        requested: requestedCount,
        artefact_id: finalDeliveryArtefact.id,
        execution_source: 'gpt4o_primary',
        phase: 'final_delivery',
      },
      userId,
      conversationId,
    }).catch(() => {});

    await logAFREvent({
      userId, runId, conversationId, clientRequestId,
      actionTaken: 'tower_verdict',
      status: towerResult.shouldStop ? 'failed' : 'success',
      taskGenerated: `Tower final verdict: ${finalVerdict}`,
      runType: 'plan',
      metadata: { verdict: finalVerdict, action: finalAction, delivered: cappedLeads.length, execution_source: 'gpt4o_primary' },
    });
  } catch (towerErr: any) {
    console.error(`[GPT4O_SEARCH] Tower final judgement failed: ${towerErr.message}`);
    finalVerdict = 'tower_unavailable';
    finalAction = 'continue';
    console.warn(`[GPT4O_SEARCH] Tower unavailable — delivering results without Tower verdict. Error: ${towerErr.message}`);

    await createArtefact({
      runId,
      type: 'tower_unavailable',
      title: 'Tower judgement unavailable',
      summary: `Tower API call failed: ${(towerErr.message ?? '').substring(0, 200)}`,
      payload: {
        run_id: runId,
        stage: 'final_delivery',
        error_message: (towerErr.message ?? '').substring(0, 500),
        execution_source: 'gpt4o_primary',
      },
      userId,
      conversationId,
    }).catch(() => {});
  }

  await storage.updateAgentRun(runId, {
    status: 'completed',
    terminalState: finalVerdict === 'error' ? 'failed' : finalVerdict === 'fail' ? 'stopped' : 'completed',
    metadata: {
      verdict: finalVerdict,
      action: finalAction,
      leads_count: cappedLeads.length,
      execution_source: 'gpt4o_primary',
      rounds_performed: roundsPerformed,
      elapsed_ms: Date.now() - runStartTime,
    },
  }).catch((e: any) => console.warn(`[GPT4O_SEARCH] agent_run completion update failed: ${e.message}`));

  const dsPlanVersions: PlanVersionEntry[] = [{ version: 1, changes_made: ['GPT-4o web search'] }];
  const dsSoftRelaxations: SoftRelaxation[] = [];

  // Build the delivery summary input from FinalizedLeads ONLY
  const dsLeads: DeliverySummaryLeadInput[] = finalized.verifiedLeads.map(fl => ({
    entity_id: fl.entity_id,
    name: fl.name,
    address: fl.address,
    found_in_plan_version: 1,
    match_valid: fl.match_valid,
    match_summary: fl.match_summary,
    match_basis: [],
    supporting_evidence: fl.supporting_evidence as any,
    match_evidence: fl.match_evidence as any,
  }));

  const dsInput: DeliverySummaryInput = {
    runId,
    userId,
    conversationId,
    originalUserGoal: rawUserInput,
    requestedCount,
    hardConstraints,
    softConstraints,
    planVersions: dsPlanVersions,
    softRelaxations: dsSoftRelaxations,
    leads: dsLeads,
    finalVerdict,
    finalAction,
    stopReason: null,
    verificationPolicy,
    verificationPolicyReason,
  };

  let dsPayload: DeliverySummaryPayload | null = null;
  if (ctx.suppressDeliverySummary) {
    dsPayload = buildDeliverySummaryPayload(dsInput);
    console.log(`[DELIVERY_SUMMARY] Suppressed artefact emission (re-loop mode) — payload built with ${dsPayload.delivered_exact_count} exact leads`);
  } else {
    dsPayload = await emitDeliverySummary(dsInput);
  }

  await logAFREvent({
    userId, runId, conversationId, clientRequestId,
    actionTaken: 'run_completed',
    status: 'success',
    taskGenerated: `GPT-4o primary search complete: ${cappedLeads.length} lead${cappedLeads.length === 1 ? '' : 's'}, verdict=${finalVerdict}`,
    runType: 'plan',
    metadata: {
      execution_source: 'gpt4o_primary',
      verdict: finalVerdict,
      leads_count: cappedLeads.length,
      rounds_performed: roundsPerformed,
    },
  });

  console.log(`[GPT4O_SEARCH] ===== GPT-4o primary execution complete =====`);
  console.log(`[GPT4O_SEARCH] runId=${runId} leads=${cappedLeads.length} verdict=${finalVerdict} rounds=${roundsPerformed}`);

  return {
    response: 'Run complete. Results are available.',
    leadIds: cappedLeads.map(l => l.placeId),
    deliverySummary: dsPayload,
    towerVerdict: finalVerdict,
    leads: cappedLeads,
  };
}
