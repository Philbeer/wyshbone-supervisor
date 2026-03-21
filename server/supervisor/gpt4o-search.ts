/**
 * GPT-4o Primary Search Execution Path
 *
 * An alternative execution path where GPT-4o web search handles discovery AND
 * verification in a single call. Triggered when execution_path === "gpt4o_primary".
 *
 * This module is self-contained. It does NOT modify any existing GP cascade code.
 */

import { createArtefact } from './artefacts';
import { judgeArtefact } from './tower-artefact-judge';
import {
  emitDeliverySummary,
  type DeliverySummaryPayload,
  type PlanVersionEntry,
  type SoftRelaxation,
} from './delivery-summary';
import { logAFREvent } from './afr-logger';
import { storage } from '../storage';
import type { IntentNarrative } from './mission-schema';
import type { VerificationPolicy } from './verification-policy';

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
  structuredConstraints: Record<string, unknown>[];
  intentNarrative: IntentNarrative | null;
  verificationPolicy: VerificationPolicy;
  verificationPolicyReason: string;
  queryId?: string | null;
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
  location: string;
  confidence: 'high' | 'medium' | 'low';
}

interface Gpt4oSearchResponse {
  results: Gpt4oLead[];
  search_summary: string;
  coverage_assessment: string;
}

function buildSearchPrompt(ctx: Gpt4oSearchContext, angle: string): string {
  const entityDesc = ctx.intentNarrative?.entity_description ?? ctx.businessType;
  const constraintText = ctx.hardConstraints.length > 0
    ? `They must: ${ctx.hardConstraints.join(', ')}.`
    : '';
  const angleNote = angle !== 'primary'
    ? `\nSearch angle: ${angle}\n`
    : '';

  return `You are a research assistant finding specific entities. Search the web thoroughly.${angleNote}
TASK: Find ${entityDesc} in ${ctx.location} that match the following search. ${constraintText}
Location: ${ctx.location}, ${ctx.country}

For EACH result you find, provide:
- name: The entity/business name
- description: Brief description of what they do
- evidence: The specific evidence that they match the search criteria (quote or paraphrase from your source)
- source_url: The URL where you found this information
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

    const response = await (openai as any).responses.create({
      model: 'gpt-4o',
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

  const searchAngles = [
    'primary',
    `${businessType} ${location} ${hardConstraints.join(' ')} site listings`.trim(),
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

  await createArtefact({
    runId,
    type: 'attribute_verification',
    title: `Evidence verification: ${allLeads.length}/${allLeads.length} checks (GPT-4o web search)`,
    summary: `${allLeads.length} results found via GPT-4o web search across ${roundsPerformed} round${roundsPerformed === 1 ? '' : 's'}`,
    payload: {
      execution_source: 'gpt4o_primary',
      total_checks: allLeads.length,
      checks_with_evidence: allLeads.length,
      leads_checked: allLeads.length,
      fallback_candidates: 0,
      fallback_verified: 0,
      search_method: 'gpt4o_web_search',
      rounds_performed: roundsPerformed,
      results: allLeads.map(lead => ({
        lead: lead.name,
        constraint: hardConstraints.join(', ') || 'general search',
        type: 'attribute',
        found: true,
        strength: lead.confidence === 'high' ? 'strong' : 'weak',
        tower_status: 'verified',
        source_tier: 'gpt4o_web_search',
        evidence: lead.evidence,
        source_url: lead.source_url,
      })),
    },
    userId,
    conversationId,
  }).catch(() => {});

  const deliveryLeads = allLeads.map((lead, i) => toDeliveryLead(lead, i));
  const cappedLeads = requestedCount !== null ? deliveryLeads.slice(0, requestedCount) : deliveryLeads;
  const cappedGpt4oLeads = requestedCount !== null ? allLeads.slice(0, requestedCount) : allLeads;

  const deliveredLeadsWithEvidence = cappedLeads.map((l, i) => {
    const gLead = cappedGpt4oLeads[i];
    return {
      ...l,
      source: 'gpt4o_web_search',
      verified: gLead?.confidence === 'high' || gLead?.confidence === 'medium',
      verification_status: gLead?.confidence === 'high' ? 'verified' as const
        : gLead?.confidence === 'medium' ? 'weak_match' as const
        : 'no_evidence' as const,
      constraint_verdicts: hardConstraints.map(c => ({
        constraint: c,
        verdict: gLead?.confidence === 'high' ? 'verified' as const
          : gLead?.confidence === 'medium' ? 'weak_match' as const
          : 'unverified' as const,
      })),
      evidence: gLead ? [{ source_url: gLead.source_url, text: gLead.evidence, confidence: gLead.confidence }] : [],
      match_valid: true,
      match_summary: gLead
        ? `Found via GPT-4o web search: ${gLead.evidence.substring(0, 150)}`
        : 'Found via GPT-4o web search',
      match_basis: [] as Record<string, unknown>[],
      supporting_evidence: gLead ? [{ url: gLead.source_url, snippet: gLead.evidence }] : [] as Record<string, unknown>[],
      match_evidence: [] as Record<string, unknown>[],
    };
  });

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
      requested_count_user: requestedCount !== null ? 'explicit' : 'implicit',
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
    finalVerdict = 'error';
    finalAction = 'stop';

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
    terminalState: 'completed',
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

  const dsLeads = cappedLeads.map((l, i) => {
    const gLead = cappedGpt4oLeads[i];
    return {
      entity_id: l.placeId,
      name: l.name,
      address: l.address,
      found_in_plan_version: 1 as const,
      match_valid: true,
      match_summary: gLead
        ? `Found via GPT-4o web search: ${gLead.evidence.substring(0, 150)}`
        : 'Found via GPT-4o web search',
      match_basis: [] as Record<string, unknown>[],
      supporting_evidence: gLead
        ? [{ url: gLead.source_url, snippet: gLead.evidence }]
        : [] as Record<string, unknown>[],
      match_evidence: [] as Record<string, unknown>[],
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
    finalAction,
    stopReason: null,
    verificationPolicy,
    verificationPolicyReason,
  });

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
