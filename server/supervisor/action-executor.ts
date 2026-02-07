/**
 * Action Executor - Single execution spine for Supervisor
 * 
 * Supports SEARCH_PLACES, ENRICH_LEADS, SCORE_LEADS, EVALUATE_RESULTS.
 * Uses native Google Places API directly (no UI tool endpoint dependency).
 */

import type { PlanStep } from './types/plan';
import { searchPlaces } from './google-places';

export interface ActionResult {
  success: boolean;
  summary: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface ActionInput {
  toolName: string;
  toolArgs: Record<string, unknown>;
  userId: string;
}

export async function executeAction(input: ActionInput): Promise<ActionResult> {
  const { toolName, toolArgs, userId } = input;
  
  console.log(`[ACTION_EXECUTOR] Executing ${toolName} with args:`, JSON.stringify(toolArgs).substring(0, 200));
  
  try {
    switch (toolName) {
      case 'SEARCH_PLACES':
        return await executeSearchPlaces(toolArgs, userId);

      case 'ENRICH_LEADS':
        return await executeEnrichLeads(toolArgs, userId);

      case 'SCORE_LEADS':
        return await executeScoreLeads(toolArgs, userId);

      case 'EVALUATE_RESULTS':
        return await executeEvaluateResults(toolArgs, userId);
      
      default:
        console.warn(`[ACTION_EXECUTOR] Unsupported tool: ${toolName}`);
        return {
          success: false,
          summary: `Unsupported tool: ${toolName}`,
          error: `Tool ${toolName} is not supported`
        };
    }
  } catch (error: any) {
    console.error(`[ACTION_EXECUTOR] Error executing ${toolName}:`, error.message);
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
  
  console.log(`[ACTION_EXECUTOR] SEARCH_PLACES: ${query} in ${location}, ${country}`);
  
  const result = await searchPlaces(query, location, country, 20);
  
  if (result.success) {
    return {
      success: true,
      summary: `Found ${result.places.length} places for "${query}" in ${location}, ${country}`,
      data: { places: result.places, count: result.places.length }
    };
  } else {
    return {
      success: false,
      summary: `Search failed: ${result.error}`,
      error: result.error
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
  userId: string
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
    userId
  });
}
