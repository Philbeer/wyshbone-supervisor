/**
 * Action Executor - Single execution spine for Supervisor
 * 
 * Supports SEARCH_PLACES, ENRICH_LEADS, SCORE_LEADS, EVALUATE_RESULTS, WEB_VISIT, CONTACT_EXTRACT, WEB_SEARCH, LEAD_ENRICH, ASK_LEAD_QUESTION.
 * Uses native Google Places API directly (no UI tool endpoint dependency).
 */

import type { PlanStep } from './types/plan';
import { searchPlaces, type GoogleQueryMode } from './google-places';
import { executeWebVisit } from './web-visit';
import type { WebVisitInput } from './web-visit';
import { executeContactExtract } from './contact-extract';
import type { ContactExtractInput } from './contact-extract';
import { executeLeadEnrich } from './lead-enrich';
import type { LeadEnrichInput } from './lead-enrich';
import { executeAskLeadQuestion } from './ask-lead-question';
import type { AskLeadQuestionInput } from './ask-lead-question';
import { createArtefact } from './artefacts';
import { isToolEnabled, checkRoutingRules, checkIntentGate } from './tool-registry';
import { logToolCallStarted, logToolCallCompleted, logToolCallFailed } from './afr-logger';

export interface ToolRejection {
  tool: string;
  reason: string;
}

export interface ToolReplan {
  from_tool: string;
  to_tool: string;
  reason: string;
}

export interface RunToolTracker {
  tools_used: string[];
  tools_rejected: ToolRejection[];
  replans: ToolReplan[];
}

export function createRunToolTracker(): RunToolTracker {
  return { tools_used: [], tools_rejected: [], replans: [] };
}

function recordUsed(tracker: RunToolTracker | undefined, tool: string): void {
  if (!tracker) return;
  if (!tracker.tools_used.includes(tool)) {
    tracker.tools_used.push(tool);
  }
}

function recordRejection(tracker: RunToolTracker | undefined, tool: string, reason: string): void {
  if (!tracker) return;
  tracker.tools_rejected.push({ tool, reason });
}

function recordReplan(tracker: RunToolTracker | undefined, from: string, to: string, reason: string): void {
  if (!tracker) return;
  tracker.replans.push({ from_tool: from, to_tool: to, reason });
}

export interface ActionResult {
  success: boolean;
  summary: string;
  data?: Record<string, unknown>;
  error?: string;
  replannedTool?: string;
}

export interface ActionInput {
  toolName: string;
  toolArgs: Record<string, unknown>;
  userId: string;
  tracker?: RunToolTracker;
  runId?: string;
  conversationId?: string;
  clientRequestId?: string;
}

export async function executeAction(input: ActionInput): Promise<ActionResult> {
  const { toolName, toolArgs, userId, tracker, runId, conversationId, clientRequestId } = input;
  
  console.log(`[ACTION_EXECUTOR] Executing ${toolName} with args:`, JSON.stringify(toolArgs).substring(0, 200));

  const queryStr = String(toolArgs.query || toolArgs.prompt || '');

  if (!isToolEnabled(toolName)) {
    const reason = 'tool is disabled in registry';
    console.warn(`[ACTION_EXECUTOR] REJECTED tool=${toolName} reason="${reason}"`);
    recordRejection(tracker, toolName, reason);

    if (toolName === 'SEARCH_WYSHBONE_DB') {
      console.log(`[ACTION_EXECUTOR] Auto-replanning: ${toolName} → SEARCH_PLACES`);
      recordReplan(tracker, toolName, 'SEARCH_PLACES', reason);
      return executeAction({
        toolName: 'SEARCH_PLACES',
        toolArgs: {
          query: queryStr || 'businesses',
          location: (toolArgs.location as string) || 'UK',
          country: (toolArgs.country as string) || 'GB',
          maxResults: 20,
        },
        userId,
        tracker,
        runId, conversationId, clientRequestId,
      }).then(result => ({ ...result, replannedTool: 'SEARCH_PLACES' }));
    }

    return {
      success: false,
      summary: `Tool ${toolName} is disabled — DB not available; use Google Places instead`,
      error: `Tool ${toolName} is currently disabled in the tool registry`,
    };
  }

  const intentGate = checkIntentGate(toolName, queryStr);
  if (!intentGate.allowed) {
    const reason = intentGate.reason || 'intent gate failed';
    console.warn(`[ACTION_EXECUTOR] REJECTED tool=${toolName} reason="${reason}"`);
    recordRejection(tracker, toolName, reason);

    console.log(`[ACTION_EXECUTOR] Auto-replanning: ${toolName} → SEARCH_PLACES (intent gate failed)`);
    recordReplan(tracker, toolName, 'SEARCH_PLACES', reason);
    return executeAction({
      toolName: 'SEARCH_PLACES',
      toolArgs: {
        query: queryStr || 'businesses',
        location: (toolArgs.location as string) || 'UK',
        country: (toolArgs.country as string) || 'GB',
        maxResults: 20,
      },
      userId,
      tracker,
      runId, conversationId, clientRequestId,
    }).then(result => ({ ...result, replannedTool: 'SEARCH_PLACES' }));
  }

  const routing = checkRoutingRules(toolName, queryStr);
  if (!routing.allowed) {
    const reason = routing.reason || 'routing rule failed';
    console.warn(`[ACTION_EXECUTOR] REJECTED tool=${toolName} reason="${reason}"`);
    recordRejection(tracker, toolName, reason);
    return {
      success: false,
      summary: `Tool ${toolName} blocked: ${routing.reason}`,
      error: routing.reason,
    };
  }

  recordUsed(tracker, toolName);

  const compactArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(toolArgs)) {
    if (v !== undefined && v !== null && v !== '') {
      compactArgs[k] = typeof v === 'string' && v.length > 120 ? v.substring(0, 120) : v;
    }
  }

  if (runId) {
    logToolCallStarted(userId, runId, toolName, compactArgs, conversationId, clientRequestId).catch(() => {});
  }

  try {
    let result: ActionResult;
    switch (toolName) {
      case 'SEARCH_PLACES':
        result = await executeSearchPlaces(toolArgs, userId);
        break;

      case 'ENRICH_LEADS':
        result = await executeEnrichLeads(toolArgs, userId);
        break;

      case 'SCORE_LEADS':
        result = await executeScoreLeads(toolArgs, userId);
        break;

      case 'EVALUATE_RESULTS':
        result = await executeEvaluateResults(toolArgs, userId);
        break;

      case 'WEB_VISIT':
        result = await executeWebVisitAction(toolArgs, userId, runId, conversationId);
        break;

      case 'CONTACT_EXTRACT':
        result = await executeContactExtractAction(toolArgs, userId, runId, conversationId);
        break;

      case 'LEAD_ENRICH':
        result = await executeLeadEnrichAction(toolArgs, userId, runId, conversationId);
        break;

      case 'ASK_LEAD_QUESTION':
        result = await executeAskLeadQuestionAction(toolArgs, userId, runId, conversationId);
        break;

      default:
        console.warn(`[ACTION_EXECUTOR] Unsupported tool: ${toolName}`);
        return {
          success: false,
          summary: `Unsupported tool: ${toolName}`,
          error: `Tool ${toolName} is not supported`
        };
    }

    if (runId) {
      if (result.success) {
        const outSummary: Record<string, unknown> = { summary: result.summary };
        if (result.data) {
          for (const [k, v] of Object.entries(result.data)) {
            if (Array.isArray(v)) outSummary[`${k}_count`] = v.length;
            else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') outSummary[k] = v;
          }
        }
        logToolCallCompleted(userId, runId, toolName, outSummary, conversationId, clientRequestId).catch(() => {});
      } else {
        logToolCallFailed(userId, runId, toolName, result.error || 'Unknown', conversationId, clientRequestId).catch(() => {});
      }
    }

    return result;
  } catch (error: any) {
    console.error(`[ACTION_EXECUTOR] Error executing ${toolName}:`, error.message);
    if (runId) {
      logToolCallFailed(userId, runId, toolName, error.message, conversationId, clientRequestId).catch(() => {});
    }
    return {
      success: false,
      summary: `Execution failed: ${error.message}`,
      error: error.message
    };
  }
}

async function executeSearchPlaces(
  args: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const query = args.query as string || 'businesses';
  const location = args.location as string || 'UK';
  const country = (args.country as string) || 'GB';
  const maxResults = Number(args.maxResults) || 20;
  const targetCount = args.target_count != null ? Number(args.target_count) : null;
  const rawMode = (args.google_query_mode as string) || '';
  const queryMode: GoogleQueryMode = rawMode === 'BIASED_STABLE' ? 'BIASED_STABLE' : 'TEXT_ONLY';
  const modeDefaulted = !rawMode || (rawMode !== 'TEXT_ONLY' && rawMode !== 'BIASED_STABLE');
  
  console.log(`[ACTION_EXECUTOR] SEARCH_PLACES: ${query} in ${location}, ${country} (maxResults=${maxResults}, target=${targetCount ?? 'unspecified'}, mode=${queryMode}${modeDefaulted ? ' [defaulted]' : ''})`);
  
  const result = await searchPlaces(query, location, country, maxResults, queryMode);
  
  if (result.success) {
    return {
      success: true,
      summary: `Found ${result.places.length} places for "${query}" in ${location}, ${country}${targetCount != null ? ` (target: ${targetCount})` : ''}`,
      data: {
        places: result.places,
        count: result.places.length,
        delivered_count: result.places.length,
        target_count: targetCount,
        ...(result.debug ? { search_debug: result.debug } : {}),
      }
    };
  } else {
    return {
      success: false,
      summary: `Search failed: ${result.error}`,
      error: result.error,
      data: result.debug ? { search_debug: result.debug } : undefined,
    };
  }
}

async function executeEnrichLeads(
  args: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const query = args.query as string || 'businesses';
  const location = args.location as string || 'UK';
  const country = (args.country as string) || 'GB';
  const enrichType = (args.enrichType as string) || 'detail';

  console.log(`[ACTION_EXECUTOR] ENRICH_LEADS: enriching "${query}" in ${location} (${enrichType})`);

  const result = await searchPlaces(`${query} with reviews`, location, country, 10);

  if (!result.success) {
    return { success: false, summary: `Enrichment search failed: ${result.error}`, error: result.error };
  }

  const enriched = result.places.map(p => ({
    place_id: p.place_id,
    name: p.name,
    address: p.formatted_address,
    has_website: p.types?.includes('establishment') ?? false,
    has_phone: true,
    category: (p.types && p.types[0]) || 'unknown',
    enrichType,
  }));

  console.log(`[ACTION_EXECUTOR] ENRICH_LEADS: enriched ${enriched.length} leads`);

  return {
    success: true,
    summary: `Enriched ${enriched.length} leads for "${query}" in ${location} (${enrichType})`,
    data: { leads: enriched, count: enriched.length },
  };
}

async function executeScoreLeads(
  args: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const query = args.query as string || 'businesses';
  const location = args.location as string || 'UK';
  const country = (args.country as string) || 'GB';
  const scoreModel = (args.scoreModel as string) || 'basic';

  console.log(`[ACTION_EXECUTOR] SCORE_LEADS: scoring "${query}" in ${location} (model: ${scoreModel})`);

  const result = await searchPlaces(query, location, country, 10);

  if (!result.success) {
    return { success: false, summary: `Scoring search failed: ${result.error}`, error: result.error };
  }

  const scored = result.places.map((p, idx) => {
    const typeBonus = (p.types || []).length * 0.05;
    const nameLength = Math.min(p.name.length / 50, 0.3);
    const addressLength = Math.min(p.formatted_address.length / 100, 0.2);
    const score = Math.min(parseFloat((0.4 + typeBonus + nameLength + addressLength).toFixed(3)), 1.0);
    return { place_id: p.place_id, name: p.name, score, rank: idx + 1 };
  });

  scored.sort((a, b) => b.score - a.score);
  scored.forEach((s, i) => { s.rank = i + 1; });

  const avgScore = scored.length > 0
    ? parseFloat((scored.reduce((sum, s) => sum + s.score, 0) / scored.length).toFixed(3))
    : 0;

  const aboveThreshold = scored.filter(s => s.score >= 0.6).length;

  console.log(`[ACTION_EXECUTOR] SCORE_LEADS: scored ${scored.length} leads, avg=${avgScore}, above-threshold=${aboveThreshold}`);

  return {
    success: true,
    summary: `Scored ${scored.length} leads (avg ${avgScore}, ${aboveThreshold} above threshold) using ${scoreModel} model`,
    data: { leads: scored, count: scored.length, avgScore, aboveThreshold },
  };
}

async function executeEvaluateResults(
  args: Record<string, unknown>,
  userId: string
): Promise<ActionResult> {
  const totalSearched = (args.totalSearched as number) || 0;
  const totalEnriched = (args.totalEnriched as number) || 0;
  const totalScored = (args.totalScored as number) || 0;
  const goalDescription = (args.goalDescription as string) || 'Lead generation evaluation';

  console.log(`[ACTION_EXECUTOR] EVALUATE_RESULTS: evaluating ${totalSearched} searched, ${totalEnriched} enriched, ${totalScored} scored`);

  const coverageRate = totalSearched > 0
    ? parseFloat(((totalEnriched / totalSearched) * 100).toFixed(1))
    : 0;
  const scoringRate = totalEnriched > 0
    ? parseFloat(((totalScored / totalEnriched) * 100).toFixed(1))
    : 0;
  const overallQuality = parseFloat(((coverageRate + scoringRate) / 200).toFixed(3));

  const verdict = overallQuality >= 0.6 ? 'PASS' : overallQuality >= 0.3 ? 'MARGINAL' : 'FAIL';

  console.log(`[ACTION_EXECUTOR] EVALUATE_RESULTS: verdict=${verdict}, quality=${overallQuality}`);

  return {
    success: true,
    summary: `Evaluation ${verdict}: coverage ${coverageRate}%, scoring ${scoringRate}%, quality ${overallQuality} — ${goalDescription}`,
    data: {
      verdict,
      coverageRate,
      scoringRate,
      overallQuality,
      totalSearched,
      totalEnriched,
      totalScored,
    },
  };
}

export async function executeStep(
  step: PlanStep,
  toolMetadata: { toolName: string; toolArgs: Record<string, unknown> } | undefined,
  userId: string,
  tracker?: RunToolTracker,
  runId?: string,
  conversationId?: string,
  clientRequestId?: string,
): Promise<ActionResult> {
  const toolName = step.toolName || toolMetadata?.toolName;
  const toolArgs = step.toolArgs || toolMetadata?.toolArgs;

  if (!toolName || !toolArgs) {
    return {
      success: false,
      summary: 'No tool metadata provided',
      error: 'Missing toolName/toolArgs for step execution'
    };
  }
  
  return executeAction({
    toolName,
    toolArgs,
    userId,
    tracker,
    runId,
    conversationId,
    clientRequestId,
  });
}

async function executeWebVisitAction(
  args: Record<string, unknown>,
  userId: string,
  runId?: string,
  conversationId?: string,
): Promise<ActionResult> {
  const input: WebVisitInput = {
    url: String(args.url || ''),
    max_pages: Number(args.max_pages) || 3,
    page_hints: Array.isArray(args.page_hints) ? args.page_hints as string[] : undefined,
    same_domain_only: args.same_domain_only !== false,
  };

  if (!input.url) {
    return { success: false, summary: 'WEB_VISIT requires a url parameter', error: 'Missing url' };
  }

  const envelope = await executeWebVisit(input, runId || `webvisit-${Date.now()}`, undefined);

  const crawl = (envelope.outputs as any)?.crawl;
  const pageCount = (envelope.outputs as any)?.pages?.length ?? 0;

  if (runId) {
    try {
      await createArtefact({
        runId,
        type: 'web_visit_pages',
        title: `WEB_VISIT: ${input.url} (${pageCount} pages)`,
        summary: (envelope.outputs as any)?.site_summary || `Crawled ${pageCount} page(s)`,
        payload: envelope as unknown as Record<string, unknown>,
        userId,
        conversationId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ACTION_EXECUTOR] Failed to write web_visit_pages artefact: ${msg}`);
    }
  }

  if (pageCount === 0) {
    const errMsg = envelope.errors?.map(e => e.message).join('; ') || 'No pages fetched';
    return {
      success: false,
      summary: `WEB_VISIT failed for ${input.url}: ${errMsg}`,
      error: errMsg,
      data: { envelope },
    };
  }

  return {
    success: true,
    summary: `Crawled ${pageCount} page(s) from ${input.url}` +
      (crawl?.http_failures_count ? ` (${crawl.http_failures_count} failures)` : ''),
    data: { envelope },
  };
}

async function executeContactExtractAction(
  args: Record<string, unknown>,
  userId: string,
  runId?: string,
  conversationId?: string,
): Promise<ActionResult> {
  const rawPages = Array.isArray(args.pages) ? args.pages : [];
  const pages = rawPages
    .filter((p: any) => p && typeof p.url === 'string' && typeof p.text_clean === 'string')
    .map((p: any) => ({ url: p.url as string, text_clean: p.text_clean as string }));

  if (pages.length === 0) {
    return { success: false, summary: 'CONTACT_EXTRACT requires pages with url and text_clean', error: 'No valid pages provided' };
  }

  const input: ContactExtractInput = {
    pages,
    entity_name: typeof args.entity_name === 'string' ? args.entity_name : null,
  };

  const envelope = executeContactExtract(input, runId || `contact-${Date.now()}`, undefined);

  const contacts = (envelope.outputs as any)?.contacts;
  const people = (envelope.outputs as any)?.people;
  const emailCount = contacts?.emails?.length ?? 0;
  const phoneCount = contacts?.phones?.length ?? 0;
  const peopleCount = people?.length ?? 0;

  if (runId) {
    try {
      await createArtefact({
        runId,
        type: 'contact_extract',
        title: `CONTACT_EXTRACT: ${emailCount} emails, ${phoneCount} phones, ${peopleCount} people`,
        summary: `Extracted ${emailCount} email(s), ${phoneCount} phone(s), ${peopleCount} person(s) from ${pages.length} page(s)`,
        payload: envelope as unknown as Record<string, unknown>,
        userId,
        conversationId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ACTION_EXECUTOR] Failed to write contact_extract artefact: ${msg}`);
    }
  }

  const totalFound = emailCount + phoneCount + peopleCount;
  return {
    success: true,
    summary: `Extracted ${emailCount} email(s), ${phoneCount} phone(s), ${peopleCount} person(s)`,
    data: { envelope },
  };
}

async function executeLeadEnrichAction(
  args: Record<string, unknown>,
  userId: string,
  runId?: string,
  conversationId?: string,
): Promise<ActionResult> {
  const input: LeadEnrichInput = {
    places_lead: args.places_lead && typeof args.places_lead === 'object'
      ? args.places_lead as LeadEnrichInput['places_lead']
      : null,
    web_visit_pages: Array.isArray(args.web_visit_pages)
      ? (args.web_visit_pages as any[])
          .filter((p: any) => p && typeof p.url === 'string' && typeof p.text_clean === 'string')
          .map((p: any) => ({ url: p.url as string, text_clean: p.text_clean as string, page_type: p.page_type as string | undefined }))
      : null,
    contact_extract: args.contact_extract && typeof args.contact_extract === 'object'
      ? args.contact_extract as LeadEnrichInput['contact_extract']
      : null,
    ask_lead_question_result: args.ask_lead_question_result && typeof args.ask_lead_question_result === 'object'
      ? args.ask_lead_question_result as LeadEnrichInput['ask_lead_question_result']
      : null,
    web_search: args.web_search && typeof args.web_search === 'object'
      ? args.web_search as LeadEnrichInput['web_search']
      : null,
  };

  const hasWebSearch = input.web_search && (
    (Array.isArray(input.web_search.results) && input.web_search.results.length > 0) ||
    (input.web_search.outputs && Array.isArray(input.web_search.outputs.results) && input.web_search.outputs.results.length > 0)
  );
  if (!input.places_lead && (!input.web_visit_pages || input.web_visit_pages.length === 0) && !input.contact_extract && !hasWebSearch) {
    return {
      success: false,
      summary: 'LEAD_ENRICH requires at least one data source (places_lead, web_visit_pages, contact_extract, or web_search)',
      error: 'No data sources provided',
    };
  }

  const envelope = executeLeadEnrich(input, runId || `enrich-${Date.now()}`, undefined);

  const identity = (envelope.outputs as any)?.lead_pack?.identity;
  const confidence = (envelope.outputs as any)?.lead_pack?.confidence ?? 0;
  const entityName = identity?.name ?? 'Unknown';

  if (runId) {
    try {
      await createArtefact({
        runId,
        type: 'lead_pack',
        title: `LEAD_ENRICH: ${entityName}`,
        summary: `Lead pack for "${entityName}" — confidence: ${Math.round(confidence * 100)}%`,
        payload: envelope as unknown as Record<string, unknown>,
        userId,
        conversationId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ACTION_EXECUTOR] Failed to write lead_pack artefact: ${msg}`);
    }
  }

  return {
    success: true,
    summary: `Lead pack built for "${entityName}" — confidence: ${Math.round(confidence * 100)}%`,
    data: { envelope },
  };
}

async function executeAskLeadQuestionAction(
  args: Record<string, unknown>,
  userId: string,
  runId?: string,
  conversationId?: string,
): Promise<ActionResult> {
  const leadRaw = args.lead && typeof args.lead === 'object' ? args.lead as Record<string, unknown> : null;
  if (!leadRaw || typeof leadRaw.business_name !== 'string') {
    return { success: false, summary: 'ASK_LEAD_QUESTION requires a lead object with business_name', error: 'Missing lead.business_name' };
  }

  const intentQuestion = typeof args.intent_question === 'string' ? args.intent_question.trim() : '';
  const evidenceQuery = typeof args.evidence_query === 'string' ? args.evidence_query.trim() : '';
  if (!intentQuestion || !evidenceQuery) {
    return { success: false, summary: 'ASK_LEAD_QUESTION requires intent_question and evidence_query', error: 'Missing question fields' };
  }

  const input: AskLeadQuestionInput = {
    lead: {
      business_name: leadRaw.business_name as string,
      town: typeof leadRaw.town === 'string' ? leadRaw.town : undefined,
      address: typeof leadRaw.address === 'string' ? leadRaw.address : undefined,
      website: typeof leadRaw.website === 'string' ? leadRaw.website : undefined,
      phone: typeof leadRaw.phone === 'string' ? leadRaw.phone : undefined,
    },
    intent_question: intentQuestion,
    evidence_query: evidenceQuery,
    search_budget: Number(args.search_budget) || 3,
    visit_budget: Number(args.visit_budget) || 3,
  };

  const envelope = await executeAskLeadQuestion(input, runId || `ask-${Date.now()}`, undefined);

  const answer = (envelope.outputs as any)?.answer;
  const verdict = answer?.verdict ?? 'unknown';
  const factsCount = answer?.key_facts?.length ?? 0;
  const budgetUsed = (envelope.outputs as any)?.budget_used;

  if (runId) {
    try {
      await createArtefact({
        runId,
        type: 'ask_lead_question_result',
        title: `ASK_LEAD_QUESTION: "${intentQuestion}" for ${input.lead.business_name}`,
        summary: `Verdict: ${verdict}, ${factsCount} fact(s) found (${budgetUsed?.searches_used ?? 0} searches, ${budgetUsed?.visits_used ?? 0} visits)`,
        payload: envelope as unknown as Record<string, unknown>,
        userId,
        conversationId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ACTION_EXECUTOR] Failed to write ask_lead_question_result artefact: ${msg}`);
    }
  }

  return {
    success: verdict !== 'unknown',
    summary: `Q: "${intentQuestion}" for ${input.lead.business_name} — ${verdict} (${factsCount} fact(s))`,
    data: { envelope },
  };
}
