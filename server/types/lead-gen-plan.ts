/**
 * Lead Generation Planning & Execution Module (SUP-001 + SUP-002 + SUP-012)
 * 
 * SUP-001: Pure planning function that generates execution plans
 * SUP-002: Executor that runs plans and manages tool execution
 * SUP-012: Historical performance integration for smarter planning
 */

import { storage } from "../storage";
import { getHistoricalContextForGoal, type HistoricalContext } from "../historical-performance";
import type { ActionType, ActionInput, ActionResult } from "../actions/registry";

// ========================================
// TOOL IDENTIFIERS
// ========================================

export type LeadToolIdentifier =
  | "GOOGLE_PLACES_SEARCH"
  | "HUNTER_DOMAIN_LOOKUP"
  | "HUNTER_ENRICH"
  | "EMAIL_SEQUENCE_SETUP"
  | "LEAD_LIST_SAVE"
  | "MONITOR_SETUP";

// ========================================
// CONDITIONAL BRANCHING (SUP-010)
// ========================================

/**
 * Conditions that trigger different execution paths
 */
export type BranchCondition =
  | { type: "too_many_results"; threshold: number }
  | { type: "too_few_results"; threshold: number }
  | { type: "data_source_failed"; source: string }
  | { type: "budget_exceeded"; maxBudget: number }
  | { type: "fallback"; reason?: string };

/**
 * A single branch in a plan step
 */
export interface PlanBranch {
  when: BranchCondition;
  nextStepId: string;
}

// ========================================
// TOOL PARAMETERS
// ========================================

export type LeadToolParams = Record<string, unknown>;

export interface GooglePlacesSearchParams {
  query: string;
  region: string;
  country?: string;
  maxResults?: number;
}

export interface HunterDomainLookupParams {
  companyName?: string;
  website?: string;
  country?: string;
  sourceStepId?: string;
}

export interface HunterEnrichParams {
  domain?: string;
  roleHint?: string;
  maxContactsPerDomain?: number;
  sourceStepId?: string;
}

export interface EmailSequenceSetupParams {
  campaignName: string;
  fromIdentityId: string;
  targetSegmentId?: string;
  estimatedVolume?: number;
  startTiming?: string;
  sourceListStepId?: string;
}

export interface LeadListSaveParams {
  sourceStepId: string;
  listName: string;
  region?: string;
  persona?: string;
  estimatedVolume?: number;
}

export interface MonitorSetupParams {
  sourceListStepId: string;
  cadence: "daily" | "weekly" | "monthly";
  signalTypes?: string[];
}

// ========================================
// PLAN STEP
// ========================================

export interface LeadGenPlanStep {
  /**
   * Unique ID within the plan, e.g. "step_1", "google_places_1".
   */
  id: string;

  /**
   * High-level label for humans, optional but useful.
   */
  label?: string;

  /**
   * Which tool this step intends to call (legacy).
   */
  tool: LeadToolIdentifier;

  /**
   * Parameters to feed into that tool when the executor runs it (legacy).
   */
  params: LeadToolParams;

  /**
   * Canonical action type for execution (DEEP_RESEARCH, GLOBAL_DB, etc.)
   */
  type?: ActionType;

  /**
   * Structured input for the action executor
   */
  input?: ActionInput;

  /**
   * Execution status
   */
  status?: 'pending' | 'executing' | 'completed' | 'failed';

  /**
   * Result from action execution (populated after execution)
   */
  result?: ActionResult;

  /**
   * IDs of other steps that must be completed before this one can run.
   */
  dependsOn?: string[];

  /**
   * Optional notes / rationale for the planner / debugger.
   */
  note?: string;

  /**
   * Optional conditional branches for dynamic execution paths (SUP-010).
   * If undefined or empty, execution proceeds sequentially to next step by index.
   */
  branches?: PlanBranch[];
}

// ========================================
// GOAL AND CONTEXT
// ========================================

export interface LeadGenGoal {
  /**
   * Free-text from the user, as captured by the UI.
   */
  rawGoal: string;

  /**
   * Region(s) to target, e.g. "North West", "UK", "London and South East".
   */
  targetRegion?: string;

  /**
   * Persona or role, e.g. "pub landlords", "bar managers", "buyers".
   */
  targetPersona?: string;

  /**
   * Approximate number of leads or emails.
   */
  volume?: number;

  /**
   * Timing requirement, e.g. "this week", "ongoing weekly", ISO datetime, etc.
   */
  timing?: string;

  /**
   * Channels the user cares about. For now mostly email.
   */
  preferredChannels?: Array<"email" | "phone" | "linkedin">;

  /**
   * Whether the user wants ongoing monitoring as part of this goal.
   */
  includeMonitoring?: boolean;
}

/**
 * Environment & user-specific context the planner can use.
 */
export interface LeadGenContext {
  userId: string;
  accountId?: string;

  /**
   * Default country/region if goal doesn't specify.
   */
  defaultRegion?: string;
  defaultCountry?: string;

  /**
   * Default sending identity / email profile ID for outreach tools.
   */
  defaultFromIdentityId?: string;

  /**
   * Any saved preferences or flags (can be expanded later).
   */
  preferences?: Record<string, unknown>;
}

// ========================================
// PLAN OBJECT
// ========================================

export interface LeadGenPlan {
  /**
   * Unique identifier for this plan. Can be generated by Supervisor.
   */
  id: string;

  /**
   * A short description / title, often derived from the goal.
   */
  title: string;

  /**
   * Original raw goal text (or summary) from UI / goal capture.
   */
  rawGoal: string;

  /**
   * Optional structured goal fields.
   */
  goal: LeadGenGoal;

  /**
   * Context used to generate the plan (user, account, etc.).
   */
  context: LeadGenContext;

  /**
   * Ordered list of steps.
   */
  steps: LeadGenPlanStep[];

  /**
   * Optional metadata (e.g. createdAt, priority).
   */
  createdAt: string; // ISO timestamp
  priority?: "low" | "normal" | "high";
}

// ========================================
// PURE PLANNING FUNCTION
// ========================================

/**
 * Pure planning function that generates a lead generation execution plan.
 * 
 * IMPORTANT: This function does NOT execute tools or make external calls.
 * It only constructs a plan (DAG of steps) that can be executed later.
 * 
 * @param goal - The lead generation goal (what the user wants)
 * @param context - User and environment context
 * @returns A complete LeadGenPlan with ordered steps
 */
export function planLeadGeneration(
  goal: LeadGenGoal,
  context: LeadGenContext
): LeadGenPlan {
  // Step counter for generating unique IDs
  let stepCounter = 0;
  const steps: LeadGenPlanStep[] = [];

  function nextStepId(prefix: string): string {
    stepCounter += 1;
    return `${prefix}_${stepCounter}`;
  }

  // ========================================
  // NORMALIZE GOAL & CONTEXT
  // ========================================

  const effectiveRegion = goal.targetRegion ?? context.defaultRegion ?? "UK";
  const effectiveCountry = context.defaultCountry ?? "GB";
  const persona = goal.targetPersona ?? "target customers";
  const volume = goal.volume ?? 50;
  const timing = goal.timing ?? "asap";

  // ========================================
  // STEP 1: GOOGLE_PLACES_SEARCH
  // ========================================

  const googlePlacesStepId = nextStepId("google_places");

  steps.push({
    id: googlePlacesStepId,
    label: "Find candidate businesses via Google Places",
    tool: "GOOGLE_PLACES_SEARCH",
    type: "GLOBAL_DB",
    params: {
      query: persona,
      region: effectiveRegion,
      country: effectiveCountry,
      maxResults: volume * 2 // Over-fetch so we can filter later
    },
    input: {
      query: persona,
      region: effectiveRegion,
      country: effectiveCountry,
      maxResults: volume * 2
    },
    status: "pending",
    dependsOn: [],
    note: "Initial business discovery from Google Places based on persona and region."
  });

  // ========================================
  // STEP 2: HUNTER_DOMAIN_LOOKUP
  // ========================================

  const hunterDomainStepId = nextStepId("hunter_domain_lookup");

  steps.push({
    id: hunterDomainStepId,
    label: "Look up domains for candidate businesses",
    tool: "HUNTER_DOMAIN_LOOKUP",
    type: "EMAIL_FINDER",
    params: {
      sourceStepId: googlePlacesStepId,
      country: effectiveCountry
    },
    input: {
      leads: [], // Will be populated from previous step results
      sourceStepId: googlePlacesStepId
    },
    status: "pending",
    dependsOn: [googlePlacesStepId],
    note: "Take business names from Google Places and find domains."
  });

  // ========================================
  // STEP 3: HUNTER_ENRICH
  // ========================================

  const hunterEnrichStepId = nextStepId("hunter_enrich");

  steps.push({
    id: hunterEnrichStepId,
    label: "Find target contacts at those domains",
    tool: "HUNTER_ENRICH",
    type: "EMAIL_FINDER",
    params: {
      sourceStepId: hunterDomainStepId,
      roleHint: persona,
      maxContactsPerDomain: 2
    },
    input: {
      leads: [], // Will be populated from previous step results
      sourceStepId: hunterDomainStepId
    },
    status: "pending",
    dependsOn: [hunterDomainStepId],
    note: "Use Hunter to find contacts that match the target persona."
  });

  // ========================================
  // STEP 4: LEAD_LIST_SAVE
  // ========================================

  const saveListStepId = nextStepId("lead_list_save");

  steps.push({
    id: saveListStepId,
    label: "Save enriched leads to a list",
    tool: "LEAD_LIST_SAVE",
    type: "GLOBAL_DB",
    params: {
      sourceStepId: hunterEnrichStepId,
      listName: goal.rawGoal || "Lead list",
      region: effectiveRegion,
      persona,
      estimatedVolume: volume
    },
    input: {
      query: persona,
      region: effectiveRegion,
      maxResults: volume
    },
    status: "pending",
    dependsOn: [hunterEnrichStepId],
    note: "Store all enriched leads under a named list in Wyshbone."
  });

  // ========================================
  // STEP 5: EMAIL_SEQUENCE_SETUP (conditional)
  // ========================================

  const wantsEmail =
    !goal.preferredChannels || goal.preferredChannels.includes("email");

  if (wantsEmail && context.defaultFromIdentityId) {
    const emailSeqStepId = nextStepId("email_sequence");

    steps.push({
      id: emailSeqStepId,
      label: "Set up outbound email sequence",
      tool: "EMAIL_SEQUENCE_SETUP",
      type: "EMAIL_FINDER",
      params: {
        sourceListStepId: saveListStepId,
        campaignName: goal.rawGoal || "Outbound campaign",
        fromIdentityId: context.defaultFromIdentityId,
        estimatedVolume: volume,
        startTiming: timing
      },
      input: {
        leads: [],
        sourceStepId: saveListStepId
      },
      status: "pending",
      dependsOn: [saveListStepId],
      note: "Create an email sequence in the outreach system targeting the saved leads."
    });
  }

  // ========================================
  // STEP 6: MONITOR_SETUP (conditional)
  // ========================================

  if (goal.includeMonitoring) {
    const monitorStepId = nextStepId("monitor");

    steps.push({
      id: monitorStepId,
      label: "Set up ongoing monitoring for this lead list",
      tool: "MONITOR_SETUP",
      type: "SCHEDULED_MONITOR",
      params: {
        sourceListStepId: saveListStepId,
        cadence: "weekly",
        signalTypes: ["new_reviews", "profile_changes"]
      },
      input: {
        label: goal.rawGoal || "Lead list monitor",
        description: `Monitor for ${persona} in ${effectiveRegion}`,
        monitorType: "lead_generation"
      },
      status: "pending",
      dependsOn: [saveListStepId],
      note: "Configure background monitoring to surface future signals for this list."
    });
  }

  // ========================================
  // CONSTRUCT FINAL PLAN
  // ========================================

  const planId = `lead_plan_${Date.now()}`;

  const plan: LeadGenPlan = {
    id: planId,
    title: goal.rawGoal || "Lead generation plan",
    rawGoal: goal.rawGoal,
    goal,
    context,
    steps,
    createdAt: new Date().toISOString(),
    priority: "normal"
  };

  return plan;
}

// ========================================
// SUP-012: HISTORICAL PERFORMANCE INTEGRATION
// ========================================

/**
 * Plan lead generation with historical performance guidance (SUP-012).
 * 
 * This async wrapper:
 * 1. Fetches historical context for the goal
 * 2. Adjusts strategy based on top/low performers
 * 3. Generates plan with optimized choices
 * 4. Logs decisions for observability
 * 
 * @param goal - The lead generation goal
 * @param context - User and environment context
 * @returns Promise of LeadGenPlan with historically-informed strategies
 */
export async function planLeadGenerationWithHistory(
  goal: LeadGenGoal,
  context: LeadGenContext
): Promise<LeadGenPlan> {
  
  // Fetch historical context (SCOPED TO THIS USER/ACCOUNT)
  // IMPORTANT: Only pass explicit goal parameters to avoid over-filtering
  const historical = await getHistoricalContextForGoal(
    {
      description: goal.rawGoal,
      targetMarket: goal.targetPersona,
      country: undefined, // Don't filter by default country
      region: goal.targetRegion // Only filter by explicit goal region
    },
    context.userId,
    context.accountId
  );
  
  // Apply historical insights to modify goal and context
  const { adjustedGoal, adjustedContext, decisions } = applyHistoricalInsights(
    goal,
    context,
    historical
  );
  
  // Generate plan with adjusted parameters
  const plan = planLeadGeneration(adjustedGoal, adjustedContext);
  
  // Log SUP-012 decisions for observability
  logHistoricalDecisions(goal, decisions, historical);
  
  return plan;
}

/**
 * Apply historical insights to adjust planning parameters.
 * Returns modified goal/context and a record of decisions made.
 */
function applyHistoricalInsights(
  goal: LeadGenGoal,
  context: LeadGenContext,
  historical: HistoricalContext
): {
  adjustedGoal: LeadGenGoal;
  adjustedContext: LeadGenContext;
  decisions: {
    preferredDataSource?: string;
    avoidedDataSource?: string;
    preferredNiche?: string;
    preferredRegion?: string;
    addedChannel?: string;
    removedChannel?: string;
  };
} {
  const decisions: any = {};
  let adjustedGoal = { ...goal };
  let adjustedContext = { ...context };
  
  // No historical data? Use defaults
  if (historical.topStrategies.length === 0) {
    return { adjustedGoal, adjustedContext, decisions };
  }
  
  // 1. Prefer successful niches
  const topNiches = historical.topStrategies
    .filter(s => s.key.niche)
    .slice(0, 3);
  
  if (topNiches.length > 0 && !goal.targetPersona) {
    adjustedGoal.targetPersona = topNiches[0].key.niche;
    decisions.preferredNiche = topNiches[0].key.niche;
  }
  
  // 2. Prefer successful regions
  const topRegions = historical.topStrategies
    .filter(s => s.key.region)
    .slice(0, 3);
  
  if (topRegions.length > 0 && !goal.targetRegion && !context.defaultRegion) {
    adjustedContext.defaultRegion = topRegions[0].key.region;
    decisions.preferredRegion = topRegions[0].key.region;
  }
  
  // 3. Prefer/avoid data sources based on performance
  const dataSourceStrategies = historical.topStrategies.filter(s => s.key.dataSource);
  const lowDataSources = historical.lowPerformers.filter(s => s.key.dataSource);
  
  if (dataSourceStrategies.length > 0) {
    decisions.preferredDataSource = dataSourceStrategies[0].key.dataSource;
  }
  
  if (lowDataSources.length > 0) {
    decisions.avoidedDataSource = lowDataSources[0].key.dataSource;
  }
  
  // Note: Data source selection happens in planLeadGeneration via fallback logic (SUP-011)
  // The decisions here inform logging but don't directly change the plan steps
  
  // 4. Adjust outreach channels based on performance
  const channelStrategies = historical.topStrategies.filter(s => s.key.outreachChannel);
  const lowChannels = historical.lowPerformers.filter(s => s.key.outreachChannel);
  
  // Type guard for valid channels
  type ValidChannel = "email" | "phone" | "linkedin";
  const isValidChannel = (ch: string): ch is ValidChannel => {
    return ch === "email" || ch === "phone" || ch === "linkedin";
  };
  
  if (channelStrategies.length > 0) {
    const topChannel = channelStrategies[0].key.outreachChannel!;
    if (isValidChannel(topChannel)) {
      if (!goal.preferredChannels) {
        adjustedGoal.preferredChannels = [topChannel];
        decisions.addedChannel = topChannel;
      } else if (!goal.preferredChannels.includes(topChannel)) {
        adjustedGoal.preferredChannels = [topChannel, ...goal.preferredChannels];
        decisions.addedChannel = topChannel;
      }
    }
  }
  
  if (lowChannels.length > 0) {
    const worstChannel = lowChannels[0].key.outreachChannel!;
    if (isValidChannel(worstChannel) && adjustedGoal.preferredChannels?.includes(worstChannel)) {
      adjustedGoal.preferredChannels = adjustedGoal.preferredChannels.filter(c => c !== worstChannel);
      decisions.removedChannel = worstChannel;
    }
  }
  
  return { adjustedGoal, adjustedContext, decisions };
}

/**
 * Log SUP-012 decisions for debugging and observability
 */
function logHistoricalDecisions(
  originalGoal: LeadGenGoal,
  decisions: any,
  historical: HistoricalContext
): void {
  const hasDecisions = Object.keys(decisions).length > 0;
  
  if (!hasDecisions && historical.topStrategies.length === 0) {
    console.log('[SUP-012] No historical data available - using default planning');
    return;
  }
  
  console.log('[SUP-012] Using historical performance to bias plan');
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'SUP012_PLANNING',
    goalDescription: originalGoal.rawGoal,
    topStrategiesCount: historical.topStrategies.length,
    lowPerformersCount: historical.lowPerformers.length,
    decisions: {
      preferredDataSource: decisions.preferredDataSource || null,
      avoidedDataSource: decisions.avoidedDataSource || null,
      preferredNiche: decisions.preferredNiche || null,
      preferredRegion: decisions.preferredRegion || null,
      addedChannel: decisions.addedChannel || null,
      removedChannel: decisions.removedChannel || null
    },
    topStrategies: historical.topStrategies.slice(0, 3).map(s => ({
      niche: s.key.niche,
      region: s.key.region,
      dataSource: s.key.dataSource,
      score: s.score.toFixed(2),
      samples: s.samples,
      successRate: s.successRate?.toFixed(2)
    }))
  }));
}

// ========================================
// EXAMPLE USAGE (for testing)
// ========================================

/**
 * Example usage showing how to create a lead generation plan.
 * This demonstrates the expected output for a typical goal.
 */
export function exampleLeadGenPlan(): LeadGenPlan {
  return planLeadGeneration(
    {
      rawGoal: "Find 50 pubs in the North West and email the landlords this week",
      targetRegion: "North West",
      targetPersona: "pub landlords",
      volume: 50,
      timing: "this_week",
      preferredChannels: ["email"],
      includeMonitoring: true
    },
    {
      userId: "test-user-123",
      accountId: "test-account",
      defaultRegion: "UK",
      defaultCountry: "GB",
      defaultFromIdentityId: "from-identity-1"
    }
  );
}

// ========================================
// SUP-002: EXECUTION TYPES & LOGIC
// ========================================

/**
 * User context for Supervisor execution
 */
export interface SupervisorUserContext {
  userId: string;
  accountId?: string;
  email?: string;
}

/**
 * Step execution status
 */
export type LeadGenStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

/**
 * Result of executing a single plan step
 */
export interface LeadGenStepResult {
  stepId: string;
  status: LeadGenStepStatus;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  errorMessage?: string;
  data?: unknown;
}

/**
 * Overall result of executing a complete plan
 */
export interface LeadGenExecutionResult {
  planId: string;
  overallStatus: "succeeded" | "partial" | "failed";
  startedAt: string;
  finishedAt: string;
  stepResults: LeadGenStepResult[];
}

/**
 * Environment passed to tool execution functions
 */
export interface LeadToolExecutionEnv {
  user: SupervisorUserContext;
  plan: LeadGenPlan;
  priorResults: Record<string, LeadGenStepResult>;
}

/**
 * SUP-011: Lead data source identifiers
 */
export type LeadDataSourceId = "google_places" | "internal_pubs" | "dataledger" | "fallback_mock";

/**
 * SUP-011: Metadata about lead search results including source and fallback info
 */
export interface LeadSearchResultMeta {
  source: LeadDataSourceId;
  leadsFound: number;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  fallbackUsed: boolean;
  fallbackChain?: Array<{
    source: LeadDataSourceId;
    success: boolean;
    errorMessage?: string;
    leadsFound?: number;
  }>;
}

/**
 * Result from executing a single tool
 */
export interface LeadToolExecutionResult {
  success: boolean;
  data?: unknown;
  errorMessage?: string;
  // SUP-011: Optional source metadata for search tools
  sourceMeta?: LeadSearchResultMeta;
}

/**
 * Structured event types for plan execution logging
 */
export type LeadPlanEventType =
  | "PLAN_STARTED"
  | "PLAN_COMPLETED"
  | "STEP_STARTED"
  | "STEP_SUCCEEDED"
  | "STEP_FAILED"
  | "STEP_SKIPPED"
  | "STEP_RETRYING";

/**
 * Payload for plan execution events
 */
export interface LeadPlanEventPayload {
  plan: LeadGenPlan;
  step?: LeadGenPlanStep;
  result?: LeadGenStepResult | LeadGenExecutionResult;
  user: SupervisorUserContext;
  meta?: Record<string, unknown>;
}

// ========================================
// BRANCH EVALUATION (SUP-010)
// ========================================

/**
 * Evaluate a branch condition against a step result and execution context
 */
function evaluateBranchCondition(
  condition: BranchCondition,
  stepResult: LeadGenStepResult,
  planContext: Record<string, unknown>
): boolean {
  switch (condition.type) {
    case "too_many_results": {
      const leadsFound = (stepResult.data as any)?.leadsFound ?? 0;
      return leadsFound > condition.threshold;
    }
    case "too_few_results": {
      const leadsFound = (stepResult.data as any)?.leadsFound ?? 0;
      return leadsFound < condition.threshold;
    }
    case "data_source_failed": {
      // SUP-011: Check if primary source failed (even if fallback succeeded)
      const sourceMeta = (stepResult.data as any)?.sourceMeta;
      if (sourceMeta?.fallbackChain) {
        const primaryAttempt = sourceMeta.fallbackChain[0];
        return primaryAttempt && !primaryAttempt.success && primaryAttempt.source === condition.source;
      }
      // Backwards compatibility: check legacy errorSource field
      const errorSource = (stepResult.data as any)?.errorSource;
      return stepResult.status === "failed" && errorSource === condition.source;
    }
    case "budget_exceeded": {
      const spentBudget = (planContext.spentBudget as number) ?? 0;
      return spentBudget > condition.maxBudget;
    }
    case "fallback": {
      // Fallback always matches as a catch-all
      return true;
    }
    default:
      return false;
  }
}

/**
 * Choose the next step to execute based on branches or sequential order (SUP-010)
 * 
 * @param currentStep The step that just completed
 * @param stepResult The result of the current step
 * @param plan The full plan being executed
 * @param currentStepIndex Index of the current step in plan.steps
 * @param planContext Additional context (e.g., budget tracking)
 * @returns The ID of the next step to execute, or null if plan is complete
 */
export function chooseNextStep(
  currentStep: LeadGenPlanStep,
  stepResult: LeadGenStepResult,
  plan: LeadGenPlan,
  currentStepIndex: number,
  planContext: Record<string, unknown> = {}
): { nextStepId: string | null; matchedBranch: PlanBranch | null } {
  // If step has branches, evaluate them in order
  if (currentStep.branches && currentStep.branches.length > 0) {
    for (const branch of currentStep.branches) {
      if (evaluateBranchCondition(branch.when, stepResult, planContext)) {
        // First matching branch wins
        return {
          nextStepId: branch.nextStepId,
          matchedBranch: branch
        };
      }
    }
  }

  // No branches or no matching branches - fall back to sequential execution
  // Note: We don't skip steps here. Reachability tracking will handle which steps execute.
  const nextIndex = currentStepIndex + 1;
  if (nextIndex < plan.steps.length) {
    return {
      nextStepId: plan.steps[nextIndex].id,
      matchedBranch: null
    };
  }

  // Plan is complete
  return {
    nextStepId: null,
    matchedBranch: null
  };
}

// ========================================
// STRUCTURED EVENT LOGGING
// ========================================

// Event handler type
type PlanEventHandler = (eventType: string, payload: any) => void;

// Registry of event handlers keyed by planId
const eventHandlers = new Map<string, PlanEventHandler>();

/**
 * Register an event handler for a specific plan execution
 * @param planId - Unique plan identifier
 * @param handler - Event handler function
 */
export function registerPlanEventHandler(planId: string, handler: PlanEventHandler): void {
  eventHandlers.set(planId, handler);
  console.log(`[LEAD_GEN_PLAN] Event handler registered for plan ${planId}`);
}

/**
 * Unregister an event handler for a plan
 * @param planId - Unique plan identifier
 */
export function unregisterPlanEventHandler(planId: string): void {
  eventHandlers.delete(planId);
  console.log(`[LEAD_GEN_PLAN] Event handler unregistered for plan ${planId}`);
}

/**
 * @deprecated Use registerPlanEventHandler instead
 * Legacy single-handler registration (for backward compatibility with tests)
 */
export function onPlanEvent(handler: PlanEventHandler | null): void {
  console.warn('[LEAD_GEN_PLAN] onPlanEvent is deprecated, use registerPlanEventHandler');
  if (handler) {
    // Register with a special key for legacy support
    eventHandlers.set('__legacy__', handler);
  } else {
    eventHandlers.delete('__legacy__');
  }
}

/**
 * Emit a structured plan execution event for logging/monitoring
 */
export function emitPlanEvent(
  type: LeadPlanEventType,
  payload: LeadPlanEventPayload
): void {
  const timestamp = new Date().toISOString();
  const planId = payload.plan.id;
  
  const logEntry = {
    timestamp,
    type,
    planId,
    userId: payload.user.userId,
    stepId: payload.step?.id,
    stepTool: payload.step?.tool,
    status: 'result' in payload && payload.result && 'status' in payload.result 
      ? payload.result.status 
      : undefined,
    meta: payload.meta
  };

  // Structured logging - can be extended to persist to DB or event bus
  console.log(`[LEAD_GEN_PLAN] ${JSON.stringify(logEntry)}`);

  // Call registered event handler for this specific plan
  const handler = eventHandlers.get(planId);
  if (handler) {
    const simplifiedPayload = {
      stepId: payload.step?.id,
      attempts: 'result' in payload && payload.result && 'attempts' in payload.result 
        ? payload.result.attempts 
        : undefined,
      error: 'result' in payload && payload.result && 'errorMessage' in payload.result 
        ? payload.result.errorMessage 
        : undefined
    };
    handler(type, simplifiedPayload);
  }

  // Also call legacy handler if registered
  const legacyHandler = eventHandlers.get('__legacy__');
  if (legacyHandler && planId !== '__legacy__') {
    const simplifiedPayload = {
      stepId: payload.step?.id,
      attempts: 'result' in payload && payload.result && 'attempts' in payload.result 
        ? payload.result.attempts 
        : undefined,
      error: 'result' in payload && payload.result && 'errorMessage' in payload.result 
        ? payload.result.errorMessage 
        : undefined
    };
    legacyHandler(type, simplifiedPayload);
  }
}

// ========================================
// TOOL EXECUTION LAYER
// ========================================

/**
 * Route and execute a single lead generation tool
 * 
 * This is the single point of integration with actual tool implementations.
 * Adding a new tool only requires adding a case here.
 */
export async function runLeadTool(
  tool: LeadToolIdentifier,
  params: LeadToolParams,
  env: LeadToolExecutionEnv
): Promise<LeadToolExecutionResult> {
  try {
    switch (tool) {
      case "GOOGLE_PLACES_SEARCH":
        return await executeGooglePlacesSearch(params, env);
      
      case "HUNTER_DOMAIN_LOOKUP":
        return await executeHunterDomainLookup(params, env);
      
      case "HUNTER_ENRICH":
        return await executeHunterEnrich(params, env);
      
      case "LEAD_LIST_SAVE":
        return await executeLeadListSave(params, env);
      
      case "EMAIL_SEQUENCE_SETUP":
        return await executeEmailSequenceSetup(params, env);
      
      case "MONITOR_SETUP":
        return await executeMonitorSetup(params, env);
      
      default:
        return {
          success: false,
          errorMessage: `Unknown tool: ${tool}`
        };
    }
  } catch (error) {
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}

// ========================================
// TOOL IMPLEMENTATIONS
// ========================================

/**
 * Execute Google Places search with SUP-011 fallback support
 */
async function executeGooglePlacesSearch(
  params: LeadToolParams,
  env: LeadToolExecutionEnv
): Promise<LeadToolExecutionResult> {
  const { query, region, country, maxResults = 20 } = params as unknown as GooglePlacesSearchParams;
  
  console.log(`🔍 GOOGLE_PLACES_SEARCH: "${query}" in ${region}, ${country} (max: ${maxResults})`);
  
  // SUP-011: Use fallback search with automatic source switching
  const { searchLeadsWithFallback } = await import("../lead-search-with-fallback");
  
  const result = await searchLeadsWithFallback(
    {
      primary: "google_places",
      fallbacks: ["fallback_mock"]  // Use mock fallback for testing
    },
    {
      query,
      region,
      country,
      maxResults
    }
  );
  
  // Map to our business format
  const businesses = result.leads.map(lead => ({
    place_id: lead.place_id,
    name: lead.name,
    address: lead.address,
    website: lead.website,
    phone: lead.phone
  }));
  
  return {
    success: result.meta.success,
    data: {
      businesses,
      count: businesses.length,
      leadsFound: businesses.length  // SUP-010: For branch condition evaluation
    },
    errorMessage: result.meta.errorMessage,
    // SUP-011: Include source metadata
    sourceMeta: result.meta
  };
}

/**
 * Execute Hunter domain lookup
 */
async function executeHunterDomainLookup(
  params: LeadToolParams,
  env: LeadToolExecutionEnv
): Promise<LeadToolExecutionResult> {
  const { sourceStepId, country } = params as unknown as HunterDomainLookupParams;
  
  console.log(`🌐 HUNTER_DOMAIN_LOOKUP: Looking up domains from step ${sourceStepId}`);
  
  // Get data from previous step
  const sourceResult = sourceStepId ? env.priorResults[sourceStepId] : undefined;
  if (!sourceResult || sourceResult.status !== "succeeded") {
    return {
      success: false,
      errorMessage: `Source step ${sourceStepId} not found or failed`
    };
  }
  
  const sourceData = sourceResult.data as { businesses?: Array<{ website?: string; name?: string }> };
  const businesses = sourceData?.businesses || [];
  
  // Extract domains
  const domains = businesses
    .filter(b => b.website)
    .map(b => {
      try {
        const url = new URL(b.website!);
        return {
          business: b.name,
          domain: url.hostname.replace('www.', '')
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  
  return {
    success: true,
    data: { domains, count: domains.length }
  };
}

/**
 * Execute Hunter email enrichment
 */
async function executeHunterEnrich(
  params: LeadToolParams,
  env: LeadToolExecutionEnv
): Promise<LeadToolExecutionResult> {
  const { sourceStepId, roleHint, maxContactsPerDomain = 2 } = params as unknown as HunterEnrichParams;
  
  console.log(`📧 HUNTER_ENRICH: Finding contacts (role: ${roleHint}) from step ${sourceStepId}`);
  
  // Get data from previous step
  const sourceResult = sourceStepId ? env.priorResults[sourceStepId] : undefined;
  if (!sourceResult || sourceResult.status !== "succeeded") {
    return {
      success: false,
      errorMessage: `Source step ${sourceStepId} not found or failed`
    };
  }
  
  const sourceData = sourceResult.data as { domains?: Array<{ domain?: string; business?: string }> };
  const domains = sourceData?.domains || [];
  
  // TODO: Integrate with existing findEmails method from Supervisor
  // For now, generate stub email candidates
  const enrichedLeads = domains.map(d => ({
    business: d.business,
    domain: d.domain,
    emailCandidates: [
      `contact@${d.domain}`,
      `info@${d.domain}`
    ].slice(0, maxContactsPerDomain)
  }));
  
  return {
    success: true,
    data: { enrichedLeads, count: enrichedLeads.length }
  };
}

/**
 * Save leads to a list
 */
async function executeLeadListSave(
  params: LeadToolParams,
  env: LeadToolExecutionEnv
): Promise<LeadToolExecutionResult> {
  const { sourceStepId, listName, region, persona, estimatedVolume } = params as unknown as LeadListSaveParams;
  
  console.log(`💾 LEAD_LIST_SAVE: Saving leads from step ${sourceStepId} to list "${listName}"`);
  
  // Get data from previous step
  const sourceResult = sourceStepId ? env.priorResults[sourceStepId] : undefined;
  if (!sourceResult || sourceResult.status !== "succeeded") {
    return {
      success: false,
      errorMessage: `Source step ${sourceStepId} not found or failed`
    };
  }
  
  const sourceData = sourceResult.data as { enrichedLeads?: Array<any> };
  const leads = sourceData?.enrichedLeads || [];
  
  // TODO: Integrate with existing storage.createSuggestedLead
  // For now, simulate saving
  const savedCount = leads.length;
  
  return {
    success: true,
    data: {
      listName,
      savedCount,
      listId: `list_${Date.now()}`
    }
  };
}

/**
 * Set up email outreach sequence
 */
async function executeEmailSequenceSetup(
  params: LeadToolParams,
  env: LeadToolExecutionEnv
): Promise<LeadToolExecutionResult> {
  const { sourceListStepId, campaignName, fromIdentityId, estimatedVolume, startTiming } = params as unknown as EmailSequenceSetupParams;
  
  console.log(`📬 EMAIL_SEQUENCE_SETUP: Creating campaign "${campaignName}"`);
  
  // Get data from previous step
  const sourceResult = sourceListStepId ? env.priorResults[sourceListStepId] : undefined;
  if (!sourceResult || sourceResult.status !== "succeeded") {
    return {
      success: false,
      errorMessage: `Source step ${sourceListStepId} not found or failed`
    };
  }
  
  // TODO: Integrate with email sequence/outreach system
  // For now, simulate sequence setup
  return {
    success: true,
    data: {
      campaignId: `campaign_${Date.now()}`,
      campaignName,
      status: "scheduled",
      startTiming
    }
  };
}

/**
 * Set up ongoing monitoring for a lead list
 */
async function executeMonitorSetup(
  params: LeadToolParams,
  env: LeadToolExecutionEnv
): Promise<LeadToolExecutionResult> {
  const { sourceListStepId, cadence, signalTypes } = params as unknown as MonitorSetupParams;
  
  console.log(`🔔 MONITOR_SETUP: Setting up ${cadence} monitoring for list from step ${sourceListStepId}`);
  
  // Get data from previous step
  const sourceResult = sourceListStepId ? env.priorResults[sourceListStepId] : undefined;
  if (!sourceResult || sourceResult.status !== "succeeded") {
    return {
      success: false,
      errorMessage: `Source step ${sourceListStepId} not found or failed`
    };
  }
  
  // TODO: Integrate with monitoring/cron system
  // For now, simulate monitor setup
  return {
    success: true,
    data: {
      monitorId: `monitor_${Date.now()}`,
      cadence,
      signalTypes: signalTypes || [],
      status: "active"
    }
  };
}

// ========================================
// PLAN EXECUTION
// ========================================

/**
 * Sleep helper for retry backoff
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a single step with retry logic and exponential backoff
 */
async function executeStepWithRetries(
  step: LeadGenPlanStep,
  plan: LeadGenPlan,
  user: SupervisorUserContext,
  stepResults: Record<string, LeadGenStepResult>,
  maxRetries: number,
  baseDelayMs: number
): Promise<LeadGenStepResult> {
  const result: LeadGenStepResult = {
    stepId: step.id,
    status: "pending",
    attempts: 0
  };

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    result.attempts = attempt;
    
    if (attempt === 1) {
      result.status = "running";
      result.startedAt = new Date().toISOString();
      emitPlanEvent("STEP_STARTED", { plan, step, result, user });
    } else {
      // This is a retry
      result.status = "running";
      emitPlanEvent("STEP_RETRYING", {
        plan,
        step,
        result,
        user,
        meta: {
          attempt,
          maxRetries,
          totalAttempts: maxRetries + 1,
          previousError: result.errorMessage
        }
      });
    }

    try {
      const toolResult = await runLeadTool(
        step.tool,
        step.params,
        { user, plan, priorResults: stepResults }
      );

      if (toolResult.success) {
        result.status = "succeeded";
        result.finishedAt = new Date().toISOString();
        // SUP-011: Include source metadata in step result data for observability and branching
        result.data = {
          ...toolResult.data as object,
          sourceMeta: toolResult.sourceMeta
        };
        emitPlanEvent("STEP_SUCCEEDED", { plan, step, result, user });
        return result;
      } else {
        result.errorMessage = toolResult.errorMessage;
        
        if (attempt <= maxRetries) {
          const delayMs = baseDelayMs * attempt;
          await sleep(delayMs);
          continue;
        } else {
          result.status = "failed";
          result.finishedAt = new Date().toISOString();
          emitPlanEvent("STEP_FAILED", { plan, step, result, user });
          return result;
        }
      }
    } catch (error) {
      result.errorMessage = error instanceof Error ? error.message : String(error);
      
      if (attempt <= maxRetries) {
        const delayMs = baseDelayMs * attempt;
        await sleep(delayMs);
        continue;
      } else {
        result.status = "failed";
        result.finishedAt = new Date().toISOString();
        emitPlanEvent("STEP_FAILED", { plan, step, result, user });
        return result;
      }
    }
  }

  return result;
}

/**
 * Execute a complete lead generation plan
 * 
 * Executes steps in dependency order, handles retries, and returns comprehensive results.
 */
export async function executeLeadGenerationPlan(
  plan: LeadGenPlan,
  user: SupervisorUserContext
): Promise<LeadGenExecutionResult> {
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const stepResults: Record<string, LeadGenStepResult> = {};
  let overallStatus: LeadGenExecutionResult["overallStatus"] = "succeeded";
  const planContext: Record<string, unknown> = { spentBudget: 0 };
  const executionPath: string[] = []; // Track which steps were executed

  console.log(`\n${'='.repeat(70)}`);
  console.log(`[PLAN_EXEC] STARTING EXECUTION`);
  console.log(`  planId: ${plan.id}`);
  console.log(`  userId: ${user.userId}`);
  console.log(`  accountId: ${user.accountId || 'N/A'}`);
  console.log(`  goal: ${plan.title}`);
  console.log(`  totalSteps: ${plan.steps.length}`);
  console.log(`  startedAt: ${startedAt}`);
  console.log(`${'='.repeat(70)}\n`);

  // Log to Tower (Control Tower)
  const { logPlanStart } = await import('../tower-logger');
  logPlanStart(plan.id, user.userId, user.accountId, plan.title);

  emitPlanEvent("PLAN_STARTED", { plan, user });

  // Build step lookup map for branch-based navigation
  const stepMap = new Map<string, { step: LeadGenPlanStep; index: number }>();
  plan.steps.forEach((step, index) => {
    stepMap.set(step.id, { step, index });
  });

  // Identify steps that are branch-only targets (SUP-010)
  // These steps can ONLY be reached via branches, not sequential progression
  const branchOnlySteps = new Set<string>();
  for (const step of plan.steps) {
    if (step.branches) {
      for (const branch of step.branches) {
        branchOnlySteps.add(branch.nextStepId);
      }
    }
  }

  // Track which steps are reachable (SUP-010: for conditional execution)
  const reachableSteps = new Set<string>();
  reachableSteps.add(plan.steps[0]?.id); // First step is always reachable

  // Start with first step
  let currentStepId: string | null = plan.steps[0]?.id ?? null;

  while (currentStepId !== null) {
    const stepInfo = stepMap.get(currentStepId);
    if (!stepInfo) {
      console.error(`[EXECUTOR] Referenced step "${currentStepId}" not found in plan`);
      overallStatus = "failed";
      break;
    }

    const { step, index: currentIndex } = stepInfo;
    executionPath.push(step.id);

    const deps = step.dependsOn ?? [];
    
    // Check for failed dependencies
    const failedDeps = deps.filter(
      (depId) => stepResults[depId]?.status === "failed"
    );
    
    // Check for missing dependencies (not in plan or never executed)
    const missingDeps = deps.filter(
      (depId) => !stepResults[depId]
    );
    
    // Check for skipped dependencies
    const skippedDeps = deps.filter(
      (depId) => stepResults[depId]?.status === "skipped"
    );
    
    const unmetDeps = [...failedDeps, ...missingDeps, ...skippedDeps];
    const shouldSkip = unmetDeps.length > 0;

    if (shouldSkip) {
      // Skip this step because dependencies are unmet
      const reasons: string[] = [];
      if (failedDeps.length > 0) reasons.push(`${failedDeps.length} failed: ${failedDeps.join(', ')}`);
      if (missingDeps.length > 0) reasons.push(`${missingDeps.length} missing: ${missingDeps.join(', ')}`);
      if (skippedDeps.length > 0) reasons.push(`${skippedDeps.length} skipped: ${skippedDeps.join(', ')}`);
      
      const skipped: LeadGenStepResult = {
        stepId: step.id,
        status: "skipped",
        attempts: 0,
        errorMessage: `Skipped because dependencies unmet (${reasons.join('; ')})`
      };
      stepResults[step.id] = skipped;
      emitPlanEvent("STEP_SKIPPED", {
        plan,
        step,
        result: skipped,
        user,
        meta: {
          failedDependencies: failedDeps,
          missingDependencies: missingDeps,
          skippedDependencies: skippedDeps,
          dependencyResults: failedDeps.map(depId => stepResults[depId])
        }
      });
      
      // Only set to failed if there were actual failures (not just missing/skipped deps)
      if (failedDeps.length > 0) {
        overallStatus = "failed";
      } else if (overallStatus === "succeeded") {
        overallStatus = "partial";
      }
      
      // Move to next step (sequential fallback for skipped steps)
      const nextIndex = currentIndex + 1;
      currentStepId = nextIndex < plan.steps.length ? plan.steps[nextIndex].id : null;
      continue;
    }

    // Execute the step with retries
    const stepNumber = currentIndex + 1;
    console.log(`[PLAN_EXEC] Step ${stepNumber}/${plan.steps.length}: ${step.label || step.tool} (${step.id}) → status=running`);
    
    const result = await executeStepWithRetries(
      step,
      plan,
      user,
      stepResults,
      2,  // maxRetries
      1000  // baseDelayMs
    );

    stepResults[step.id] = result;

    const statusEmoji = result.status === "succeeded" ? "✓" : result.status === "failed" ? "✗" : "○";
    console.log(`[PLAN_EXEC] Step ${stepNumber}/${plan.steps.length}: ${step.label || step.tool} → ${statusEmoji} status=${result.status}${result.errorMessage ? ` (${result.errorMessage})` : ''}`);

    if (result.status === "failed") {
      overallStatus = "failed";
    }

    // Determine next step using branching logic (SUP-010)
    const { nextStepId, matchedBranch } = chooseNextStep(
      step,
      result,
      plan,
      currentIndex,
      planContext
    );

    // Log which branch was taken (if any)
    if (matchedBranch) {
      console.log(`[EXECUTOR] Branch taken: ${step.id} → ${nextStepId} (condition: ${matchedBranch.when.type})`);
    }

    // Mark the chosen next step as reachable
    if (nextStepId) {
      reachableSteps.add(nextStepId);
    }

    currentStepId = nextStepId;
  }

  // Skip any steps that were never made reachable (untaken branch targets)
  for (const step of plan.steps) {
    if (!reachableSteps.has(step.id) && !stepResults[step.id]) {
      const skipped: LeadGenStepResult = {
        stepId: step.id,
        status: "skipped",
        attempts: 0,
        errorMessage: "Skipped because not reachable via execution path (untaken branch target)"
      };
      stepResults[step.id] = skipped;
      emitPlanEvent("STEP_SKIPPED", {
        plan,
        step,
        result: skipped,
        user,
        meta: {
          reason: "unreachable_branch_target"
        }
      });
    }
  }

  // Check if any steps were skipped while overall is still "succeeded"
  const hasSkipped = Object.values(stepResults).some(r => r.status === "skipped");
  if (hasSkipped && overallStatus === "succeeded") {
    overallStatus = "partial";
  }

  const finishedAtDate = new Date();
  const finishedAt = finishedAtDate.toISOString();

  const finalResult: LeadGenExecutionResult = {
    planId: plan.id,
    overallStatus,
    startedAt,
    finishedAt,
    stepResults: Object.values(stepResults)
  };

  const succeeded = Object.values(stepResults).filter(r => r.status === "succeeded").length;
  const failed = Object.values(stepResults).filter(r => r.status === "failed").length;
  const skipped = Object.values(stepResults).filter(r => r.status === "skipped").length;
  const durationSeconds = (finishedAtDate.getTime() - startedAtDate.getTime()) / 1000;
  const duration = durationSeconds.toFixed(1);

  const statusEmoji = overallStatus === "succeeded" ? "✓✓✓" : overallStatus === "failed" ? "✗✗✗" : "○○○";
  console.log(`\n${'='.repeat(70)}`);
  console.log(`[PLAN_EXEC] ${statusEmoji} ${overallStatus.toUpperCase()}`);
  console.log(`  planId: ${plan.id}`);
  console.log(`  duration: ${duration}s`);
  console.log(`  steps: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped`);
  console.log(`  executionPath: [${executionPath.slice(0, 3).join(', ')}${executionPath.length > 3 ? `, ... (${executionPath.length} total)` : ''}]`);
  console.log(`${'='.repeat(70)}\n`);

  // Log to Tower (Control Tower)
  const { logPlanComplete } = await import('../tower-logger');
  logPlanComplete(
    plan.id,
    user.userId,
    user.accountId,
    plan.title,
    overallStatus === "succeeded" ? "success" : overallStatus === "failed" ? "failed" : "partial",
    {
      total: plan.steps.length,
      succeeded,
      failed,
      skipped
    },
    durationSeconds,
    failed > 0 ? `${failed} step(s) failed` : undefined
  );

  emitPlanEvent("PLAN_COMPLETED", {
    plan,
    user,
    result: finalResult
  });

  // Persist execution results to database for monitoring (SUP-003)
  try {
    await storage.createPlanExecution({
      planId: plan.id,
      userId: user.userId,
      accountId: user.accountId || undefined, // SUP-012: Account isolation
      goalId: undefined, // No goalId at plan level - could be added in future
      goalText: plan.rawGoal || plan.title,
      overallStatus,
      startedAt: startedAtDate,
      finishedAt: finishedAtDate,
      stepResults: Object.values(stepResults),
      metadata: {
        totalSteps: plan.steps.length,
        succeededSteps: Object.values(stepResults).filter(r => r.status === "succeeded").length,
        failedSteps: Object.values(stepResults).filter(r => r.status === "failed").length,
        skippedSteps: Object.values(stepResults).filter(r => r.status === "skipped").length,
        executionPath, // SUP-010: Track which path through the plan was taken
        source: 'executor'
      }
    });
  } catch (error) {
    console.error('[EXECUTOR] Failed to persist execution results:', error);
    // Don't fail the execution if persistence fails
  }

  return finalResult;
}
