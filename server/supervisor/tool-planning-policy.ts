import { createArtefact } from './artefacts';

export type ToolStepId =
  | 'SEARCH_PLACES'
  | 'WEB_VISIT'
  | 'CONTACT_EXTRACT'
  | 'LEAD_ENRICH'
  | 'WEB_SEARCH'
  | 'ASK_LEAD_QUESTION';

export type StepCondition =
  | 'always'
  | 'website_exists'
  | 'website_missing_or_unreachable'
  | 'user_question_present';

export type StepPhase = 'candidate_discovery' | 'enrichment_primary' | 'enrichment_fallback' | 'special';

export interface PlannedStep {
  order: number;
  tool: ToolStepId;
  phase: StepPhase;
  condition: StepCondition;
  reason: string;
  depends_on: ToolStepId[];
  budgeted?: boolean;
}

export interface ToolPlanExplainer {
  lead_context: {
    business_name: string;
    has_website: boolean;
    has_phone: boolean;
    has_address: boolean;
    user_question: string | null;
  };
  selected_path: 'primary' | 'fallback' | 'primary_with_question' | 'fallback_with_question';
  steps: PlannedStep[];
  rules_applied: string[];
  never_rules_checked: string[];
}

export interface LeadContext {
  business_name: string;
  website?: string | null;
  phone?: string | null;
  address?: string | null;
  town?: string | null;
  website_unreachable?: boolean;
  user_question?: string | null;
}

const RULE_PLACES_FIRST = 'Google Places → candidates (always first)';
const RULE_PRIMARY_CHAIN = 'If website exists: WEB_VISIT → CONTACT_EXTRACT → LEAD_ENRICH';
const RULE_FALLBACK_CHAIN = 'If website missing/unreachable: WEB_SEARCH → WEB_VISIT → CONTACT_EXTRACT → LEAD_ENRICH';
const RULE_QUESTION = 'If user asks non-Places attribute: ASK_LEAD_QUESTION (budgeted)';
const RULE_NEVER_OVERRIDE = 'Never override Places website unless disambiguation passes';
const RULE_NEVER_GUESS = 'Never guess when uncertain';

export function buildToolPlan(ctx: LeadContext): ToolPlanExplainer {
  const hasWebsite = !!(ctx.website && ctx.website.trim().length > 0);
  const websiteAvailable = hasWebsite && !ctx.website_unreachable;
  const hasQuestion = !!(ctx.user_question && ctx.user_question.trim().length > 0);

  const steps: PlannedStep[] = [];
  const rulesApplied: string[] = [];
  let order = 1;

  steps.push({
    order: order++,
    tool: 'SEARCH_PLACES',
    phase: 'candidate_discovery',
    condition: 'always',
    reason: 'Google Places is always the first step for candidate discovery',
    depends_on: [],
  });
  rulesApplied.push(RULE_PLACES_FIRST);

  if (websiteAvailable) {
    rulesApplied.push(RULE_PRIMARY_CHAIN);

    steps.push({
      order: order++,
      tool: 'WEB_VISIT',
      phase: 'enrichment_primary',
      condition: 'website_exists',
      reason: 'Website exists — crawl for contact and business data',
      depends_on: ['SEARCH_PLACES'],
    });

    steps.push({
      order: order++,
      tool: 'CONTACT_EXTRACT',
      phase: 'enrichment_primary',
      condition: 'website_exists',
      reason: 'Extract contacts from crawled pages',
      depends_on: ['WEB_VISIT'],
    });

    steps.push({
      order: order++,
      tool: 'LEAD_ENRICH',
      phase: 'enrichment_primary',
      condition: 'website_exists',
      reason: 'Assemble lead pack from Places + crawl + contacts',
      depends_on: ['SEARCH_PLACES', 'WEB_VISIT', 'CONTACT_EXTRACT'],
    });
  } else {
    rulesApplied.push(RULE_FALLBACK_CHAIN);

    steps.push({
      order: order++,
      tool: 'WEB_SEARCH',
      phase: 'enrichment_fallback',
      condition: 'website_missing_or_unreachable',
      reason: hasWebsite
        ? 'Website unreachable — search for alternative sources'
        : 'No website from Places — search to find one',
      depends_on: ['SEARCH_PLACES'],
    });

    steps.push({
      order: order++,
      tool: 'WEB_VISIT',
      phase: 'enrichment_fallback',
      condition: 'website_missing_or_unreachable',
      reason: 'Visit disambiguated URL or top search results',
      depends_on: ['WEB_SEARCH'],
    });

    steps.push({
      order: order++,
      tool: 'CONTACT_EXTRACT',
      phase: 'enrichment_fallback',
      condition: 'website_missing_or_unreachable',
      reason: 'Extract contacts from search-discovered pages',
      depends_on: ['WEB_VISIT'],
    });

    steps.push({
      order: order++,
      tool: 'LEAD_ENRICH',
      phase: 'enrichment_fallback',
      condition: 'website_missing_or_unreachable',
      reason: 'Assemble lead pack from Places + search-discovered data',
      depends_on: ['SEARCH_PLACES', 'WEB_SEARCH', 'WEB_VISIT', 'CONTACT_EXTRACT'],
    });
  }

  if (hasQuestion) {
    rulesApplied.push(RULE_QUESTION);

    steps.push({
      order: order++,
      tool: 'ASK_LEAD_QUESTION',
      phase: 'special',
      condition: 'user_question_present',
      reason: `User question: "${ctx.user_question}" — budgeted evidence search`,
      depends_on: ['SEARCH_PLACES'],
      budgeted: true,
    });
  }

  const selectedPath = websiteAvailable
    ? (hasQuestion ? 'primary_with_question' : 'primary')
    : (hasQuestion ? 'fallback_with_question' : 'fallback');

  return {
    lead_context: {
      business_name: ctx.business_name,
      has_website: hasWebsite,
      has_phone: !!(ctx.phone && ctx.phone.trim().length > 0),
      has_address: !!(ctx.address && ctx.address.trim().length > 0),
      user_question: ctx.user_question?.trim() || null,
    },
    selected_path: selectedPath,
    steps,
    rules_applied: rulesApplied,
    never_rules_checked: [
      RULE_NEVER_OVERRIDE,
      RULE_NEVER_GUESS,
    ],
  };
}

export function getOrderedToolNames(plan: ToolPlanExplainer): ToolStepId[] {
  return plan.steps
    .sort((a, b) => a.order - b.order)
    .map((s) => s.tool);
}

export function getStepByTool(plan: ToolPlanExplainer, tool: ToolStepId): PlannedStep | undefined {
  return plan.steps.find((s) => s.tool === tool);
}

export function isToolInPlan(plan: ToolPlanExplainer, tool: ToolStepId): boolean {
  return plan.steps.some((s) => s.tool === tool);
}

export function validateToolOrder(plan: ToolPlanExplainer, currentTool: ToolStepId, completedTools: ToolStepId[]): { valid: boolean; reason?: string } {
  const step = getStepByTool(plan, currentTool);
  if (!step) {
    return { valid: false, reason: `${currentTool} is not in the current plan` };
  }

  for (const dep of step.depends_on) {
    if (!completedTools.includes(dep)) {
      return { valid: false, reason: `${currentTool} depends on ${dep} which has not completed` };
    }
  }

  return { valid: true };
}

export function shouldUseWebSearchFallback(ctx: LeadContext): boolean {
  return !ctx.website || ctx.website.trim().length === 0 || !!ctx.website_unreachable;
}

export function mayOverridePlacesWebsite(
  placesWebsite: string | null | undefined,
  disambiguatedUrl: string | null | undefined,
  disambiguationSignalCount: number,
): { override: boolean; reason: string } {
  if (!placesWebsite || placesWebsite.trim().length === 0) {
    if (disambiguatedUrl) {
      return { override: true, reason: 'No Places website — using disambiguated URL' };
    }
    return { override: false, reason: 'No Places website and no disambiguation result' };
  }

  if (!disambiguatedUrl) {
    return { override: false, reason: 'Places website exists — no disambiguation to consider' };
  }

  if (disambiguationSignalCount < 2) {
    return { override: false, reason: `Disambiguation has only ${disambiguationSignalCount} signal(s) — insufficient to override Places website (requires 2+)` };
  }

  const placesHost = extractHost(placesWebsite);
  const disambiguatedHost = extractHost(disambiguatedUrl);

  if (placesHost === disambiguatedHost) {
    return { override: false, reason: 'Disambiguated URL matches Places website domain — no override needed' };
  }

  return {
    override: true,
    reason: `Disambiguation passed with ${disambiguationSignalCount} signals — overriding Places website (${placesHost} → ${disambiguatedHost})`,
  };
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.toLowerCase().trim();
  }
}

export async function persistToolPlanExplainer(
  plan: ToolPlanExplainer,
  runId: string,
  userId: string,
  conversationId?: string,
): Promise<void> {
  try {
    await createArtefact({
      runId,
      type: 'tool_plan_explainer',
      title: `Tool Plan: ${plan.lead_context.business_name} (${plan.selected_path})`,
      summary: `${plan.steps.length} steps — path: ${plan.selected_path} — rules: ${plan.rules_applied.join(', ')}`,
      payload: plan as unknown as Record<string, unknown>,
      userId,
      conversationId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[TOOL_PLAN_POLICY] Failed to write tool_plan_explainer artefact: ${msg}`);
  }
}
