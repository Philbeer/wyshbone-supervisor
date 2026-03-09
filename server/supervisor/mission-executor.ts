import type { StructuredMission, MissionConstraint, MissionExtractionTrace } from './mission-schema';
import { extractConstraintLedEvidence, type ConstraintLedExtractionResult, type EvidenceItem } from './constraint-led-extractor';
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
  requiresWebSearch,
  requiresWebVisit,
  requiresTowerJudge,
  logMissionPlan,
  persistMissionPlan,
} from './mission-planner';
import { executeAction, createRunToolTracker, type RunToolTracker } from './action-executor';
import { createArtefact } from './artefacts';
import { judgeArtefact } from './tower-artefact-judge';
import { requestSemanticVerification, type TowerSemanticStatus } from './tower-semantic-verify';
import {
  emitDeliverySummary,
  type DeliverySummaryPayload,
  type PlanVersionEntry,
  type SoftRelaxation,
} from './delivery-summary';
import { logAFREvent } from './afr-logger';
import { storage } from '../storage';
import { sanitiseLocationString, inferCountryFromLocation } from './goal-to-constraints';
import { detectRelationshipPredicate, type RelationshipPredicateResult } from './relationship-predicate';
import { RADIUS_LADDER_KM } from './agent-loop';

const SUPERVISOR_NEUTRAL_MESSAGE = 'Run complete. Results are available.';
const MAX_RUN_DURATION_MS_DEFAULT = 180_000;
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
  towerStatus: TowerSemanticStatus | null;
  towerConfidence: number | null;
  towerReasoning: string | null;
  sourceUrl: string | null;
  snippets: string[];
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

export async function executeMissionDrivenPlan(
  ctx: MissionExecutionContext,
): Promise<MissionExecutionResult> {
  const { mission, plan, runId, userId, conversationId, clientRequestId, rawUserInput, missionTrace } = ctx;
  const { businessType, location, country, requestedCount, searchBudget } = deriveSearchParams(mission);

  const MAX_REPLANS = Math.min(
    parseInt(process.env.MAX_REPLANS || String(MAX_REPLANS_DEFAULT), 10),
    HARD_CAP_MAX_REPLANS,
  );
  const MAX_RUN_DURATION_MS = parseInt(process.env.MAX_RUN_DURATION_MS || String(MAX_RUN_DURATION_MS_DEFAULT), 10);
  const MAX_TOOL_CALLS = parseInt(process.env.MAX_TOOL_CALLS_PER_RUN || String(MAX_TOOL_CALLS_DEFAULT), 10);

  const runStartTime = Date.now();
  let runToolCallCount = 0;
  let runDeadlineExceeded = false;
  let runDeadlineReason = '';

  const checkDeadline = (): boolean => {
    const elapsed = Date.now() - runStartTime;
    if (elapsed > MAX_RUN_DURATION_MS) {
      runDeadlineExceeded = true;
      runDeadlineReason = `wall_clock_timeout: ${Math.round(elapsed / 1000)}s > ${Math.round(MAX_RUN_DURATION_MS / 1000)}s`;
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
  const toolTracker = createRunToolTracker();
  const createdLeadIds: string[] = [];

  const normalizedGoal = `Find ${requestedCount ? requestedCount + ' ' : ''}${businessType} in ${location}`;

  console.log(`[MISSION_EXEC] ===== Mission-driven execution starting =====`);
  console.log(`[MISSION_EXEC] runId=${runId} strategy=${plan.strategy} tools=${plan.tool_sequence.join(' → ')}`);
  console.log(`[MISSION_EXEC] entity="${businessType}" location="${location}" country="${country}" count=${requestedCount}`);
  console.log(`[MISSION_EXEC] constraints=${mission.constraints.length} hard=${hardConstraints.length} soft=${softConstraints.length}`);

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
      requested_count: requestedCount,
      search_budget: searchBudget,
    },
    userId,
    conversationId,
  });

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
  try {
    runToolCallCount++;
    const searchResult = await executeAction({
      toolName: 'SEARCH_PLACES',
      toolArgs: {
        query: currentBusinessType,
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

    if (searchResult.success && searchResult.data?.places && Array.isArray(searchResult.data.places)) {
      const places = searchResult.data.places as any[];
      candidateCountFromGoogle = places.length;
      for (const p of places) {
        leads.push({
          name: p.name || p.displayName?.text || 'Unknown Business',
          address: p.formatted_address || p.formattedAddress || `${location}, ${country}`,
          phone: p.phone || p.nationalPhoneNumber || p.internationalPhoneNumber || null,
          website: p.website || p.websiteUri || null,
          placeId: p.place_id || p.id || '',
          source: 'google_places',
          lat: typeof p.lat === 'number' ? p.lat : (p.geometry?.location?.lat ?? null),
          lng: typeof p.lng === 'number' ? p.lng : (p.geometry?.location?.lng ?? null),
        });
      }
      console.log(`[MISSION_EXEC] SEARCH_PLACES returned ${leads.length} results`);
    } else {
      console.log(`[MISSION_EXEC] SEARCH_PLACES returned 0 results or failed`);
    }
  } catch (searchErr: any) {
    console.warn(`[MISSION_EXEC] SEARCH_PLACES failed: ${searchErr.message}`);
  }

  const searchStepEnd = Date.now();
  await createArtefact({
    runId,
    type: 'step_result',
    title: `Step 1: SEARCH_PLACES — ${leads.length} results`,
    summary: `${leads.length > 0 ? 'success' : 'fail'} — ${leads.length} ${businessType} found in ${location}`,
    payload: {
      execution_source: 'mission',
      step_index: 0,
      step_tool: 'SEARCH_PLACES',
      step_status: leads.length > 0 ? 'success' : 'fail',
      results_count: leads.length,
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
    } catch (leadErr: any) {
      console.error(`[MISSION_EXEC] Failed to persist lead "${lead.name}": ${leadErr.message}`);
    }
  }

  const evidenceConstraints = getEvidenceConstraints(mission);
  const webVisitPages = new Map<number, any[]>();

  if (
    (requiresWebVisit(plan) || requiresWebSearch(plan)) &&
    leads.length > 0 &&
    !checkDeadline()
  ) {
    console.log(`[MISSION_EXEC] === Phase: Evidence Gathering ===`);
    const needsWebSearch = requiresWebSearch(plan);
    const needsWebVisit = requiresWebVisit(plan);
    const constraintsToVerify = [...evidenceConstraints, ...relationshipConstraints];

    const enrichableLeads = leads
      .map((l, i) => ({ ...l, _idx: i }))
      .filter(l => needsWebSearch || (needsWebVisit && l.website))
      .slice(0, effectiveEnrichBatch);

    console.log(`[MISSION_EXEC] Evidence gathering for ${enrichableLeads.length} leads (web_search=${needsWebSearch} web_visit=${needsWebVisit})`);

    const processOneLead = async (lead: typeof enrichableLeads[0], eli: number) => {
      const leadIdx = lead._idx;
      let pages: any[] = [];
      let webSearchSnippets: string[] = [];

      if (needsWebSearch && constraintsToVerify.length > 0) {
        const useReverseQueries = relationshipDir?.chosen_direction === 'reverse' && relationshipDir.reverse_search_queries.length > 0;

        const searchQueries: string[] = [];
        if (useReverseQueries) {
          const leadSpecificReverse = relationshipDir.reverse_search_queries.map(
            q => q.includes(lead.name) ? q : `${q} "${lead.name}"`
          );
          searchQueries.push(leadSpecificReverse[0] || `"${lead.name}" ${relationshipPredicate.relationship_target || ''}`);
          if (eli === 0 && leadSpecificReverse.length > 1) {
            searchQueries.push(...leadSpecificReverse.slice(1, 3));
          }
        } else if (relationshipConstraints.length > 0) {
          searchQueries.push(
            `"${lead.name}" ${relationshipPredicate.relationship_target || ''} ${relationshipPredicate.detected_predicate || ''}`
          );
        } else {
          searchQueries.push(
            `"${lead.name}" ${constraintsToVerify.map(c => String(c.value)).join(' ')}`
          );
        }

        for (const searchQuery of searchQueries) {
          try {
            runToolCallCount++;
            const wsResult = await executeAction({
              toolName: 'WEB_SEARCH',
              toolArgs: { query: searchQuery.trim(), max_results: 5 },
              userId,
              tracker: toolTracker,
              runId,
              conversationId,
              clientRequestId,
            });

            if (wsResult.success && wsResult.data) {
              const results = (wsResult.data as any)?.results || (wsResult.data as any)?.envelope?.outputs?.results || [];
              if (Array.isArray(results)) {
                const snippets = results.map((r: any) => r.snippet || r.description || '').filter(Boolean);
                webSearchSnippets.push(...snippets);
              }
            }
          } catch (wsErr: any) {
            console.warn(`[MISSION_EXEC] WEB_SEARCH failed for "${lead.name}" (query="${searchQuery}"): ${wsErr.message}`);
          }
        }
        console.log(`[MISSION_EXEC] WEB_SEARCH for "${lead.name}": ${webSearchSnippets.length} snippets (direction=${useReverseQueries ? 'reverse' : 'forward'}, queries=${searchQueries.length})`);
      }

      if (needsWebVisit && lead.website) {
        try {
          runToolCallCount++;
          const wvResult = await executeAction({
            toolName: 'WEB_VISIT',
            toolArgs: { url: lead.website, max_pages: 3, same_domain_only: true },
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

      const allText = [
        ...pages.map((p: any) => p.text_clean || p.text || p.content || ''),
        ...webSearchSnippets,
      ].join('\n');

      for (const constraint of constraintsToVerify) {
        const constraintValue = typeof constraint.value === 'string' ? constraint.value : String(constraint.value ?? '');

        const extraction: ConstraintLedExtractionResult = extractConstraintLedEvidence(
          pages,
          {
            type: constraint.type,
            field: constraint.field,
            operator: constraint.operator,
            value: constraintValue,
            hardness: constraint.hardness,
          },
          webSearchSnippets,
        );

        const extractedQuotes = extraction.evidence_items.map(e => e.quote);
        const keywordFound = extraction.evidence_items.length > 0;

        if (extraction.evidence_items.length > 0) {
          console.log(`[MISSION_EXEC] Constraint-led extraction for "${lead.name}" + "${constraintValue}": ${extraction.evidence_items.length} evidence item(s)`);
        } else {
          console.log(`[MISSION_EXEC] Constraint-led extraction for "${lead.name}" + "${constraintValue}": no evidence found`);
        }

        let towerStatus: TowerSemanticStatus | null = null;
        let towerConfidence: number | null = null;
        let towerReasoning: string | null = null;

        if (requiresTowerJudge(plan) && allText.length > 50) {
          const bestEvidenceUrl = extraction.evidence_items[0]?.url || lead.website || 'web_search';
          const bestPageTitle = extraction.evidence_items[0]?.page_title || pages[0]?.title || null;

          try {
            const verifyResult = await requestSemanticVerification({
              request: {
                run_id: runId,
                original_user_goal: rawUserInput,
                lead_name: lead.name,
                lead_place_id: lead.placeId,
                constraint_to_check: constraintValue,
                source_url: bestEvidenceUrl,
                evidence_text: allText.substring(0, 5000),
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

        evidenceResults.push({
          leadIndex: leadIdx,
          leadName: lead.name,
          leadPlaceId: lead.placeId,
          constraintField: constraint.field,
          constraintValue,
          constraintType: constraint.type,
          evidenceFound: evidenceStrength !== 'none',
          evidenceStrength,
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
            evidence_items: extraction.evidence_items.map(e => ({
              quote: e.quote,
              url: e.url,
              page_title: e.page_title,
              match_reason: e.match_reason,
              confidence: e.confidence,
              keyword_matched: e.keyword_matched,
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
          web_search_snippets: webSearchSnippets.length,
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
        results: evidenceResults.map(r => ({
          lead: r.leadName,
          constraint: r.constraintValue,
          type: r.constraintType,
          found: r.evidenceFound,
          strength: r.evidenceStrength,
          tower_status: r.towerStatus,
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

  if (hasShortfall && locationIsSoft && !checkDeadline()) {
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
        const reSearchResult = await executeAction({
          toolName: 'SEARCH_PLACES',
          toolArgs: {
            query: currentBusinessType,
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

  if (hardEvidenceConstraints.length > 0 && evidenceResults.length > 0) {
    const leadsWithEvidence = new Set<number>();
    for (const er of evidenceResults) {
      if (er.evidenceFound && hardEvidenceConstraints.some(c => c.field === er.constraintField || String(c.value) === er.constraintValue)) {
        leadsWithEvidence.add(er.leadIndex);
      }
    }

    const leadsChecked = new Set(evidenceResults.map(r => r.leadIndex));
    filteredLeads = leads.filter((_, i) => {
      if (!leadsChecked.has(i)) return true;
      return leadsWithEvidence.has(i);
    });

    if (filteredLeads.length < leads.length) {
      console.log(`[MISSION_EXEC] Hard evidence filter: ${leads.length} → ${filteredLeads.length} (removed ${leads.length - filteredLeads.length} leads without evidence for hard constraints)`);
    }
  }

  const finalLeads = requestedCount !== null ? filteredLeads.slice(0, requestedCount) : filteredLeads;

  const persistedPlaceIds = new Set<string>();
  for (let i = 0; i < Math.min(leads.length, createdLeadIds.length); i++) {
    persistedPlaceIds.add(leads[i].placeId);
  }

  for (const lead of finalLeads) {
    if (persistedPlaceIds.has(lead.placeId)) continue;
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
      persistedPlaceIds.add(lead.placeId);
    } catch (e: any) {
      console.error(`[MISSION_EXEC] Failed to persist replan lead "${lead.name}": ${e.message}`);
    }
  }

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

    return {
      name: l.name,
      address: l.address,
      phone: l.phone,
      website: l.website,
      placeId: l.placeId,
      source: l.source,
      verified: evidenceWasAttempted ? hasAnyEvidence : (isRankingOnly ? false : undefined),
      verification_status: evidenceWasAttempted
        ? (strongCount > 0 ? 'verified' as const : weakCount > 0 ? 'weak_match' as const : 'no_evidence' as const)
        : (isRankingOnly ? 'ranking_only' as const : (isFieldFilterOnly ? 'field_filter_only' as const : 'not_attempted' as const)),
      evidence: evidenceAttachment,
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
      mission_plan_tool_sequence: plan.tool_sequence,
      delivered_count: finalLeads.length,
      target_count: requestedCount,
      plan_version: planVersion,
      replans_used: replansUsed,
      candidate_count_from_google: candidateCountFromGoogle,
      evidence_summary: evidenceSummary,
      evidence_ready_for_tower: evidenceWasAttempted,
      run_deadline_exceeded: runDeadlineExceeded,
      leads: deliveredLeadsWithEvidence,
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
  };

  try {
    const towerResult = await judgeArtefact({
      artefact: finalDeliveryArtefact,
      runId,
      goal: normalizedGoal,
      userId,
      conversationId,
      successCriteria: finalSuccessCriteria,
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

  await storage.updateAgentRun(runId, {
    status: 'completed',
    terminalState: 'completed',
    metadata: {
      verdict: finalVerdict,
      action: finalAction,
      leads_count: finalLeads.length,
      plan_version: planVersion,
      replans_used: replansUsed,
      execution_source: 'mission',
      mission_strategy: plan.strategy,
    },
  }).catch((e: any) => console.warn(`[MISSION_EXEC] agent_run completion update failed: ${e.message}`));

  const dsLeads = finalLeads.map(l => ({
    entity_id: l.placeId,
    name: l.name,
    address: l.address,
    found_in_plan_version: 1,
  }));

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
    leadIds: createdLeadIds,
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
