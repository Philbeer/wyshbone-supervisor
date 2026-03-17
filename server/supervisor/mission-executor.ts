import type { StructuredMission, MissionConstraint, MissionExtractionTrace, EvidenceRequirement, IntentNarrative } from './mission-schema';
import { defaultEvidenceRequirement } from './mission-schema';
import { extractConstraintLedEvidence, type ConstraintLedExtractionResult, type EvidenceItem, getPageHintsForConstraint } from './constraint-led-extractor';
import type {
  MissionPlan,
  MissionToolStep,
  ConstraintPlanMapping,
  CandidatePoolStrategy,
} from './mission-planner';
import {
  hasRelationshipConstraint,
  hasWebsiteEvidenceConstraint,
  hasDirectFieldConstraint,
  hasRankingConstraint,
  requiresWebVisit,
  requiresTowerJudge,
  logMissionPlan,
  persistMissionPlan,
} from './mission-planner';
import { emitVerificationPolicyArtefact } from './verification-policy';
import { executeAction, createRunToolTracker, type RunToolTracker } from './action-executor';
import { createArtefact } from './artefacts';
import { judgeArtefact } from './tower-artefact-judge';
import { requestSemanticVerification, type TowerSemanticStatus } from './tower-semantic-verify';
import {
  emitDeliverySummary,
  type DeliverySummaryPayload,
  type PlanVersionEntry,
  type SoftRelaxation,
  type MatchEvidenceItem,
  type MatchBasisItem,
  type SupportingEvidenceItem,
} from './delivery-summary';
import { logAFREvent } from './afr-logger';
import { storage } from '../storage';
import { sanitiseLocationString, inferCountryFromLocation } from './goal-to-constraints';
import { detectRelationshipPredicate, type RelationshipPredicateResult } from './relationship-predicate';
import { RADIUS_LADDER_KM } from './agent-loop';

const SUPERVISOR_NEUTRAL_MESSAGE = 'Run complete. Results are available.';
const RUN_EXECUTION_TIMEOUT_MS_DEFAULT = 120_000;
const MAX_TOOL_CALLS_DEFAULT = 150;
const MAX_REPLANS_DEFAULT = 5;
const HARD_CAP_MAX_REPLANS = 10;
const DEFAULT_SEARCH_BUDGET = 20;
const ENRICH_CONCURRENCY = 3;
const ENRICH_BATCH_SIZE = 10;

export interface MissionExecutionContext {
  mission: StructuredMission;
  plan: MissionPlan;
  runId: string;
  userId: string;
  conversationId?: string;
  clientRequestId?: string;
  rawUserInput: string;
  missionTrace: MissionExtractionTrace;
  intentNarrative: IntentNarrative | null;
  queryId?: string | null;
}

export interface MissionExecutionResult {
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

interface DiscoveredLead {
  name: string;
  address: string;
  phone: string | null;
  website: string | null;
  placeId: string;
  source: string;
  lat: number | null;
  lng: number | null;
}

interface EvidenceResult {
  leadIndex: number;
  leadName: string;
  leadPlaceId: string;
  constraintField: string;
  constraintValue: string;
  constraintType: string;
  evidenceFound: boolean;
  evidenceStrength: 'strong' | 'weak' | 'none';
  isBotBlocked: boolean;
  towerStatus: TowerSemanticStatus | null;
  towerConfidence: number | null;
  towerReasoning: string | null;
  sourceUrl: string | null;
  snippets: string[];
  sourceTier?: 'first_party' | 'web_search_fallback' | 'snippet';
}

function buildMatchEvidence(evidenceResults: EvidenceResult[]): MatchEvidenceItem[] {
  const items: MatchEvidenceItem[] = [];
  for (const er of evidenceResults) {
    if (!er.evidenceFound) continue;
    const verificationStatus: MatchEvidenceItem['verification_status'] =
      er.towerStatus === 'verified' ? 'verified' :
      er.towerStatus === 'weak_match' ? 'weak_match' :
      er.evidenceStrength === 'strong' ? 'proxy' :
      'unverified';

    const confidence =
      er.towerConfidence !== null ? er.towerConfidence :
      er.evidenceStrength === 'strong' ? 0.8 :
      er.evidenceStrength === 'weak' ? 0.4 :
      0.1;

    items.push({
      constraint_type: er.constraintType,
      source_url: er.sourceUrl,
      source_type: er.constraintType === 'text_compare' ? 'field_match' :
                   er.constraintType === 'relationship_check' ? 'web_search' :
                   er.sourceUrl ? 'website' : null,
      quote: er.snippets.length > 0 ? er.snippets[0].substring(0, 300) : null,
      matched_phrase: er.constraintValue,
      context_snippet: er.snippets.length > 1 ? er.snippets[1].substring(0, 200) : null,
      confidence,
      verification_status: verificationStatus,
    });
  }

  items.sort((a, b) => b.confidence - a.confidence);
  return items.slice(0, 3);
}

function buildMatchBasis(leadName: string, evidenceResults: EvidenceResult[]): MatchBasisItem[] {
  const byConstraint = new Map<string, EvidenceResult[]>();
  for (const er of evidenceResults) {
    const key = `${er.constraintType}::${er.constraintValue}`;
    const arr = byConstraint.get(key) || [];
    arr.push(er);
    byConstraint.set(key, arr);
  }
  const items: MatchBasisItem[] = [];
  byConstraint.forEach((results, _key) => {
    const best = results.reduce((a, b) => {
      const aScore = a.evidenceFound ? (a.towerConfidence ?? (a.evidenceStrength === 'strong' ? 0.8 : 0.4)) : 0;
      const bScore = b.evidenceFound ? (b.towerConfidence ?? (b.evidenceStrength === 'strong' ? 0.8 : 0.4)) : 0;
      return bScore > aScore ? b : a;
    });
    const valid = best.evidenceFound && best.evidenceStrength !== 'none';
    let reason: string;
    if (best.constraintType === 'text_compare') {
      reason = valid ? `Name/field contains "${best.constraintValue}".` : `No match found for "${best.constraintValue}" in fields.`;
    } else if (best.constraintType === 'website_evidence' || best.constraintType === 'attribute_check') {
      const src = best.sourceUrl ? ' on their website' : '';
      reason = valid
        ? `Evidence of "${best.constraintValue}" found${src}${best.towerStatus === 'verified' ? ' (Tower verified)' : best.towerStatus === 'weak_match' ? ' (weak match)' : ''}.`
        : `No evidence of "${best.constraintValue}" found.`;
    } else if (best.constraintType === 'relationship_check') {
      reason = valid
        ? `Evidence of relationship with "${best.constraintValue}" found${best.towerStatus === 'verified' ? ' (Tower verified)' : ''}.`
        : `No relationship evidence found for "${best.constraintValue}".`;
    } else if (best.constraintType === 'status_check') {
      reason = valid ? `Status "${best.constraintValue}" confirmed.` : `Status "${best.constraintValue}" not confirmed.`;
    } else {
      reason = valid ? `"${best.constraintValue}" matched.` : `"${best.constraintValue}" not matched.`;
    }
    items.push({
      constraint_type: best.constraintType,
      constraint_value: best.constraintValue,
      valid,
      reason,
    });
  });
  return items;
}

function buildSupportingEvidence(leadName: string, evidenceResults: EvidenceResult[]): SupportingEvidenceItem[] {
  const items: SupportingEvidenceItem[] = [];
  for (const er of evidenceResults) {
    if (!er.evidenceFound) continue;
    const vs: SupportingEvidenceItem['verification_status'] =
      er.towerStatus === 'verified' ? 'verified' :
      er.towerStatus === 'weak_match' ? 'weak_match' :
      er.evidenceStrength === 'strong' ? 'proxy' : 'no_relevant_evidence';
    const conf = er.towerConfidence !== null ? er.towerConfidence :
      er.evidenceStrength === 'strong' ? 0.8 : er.evidenceStrength === 'weak' ? 0.4 : 0.1;
    items.push({
      entity_name: leadName,
      constraint_type: er.constraintType,
      constraint_value: er.constraintValue,
      source_url: er.sourceUrl,
      source_type: er.constraintType === 'text_compare' ? 'field_match' :
                   er.constraintType === 'relationship_check' ? 'web_search' :
                   er.sourceUrl ? 'website' : null,
      quote: er.snippets.length > 0 ? er.snippets[0].substring(0, 300) : null,
      matched_phrase: er.constraintValue,
      context_snippet: er.snippets.length > 1 ? er.snippets[1].substring(0, 200) : null,
      verification_status: vs,
      confidence: conf,
    });
  }
  items.sort((a, b) => b.confidence - a.confidence);
  return items.slice(0, 3);
}

function buildMatchSummary(
  leadName: string,
  evidence: MatchEvidenceItem[],
  allResults: EvidenceResult[],
): string {
  if (evidence.length === 0 && allResults.length === 0) {
    return `Included as a search result.`;
  }
  if (evidence.length === 0) {
    return `Included as a candidate — evidence was checked but not confirmed.`;
  }

  const reasons: string[] = [];
  for (const ev of evidence) {
    const status = ev.verification_status === 'verified' ? 'verified' :
                   ev.verification_status === 'weak_match' ? 'partially matched' :
                   'matched';
    if (ev.constraint_type === 'text_compare') {
      reasons.push(`the name/field ${status} "${ev.matched_phrase}"`);
    } else if (ev.constraint_type === 'website_evidence' || ev.constraint_type === 'attribute_check') {
      const via = ev.source_url ? ` on their website` : '';
      reasons.push(`${status} "${ev.matched_phrase}"${via}`);
    } else if (ev.constraint_type === 'relationship_check') {
      reasons.push(`evidence of relationship with "${ev.matched_phrase}" was ${status}`);
    } else if (ev.constraint_type === 'status_check') {
      reasons.push(`status "${ev.matched_phrase}" was ${status}`);
    } else {
      reasons.push(`${status} "${ev.matched_phrase}"`);
    }
  }
  return `Included because ${reasons.join('; ')}.`;
}

function deriveSearchParams(mission: StructuredMission): {
  businessType: string;
  location: string;
  country: string;
  requestedCount: number | null;
  searchBudget: number;
} {
  const businessType = mission.entity_category;
  const rawLocation = mission.location_text ?? 'Local';
  const location = sanitiseLocationString(rawLocation);
  const country = inferCountryFromLocation(location) || 'GB';
  const requestedCount = mission.requested_count;
  const searchBudget = requestedCount
    ? Math.min(50, Math.max(30, requestedCount))
    : DEFAULT_SEARCH_BUDGET;

  return { businessType, location, country, requestedCount, searchBudget };
}

function getTextCompareConstraints(mission: StructuredMission): MissionConstraint[] {
  return mission.constraints.filter(c => c.type === 'text_compare');
}

function getNumericRangeConstraints(mission: StructuredMission): MissionConstraint[] {
  return mission.constraints.filter(c => c.type === 'numeric_range');
}

function getEvidenceConstraints(mission: StructuredMission): MissionConstraint[] {
  return mission.constraints.filter(
    c =>
      c.type === 'attribute_check' ||
      c.type === 'website_evidence' ||
      c.type === 'status_check' ||
      c.type === 'time_constraint',
  );
}

function getRelationshipConstraints(mission: StructuredMission): MissionConstraint[] {
  return mission.constraints.filter(c => c.type === 'relationship_check');
}

function getRankingConstraints(mission: StructuredMission): MissionConstraint[] {
  return mission.constraints.filter(c => c.type === 'ranking');
}

export interface HardEvidenceFilterInput {
  leadIndex: number;
  constraintField: string;
  constraintValue: string;
  evidenceFound: boolean;
  isBotBlocked?: boolean;
}

export interface HardEvidenceConstraintRef {
  field: string;
  value: string | number | boolean | null;
}

export function applyHardEvidenceFilter<T>(
  leads: T[],
  evidenceResults: HardEvidenceFilterInput[],
  hardEvidenceConstraints: HardEvidenceConstraintRef[],
): T[] {
  const leadsWithEvidence = new Set<number>();
  for (const er of evidenceResults) {
    if (er.evidenceFound && hardEvidenceConstraints.some(c => c.field === er.constraintField || String(c.value) === er.constraintValue)) {
      leadsWithEvidence.add(er.leadIndex);
    }
  }

  const botBlockedLeads = new Set<number>();
  for (const er of evidenceResults) {
    if (er.isBotBlocked) {
      botBlockedLeads.add(er.leadIndex);
    }
  }

  const leadsChecked = new Set(evidenceResults.map(r => r.leadIndex));
  return leads.filter((_, i) => {
    if (!leadsChecked.has(i)) return false;
    if (botBlockedLeads.has(i)) return true;
    return leadsWithEvidence.has(i);
  });
}

function applyFieldFilters(
  leads: DiscoveredLead[],
  mission: StructuredMission,
  runId: string,
): DiscoveredLead[] {
  let filtered = [...leads];

  for (const tc of getTextCompareConstraints(mission)) {
    const value = typeof tc.value === 'string' ? tc.value : '';
    if (!value) continue;

    const before = filtered.length;
    switch (tc.operator) {
      case 'contains':
        filtered = filtered.filter(l => l.name.toLowerCase().includes(value.toLowerCase()));
        break;
      case 'starts_with':
        filtered = filtered.filter(l => l.name.toLowerCase().startsWith(value.toLowerCase()));
        break;
      case 'ends_with':
        filtered = filtered.filter(l => l.name.toLowerCase().endsWith(value.toLowerCase()));
        break;
      case 'equals':
        filtered = filtered.filter(l => l.name.toLowerCase() === value.toLowerCase());
        break;
      case 'not_contains':
        filtered = filtered.filter(l => !l.name.toLowerCase().includes(value.toLowerCase()));
        break;
    }
    console.log(
      `[MISSION_EXEC] Field filter: ${tc.field} ${tc.operator} "${value}" — ${before} → ${filtered.length}`,
    );
  }

  return filtered;
}

function buildHardConstraintLabels(mission: StructuredMission): string[] {
  return mission.constraints
    .filter(c => c.hardness === 'hard')
    .map(c => {
      if (c.type === 'text_compare') return `name_${c.operator}`;
      if (c.type === 'numeric_range') return `${c.field}_${c.operator}`;
      return c.type;
    });
}

function buildSoftConstraintLabels(mission: StructuredMission): string[] {
  return mission.constraints
    .filter(c => c.hardness === 'soft')
    .map(c => c.type);
}

export interface StructuredConstraintPayload {
  id: string;
  type: string;
  field: string;
  operator: string;
  value: string | number | boolean | null;
  hardness: 'hard' | 'soft';
  evidence_requirement: EvidenceRequirement;
  label: string;
}

function buildStructuredConstraints(mission: StructuredMission): StructuredConstraintPayload[] {
  return mission.constraints.map((c, idx) => {
    const evReq = c.evidence_requirement ?? defaultEvidenceRequirement(c.type as any, c.operator);
    const label = c.type === 'text_compare'
      ? `${c.field} ${c.operator} "${c.value}"`
      : c.type === 'numeric_range'
        ? `${c.field} ${c.operator} ${c.value}${c.value_secondary != null ? ` and ${c.value_secondary}` : ''}`
        : `${c.type}: ${c.field} ${c.operator} ${String(c.value ?? '')}`;

    return {
      id: `c${idx}`,
      type: c.type,
      field: c.field,
      operator: c.operator,
      value: c.value,
      hardness: c.hardness,
      evidence_requirement: evReq,
      label,
    };
  });
}

interface GeneratedQuery {
  query: string;
  rationale: string;
}

async function generatePlacesQueries(
  intentNarrative: IntentNarrative,
  fallbackQuery: string,
): Promise<GeneratedQuery[]> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.warn('[PLACES] OPENAI_API_KEY not set — using fallback query');
    return [{ query: fallbackQuery, rationale: 'fallback — no API key' }];
  }

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: openaiKey });

  const prompt = `You are a Google Places search expert. Generate 3-5 search queries that will find the best results in Google Places for this business type.

Entity the user wants:
${intentNarrative.entity_description}

Key discriminator (what makes a result correct):
${intentNarrative.key_discriminator}

Things to avoid:
${JSON.stringify(intentNarrative.entity_exclusions)}

Suggested approaches:
${intentNarrative.suggested_approaches.join('\n')}

Rules:
- Each query should use different keywords to maximise coverage
- Prefer specific terms over generic ones
- Google Places works best with short noun phrases like "craft beer shop" or "independent off licence"
- Do not include location — that is added separately
- Order queries from most specific to least specific

Respond with JSON only:
{
  "queries": [
    { "query": "craft beer bottle shop", "rationale": "most specific term" },
    ...
  ]
}`;

  try {
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 512,
      response_format: { type: 'json_object' },
    });
    const raw = (resp.choices[0]?.message?.content ?? '').trim();
    const parsed = JSON.parse(raw) as { queries: GeneratedQuery[] };
    const queries = parsed.queries?.filter(q => typeof q.query === 'string' && q.query.trim()) ?? [];
    if (queries.length === 0) throw new Error('empty queries array');
    return queries.slice(0, 5);
  } catch (err: any) {
    console.warn(`[PLACES] Query generation failed (non-fatal): ${err.message} — using fallback`);
    return [{ query: fallbackQuery, rationale: 'fallback — query generation failed' }];
  }
}

interface ExclusionFilterResult {
  kept: DiscoveredLead[];
  excluded: Array<{ name: string; reason: string }>;
}

async function filterByEntityExclusions(
  leads: DiscoveredLead[],
  intentNarrative: IntentNarrative,
): Promise<ExclusionFilterResult> {
  if (!intentNarrative.entity_exclusions || intentNarrative.entity_exclusions.length === 0) {
    return { kept: leads, excluded: [] };
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.warn('[EXCL_FILTER] OPENAI_API_KEY not set — skipping exclusion filter');
    return { kept: leads, excluded: [] };
  }

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: openaiKey });

  const kept: DiscoveredLead[] = [];
  const excluded: Array<{ name: string; reason: string }> = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    const businessList = batch
      .map((l, idx) => `${idx + 1}. Name: "${l.name}" | Address: "${l.address}"`)
      .join('\n');

    const prompt = `Given these entity exclusions: ${JSON.stringify(intentNarrative.entity_exclusions)}
And this key discriminator: "${intentNarrative.key_discriminator}"

For each of these businesses, classify as:
- INCLUDE: likely matches what the user wants
- EXCLUDE: matches an exclusion (state which one)
- UNCERTAIN: cannot tell without visiting website

Businesses:
${businessList}

Respond with a JSON array only, no markdown fences:
[{ "name": "...", "decision": "INCLUDE|EXCLUDE|UNCERTAIN", "reason": "..." }]`;

    try {
      const resp = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 512,
      });
      const raw = (resp.choices[0]?.message?.content ?? '').trim();
      const parsed = JSON.parse(raw) as Array<{ name: string; decision: string; reason: string }>;
      for (let j = 0; j < batch.length; j++) {
        const lead = batch[j];
        const judgement = parsed[j] ?? { decision: 'UNCERTAIN', reason: 'no judgement returned' };
        if (judgement.decision === 'EXCLUDE') {
          excluded.push({ name: lead.name, reason: judgement.reason });
          console.log(`[EXCL_FILTER] EXCLUDED "${lead.name}": ${judgement.reason}`);
        } else {
          kept.push(lead);
          if (judgement.decision === 'UNCERTAIN') {
            console.log(`[EXCL_FILTER] UNCERTAIN "${lead.name}" — kept for website verification`);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[EXCL_FILTER] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed (non-fatal): ${err.message} — keeping all ${batch.length} leads`);
      kept.push(...batch);
    }
  }

  console.log(`[EXCL_FILTER] Complete — kept=${kept.length} excluded=${excluded.length} from ${leads.length} candidates`);
  return { kept, excluded };
}

export async function executeMissionDrivenPlan(
  ctx: MissionExecutionContext,
): Promise<MissionExecutionResult> {
  const { mission, plan, runId, userId, conversationId, clientRequestId, rawUserInput, missionTrace, intentNarrative, queryId } = ctx;
  console.log('[QID-TRACE]', 'step3:executeMissionDrivenPlan_destructured', queryId);
  const { businessType, location, country, requestedCount, searchBudget } = deriveSearchParams(mission);

  const MAX_REPLANS = Math.min(
    parseInt(process.env.MAX_REPLANS || String(MAX_REPLANS_DEFAULT), 10),
    HARD_CAP_MAX_REPLANS,
  );
  const RUN_EXECUTION_TIMEOUT_MS = parseInt(
    process.env.RUN_EXECUTION_TIMEOUT_MS || process.env.MAX_RUN_DURATION_MS || String(RUN_EXECUTION_TIMEOUT_MS_DEFAULT), 10,
  );
  const MAX_TOOL_CALLS = parseInt(process.env.MAX_TOOL_CALLS_PER_RUN || String(MAX_TOOL_CALLS_DEFAULT), 10);

  const runStartTime = Date.now();
  let runToolCallCount = 0;
  let runDeadlineExceeded = false;
  let runDeadlineReason = '';

  const checkDeadline = (): boolean => {
    const elapsed = Date.now() - runStartTime;
    if (elapsed > RUN_EXECUTION_TIMEOUT_MS) {
      runDeadlineExceeded = true;
      runDeadlineReason = `execution_timeout: ${Math.round(elapsed / 1000)}s > ${Math.round(RUN_EXECUTION_TIMEOUT_MS / 1000)}s`;
      return true;
    }
    if (runToolCallCount > MAX_TOOL_CALLS) {
      runDeadlineExceeded = true;
      runDeadlineReason = `max_tool_calls: ${runToolCallCount} > ${MAX_TOOL_CALLS}`;
      return true;
    }
    return false;
  };

  const hardConstraints = buildHardConstraintLabels(mission);
  const softConstraints = buildSoftConstraintLabels(mission);
  const structuredConstraints = buildStructuredConstraints(mission);
  const toolTracker = createRunToolTracker();
  const createdLeadIds: string[] = [];
  const placeIdToDbId = new Map<string, string>();

  const normalizedGoal = `Find ${requestedCount ? requestedCount + ' ' : ''}${businessType} in ${location}`;

  console.log(`[MISSION_EXEC] ===== Mission-driven execution starting =====`);
  console.log(`[MISSION_EXEC] runId=${runId} strategy=${plan.strategy} tools=${plan.tool_sequence.join(' → ')}`);
  console.log(`[MISSION_EXEC] entity="${businessType}" location="${location}" country="${country}" count=${requestedCount}`);
  console.log(`[MISSION_EXEC] constraints=${mission.constraints.length} hard=${hardConstraints.length} soft=${softConstraints.length} structured=${structuredConstraints.length}`);
  console.log(`[MISSION_EXEC] timeout=${RUN_EXECUTION_TIMEOUT_MS}ms max_tool_calls=${MAX_TOOL_CALLS}`);

  logMissionPlan(plan, runId);

  await storage.updateAgentRun(runId, {
    status: 'executing',
    error: null,
    terminalState: null,
    metadata: {
      feature_flag: 'MISSION_DRIVEN_EXECUTION',
      execution_source: 'mission',
      original_user_goal: rawUserInput,
      normalized_goal: normalizedGoal,
      mission_strategy: plan.strategy,
      mission_tool_sequence: plan.tool_sequence,
    },
  }).catch((e: any) => console.warn(`[MISSION_EXEC] agent_run update failed (non-fatal): ${e.message}`));

  const missionPlanArtefact = await createArtefact({
    runId,
    type: 'plan',
    title: `Mission Plan v1: ${plan.strategy} — ${plan.tool_sequence.join(' → ')}`,
    summary: `Mission-driven execution | strategy=${plan.strategy} | tools=${plan.tool_sequence.length} | constraints=${plan.constraint_mappings.length}`,
    payload: {
      execution_source: 'mission',
      raw_user_input: rawUserInput,
      pass1_semantic: missionTrace.pass1_semantic_interpretation,
      mission: mission as unknown as Record<string, unknown>,
      mission_plan: plan as unknown as Record<string, unknown>,
      hard_constraints: hardConstraints,
      soft_constraints: softConstraints,
      structured_constraints: structuredConstraints,
      requested_count: requestedCount,
      search_budget: searchBudget,
    },
    userId,
    conversationId,
  });

  await emitVerificationPolicyArtefact({
    runId,
    userId,
    conversationId,
    query: rawUserInput,
    strategy: plan.strategy,
    policyResult: plan.verification_policy,
  }).catch((e: any) => console.warn(`[MISSION_EXEC] verification_policy artefact failed (non-fatal): ${e.message}`));

  if (missionTrace.pass1_constraint_checklist) {
    await createArtefact({
      runId,
      type: 'pass1_constraint_checklist',
      title: 'Pass 1 Constraint Checklist',
      summary: `Constraint classification from Pass 1 semantic interpretation`,
      payload: {
        constraint_checklist: missionTrace.pass1_constraint_checklist as unknown as Record<string, unknown>,
      },
      userId,
      conversationId,
    });
  }

  if (missionTrace.implicit_expansion && (missionTrace.implicit_expansion.inferred_constraints.length > 0 || missionTrace.implicit_expansion.inference_notes.length > 0)) {
    await createArtefact({
      runId,
      type: 'implicit_constraint_expansion',
      title: 'Implicit Constraint Expansion',
      summary: `Expanded ${missionTrace.implicit_expansion.inferred_constraints.length} inferred constraint(s) from user phrasing`,
      payload: {
        explicit_constraints: missionTrace.implicit_expansion.explicit_constraints,
        inferred_constraints: missionTrace.implicit_expansion.inferred_constraints as unknown as Record<string, unknown>[],
        inference_notes: missionTrace.implicit_expansion.inference_notes,
        had_addendum: missionTrace.implicit_expansion.had_addendum,
      },
      userId,
      conversationId,
    });
  }

  if (intentNarrative) {
    await createArtefact({
      runId,
      type: 'intent_narrative',
      title: 'Intent Narrative (Pass 3)',
      summary: `entity="${intentNarrative.entity_description.substring(0, 80)}" scarcity=${intentNarrative.scarcity_expectation} exclusions=${intentNarrative.entity_exclusions.length}`,
      payload: intentNarrative as unknown as Record<string, unknown>,
      userId,
      conversationId,
    }).catch((e: any) => console.warn(`[MISSION_EXEC] intent_narrative artefact failed (non-fatal): ${e.message}`));
  }

  await logAFREvent({
    userId, runId, conversationId, clientRequestId,
    actionTaken: 'plan_execution_started', status: 'pending',
    taskGenerated: `Mission-driven execution: ${normalizedGoal} (${plan.strategy})`,
    runType: 'plan',
    metadata: {
      execution_source: 'mission',
      strategy: plan.strategy,
      tool_sequence: plan.tool_sequence,
      planArtefactId: missionPlanArtefact.id,
    },
  });

  let leads: DiscoveredLead[] = [];
  let usedStub = false;
  let candidateCountFromGoogle = 0;
  const poolStrategy = plan.candidate_pool;
  const effectiveSearchBudget = poolStrategy?.applied
    ? Math.max(searchBudget, poolStrategy.candidate_pool_size)
    : searchBudget;
  let currentSearchBudget = effectiveSearchBudget;
  let currentLocation = location;
  let currentBusinessType = businessType;
  const effectiveEnrichBatch = poolStrategy?.applied
    ? Math.min(poolStrategy.candidate_pool_size, 30)
    : ENRICH_BATCH_SIZE;

  const relationshipConstraints = getRelationshipConstraints(mission);
  const relationshipPredicate: RelationshipPredicateResult = relationshipConstraints.length > 0
    ? detectRelationshipPredicate(rawUserInput)
    : { requires_relationship_evidence: false, detected_predicate: null, relationship_target: null };

  if (relationshipPredicate.requires_relationship_evidence) {
    console.log(`[MISSION_EXEC] Relationship predicate detected: "${relationshipPredicate.detected_predicate}" target="${relationshipPredicate.relationship_target}"`);
  }

  if (poolStrategy?.applied) {
    console.log(`[MISSION_EXEC] Candidate pool expansion active: search_budget=${effectiveSearchBudget} enrich_batch=${effectiveEnrichBatch} (requested=${requestedCount ?? 'any'} pool=${poolStrategy.candidate_pool_size})`);
    await createArtefact({
      runId,
      type: 'candidate_pool_strategy',
      title: `Candidate Pool: ${poolStrategy.candidate_pool_size} (×${poolStrategy.multiplier})`,
      summary: poolStrategy.reason,
      payload: {
        requested_results: poolStrategy.requested_results,
        candidate_pool_size: poolStrategy.candidate_pool_size,
        multiplier: poolStrategy.multiplier,
        effective_search_budget: effectiveSearchBudget,
        effective_enrich_batch: effectiveEnrichBatch,
        reason: poolStrategy.reason,
        applied: poolStrategy.applied,
      },
      userId,
      conversationId,
    }).catch(() => {});
  }

  const relationshipDir = plan.relationship_direction;
  if (relationshipDir?.relationship_query) {
    console.log(`[MISSION_EXEC] Relationship direction: ${relationshipDir.chosen_direction} (left="${relationshipDir.left_entity?.raw}" right="${relationshipDir.right_entity?.raw}")`);
    if (relationshipDir.chosen_direction === 'reverse') {
      console.log(`[MISSION_EXEC] Reverse search queries: ${relationshipDir.reverse_search_queries.join(' | ')}`);
    }

    await createArtefact({
      runId,
      type: 'planner_relationship_direction',
      title: `Relationship Direction: ${relationshipDir.chosen_direction}`,
      summary: `${relationshipDir.chosen_direction === 'reverse' ? 'Searching from authority/institutional entity first' : 'Standard forward search'} — ${relationshipDir.reason}`,
      payload: {
        relationship_query: relationshipDir.relationship_query,
        left_entity: relationshipDir.left_entity?.raw ?? null,
        left_entity_label: relationshipDir.left_entity?.label ?? null,
        left_entity_score: relationshipDir.left_entity?.institutional_score ?? null,
        right_entity: relationshipDir.right_entity?.raw ?? null,
        right_entity_label: relationshipDir.right_entity?.label ?? null,
        right_entity_score: relationshipDir.right_entity?.institutional_score ?? null,
        chosen_direction: relationshipDir.chosen_direction,
        reason: relationshipDir.reason,
        reverse_search_queries: relationshipDir.reverse_search_queries,
      },
      userId,
      conversationId,
    }).catch(() => {});
  }

  console.log(`[MISSION_EXEC] === Phase: SEARCH_PLACES ===`);
  const searchStepStart = Date.now();

  const fallbackQuery = currentBusinessType;
  let generatedQueries: GeneratedQuery[];
  if (intentNarrative) {
    console.log(`[PLACES] Generating optimised queries from intent_narrative for "${intentNarrative.entity_description.substring(0, 80)}"`);
    generatedQueries = await generatePlacesQueries(intentNarrative, fallbackQuery);
  } else {
    generatedQueries = [{ query: fallbackQuery, rationale: 'no intent_narrative — using entity_category' }];
  }

  console.log(`[PLACES] Generated ${generatedQueries.length} quer${generatedQueries.length === 1 ? 'y' : 'ies'} for "${(intentNarrative?.entity_description ?? fallbackQuery).substring(0, 80)}"`);

  await createArtefact({
    runId,
    type: 'search_query_plan',
    title: `Search query plan: ${generatedQueries.length} queries for "${businessType}"`,
    summary: `${generatedQueries.length} optimised Places queries generated${intentNarrative ? ' from intent_narrative' : ' (fallback)'}`,
    payload: {
      execution_source: 'mission',
      entity_description: intentNarrative?.entity_description ?? null,
      key_discriminator: intentNarrative?.key_discriminator ?? null,
      entity_exclusions: intentNarrative?.entity_exclusions ?? [],
      suggested_approaches: intentNarrative?.suggested_approaches ?? [],
      fallback_query: fallbackQuery,
      generated_queries: generatedQueries,
    },
    userId,
    conversationId,
  }).catch((e: any) => console.warn(`[PLACES] search_query_plan artefact failed (non-fatal): ${e.message}`));

  const placeMatchCount = new Map<string, { lead: DiscoveredLead; count: number }>();
  const placeNameToId = new Map<string, string>();
  const PLACES_PER_QUERY = 10;
  const MAX_QUERIES = 5;
  const queriesToRun = generatedQueries.slice(0, MAX_QUERIES);

  for (let qi = 0; qi < queriesToRun.length; qi++) {
    const { query: qText, rationale } = queriesToRun[qi];
    try {
      runToolCallCount++;
      const qResult = await executeAction({
        toolName: 'SEARCH_PLACES',
        toolArgs: {
          query: qText,
          location: currentLocation,
          country,
          maxResults: PLACES_PER_QUERY,
          target_count: requestedCount ?? DEFAULT_SEARCH_BUDGET,
        },
        userId,
        tracker: toolTracker,
        runId,
        conversationId,
        clientRequestId,
      });

      let qResultCount = 0;
      if (qResult.success && qResult.data?.places && Array.isArray(qResult.data.places)) {
        const places = qResult.data.places as any[];
        qResultCount = places.length;
        for (const p of places) {
          const pid = p.place_id || p.id || '';
          if (!pid) continue;
          const rawName = p.name || p.displayName?.text || 'Unknown Business';
          const normName = rawName.toLowerCase().trim().split(',')[0].trim();
          if (placeMatchCount.has(pid)) {
            placeMatchCount.get(pid)!.count += 1;
          } else if (normName && placeNameToId.has(normName)) {
            const existingPid = placeNameToId.get(normName)!;
            placeMatchCount.get(existingPid)!.count += 1;
            console.log(`[PLACES_DEDUP] Merged pid="${pid}" (${rawName}) → existing pid="${existingPid}" (same name)`);
          } else {
            placeMatchCount.set(pid, {
              count: 1,
              lead: {
                name: rawName,
                address: p.formatted_address || p.formattedAddress || `${location}, ${country}`,
                phone: p.phone || p.nationalPhoneNumber || p.internationalPhoneNumber || null,
                website: p.website || p.websiteUri || null,
                placeId: pid,
                source: 'google_places',
                lat: typeof p.lat === 'number' ? p.lat : (p.geometry?.location?.lat ?? null),
                lng: typeof p.lng === 'number' ? p.lng : (p.geometry?.location?.lng ?? null),
              },
            });
            if (normName) placeNameToId.set(normName, pid);
          }
        }
      }
      console.log(`[PLACES] Query ${qi + 1}: "${qText}" → ${qResultCount} results (rationale: ${rationale})`);
    } catch (qErr: any) {
      console.warn(`[PLACES] Query ${qi + 1} "${qText}" failed (non-fatal): ${qErr.message}`);
    }
  }

  const sortedEntries = Array.from(placeMatchCount.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.lead.name.localeCompare(b.lead.name);
  });

  const websiteVisitCap = requestedCount !== null ? requestedCount * 2 : currentSearchBudget;
  const cappedCandidates = sortedEntries.slice(0, Math.max(websiteVisitCap, PLACES_PER_QUERY));

  for (const entry of cappedCandidates) {
    leads.push(entry.lead);
  }

  candidateCountFromGoogle = leads.length;
  console.log(`[PLACES] After dedup: ${placeMatchCount.size} unique candidates | after cap (${websiteVisitCap}): ${leads.length} → proceeding to exclusion filter`);

  const searchStepEnd = Date.now();
  await createArtefact({
    runId,
    type: 'step_result',
    title: `Step 1: SEARCH_PLACES — ${leads.length} results (${queriesToRun.length} queries)`,
    summary: `${leads.length > 0 ? 'success' : 'fail'} — ${leads.length} ${businessType} found in ${location} via ${queriesToRun.length} generated queries`,
    payload: {
      execution_source: 'mission',
      step_index: 0,
      step_tool: 'SEARCH_PLACES',
      step_status: leads.length > 0 ? 'success' : 'fail',
      results_count: leads.length,
      unique_candidates_before_cap: placeMatchCount.size,
      website_visit_cap: websiteVisitCap,
      queries_run: queriesToRun.length,
      queries: queriesToRun,
      timings: {
        started_at: new Date(searchStepStart).toISOString(),
        finished_at: new Date(searchStepEnd).toISOString(),
        duration_ms: searchStepEnd - searchStepStart,
      },
    },
    userId,
    conversationId,
  }).catch((e: any) => console.warn(`[MISSION_EXEC] step_result artefact failed: ${e.message}`));

  await logAFREvent({
    userId, runId, conversationId, clientRequestId,
    actionTaken: 'step_completed', status: leads.length > 0 ? 'success' : 'failed',
    taskGenerated: `SEARCH_PLACES: ${leads.length} leads found`,
    runType: 'plan',
    metadata: { step: 1, tool: 'SEARCH_PLACES', leads_count: leads.length },
  });

  let excludedCandidates: Array<{ name: string; reason: string }> = [];
  if (intentNarrative && intentNarrative.entity_exclusions.length > 0 && leads.length > 0) {
    console.log(`[MISSION_EXEC] === Phase: EXCLUSION_FILTER (${intentNarrative.entity_exclusions.length} exclusion rules) ===`);
    const filterResult = await filterByEntityExclusions(leads, intentNarrative);
    excludedCandidates = filterResult.excluded;
    leads = filterResult.kept;
    if (filterResult.excluded.length > 0) {
      await createArtefact({
        runId,
        type: 'exclusion_filter',
        title: `Exclusion filter: ${filterResult.excluded.length} removed, ${filterResult.kept.length} kept`,
        summary: `Removed ${filterResult.excluded.length} candidates matching entity_exclusions before website visits`,
        payload: {
          execution_source: 'mission',
          entity_exclusions: intentNarrative.entity_exclusions,
          key_discriminator: intentNarrative.key_discriminator,
          excluded_count: filterResult.excluded.length,
          kept_count: filterResult.kept.length,
          excluded: filterResult.excluded,
        },
        userId,
        conversationId,
      }).catch((e: any) => console.warn(`[MISSION_EXEC] exclusion_filter artefact failed (non-fatal): ${e.message}`));
    }
  }

  console.log(`[PLACES] After exclusion filter: ${leads.length} kept${excludedCandidates.length > 0 ? ` (${excludedCandidates.length} removed)` : ''}`);

  const evidenceResults: EvidenceResult[] = [];

  if (plan.tool_sequence.includes('FILTER_FIELDS')) {
    console.log(`[MISSION_EXEC] === Phase: FILTER_FIELDS ===`);
    const beforeFilter = leads.length;
    const filterConstraints = getTextCompareConstraints(mission);
    leads = applyFieldFilters(leads, mission, runId);
    console.log(`[MISSION_EXEC] FILTER_FIELDS: ${beforeFilter} → ${leads.length}`);

    for (let i = 0; i < leads.length; i++) {
      for (const fc of filterConstraints) {
        const filterValue = typeof fc.value === 'string' ? fc.value : String(fc.value ?? '');
        if (!filterValue) continue;
        evidenceResults.push({
          leadIndex: i,
          leadName: leads[i].name,
          leadPlaceId: leads[i].placeId,
          constraintField: fc.field,
          constraintValue: filterValue,
          constraintType: fc.type,
          evidenceFound: true,
          evidenceStrength: 'strong',
          towerStatus: null,
          towerConfidence: null,
          towerReasoning: null,
          sourceUrl: null,
          snippets: [`Field match: ${fc.field} ${fc.operator} "${filterValue}" → matched "${leads[i].name}"`],
        });
      }
    }
    console.log(`[MISSION_EXEC] FILTER_FIELDS: generated ${leads.length * filterConstraints.length} field_match evidence items`);

    await createArtefact({
      runId,
      type: 'step_result',
      title: `Step: FILTER_FIELDS — ${beforeFilter} → ${leads.length}`,
      summary: `Field filtering applied: ${beforeFilter} → ${leads.length} leads`,
      payload: {
        execution_source: 'mission',
        step_tool: 'FILTER_FIELDS',
        before_count: beforeFilter,
        after_count: leads.length,
        filters_applied: filterConstraints.map(c => ({
          field: c.field,
          operator: c.operator,
          value: c.value,
        })),
      },
      userId,
      conversationId,
    }).catch(() => {});
  }

  if (leads.length > currentSearchBudget) {
    leads = leads.slice(0, currentSearchBudget);
  }

  for (const lead of leads) {
    try {
      const created = await storage.createSuggestedLead({
        userId,
        rationale: `Mission-driven ${businessType} lead in ${location}`,
        source: 'mission_executor',
        score: 0.75,
        lead: {
          name: lead.name,
          address: lead.address,
          place_id: lead.placeId,
          domain: lead.website || '',
          emailCandidates: [],
          tags: [businessType, 'mission_executor'],
          phone: lead.phone || '',
        },
      });
      createdLeadIds.push(created.id);
      placeIdToDbId.set(lead.placeId, created.id);
    } catch (leadErr: any) {
      console.error(`[MISSION_EXEC] Failed to persist lead "${lead.name}": ${leadErr.message}`);
    }
  }

  const evidenceConstraints = getEvidenceConstraints(mission);
  const webVisitPages = new Map<number, any[]>();

  if (
    requiresWebVisit(plan) &&
    leads.length > 0 &&
    !checkDeadline()
  ) {
    console.log(`[MISSION_EXEC] === Phase: Evidence Gathering ===`);
    const needsWebVisit = requiresWebVisit(plan);
    const constraintsToVerify = [...evidenceConstraints, ...relationshipConstraints];

    const enrichableLeads = leads
      .map((l, i) => ({ ...l, _idx: i }))
      .filter(l => needsWebVisit && l.website)
      .slice(0, effectiveEnrichBatch);

    console.log(`[MISSION_EXEC] Evidence gathering for ${enrichableLeads.length} leads (web_visit=${needsWebVisit})`);

    const processOneLead = async (lead: typeof enrichableLeads[0], _eli: number) => {
      const leadIdx = lead._idx;
      let pages: any[] = [];

      if (needsWebVisit && lead.website) {
        try {
          const allPageHints: string[] = [];
          for (const c of constraintsToVerify) {
            const cValue = typeof c.value === 'string' ? c.value : String(c.value ?? '');
            const hints = getPageHintsForConstraint({
              type: c.type, field: c.field, operator: c.operator, value: cValue, hardness: c.hardness,
            });
            for (const h of hints) {
              if (!allPageHints.includes(h)) allPageHints.push(h);
            }
          }
          const pageHintsArg = allPageHints.length > 0 ? allPageHints.slice(0, 6) : undefined;

          runToolCallCount++;
          const wvResult = await executeAction({
            toolName: 'WEB_VISIT',
            toolArgs: {
              url: lead.website,
              max_pages: 5,
              same_domain_only: true,
              ...(pageHintsArg ? { page_hints: pageHintsArg } : {}),
            },
            userId,
            tracker: toolTracker,
            runId,
            conversationId,
            clientRequestId,
          });

          if (wvResult.success && wvResult.data) {
            const visitPages = (wvResult.data as any)?.envelope?.outputs?.pages || [];
            if (Array.isArray(visitPages)) {
              pages = visitPages;
              webVisitPages.set(leadIdx, pages);
            }
          }
          console.log(`[MISSION_EXEC] WEB_VISIT for "${lead.name}": ${pages.length} pages`);
        } catch (wvErr: any) {
          console.warn(`[MISSION_EXEC] WEB_VISIT failed for "${lead.name}": ${wvErr.message}`);
        }
      }

      for (const constraint of constraintsToVerify) {
        const constraintValue = typeof constraint.value === 'string' ? constraint.value : String(constraint.value ?? '');

        const extraction: ConstraintLedExtractionResult = await extractConstraintLedEvidence(
          pages,
          {
            type: constraint.type,
            field: constraint.field,
            operator: constraint.operator,
            value: constraintValue,
            hardness: constraint.hardness,
          },
          [],
          3,
          lead.name,
        );

        const extractedQuotes = extraction.evidence_items.map(e => e.direct_quote);
        const keywordFound = extraction.evidence_items.length > 0;

        if (extraction.evidence_items.length > 0) {
          console.log(`[MISSION_EXEC] Constraint-led extraction for "${lead.name}" + "${constraintValue}": ${extraction.evidence_items.length} evidence item(s), phrases=${extraction.phrase_targets.length}`);
        } else {
          console.log(`[MISSION_EXEC] Constraint-led extraction for "${lead.name}" + "${constraintValue}": no evidence found`);
        }

        let towerStatus: TowerSemanticStatus | null = null;
        let towerConfidence: number | null = null;
        let towerReasoning: string | null = null;

        const structuredEvidenceText = extraction.evidence_items.length > 0
          ? extraction.evidence_items.map((e, i) =>
              `[Evidence ${i + 1}] Source: ${e.source_url} | Quote: "${e.direct_quote}" | Context: ${e.context_snippet}`
            ).join('\n')
          : '';

        const hasSubstantialEvidence = structuredEvidenceText.length > 30 || extractedQuotes.length > 0;

        if (requiresTowerJudge(plan) && hasSubstantialEvidence) {
          const bestEvidence = extraction.evidence_items[0];
          const bestEvidenceUrl = bestEvidence?.source_url || lead.website || 'web_search';
          const bestPageTitle = bestEvidence?.page_title || pages[0]?.title || null;

          try {
            const verifyResult = await requestSemanticVerification({
              request: {
                run_id: runId,
                original_user_goal: rawUserInput,
                lead_name: lead.name,
                lead_place_id: lead.placeId,
                constraint_to_check: constraintValue,
                source_url: bestEvidenceUrl,
                evidence_text: structuredEvidenceText.substring(0, 5000),
                extracted_quotes: extractedQuotes,
                page_title: bestPageTitle,
              },
              userId,
              conversationId,
              clientRequestId,
            });

            towerStatus = verifyResult.towerResponse.status;
            towerConfidence = verifyResult.towerResponse.confidence;
            towerReasoning = verifyResult.towerResponse.reasoning;
            console.log(
              `[MISSION_EXEC] Tower semantic: "${lead.name}" + "${constraintValue}" → ${towerStatus} (confidence=${towerConfidence})`,
            );
          } catch (towerErr: any) {
            console.warn(`[MISSION_EXEC] Tower semantic verify failed for "${lead.name}": ${towerErr.message}`);
          }
        }

        const evidenceStrength: 'strong' | 'weak' | 'none' =
          towerStatus === 'verified' ? 'strong' :
          towerStatus === 'weak_match' || keywordFound ? 'weak' :
          'none';

        const pagesWithContent = pages.filter(p => (p.text_clean || p.text || '').trim().length > 50);
        const isBotBlocked = pagesWithContent.length === 0 && !!lead.website;

        evidenceResults.push({
          leadIndex: leadIdx,
          leadName: lead.name,
          leadPlaceId: lead.placeId,
          constraintField: constraint.field,
          constraintValue,
          constraintType: constraint.type,
          evidenceFound: evidenceStrength !== 'none',
          evidenceStrength,
          isBotBlocked,
          towerStatus,
          towerConfidence,
          towerReasoning,
          sourceUrl: lead.website || null,
          snippets: extractedQuotes,
        });

        await createArtefact({
          runId,
          type: 'constraint_led_evidence',
          title: `Evidence: "${lead.name}" — ${constraint.type}: "${constraintValue}"`,
          summary: extraction.no_evidence
            ? `No evidence found for "${constraintValue}" on "${lead.name}"`
            : `${extraction.evidence_items.length} evidence item(s) for "${constraintValue}" (${extraction.extraction_method})`,
          payload: {
            lead_name: lead.name,
            lead_place_id: lead.placeId,
            constraint: {
              type: constraint.type,
              field: constraint.field,
              operator: constraint.operator,
              value: constraintValue,
              hardness: constraint.hardness,
            },
            pages_scanned: extraction.pages_scanned,
            extraction_method: extraction.extraction_method,
            no_evidence: extraction.no_evidence,
            phrase_targets: extraction.phrase_targets,
            fallback_used: false,
            evidence_items: extraction.evidence_items.map(e => ({
              quote: e.quote,
              url: e.url,
              page_title: e.page_title,
              match_reason: e.match_reason,
              confidence: e.confidence,
              keyword_matched: e.keyword_matched,
              source_url: e.source_url,
              constraint_type: e.constraint_type,
              constraint_value: e.constraint_value,
              matched_phrase: e.matched_phrase,
              direct_quote: e.direct_quote,
              context_snippet: e.context_snippet,
              constraint_match_reason: e.constraint_match_reason,
              source_type: e.source_type,
              source_tier: (e.url && e.url.trim()) ? 'first_party_website' : 'search_snippet',
              confidence_score: e.confidence_score,
            })),
            tower_status: towerStatus,
            tower_confidence: towerConfidence,
          },
          userId,
          conversationId,
        });
      }

      await createArtefact({
        runId,
        type: 'step_result',
        title: `Evidence: "${lead.name}" — ${constraintsToVerify.length} constraint(s) checked`,
        summary: `${evidenceResults.filter(r => r.leadIndex === leadIdx && r.evidenceFound).length}/${constraintsToVerify.length} evidence found`,
        payload: {
          execution_source: 'mission',
          step_tool: 'EVIDENCE_GATHER',
          lead_name: lead.name,
          lead_place_id: lead.placeId,
          pages_visited: pages.length,
          web_search_snippets: 0,
          evidence_results: evidenceResults
            .filter(r => r.leadIndex === leadIdx)
            .map(r => ({
              constraint: r.constraintValue,
              found: r.evidenceFound,
              strength: r.evidenceStrength,
              tower_status: r.towerStatus,
              tower_confidence: r.towerConfidence,
              snippets: r.snippets,
            })),
        },
        userId,
        conversationId,
      }).catch(() => {});
    };

    for (let batchStart = 0; batchStart < enrichableLeads.length; batchStart += ENRICH_CONCURRENCY) {
      if (checkDeadline()) {
        console.warn(`[MISSION_EXEC] Deadline exceeded during evidence gathering — stopping early`);
        break;
      }
      const batch = enrichableLeads.slice(batchStart, batchStart + ENRICH_CONCURRENCY);
      await Promise.allSettled(batch.map((lead, i) => processOneLead(lead, batchStart + i)));
    }

    // ── GPT-4o web search fallback for bot-blocked / unreachable candidates ──────
    const blockedWithNoEvidence = evidenceResults.filter(er => er.isBotBlocked && !er.evidenceFound);
    if (blockedWithNoEvidence.length > 0 && !checkDeadline()) {
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) {
        console.warn('[GPT4O_FALLBACK] OPENAI_API_KEY not set — skipping web search fallback');
      } else {
        console.log(`[GPT4O_FALLBACK] Verifying ${blockedWithNoEvidence.length} blocked candidates via GPT-4o web search...`);
        let fallbackVerified = 0;
        let fallbackContradicted = 0;
        let fallbackUnverified = 0;

        for (const er of blockedWithNoEvidence) {
          if (checkDeadline()) {
            console.warn('[GPT4O_FALLBACK] Deadline exceeded — stopping fallback early');
            break;
          }
          console.log(`[GPT4O_FALLBACK] Website visit failed for "${er.leadName}": bot-blocked. Queued for GPT-4o verification fallback.`);
          try {
            const fbPrompt = `Search for "${er.leadName}" in "${location}". Find their website or any authoritative online source. Determine whether the following is genuinely true for this specific business: "${er.constraintValue}". Start your response with exactly one of:\n- VERIFIED: [evidence summary and source URL]\n- UNVERIFIED: [reason you could not confirm]\n- CONTRADICTED: [evidence that it is NOT true]`;

            const fbResp = await fetch('https://api.openai.com/v1/responses', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${openaiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: 'gpt-4o',
                input: fbPrompt,
                tools: [{ type: 'web_search' }],
                store: false,
              }),
            });

            if (!fbResp.ok) {
              const errText = await fbResp.text().catch(() => '');
              console.warn(`[GPT4O_FALLBACK] API error for "${er.leadName}": HTTP ${fbResp.status} — ${errText.substring(0, 150)}`);
              er.sourceTier = 'web_search_fallback';
              fallbackUnverified++;
              continue;
            }

            const fbData = await fbResp.json();
            let fbContent = '';
            let fbSourceUrl = '';

            if (Array.isArray(fbData.output)) {
              for (const item of fbData.output) {
                if (item.type === 'message' && Array.isArray(item.content)) {
                  for (const block of item.content) {
                    if (block.type === 'output_text') {
                      fbContent += block.text;
                      if (Array.isArray(block.annotations)) {
                        for (const ann of block.annotations) {
                          if (ann.type === 'url_citation' && ann.url && !fbSourceUrl) {
                            fbSourceUrl = ann.url;
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
            if (!fbContent && fbData.output_text) fbContent = fbData.output_text;

            er.sourceTier = 'web_search_fallback';
            const fbUpper = fbContent.trimStart().toUpperCase();
            if (fbUpper.startsWith('VERIFIED')) {
              er.evidenceFound = true;
              er.evidenceStrength = 'weak';
              er.snippets = [fbContent.substring(0, 500)];
              if (fbSourceUrl) er.sourceUrl = fbSourceUrl;
              fallbackVerified++;
              console.log(`[GPT4O_FALLBACK] GPT-4o fallback result for "${er.leadName}": verified — source=${fbSourceUrl || 'no_url'} evidence="${fbContent.substring(0, 120)}"`);
            } else if (fbUpper.startsWith('CONTRADICTED')) {
              fallbackContradicted++;
              console.log(`[GPT4O_FALLBACK] GPT-4o fallback result for "${er.leadName}": contradicted — "${fbContent.substring(0, 120)}"`);
            } else {
              fallbackUnverified++;
              console.log(`[GPT4O_FALLBACK] GPT-4o fallback result for "${er.leadName}": unverified — "${fbContent.substring(0, 120)}"`);
            }
          } catch (fbErr: any) {
            console.warn(`[GPT4O_FALLBACK] "${er.leadName}": error — ${fbErr.message}`);
            er.sourceTier = 'web_search_fallback';
            fallbackUnverified++;
          }
        }

        const directVerified = evidenceResults.filter(er => !er.isBotBlocked && er.evidenceFound).length;
        const stillUnverified = evidenceResults.filter(er => !er.evidenceFound).length;
        console.log(`[GPT4O_FALLBACK] Verification complete: ${directVerified} direct, ${fallbackVerified} via fallback, ${fallbackContradicted} contradicted, ${stillUnverified} still unverified`);
      }
    }
    // ── end GPT-4o fallback ───────────────────────────────────────────────────

    const totalEvidenceFound = evidenceResults.filter(r => r.evidenceFound).length;
    const totalEvidenceChecks = evidenceResults.length;
    console.log(`[MISSION_EXEC] Evidence gathering complete: ${totalEvidenceFound}/${totalEvidenceChecks} checks found evidence`);

    await createArtefact({
      runId,
      type: 'attribute_verification',
      title: `Evidence verification: ${totalEvidenceFound}/${totalEvidenceChecks} checks passed`,
      summary: `${totalEvidenceFound} evidence found out of ${totalEvidenceChecks} checks across ${enrichableLeads.length} leads`,
      payload: {
        execution_source: 'mission',
        total_checks: totalEvidenceChecks,
        checks_with_evidence: totalEvidenceFound,
        leads_checked: enrichableLeads.length,
        fallback_candidates: evidenceResults.filter(r => r.sourceTier === 'web_search_fallback').length,
        fallback_verified: evidenceResults.filter(r => r.sourceTier === 'web_search_fallback' && r.evidenceFound).length,
        results: evidenceResults.map(r => ({
          lead: r.leadName,
          constraint: r.constraintValue,
          type: r.constraintType,
          found: r.evidenceFound,
          strength: r.evidenceStrength,
          tower_status: r.towerStatus,
          source_tier: r.sourceTier ?? (r.isBotBlocked ? 'snippet' : 'first_party'),
        })),
      },
      userId,
      conversationId,
    }).catch(() => {});

    if (
      evidenceConstraints.some(c => c.hardness === 'hard') &&
      totalEvidenceFound === 0 &&
      leads.length > 0
    ) {
      console.log(`[MISSION_EXEC] No evidence found for hard evidence constraints — all results are unverified candidates`);
    }
  }

  if (plan.tool_sequence.includes('RANK_SCORE') && leads.length > 0) {
    console.log(`[MISSION_EXEC] === Phase: RANK_SCORE ===`);
    const rankingConstraint = getRankingConstraints(mission)[0];
    if (rankingConstraint) {
      if (evidenceResults.length === 0) {
        for (let i = 0; i < leads.length; i++) {
          const rankValue = typeof rankingConstraint.value === 'string' ? rankingConstraint.value : String(rankingConstraint.value ?? '');
          evidenceResults.push({
            leadIndex: i,
            leadName: leads[i].name,
            leadPlaceId: leads[i].placeId,
            constraintField: rankingConstraint.field || 'ranking',
            constraintValue: rankValue,
            constraintType: 'ranking',
            evidenceFound: true,
            evidenceStrength: 'weak',
            towerStatus: null,
            towerConfidence: null,
            towerReasoning: null,
            sourceUrl: null,
            snippets: [`Ranked by Google Places relevance for "${rankValue}" in position ${i + 1}/${leads.length}`],
          });
        }
        console.log(`[MISSION_EXEC] RANK_SCORE: generated ${leads.length} ranking source evidence items (no prior evidence to score by)`);
      }
      const evidenceByLead = new Map<number, number>();
      for (const er of evidenceResults) {
        const current = evidenceByLead.get(er.leadIndex) || 0;
        evidenceByLead.set(
          er.leadIndex,
          current + (er.evidenceStrength === 'strong' ? 2 : er.evidenceStrength === 'weak' ? 1 : 0),
        );
      }

      leads = leads.map((l, i) => ({
        ...l,
        _score: evidenceByLead.get(i) ?? 0,
      })).sort((a: any, b: any) => (b._score || 0) - (a._score || 0)) as DiscoveredLead[];

      console.log(`[MISSION_EXEC] RANK_SCORE: leads sorted by evidence strength`);

      await createArtefact({
        runId,
        type: 'step_result',
        title: `Step: RANK_SCORE — ${leads.length} leads ranked`,
        summary: `Leads ranked by evidence strength for "${rankingConstraint.value}"`,
        payload: {
          execution_source: 'mission',
          step_tool: 'RANK_SCORE',
          ranking_criteria: String(rankingConstraint.value),
          leads_ranked: leads.length,
        },
        userId,
        conversationId,
      }).catch(() => {});
    }
  }

  let planVersion = 1;
  let replansUsed = 0;
  let radiusRung = 0;
  const dsPlanVersions: PlanVersionEntry[] = [{ version: 1, changes_made: ['Initial mission plan'] }];
  const dsSoftRelaxations: SoftRelaxation[] = [];

  const hasShortfall = requestedCount !== null && leads.length < requestedCount;
  const locationIsSoft = mission.constraints.some(
    c => c.type === 'location_constraint' && c.hardness === 'soft',
  ) || softConstraints.length > 0;

  const narrativeAcceptsShortfall = (() => {
    if (!intentNarrative || !hasShortfall || leads.length === 0) return false;
    if (intentNarrative.scarcity_expectation === 'scarce') {
      console.log(`[BEHAVIOUR_JUDGE] scarcity_expectation="${intentNarrative.scarcity_expectation}" with ${leads.length} leads — accepting shortfall, skipping replan`);
      return true;
    }
    return false;
  })();

  if (hasShortfall && locationIsSoft && !checkDeadline() && !narrativeAcceptsShortfall) {
    console.log(`[MISSION_EXEC] === Phase: REPLAN (shortfall) ===`);

    while (replansUsed < MAX_REPLANS && leads.length < (requestedCount ?? 0) && !checkDeadline()) {
      replansUsed++;
      planVersion++;
      radiusRung = Math.min(radiusRung + 1, RADIUS_LADDER_KM.length - 1);
      const radiusKm = RADIUS_LADDER_KM[radiusRung];

      const expandedLocation = radiusKm > 0
        ? `${location} within ${radiusKm}km`
        : location;

      console.log(`[MISSION_EXEC] Replan v${planVersion}: expanding to "${expandedLocation}" (radius=${radiusKm}km)`);

      dsPlanVersions.push({
        version: planVersion,
        changes_made: [`Expanded radius to ${radiusKm}km`],
      });
      dsSoftRelaxations.push({
        constraint: 'location',
        from: currentLocation,
        to: expandedLocation,
        reason: `Shortfall: ${leads.length}/${requestedCount} — expanding search radius`,
        plan_version: planVersion,
      });

      currentLocation = expandedLocation;

      try {
        runToolCallCount++;
        const replanQuery = intentNarrative?.entity_description ?? currentBusinessType;
        const reSearchResult = await executeAction({
          toolName: 'SEARCH_PLACES',
          toolArgs: {
            query: replanQuery,
            location: currentLocation,
            country,
            maxResults: currentSearchBudget,
            target_count: requestedCount ?? DEFAULT_SEARCH_BUDGET,
          },
          userId,
          tracker: toolTracker,
          runId,
          conversationId,
          clientRequestId,
        });

        if (reSearchResult.success && reSearchResult.data?.places && Array.isArray(reSearchResult.data.places)) {
          const newPlaces = reSearchResult.data.places as any[];
          const existingPlaceIds = new Set(leads.map(l => l.placeId));

          let newLeadsAdded = 0;
          for (const p of newPlaces) {
            const pid = p.place_id || p.id || '';
            if (pid && !existingPlaceIds.has(pid)) {
              leads.push({
                name: p.name || p.displayName?.text || 'Unknown Business',
                address: p.formatted_address || p.formattedAddress || `${location}, ${country}`,
                phone: p.phone || p.nationalPhoneNumber || p.internationalPhoneNumber || null,
                website: p.website || p.websiteUri || null,
                placeId: pid,
                source: 'google_places',
                lat: typeof p.lat === 'number' ? p.lat : (p.geometry?.location?.lat ?? null),
                lng: typeof p.lng === 'number' ? p.lng : (p.geometry?.location?.lng ?? null),
              });
              existingPlaceIds.add(pid);
              newLeadsAdded++;
            }
          }

          if (plan.tool_sequence.includes('FILTER_FIELDS')) {
            const preFilterCount = leads.length;
            leads = applyFieldFilters(leads, mission, runId);
            const replanFilterConstraints = getTextCompareConstraints(mission);
            for (let i = 0; i < leads.length; i++) {
              const alreadyHasEvidence = evidenceResults.some(
                er => er.leadPlaceId === leads[i].placeId && er.constraintType === 'text_compare'
              );
              if (alreadyHasEvidence) continue;
              for (const fc of replanFilterConstraints) {
                const filterValue = typeof fc.value === 'string' ? fc.value : String(fc.value ?? '');
                if (!filterValue) continue;
                evidenceResults.push({
                  leadIndex: i,
                  leadName: leads[i].name,
                  leadPlaceId: leads[i].placeId,
                  constraintField: fc.field,
                  constraintValue: filterValue,
                  constraintType: fc.type,
                  evidenceFound: true,
                  evidenceStrength: 'strong',
                  towerStatus: null,
                  towerConfidence: null,
                  towerReasoning: null,
                  sourceUrl: null,
                  snippets: [`Field match (replan v${planVersion}): ${fc.field} ${fc.operator} "${filterValue}" → matched "${leads[i].name}"`],
                });
              }
            }
            console.log(`[MISSION_EXEC] Replan v${planVersion}: FILTER_FIELDS ${preFilterCount} → ${leads.length}, evidence items=${evidenceResults.length}`);
          }

          console.log(`[MISSION_EXEC] Replan v${planVersion}: +${newLeadsAdded} new leads, total=${leads.length}`);

          if (newLeadsAdded === 0) {
            console.log(`[MISSION_EXEC] Replan v${planVersion}: no new leads found — stopping replans`);
            break;
          }
        }

        if (replansUsed === 1 && intentNarrative && intentNarrative.suggested_approaches.length > 1) {
          const altQuery = intentNarrative.suggested_approaches[1];
          console.log(`[BEHAVIOUR_JUDGE] First replan — running suggested_approaches[1] as alternative query: "${altQuery.substring(0, 100)}"`);
          try {
            runToolCallCount++;
            const altResult = await executeAction({
              toolName: 'SEARCH_PLACES',
              toolArgs: {
                query: altQuery,
                location,
                country,
                maxResults: currentSearchBudget,
                target_count: requestedCount ?? DEFAULT_SEARCH_BUDGET,
              },
              userId,
              tracker: toolTracker,
              runId,
              conversationId,
              clientRequestId,
            });
            if (altResult.success && altResult.data?.places && Array.isArray(altResult.data.places)) {
              const existingAltIds = new Set(leads.map(l => l.placeId));
              let altAdded = 0;
              for (const p of altResult.data.places as any[]) {
                const pid = p.place_id || p.id || '';
                if (pid && !existingAltIds.has(pid)) {
                  leads.push({
                    name: p.name || p.displayName?.text || 'Unknown Business',
                    address: p.formatted_address || p.formattedAddress || `${location}, ${country}`,
                    phone: p.phone || p.nationalPhoneNumber || p.internationalPhoneNumber || null,
                    website: p.website || p.websiteUri || null,
                    placeId: pid,
                    source: 'google_places',
                    lat: typeof p.lat === 'number' ? p.lat : (p.geometry?.location?.lat ?? null),
                    lng: typeof p.lng === 'number' ? p.lng : (p.geometry?.location?.lng ?? null),
                  });
                  altAdded++;
                }
              }
              console.log(`[BEHAVIOUR_JUDGE] suggested_approaches[1] added ${altAdded} new leads (total now: ${leads.length})`);
            }
          } catch (altErr: any) {
            console.warn(`[BEHAVIOUR_JUDGE] suggested_approaches[1] search failed (non-fatal): ${altErr.message}`);
          }
        }
      } catch (reSearchErr: any) {
        console.warn(`[MISSION_EXEC] Replan search failed: ${reSearchErr.message}`);
        break;
      }

      await createArtefact({
        runId,
        type: 'plan_update',
        title: `Plan v${planVersion}: radius expanded to ${radiusKm}km`,
        summary: `Replan: ${leads.length} leads after expanding to ${currentLocation}`,
        payload: {
          execution_source: 'mission',
          plan_version: planVersion,
          strategy: 'expand_radius',
          location: currentLocation,
          radius_km: radiusKm,
          total_leads: leads.length,
          requested_count: requestedCount,
        },
        userId,
        conversationId,
      }).catch(() => {});
    }
  }

  const hardEvidenceConstraints = [...evidenceConstraints, ...relationshipConstraints].filter(c => c.hardness === 'hard');
  let filteredLeads = leads;

  if (hardEvidenceConstraints.length > 0) {
    filteredLeads = applyHardEvidenceFilter(leads, evidenceResults, hardEvidenceConstraints);

    if (filteredLeads.length < leads.length) {
      console.log(`[MISSION_EXEC] Hard evidence filter: ${leads.length} → ${filteredLeads.length} (removed ${leads.length - filteredLeads.length} leads without evidence for hard constraints)`);
    }
  }

  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const dedupedLeads = filteredLeads.filter(lead => {
    const pid = lead.placeId?.trim() ?? '';
    const fullName = lead.name?.trim().toLowerCase() ?? '';
    const shortName = fullName.split(',')[0].trim();
    if (pid && seenIds.has(pid)) {
      console.log(`[DEDUP] Dropped duplicate placeId="${pid}" name="${lead.name}"`);
      return false;
    }
    if (fullName && seenNames.has(fullName)) {
      console.log(`[DEDUP] Dropped duplicate full-name="${lead.name}"`);
      return false;
    }
    if (shortName && shortName !== fullName && seenNames.has(shortName)) {
      console.log(`[DEDUP] Dropped duplicate short-name="${shortName}" (from "${lead.name}")`);
      return false;
    }
    if (pid) seenIds.add(pid);
    if (fullName) seenNames.add(fullName);
    if (shortName && shortName !== fullName) seenNames.add(shortName);
    return true;
  });
  console.log(`[DEDUP] filteredLeads=${filteredLeads.length} after dedup=${dedupedLeads.length}`);
  const finalLeads = requestedCount !== null ? dedupedLeads.slice(0, requestedCount) : dedupedLeads;

  for (const lead of finalLeads) {
    if (placeIdToDbId.has(lead.placeId)) continue;
    try {
      const created = await storage.createSuggestedLead({
        userId,
        rationale: `Mission-driven ${businessType} lead in ${location} (replan)`,
        source: 'mission_executor',
        score: 0.75,
        lead: {
          name: lead.name,
          address: lead.address,
          place_id: lead.placeId,
          domain: lead.website || '',
          emailCandidates: [],
          tags: [businessType, 'mission_executor'],
          phone: lead.phone || '',
        },
      });
      createdLeadIds.push(created.id);
      placeIdToDbId.set(lead.placeId, created.id);
    } catch (e: any) {
      console.error(`[MISSION_EXEC] Failed to persist replan lead "${lead.name}": ${e.message}`);
    }
  }

  const filteredLeadIds = finalLeads
    .map(l => placeIdToDbId.get(l.placeId))
    .filter((id): id is string => id !== undefined);

  const leadsListArtefact = await createArtefact({
    runId,
    type: 'leads_list',
    title: `Leads list: ${finalLeads.length} ${businessType} in ${currentLocation}`,
    summary: `${finalLeads.length} leads delivered | requested=${requestedCount ?? 'any'} | plans=${planVersion}`,
    payload: {
      execution_source: 'mission',
      original_user_goal: rawUserInput,
      normalized_goal: normalizedGoal,
      hard_constraints: hardConstraints,
      soft_constraints: softConstraints,
      structured_constraints: structuredConstraints,
      delivered_count: finalLeads.length,
      target_count: requestedCount,
      leads: finalLeads.map(l => ({ name: l.name, address: l.address, phone: l.phone, website: l.website, placeId: l.placeId })),
    },
    userId,
    conversationId,
  });

  console.log(`[MISSION_EXEC] === Phase: FINAL_DELIVERY ===`);

  const hasEvidenceConstraints = evidenceConstraints.length > 0 || relationshipConstraints.length > 0;
  const evidenceSummary = evidenceResults.length > 0
    ? {
        total_checks: evidenceResults.length,
        checks_with_evidence: evidenceResults.filter(r => r.evidenceFound).length,
        tower_verified: evidenceResults.filter(r => r.towerStatus === 'verified').length,
        tower_weak: evidenceResults.filter(r => r.towerStatus === 'weak_match').length,
      }
    : null;

  const evidenceByPlaceId = new Map<string, EvidenceResult[]>();
  for (const er of evidenceResults) {
    const existing = evidenceByPlaceId.get(er.leadPlaceId) || [];
    existing.push(er);
    evidenceByPlaceId.set(er.leadPlaceId, existing);
  }

  const isRankingOnly = plan.strategy === 'discovery_then_rank' && !hasEvidenceConstraints;
  const isFieldFilterOnly = plan.strategy === 'discovery_then_direct_filter' && !hasEvidenceConstraints;
  const evidenceWasAttempted = evidenceResults.length > 0;

  const deliveredLeadsWithEvidence = finalLeads.map(l => {
    const leadEvidence = evidenceByPlaceId.get(l.placeId) || [];
    const hasAnyEvidence = leadEvidence.some(e => e.evidenceFound);
    const strongCount = leadEvidence.filter(e => e.evidenceStrength === 'strong').length;
    const weakCount = leadEvidence.filter(e => e.evidenceStrength === 'weak').length;
    const isBotBlocked = leadEvidence.some(e => e.isBotBlocked);

    const evidenceAttachment = leadEvidence.map(e => ({
      constraint_field: e.constraintField,
      constraint_value: e.constraintValue,
      constraint_type: e.constraintType,
      evidence_found: e.evidenceFound,
      evidence_strength: e.evidenceStrength,
      source_url: e.sourceUrl,
      snippets: e.snippets,
      tower_status: e.towerStatus,
      tower_confidence: e.towerConfidence,
    }));

    const matchEvidence = buildMatchEvidence(leadEvidence);
    const matchSummary = buildMatchSummary(l.name, matchEvidence, leadEvidence);
    const matchBasis = buildMatchBasis(l.name, leadEvidence);
    const supportingEvidence = buildSupportingEvidence(l.name, leadEvidence);
    const matchValid = evidenceWasAttempted
      ? strongCount > 0
      : (isRankingOnly || isFieldFilterOnly ? true : true);

    const constraintVerdicts = leadEvidence.map(er => ({
      constraint: er.constraintValue,
      verdict: er.towerStatus === 'verified' ? 'verified' as const
        : er.towerStatus === 'weak_match' ? 'weak_match' as const
        : er.isBotBlocked ? 'unreachable' as const
        : 'unverified' as const,
    }));

    return {
      name: l.name,
      address: l.address,
      phone: l.phone,
      website: l.website,
      placeId: l.placeId,
      source: l.source,
      verified: evidenceWasAttempted ? hasAnyEvidence : (isRankingOnly ? false : undefined),
      verification_status: evidenceWasAttempted
        ? (strongCount > 0 ? 'verified' as const : weakCount > 0 ? 'weak_match' as const : isBotBlocked ? 'unreachable' as const : 'no_evidence' as const)
        : (isRankingOnly ? 'ranking_only' as const : (isFieldFilterOnly ? 'field_filter_only' as const : 'not_attempted' as const)),
      constraint_verdicts: constraintVerdicts,
      evidence: evidenceAttachment,
      match_valid: matchValid,
      match_summary: matchSummary,
      match_basis: matchBasis,
      supporting_evidence: supportingEvidence,
      match_evidence: matchEvidence,
    };
  });

  const leadsWithVerification = deliveredLeadsWithEvidence.filter(l => l.verified === true).length;
  const leadsWithoutVerification = deliveredLeadsWithEvidence.filter(l => l.verified !== true).length;
  const evidenceSourcesAttached = new Set(evidenceResults.filter(r => r.sourceUrl).map(r => r.sourceUrl)).size;

  console.log(`[MISSION_EXEC] Evidence attachment: total_delivered=${deliveredLeadsWithEvidence.length} with_verification=${leadsWithVerification} without_verification=${leadsWithoutVerification} evidence_sources=${evidenceSourcesAttached}`);

  await createArtefact({
    runId,
    type: 'diagnostic',
    title: 'Verification attachment summary',
    summary: `${leadsWithVerification}/${deliveredLeadsWithEvidence.length} leads carry verification data`,
    payload: {
      total_delivered: deliveredLeadsWithEvidence.length,
      with_verification_data: leadsWithVerification,
      without_verification_data: leadsWithoutVerification,
      evidence_sources_attached: evidenceSourcesAttached,
      evidence_was_attempted: evidenceWasAttempted,
      is_ranking_only: isRankingOnly,
      is_field_filter_only: isFieldFilterOnly,
      strategy: plan.strategy,
    },
    userId,
    conversationId,
  }).catch(() => {});

  const finalDeliveryArtefact = await createArtefact({
    runId,
    type: 'final_delivery',
    title: `Final delivery: ${finalLeads.length} leads${leadsWithVerification > 0 ? ` (${leadsWithVerification} verified)` : ''}`,
    summary: `${finalLeads.length} leads delivered | strategy=${plan.strategy} | plans=${planVersion} | verified=${leadsWithVerification}`,
    payload: {
      execution_source: 'mission',
      mission_strategy: plan.strategy,
      original_user_goal: rawUserInput,
      normalized_goal: normalizedGoal,
      hard_constraints: hardConstraints,
      soft_constraints: softConstraints,
      structured_constraints: structuredConstraints,
      mission_plan_tool_sequence: plan.tool_sequence,
      delivered_count: finalLeads.length,
      target_count: requestedCount,
      plan_version: planVersion,
      replans_used: replansUsed,
      candidate_count_from_google: candidateCountFromGoogle,
      evidence_summary: evidenceSummary,
      evidence_ready_for_tower: evidenceWasAttempted,
      run_deadline_exceeded: runDeadlineExceeded,
      verification_policy: plan.verification_policy.verification_policy,
      verification_policy_reason: plan.verification_policy.reason,
      verifiable_constraints: [...new Set(evidenceResults.map(er => er.constraintValue))],
      leads: deliveredLeadsWithEvidence,
      behaviour_judge: {
        scarcity_accepted_shortfall: narrativeAcceptsShortfall,
        wrong_type_excluded_pre_delivery: excludedCandidates.length,
        wrong_type_candidates: excludedCandidates,
        narrative_search_used: intentNarrative !== null && intentNarrative.entity_description !== businessType,
        findability: intentNarrative?.findability ?? null,
        supplementary_search_fired: intentNarrative !== null && (intentNarrative.findability === 'hard' || intentNarrative.findability === 'very_hard'),
      },
    },
    userId,
    conversationId,
  });

  let finalVerdict = 'pending';
  let finalAction = 'accept';

  const finalSuccessCriteria = {
    mission_type: 'leadgen',
    target_count: requestedCount ?? DEFAULT_SEARCH_BUDGET,
    requested_count_user: requestedCount !== null ? 'explicit' : 'implicit',
    requested_count_value: requestedCount,
    hard_constraints: hardConstraints,
    soft_constraints: softConstraints,
    structured_constraints: structuredConstraints,
    plan_constraints: {
      business_type: businessType,
      location: currentLocation,
      country,
      search_count: currentSearchBudget,
      requested_count: requestedCount ?? DEFAULT_SEARCH_BUDGET,
    },
    max_replan_versions: MAX_REPLANS + 1,
    requires_relationship_evidence: relationshipPredicate.requires_relationship_evidence,
    run_deadline_exceeded: runDeadlineExceeded,
    verification_policy: plan.verification_policy.verification_policy,
    verification_policy_reason: plan.verification_policy.reason,
    intent_narrative: intentNarrative ?? null,
  };

  try {
    console.log('[QID-TRACE]', 'step4:judgeArtefact_call', queryId ?? null);
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
    console.log(`[MISSION_EXEC] Tower final verdict=${finalVerdict} action=${finalAction} stubbed=${towerResult.stubbed}`);

    await createArtefact({
      runId,
      type: 'tower_judgement',
      title: `Tower Judgement (final_delivery): ${finalVerdict}`,
      summary: `Final verdict: ${finalVerdict} | Action: ${finalAction} | Delivered: ${finalLeads.length}`,
      payload: {
        verdict: finalVerdict,
        action: finalAction,
        reasons: towerResult.judgement.reasons,
        metrics: towerResult.judgement.metrics,
        delivered: finalLeads.length,
        requested: requestedCount,
        artefact_id: finalDeliveryArtefact.id,
        stubbed: towerResult.stubbed,
        plan_version: planVersion,
        phase: 'final_delivery',
        execution_source: 'mission',
      },
      userId,
      conversationId,
    });

    await logAFREvent({
      userId, runId, conversationId, clientRequestId,
      actionTaken: 'tower_verdict', status: towerResult.shouldStop ? 'failed' : 'success',
      taskGenerated: `Tower final verdict: ${finalVerdict}`,
      runType: 'plan',
      metadata: { verdict: finalVerdict, action: finalAction, delivered: finalLeads.length, execution_source: 'mission' },
    });

    if (runDeadlineExceeded && finalVerdict !== 'pass') {
      finalVerdict = 'timeout';
      finalAction = 'stop';
      console.warn(`[MISSION_EXEC] Run timed out — reason: ${runDeadlineReason}`);
    }
  } catch (towerErr: any) {
    console.error(`[MISSION_EXEC] Tower final judgement failed: ${towerErr.message}`);
    finalVerdict = 'error';
    finalAction = 'stop';

    await createArtefact({
      runId,
      type: 'tower_unavailable',
      title: 'Tower judgement unavailable',
      summary: `Tower API call failed: ${towerErr.message?.substring(0, 200)}`,
      payload: {
        run_id: runId,
        stage: 'final_delivery',
        error_message: towerErr.message?.substring(0, 500),
        execution_source: 'mission',
      },
      userId,
      conversationId,
    }).catch(() => {});
  }

  const runTimedOut = runDeadlineExceeded;
  const finalRunStatus = runTimedOut ? 'timed_out' : 'completed';
  const finalTerminalState = runTimedOut ? 'timed_out' : 'completed';

  if (runTimedOut) {
    await createArtefact({
      runId,
      type: 'diagnostic',
      title: 'Run timed out',
      summary: `Execution exceeded time/call limit: ${runDeadlineReason}`,
      payload: {
        run_id: runId,
        deadline_reason: runDeadlineReason,
        elapsed_ms: Date.now() - runStartTime,
        tool_calls: runToolCallCount,
        timeout_limit_ms: RUN_EXECUTION_TIMEOUT_MS,
        tool_call_limit: MAX_TOOL_CALLS,
        leads_at_timeout: finalLeads.length,
        execution_source: 'mission',
      },
      userId,
      conversationId,
    }).catch(() => {});
  }

  await storage.updateAgentRun(runId, {
    status: finalRunStatus,
    terminalState: finalTerminalState,
    metadata: {
      verdict: finalVerdict,
      action: finalAction,
      leads_count: finalLeads.length,
      plan_version: planVersion,
      replans_used: replansUsed,
      execution_source: 'mission',
      mission_strategy: plan.strategy,
      ...(runTimedOut ? { timed_out: true, timeout_reason: runDeadlineReason } : {}),
    },
  }).catch((e: any) => console.warn(`[MISSION_EXEC] agent_run completion update failed: ${e.message}`));

  const evidenceLookup = new Map(deliveredLeadsWithEvidence.map(l => [l.placeId, l]));
  const dsLeads = finalLeads.map(l => {
    const ev = evidenceLookup.get(l.placeId);
    return {
      entity_id: l.placeId,
      name: l.name,
      address: l.address,
      found_in_plan_version: 1,
      match_valid: ev?.match_valid,
      match_summary: ev?.match_summary,
      match_basis: ev?.match_basis,
      supporting_evidence: ev?.supporting_evidence,
      match_evidence: ev?.match_evidence,
    };
  });

  const dsPayload = await emitDeliverySummary({
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
    finalAction, // PHASE_3: pass Tower action to delivery summary
    stopReason: null,
    relationshipContext: relationshipPredicate.requires_relationship_evidence
      ? {
          requires_relationship_evidence: true,
          detected_predicate: relationshipPredicate.detected_predicate,
          relationship_target: relationshipPredicate.relationship_target,
          verified_relationship_count: evidenceResults.filter(
            r => r.constraintType === 'relationship_check' && r.evidenceFound,
          ).length,
        }
      : undefined,
    verificationPolicy: plan.verification_policy.verification_policy,
    verificationPolicyReason: plan.verification_policy.reason,
  });

  await logAFREvent({
    userId, runId, conversationId, clientRequestId,
    actionTaken: 'run_completed', status: 'success',
    taskGenerated: `Mission-driven execution complete: ${finalLeads.length} leads, verdict=${finalVerdict}`,
    runType: 'plan',
    metadata: {
      execution_source: 'mission',
      verdict: finalVerdict,
      leads_count: finalLeads.length,
      plan_version: planVersion,
      replans_used: replansUsed,
      strategy: plan.strategy,
    },
  });

  let chatResponse = SUPERVISOR_NEUTRAL_MESSAGE;
  if (
    relationshipPredicate.requires_relationship_evidence &&
    evidenceResults.filter(r => r.constraintType === 'relationship_check' && r.evidenceFound).length === 0 &&
    finalLeads.length > 0
  ) {
    const target = relationshipPredicate.relationship_target || 'the specified entity';
    const predicate = relationshipPredicate.detected_predicate || 'works with';
    chatResponse = `I found organisations associated with ${target}, but could not verify that they ${predicate} ${target}. No relationship evidence could be confirmed. All results are candidates only.`;
  }

  console.log(`[MISSION_EXEC] ===== Mission-driven execution complete =====`);
  console.log(`[MISSION_EXEC] runId=${runId} leads=${finalLeads.length} verdict=${finalVerdict} strategy=${plan.strategy} replans=${replansUsed}`);

  return {
    response: chatResponse,
    leadIds: filteredLeadIds,
    deliverySummary: dsPayload,
    towerVerdict: finalVerdict,
    leads: finalLeads.map(l => ({
      name: l.name,
      address: l.address,
      phone: l.phone,
      website: l.website,
      placeId: l.placeId,
    })),
  };
}
