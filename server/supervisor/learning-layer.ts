import { storage } from '../storage';
import { createArtefact } from './artefacts';
import type { PolicyVersion, PolicyApplication } from '../schema';

export interface RadiusPolicyV1 {
  enabled: boolean;
  default_steps_km: number[];
  max_cap_km: number;
  high_value_extra_step_km: number;
  min_new_eligible_to_continue: number;
  stop_if_last_n_runs_beyond_cap_added_less_than: number;
  last_n_runs_window: number;
}

export interface EnrichmentPolicyV1 {
  enabled: boolean;
  mode: string;
  max_enrich_calls_per_lead: number;
  max_total_enrich_calls: number;
  enrichment_batch_size: number;
  prefer_domains: string[];
  avoid_domains: string[];
  domain_reliability_seed: Record<string, unknown>;
}

export interface StopPolicyV1 {
  enabled: boolean;
  max_replans: number;
  search_budget_count: number;
  search_count: number;
  stop_when_verified_exact_is_zero_after_enrichment: boolean;
  stop_when_cost_exceeds_budget: boolean;
  known_unverifiable_hard_constraints: string[];
  require_user_override_to_attempt_unverifiable_hard: boolean;
}

export interface PolicyBundleV1 {
  policy_bundle_version: 1;
  policies: {
    radius_policy_v1: RadiusPolicyV1;
    enrichment_policy_v1: EnrichmentPolicyV1;
    stop_policy_v1: StopPolicyV1;
  };
}

export interface RunOverrides {
  mode_preset?: 'faster' | 'balanced' | 'stricter';
  override_max_replans?: number;
  ignore_learned_policy?: boolean;
}

export interface PolicyApplicationSnapshot {
  scope_key: string;
  applied_at: string;
  applied_versions: {
    radius_policy_v1: number;
    enrichment_policy_v1: number;
    stop_policy_v1: number;
  };
  applied_policies: {
    radius_policy_v1: Pick<RadiusPolicyV1, 'default_steps_km' | 'max_cap_km'>;
    enrichment_policy_v1: Pick<EnrichmentPolicyV1, 'mode' | 'max_total_enrich_calls' | 'enrichment_batch_size'>;
    stop_policy_v1: Pick<StopPolicyV1, 'max_replans' | 'search_budget_count' | 'search_count' | 'stop_when_verified_exact_is_zero_after_enrichment' | 'require_user_override_to_attempt_unverifiable_hard'>;
  };
  why_short: string[];
  run_overrides?: RunOverrides;
}

export const GLOBAL_DEFAULT_BUNDLE: PolicyBundleV1 = {
  policy_bundle_version: 1,
  policies: {
    radius_policy_v1: {
      enabled: true,
      default_steps_km: [2, 5, 10],
      max_cap_km: 10,
      high_value_extra_step_km: 20,
      min_new_eligible_to_continue: 2,
      stop_if_last_n_runs_beyond_cap_added_less_than: 2,
      last_n_runs_window: 5,
    },
    enrichment_policy_v1: {
      enabled: true,
      mode: 'places_first_then_web',
      max_enrich_calls_per_lead: 1,
      max_total_enrich_calls: 25,
      enrichment_batch_size: 10,
      prefer_domains: [],
      avoid_domains: [],
      domain_reliability_seed: {},
    },
    stop_policy_v1: {
      enabled: true,
      max_replans: 2,
      search_budget_count: 30,
      search_count: 30,
      stop_when_verified_exact_is_zero_after_enrichment: true,
      stop_when_cost_exceeds_budget: true,
      known_unverifiable_hard_constraints: [
        'c_attr_live_music',
        'c_attr_opened_recently',
      ],
      require_user_override_to_attempt_unverifiable_hard: true,
    },
  },
};

export const GLOBAL_DEFAULT_SCOPE_KEY = 'GLOBAL_DEFAULT';

export interface ExecutionParams {
  searchBudgetCount: number;
  searchCount: number;
  maxReplans: number;
  enrichmentBatchSize: number;
  radiusStepsKm: number[];
  radiusMaxCapKm: number;
  stopWhenVerifiedZero: boolean;
  stopWhenCostExceedsBudget: boolean;
  knownUnverifiableHardConstraints: string[];
  requireUserOverrideForUnverifiable: boolean;
  maxEnrichCallsPerLead: number;
  maxTotalEnrichCalls: number;
}

export function deriveExecutionParams(bundle: PolicyBundleV1): ExecutionParams {
  const r = bundle.policies.radius_policy_v1;
  const e = bundle.policies.enrichment_policy_v1;
  const s = bundle.policies.stop_policy_v1;
  return {
    searchBudgetCount: s.search_budget_count,
    searchCount: s.search_count,
    maxReplans: s.max_replans,
    enrichmentBatchSize: e.enrichment_batch_size,
    radiusStepsKm: [...r.default_steps_km],
    radiusMaxCapKm: r.max_cap_km,
    stopWhenVerifiedZero: s.stop_when_verified_exact_is_zero_after_enrichment,
    stopWhenCostExceedsBudget: s.stop_when_cost_exceeds_budget,
    knownUnverifiableHardConstraints: [...s.known_unverifiable_hard_constraints],
    requireUserOverrideForUnverifiable: s.require_user_override_to_attempt_unverifiable_hard,
    maxEnrichCallsPerLead: e.max_enrich_calls_per_lead,
    maxTotalEnrichCalls: e.max_total_enrich_calls,
  };
}

export interface PolicyConstraints {
  radiusKm: number;
  enrichmentBatchSize: number;
  stopThresholdZero: boolean;
  stopThresholdMin: number;
  maxPlanVersions: number;
  searchBudgetCount: number;
}

export function upgradeFlatPolicyToBundle(flat: Record<string, unknown>): PolicyBundleV1 {
  if (typeof flat === 'object' && flat !== null && (flat as any).policy_bundle_version === 1) {
    return flat as unknown as PolicyBundleV1;
  }

  const bundle = structuredClone(GLOBAL_DEFAULT_BUNDLE);

  if (typeof flat.radiusKm === 'number') {
    bundle.policies.radius_policy_v1.max_cap_km = flat.radiusKm;
    bundle.policies.radius_policy_v1.default_steps_km = [
      Math.min(2, flat.radiusKm),
      Math.min(5, flat.radiusKm),
      flat.radiusKm,
    ].filter((v, i, arr) => arr.indexOf(v) === i);
  }
  if (typeof flat.enrichmentBatchSize === 'number') {
    bundle.policies.enrichment_policy_v1.enrichment_batch_size = flat.enrichmentBatchSize;
  }
  if (typeof flat.searchBudgetCount === 'number') {
    bundle.policies.stop_policy_v1.search_budget_count = flat.searchBudgetCount;
    bundle.policies.stop_policy_v1.search_count = flat.searchBudgetCount;
  }
  if (typeof flat.maxPlanVersions === 'number') {
    bundle.policies.stop_policy_v1.max_replans = flat.maxPlanVersions;
  }
  if (typeof flat.stopThresholdZero === 'boolean') {
    bundle.policies.stop_policy_v1.stop_when_verified_exact_is_zero_after_enrichment = flat.stopThresholdZero;
  }

  return bundle;
}

export function buildApplicationSnapshot(
  scopeKey: string,
  bundle: PolicyBundleV1,
  version: number,
  whyShort: string[],
): PolicyApplicationSnapshot {
  return {
    scope_key: scopeKey,
    applied_at: new Date().toISOString(),
    applied_versions: {
      radius_policy_v1: version,
      enrichment_policy_v1: version,
      stop_policy_v1: version,
    },
    applied_policies: {
      radius_policy_v1: {
        default_steps_km: bundle.policies.radius_policy_v1.default_steps_km,
        max_cap_km: bundle.policies.radius_policy_v1.max_cap_km,
      },
      enrichment_policy_v1: {
        mode: bundle.policies.enrichment_policy_v1.mode,
        max_total_enrich_calls: bundle.policies.enrichment_policy_v1.max_total_enrich_calls,
        enrichment_batch_size: bundle.policies.enrichment_policy_v1.enrichment_batch_size,
      },
      stop_policy_v1: {
        max_replans: bundle.policies.stop_policy_v1.max_replans,
        search_budget_count: bundle.policies.stop_policy_v1.search_budget_count,
        search_count: bundle.policies.stop_policy_v1.search_count,
        stop_when_verified_exact_is_zero_after_enrichment: bundle.policies.stop_policy_v1.stop_when_verified_exact_is_zero_after_enrichment,
        require_user_override_to_attempt_unverifiable_hard: bundle.policies.stop_policy_v1.require_user_override_to_attempt_unverifiable_hard,
      },
    },
    why_short: whyShort,
  };
}

export interface PolicyInput {
  request: string;
  vertical: string;
  location: string;
  constraintBucket: string[];
  userValue?: number;
  budget?: number;
}

export interface PolicyApplicationResult {
  scopeKey: string;
  policyVersionId: string | null;
  policyVersion: number;
  bundle: PolicyBundleV1;
  executionParams: ExecutionParams;
  snapshot: PolicyApplicationSnapshot;
  applied: boolean;
  rationale: string;
  constraints: PolicyConstraints;
}

export function canonicaliseBusinessType(raw: string): string {
  let v = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  v = v.replace(/^[\d]+\s+/, '');
  v = v.replace(/^(some|several|many|few|a few|a couple of|couple of|multiple|numerous|various|any|all|the)\s+/i, '');
  return v.trim();
}

export function deriveScopeKey(vertical: string, location: string, constraintBucket: string[]): string {
  const normVertical = canonicaliseBusinessType(vertical);
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

async function ensureGlobalDefault(): Promise<PolicyVersion> {
  const existing = await storage.getLatestPolicyVersion(GLOBAL_DEFAULT_SCOPE_KEY);
  if (existing) {
    const storedBundle = existing.policyData as Record<string, unknown>;
    const storedPolicies = storedBundle?.policies as Record<string, unknown> | undefined;
    const storedStop = storedPolicies?.stop_policy_v1 as Record<string, unknown> | undefined;
    const storedBudget = storedStop?.search_budget_count;
    const expectedBudget = GLOBAL_DEFAULT_BUNDLE.policies.stop_policy_v1.search_budget_count;
    if (typeof storedBudget === 'number' && storedBudget < expectedBudget) {
      console.warn(`[LEARNING_LAYER] GLOBAL_DEFAULT corrupted: search_budget_count=${storedBudget}, expected=${expectedBudget}. Repairing...`);
      const repaired = await storage.createPolicyVersion({
        scopeKey: GLOBAL_DEFAULT_SCOPE_KEY,
        version: existing.version + 1,
        policyData: GLOBAL_DEFAULT_BUNDLE as unknown as Record<string, unknown>,
        source: 'system_repair',
      });
      console.log(`[LEARNING_LAYER] GLOBAL_DEFAULT repaired to v${repaired.version}`);
      return repaired;
    }
    return existing;
  }

  console.log(`[LEARNING_LAYER] Seeding GLOBAL_DEFAULT policy bundle`);
  return storage.createPolicyVersion({
    scopeKey: GLOBAL_DEFAULT_SCOPE_KEY,
    version: 1,
    policyData: GLOBAL_DEFAULT_BUNDLE as unknown as Record<string, unknown>,
    source: 'system_seed',
  });
}

function bundleToLegacyConstraints(bundle: PolicyBundleV1): PolicyConstraints {
  return {
    radiusKm: bundle.policies.radius_policy_v1.max_cap_km,
    enrichmentBatchSize: bundle.policies.enrichment_policy_v1.enrichment_batch_size,
    stopThresholdZero: bundle.policies.stop_policy_v1.stop_when_verified_exact_is_zero_after_enrichment,
    stopThresholdMin: 1,
    maxPlanVersions: bundle.policies.stop_policy_v1.max_replans,
    searchBudgetCount: bundle.policies.stop_policy_v1.search_budget_count,
  };
}

export async function applyPolicy(input: PolicyInput, overrides?: RunOverrides): Promise<PolicyApplicationResult> {
  const scopeKey = deriveScopeKey(input.vertical, input.location, input.constraintBucket);
  console.log(`[LEARNING_LAYER] applyPolicy scope_key=${scopeKey}${overrides ? ` overrides=${JSON.stringify(overrides)}` : ''}`);

  await ensureGlobalDefault();

  const skipLearned = overrides?.ignore_learned_policy === true;
  let latestPolicy = skipLearned ? undefined : await storage.getLatestPolicyVersion(scopeKey);
  let whyShort: string[] = [];
  let applied = false;

  let bundle: PolicyBundleV1;

  const envMaxReplans = parseInt(process.env.MAX_REPLANS || '5', 10);
  const defaultMaxReplans = GLOBAL_DEFAULT_BUNDLE.policies.stop_policy_v1.max_replans;

  if (skipLearned) {
    bundle = structuredClone(GLOBAL_DEFAULT_BUNDLE);
    whyShort.push('Learned policy ignored by run override (ignore_learned_policy=true).');
    whyShort.push(`stop_policy_v1.max_replans=${bundle.policies.stop_policy_v1.max_replans} (default, learned policy skipped).`);
    console.log(`[LEARNING_LAYER] ignore_learned_policy=true, using GLOBAL_DEFAULT for scope=${scopeKey}`);
  } else if (!latestPolicy) {
    bundle = structuredClone(GLOBAL_DEFAULT_BUNDLE);
    whyShort.push('Default learning bundle applied (no learned updates yet).');
    whyShort.push(`stop_policy_v1.max_replans=${bundle.policies.stop_policy_v1.max_replans} (default, env MAX_REPLANS=${envMaxReplans}).`);
    console.log(`[LEARNING_LAYER] No stored policy for scope=${scopeKey}, using GLOBAL_DEFAULT (code constant)`);
  } else {
    const rawData = latestPolicy.policyData as Record<string, unknown>;
    bundle = upgradeFlatPolicyToBundle(rawData);
    applied = true;
    const learnedMaxReplans = bundle.policies.stop_policy_v1.max_replans;
    whyShort.push(`Learned policy v${latestPolicy.version} applied from scope=${scopeKey}.`);
    whyShort.push(`stop_policy_v1.max_replans=${learnedMaxReplans} (learned, was ${defaultMaxReplans}).`);
    console.log(`[LEARNING_LAYER] Applied policy v${latestPolicy.version} for scope=${scopeKey}`);
  }

  if (overrides?.mode_preset) {
    const mode = overrides.mode_preset;
    if (mode === 'faster') {
      bundle.policies.stop_policy_v1.max_replans = Math.min(bundle.policies.stop_policy_v1.max_replans, 1);
      bundle.policies.stop_policy_v1.search_budget_count = Math.min(bundle.policies.stop_policy_v1.search_budget_count, 20);
      bundle.policies.stop_policy_v1.search_count = Math.min(bundle.policies.stop_policy_v1.search_count, 20);
      whyShort.push(`mode_preset=faster: max_replans capped to ${bundle.policies.stop_policy_v1.max_replans}, search_budget capped to ${bundle.policies.stop_policy_v1.search_budget_count}.`);
    } else if (mode === 'stricter') {
      bundle.policies.stop_policy_v1.stop_when_verified_exact_is_zero_after_enrichment = true;
      whyShort.push(`mode_preset=stricter: stop_when_verified_exact_is_zero_after_enrichment forced true.`);
    } else {
      whyShort.push(`mode_preset=balanced: no adjustments.`);
    }
    console.log(`[LEARNING_LAYER] mode_preset=${mode} applied`);
  }

  if (overrides?.override_max_replans !== undefined) {
    const overrideVal = Math.max(0, Math.min(3, overrides.override_max_replans));
    const prev = bundle.policies.stop_policy_v1.max_replans;
    bundle.policies.stop_policy_v1.max_replans = overrideVal;
    whyShort.push(`override_max_replans=${overrideVal} (was ${prev}).`);
    console.log(`[LEARNING_LAYER] override_max_replans: ${prev} -> ${overrideVal}`);
  }

  const version = latestPolicy?.version ?? 0;
  const execParams = deriveExecutionParams(bundle);
  const snapshot = buildApplicationSnapshot(scopeKey, bundle, version, whyShort);
  if (overrides) {
    snapshot.run_overrides = overrides;
  }
  const legacyConstraints = bundleToLegacyConstraints(bundle);

  return {
    scopeKey,
    policyVersionId: latestPolicy?.id ?? null,
    policyVersion: version,
    bundle,
    executionParams: execParams,
    snapshot,
    applied,
    rationale: whyShort.join(' '),
    constraints: legacyConstraints,
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
    appliedPolicies: result.snapshot as unknown as Record<string, unknown>,
    inputSnapshot: {
      request: input.request,
      vertical: input.vertical,
      location: input.location,
      constraintBucket: input.constraintBucket,
      userValue: input.userValue ?? null,
      budget: input.budget ?? null,
    },
    outputConstraints: result.executionParams as unknown as Record<string, unknown>,
  });
}

export interface DecisionLogEntry {
  runId: string;
  userId: string;
  conversationId?: string;
  scopeKey: string;
  policyVersion: number;
  policyApplied: boolean;
  snapshot: PolicyApplicationSnapshot;
  executionParams: ExecutionParams;
  inputVertical: string;
  inputLocation: string;
  constraintBucket: string[];
  rationale: string;
  querySuspectedMerged?: boolean;
  learned_max_replans?: number;
  hard_cap_max_replans?: number;
  effective_max_replans?: number;
  run_overrides?: RunOverrides;
}

export async function writeDecisionLog(entry: DecisionLogEntry): Promise<void> {
  await createArtefact({
    runId: entry.runId,
    type: 'decision_log',
    title: `Decision Log: policy_v${entry.policyVersion} scope=${entry.scopeKey}`,
    summary: `policy_applied=${entry.policyApplied} search_budget=${entry.executionParams.searchBudgetCount} max_replans=${entry.executionParams.maxReplans} enrichment_batch=${entry.executionParams.enrichmentBatchSize}`,
    payload: {
      scope_key: entry.scopeKey,
      policy_version: entry.policyVersion,
      policy_applied: entry.policyApplied,
      application_snapshot: entry.snapshot,
      execution_params: entry.executionParams,
      input_vertical: entry.inputVertical,
      input_location: entry.inputLocation,
      constraint_bucket: entry.constraintBucket,
      rationale: entry.rationale,
      ...(entry.querySuspectedMerged ? { query_suspected_merged: true } : {}),
      ...(entry.learned_max_replans !== undefined ? { learned_max_replans: entry.learned_max_replans } : {}),
      ...(entry.hard_cap_max_replans !== undefined ? { hard_cap_max_replans: entry.hard_cap_max_replans } : {}),
      ...(entry.effective_max_replans !== undefined ? { effective_max_replans: entry.effective_max_replans } : {}),
      ...(entry.run_overrides ? { run_overrides: entry.run_overrides } : {}),
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
  requestedCount: number | null;
  verifiedExact: number;
  verifiedClosest: number;
  stopReason: string | null;
  toolCalls: number;
  costEstimate: number;
  durationMs: number;
  planVersionsUsed: number;
  scopeKey: string;
  totalRetryCount?: number;
  learned_max_replans?: number;
  hard_cap_max_replans?: number;
  effective_max_replans?: number;
  governance_status?: 'governed' | 'tower_unavailable';
  run_overrides?: RunOverrides;
}

export async function writeOutcomeLog(entry: OutcomeLogEntry): Promise<void> {
  await createArtefact({
    runId: entry.runId,
    type: 'outcome_log',
    title: `Outcome Log: delivered=${entry.deliveredCount}${entry.requestedCount !== null ? `/${entry.requestedCount}` : ''}`,
    summary: `delivered=${entry.deliveredCount}${entry.requestedCount !== null ? ` requested=${entry.requestedCount}` : ''} verified_exact=${entry.verifiedExact} stop_reason=${entry.stopReason || 'none'} tool_calls=${entry.toolCalls} cost=${entry.costEstimate.toFixed(2)} duration=${entry.durationMs}ms`,
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
      total_retry_count: entry.totalRetryCount ?? 0,
      learned_max_replans: entry.learned_max_replans ?? null,
      hard_cap_max_replans: entry.hard_cap_max_replans ?? null,
      effective_max_replans: entry.effective_max_replans ?? null,
      governance_status: entry.governance_status ?? 'governed',
      ...(entry.run_overrides ? { run_overrides: entry.run_overrides } : {}),
    },
    userId: entry.userId,
    conversationId: entry.conversationId,
  });
  console.log(`[LEARNING_LAYER] outcome_log written for run=${entry.runId}`);
}

export async function writeOutcomePolicyVersion(
  scopeKey: string,
  currentVersion: number,
  bundle: PolicyBundleV1,
  outcomeMetrics: { deliveredCount: number; requestedCount: number | null; stopReason: string | null },
): Promise<PolicyVersion> {
  const adjusted = structuredClone(bundle);

  const fillRate = (outcomeMetrics.requestedCount !== null && outcomeMetrics.requestedCount > 0)
    ? outcomeMetrics.deliveredCount / outcomeMetrics.requestedCount
    : 1;

  if (fillRate < 0.5) {
    const currentCap = adjusted.policies.radius_policy_v1.max_cap_km;
    if (currentCap < 100) {
      adjusted.policies.radius_policy_v1.max_cap_km = Math.min(currentCap + 10, 100);
      const newSteps = [...adjusted.policies.radius_policy_v1.default_steps_km];
      if (!newSteps.includes(adjusted.policies.radius_policy_v1.max_cap_km)) {
        newSteps.push(adjusted.policies.radius_policy_v1.max_cap_km);
      }
      adjusted.policies.radius_policy_v1.default_steps_km = newSteps.sort((a, b) => a - b);
    }
  }
  if (fillRate < 0.3) {
    adjusted.policies.stop_policy_v1.search_budget_count = Math.min(
      adjusted.policies.stop_policy_v1.search_budget_count + 10, 60,
    );
    adjusted.policies.stop_policy_v1.search_count = adjusted.policies.stop_policy_v1.search_budget_count;
  }
  if (outcomeMetrics.stopReason?.includes('zero') || outcomeMetrics.deliveredCount === 0) {
    adjusted.policies.stop_policy_v1.stop_when_verified_exact_is_zero_after_enrichment = true;
  }

  const globalMin = GLOBAL_DEFAULT_BUNDLE.policies.stop_policy_v1.search_budget_count;
  if (adjusted.policies.stop_policy_v1.search_budget_count < globalMin) {
    console.warn(`[LEARNING_LAYER] search_budget_count=${adjusted.policies.stop_policy_v1.search_budget_count} below global minimum ${globalMin}, clamping`);
    adjusted.policies.stop_policy_v1.search_budget_count = globalMin;
    adjusted.policies.stop_policy_v1.search_count = globalMin;
  }

  const newVersion = currentVersion + 1;
  const pv = await storage.createPolicyVersion({
    scopeKey,
    version: newVersion,
    policyData: adjusted as unknown as Record<string, unknown>,
    source: 'outcome_feedback',
  });

  console.log(`[LEARNING_LAYER] Policy v${newVersion} written for scope=${scopeKey} fillRate=${(fillRate * 100).toFixed(0)}%`);
  return pv;
}
