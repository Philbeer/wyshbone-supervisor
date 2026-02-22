import { storage } from '../storage';
import { createArtefact } from './artefacts';
import type { PolicyVersion, PolicyApplication } from '../schema';

export interface PolicyInput {
  request: string;
  vertical: string;
  location: string;
  constraintBucket: string[];
  userValue?: number;
  budget?: number;
}

export interface PolicyConstraints {
  radiusKm: number;
  enrichmentBatchSize: number;
  stopThresholdZero: boolean;
  stopThresholdMin: number;
  maxPlanVersions: number;
  searchBudgetCount: number;
}

export interface PolicyApplicationResult {
  scopeKey: string;
  policyVersionId: string | null;
  policyVersion: number;
  constraints: PolicyConstraints;
  applied: boolean;
  rationale: string;
}

const DEFAULT_POLICY: PolicyConstraints = {
  radiusKm: 0,
  enrichmentBatchSize: 5,
  stopThresholdZero: false,
  stopThresholdMin: 1,
  maxPlanVersions: 2,
  searchBudgetCount: 30,
};

export function deriveScopeKey(vertical: string, location: string, constraintBucket: string[]): string {
  const normVertical = vertical.toLowerCase().trim();
  const normLocation = location.toLowerCase().trim().replace(/\s+/g, '_');
  const sortedBucket = [...constraintBucket].sort().map(c => c.toLowerCase().trim()).join('|');
  return `${normVertical}::${normLocation}::${sortedBucket}`;
}

export function mergePolicy(base: PolicyConstraints, stored: Record<string, unknown>): PolicyConstraints {
  const merged = { ...base };
  if (typeof stored.radiusKm === 'number') merged.radiusKm = stored.radiusKm;
  if (typeof stored.enrichmentBatchSize === 'number') merged.enrichmentBatchSize = stored.enrichmentBatchSize;
  if (typeof stored.stopThresholdZero === 'boolean') merged.stopThresholdZero = stored.stopThresholdZero;
  if (typeof stored.stopThresholdMin === 'number') merged.stopThresholdMin = stored.stopThresholdMin;
  if (typeof stored.maxPlanVersions === 'number') merged.maxPlanVersions = stored.maxPlanVersions;
  if (typeof stored.searchBudgetCount === 'number') merged.searchBudgetCount = stored.searchBudgetCount;
  return merged;
}

export async function applyPolicy(input: PolicyInput): Promise<PolicyApplicationResult> {
  const scopeKey = deriveScopeKey(input.vertical, input.location, input.constraintBucket);

  console.log(`[LEARNING_LAYER] applyPolicy scope_key=${scopeKey}`);

  const latestPolicy = await storage.getLatestPolicyVersion(scopeKey);

  if (!latestPolicy) {
    console.log(`[LEARNING_LAYER] No stored policy for scope=${scopeKey}, using defaults`);
    return {
      scopeKey,
      policyVersionId: null,
      policyVersion: 0,
      constraints: { ...DEFAULT_POLICY },
      applied: false,
      rationale: 'No prior policy; defaults used',
    };
  }

  const storedData = latestPolicy.policyData as Record<string, unknown>;
  const merged = mergePolicy(DEFAULT_POLICY, storedData);

  if (input.budget !== undefined && input.budget > 0) {
    merged.enrichmentBatchSize = Math.min(merged.enrichmentBatchSize, Math.ceil(input.budget / 10));
  }

  if (input.userValue !== undefined && input.userValue > 0) {
    merged.searchBudgetCount = Math.max(merged.searchBudgetCount, Math.min(input.userValue * 3, 60));
  }

  console.log(`[LEARNING_LAYER] Applied policy v${latestPolicy.version} for scope=${scopeKey}: ${JSON.stringify(merged)}`);

  return {
    scopeKey,
    policyVersionId: latestPolicy.id,
    policyVersion: latestPolicy.version,
    constraints: merged,
    applied: true,
    rationale: `Policy v${latestPolicy.version} applied from scope=${scopeKey}`,
  };
}

export async function persistPolicyApplication(
  runId: string,
  input: PolicyInput,
  result: PolicyApplicationResult,
): Promise<PolicyApplication> {
  return storage.createPolicyApplication({
    runId,
    scopeKey: result.scopeKey,
    policyVersionId: result.policyVersionId,
    appliedPolicies: {
      policyVersion: result.policyVersion,
      constraints: result.constraints,
      applied: result.applied,
      rationale: result.rationale,
    },
    inputSnapshot: {
      request: input.request,
      vertical: input.vertical,
      location: input.location,
      constraintBucket: input.constraintBucket,
      userValue: input.userValue ?? null,
      budget: input.budget ?? null,
    },
    outputConstraints: result.constraints as unknown as Record<string, unknown>,
  });
}

export interface DecisionLogEntry {
  runId: string;
  userId: string;
  conversationId?: string;
  scopeKey: string;
  policyVersion: number;
  policyApplied: boolean;
  chosenRadiusKm: number;
  chosenEnrichmentBatch: number;
  chosenSearchBudget: number;
  stopThresholds: { zero: boolean; min: number };
  maxPlanVersions: number;
  inputVertical: string;
  inputLocation: string;
  constraintBucket: string[];
  rationale: string;
}

export async function writeDecisionLog(entry: DecisionLogEntry): Promise<void> {
  await createArtefact({
    runId: entry.runId,
    type: 'decision_log',
    title: `Decision Log: policy_v${entry.policyVersion} scope=${entry.scopeKey}`,
    summary: `policy_applied=${entry.policyApplied} radius=${entry.chosenRadiusKm}km enrichment_batch=${entry.chosenEnrichmentBatch} search_budget=${entry.chosenSearchBudget}`,
    payload: {
      scope_key: entry.scopeKey,
      policy_version: entry.policyVersion,
      policy_applied: entry.policyApplied,
      chosen_radius_km: entry.chosenRadiusKm,
      chosen_enrichment_batch: entry.chosenEnrichmentBatch,
      chosen_search_budget: entry.chosenSearchBudget,
      stop_thresholds: entry.stopThresholds,
      max_plan_versions: entry.maxPlanVersions,
      input_vertical: entry.inputVertical,
      input_location: entry.inputLocation,
      constraint_bucket: entry.constraintBucket,
      rationale: entry.rationale,
    },
    userId: entry.userId,
    conversationId: entry.conversationId,
  });
  console.log(`[LEARNING_LAYER] decision_log written for run=${entry.runId}`);
}

export interface OutcomeLogEntry {
  runId: string;
  userId: string;
  conversationId?: string;
  deliveredCount: number;
  requestedCount: number;
  verifiedExact: number;
  verifiedClosest: number;
  stopReason: string | null;
  toolCalls: number;
  costEstimate: number;
  durationMs: number;
  planVersionsUsed: number;
  scopeKey: string;
}

export async function writeOutcomeLog(entry: OutcomeLogEntry): Promise<void> {
  await createArtefact({
    runId: entry.runId,
    type: 'outcome_log',
    title: `Outcome Log: delivered=${entry.deliveredCount}/${entry.requestedCount}`,
    summary: `delivered=${entry.deliveredCount} requested=${entry.requestedCount} verified_exact=${entry.verifiedExact} stop_reason=${entry.stopReason || 'none'} tool_calls=${entry.toolCalls} cost=${entry.costEstimate.toFixed(2)} duration=${entry.durationMs}ms`,
    payload: {
      delivered_count: entry.deliveredCount,
      requested_count: entry.requestedCount,
      verified_exact: entry.verifiedExact,
      verified_closest: entry.verifiedClosest,
      stop_reason: entry.stopReason,
      tool_calls: entry.toolCalls,
      cost_estimate: entry.costEstimate,
      duration_ms: entry.durationMs,
      plan_versions_used: entry.planVersionsUsed,
      scope_key: entry.scopeKey,
    },
    userId: entry.userId,
    conversationId: entry.conversationId,
  });
  console.log(`[LEARNING_LAYER] outcome_log written for run=${entry.runId}`);
}

export async function writeOutcomePolicyVersion(
  scopeKey: string,
  currentVersion: number,
  outcomeConstraints: PolicyConstraints,
  outcomeMetrics: { deliveredCount: number; requestedCount: number; stopReason: string | null },
): Promise<PolicyVersion> {
  const adjustedPolicy = { ...outcomeConstraints };

  const fillRate = outcomeMetrics.requestedCount > 0
    ? outcomeMetrics.deliveredCount / outcomeMetrics.requestedCount
    : 0;

  if (fillRate < 0.5 && adjustedPolicy.radiusKm < 100) {
    adjustedPolicy.radiusKm = Math.min(adjustedPolicy.radiusKm + 10, 100);
  }
  if (fillRate < 0.3) {
    adjustedPolicy.searchBudgetCount = Math.min(adjustedPolicy.searchBudgetCount + 10, 60);
  }
  if (outcomeMetrics.stopReason?.includes('zero') || outcomeMetrics.deliveredCount === 0) {
    adjustedPolicy.stopThresholdZero = true;
  }

  const newVersion = currentVersion + 1;
  const pv = await storage.createPolicyVersion({
    scopeKey,
    version: newVersion,
    policyData: adjustedPolicy as unknown as Record<string, unknown>,
    source: 'outcome_feedback',
  });

  console.log(`[LEARNING_LAYER] Policy v${newVersion} written for scope=${scopeKey} fillRate=${(fillRate * 100).toFixed(0)}%`);
  return pv;
}
