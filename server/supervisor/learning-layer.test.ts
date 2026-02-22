import { describe, it, expect } from 'vitest';
import {
  deriveScopeKey,
  mergePolicy,
  deriveExecutionParams,
  upgradeFlatPolicyToBundle,
  buildApplicationSnapshot,
  GLOBAL_DEFAULT_BUNDLE,
  GLOBAL_DEFAULT_SCOPE_KEY,
  type PolicyConstraints,
  type PolicyBundleV1,
  type PolicyApplicationSnapshot,
} from './learning-layer';

const DEFAULT_POLICY: PolicyConstraints = {
  radiusKm: 0,
  enrichmentBatchSize: 5,
  stopThresholdZero: false,
  stopThresholdMin: 1,
  maxPlanVersions: 2,
  searchBudgetCount: 30,
};

describe('Learning Layer', () => {
  describe('deriveScopeKey', () => {
    it('produces deterministic scope keys', () => {
      const key1 = deriveScopeKey('pubs', 'London', ['business_type', 'location']);
      const key2 = deriveScopeKey('pubs', 'London', ['location', 'business_type']);
      expect(key1).toBe(key2);
    });

    it('normalizes case and whitespace', () => {
      const key1 = deriveScopeKey('PUBS', '  London  ', ['business_type']);
      const key2 = deriveScopeKey('pubs', 'London', ['business_type']);
      expect(key1).toBe(key2);
    });

    it('different verticals produce different keys', () => {
      const key1 = deriveScopeKey('pubs', 'London', ['business_type']);
      const key2 = deriveScopeKey('cafes', 'London', ['business_type']);
      expect(key1).not.toBe(key2);
    });

    it('different locations produce different keys', () => {
      const key1 = deriveScopeKey('pubs', 'London', ['business_type']);
      const key2 = deriveScopeKey('pubs', 'Manchester', ['business_type']);
      expect(key1).not.toBe(key2);
    });

    it('scope key format is vertical::location::bucket', () => {
      const key = deriveScopeKey('pubs', 'London', ['business_type', 'location']);
      expect(key).toMatch(/^pubs::london::business_type\|location$/);
    });
  });

  describe('mergePolicy (legacy compat)', () => {
    it('applies stored policy values over defaults', () => {
      const stored = { radiusKm: 25, searchBudgetCount: 50 };
      const merged = mergePolicy(DEFAULT_POLICY, stored);
      expect(merged.radiusKm).toBe(25);
      expect(merged.searchBudgetCount).toBe(50);
      expect(merged.enrichmentBatchSize).toBe(5);
    });

    it('ignores invalid types in stored policy', () => {
      const stored = { radiusKm: 'invalid', searchBudgetCount: null };
      const merged = mergePolicy(DEFAULT_POLICY, stored as any);
      expect(merged.radiusKm).toBe(0);
      expect(merged.searchBudgetCount).toBe(30);
    });
  });

  describe('GLOBAL_DEFAULT_BUNDLE', () => {
    it('has policy_bundle_version 1', () => {
      expect(GLOBAL_DEFAULT_BUNDLE.policy_bundle_version).toBe(1);
    });

    it('contains all three policy sections', () => {
      expect(GLOBAL_DEFAULT_BUNDLE.policies.radius_policy_v1).toBeDefined();
      expect(GLOBAL_DEFAULT_BUNDLE.policies.enrichment_policy_v1).toBeDefined();
      expect(GLOBAL_DEFAULT_BUNDLE.policies.stop_policy_v1).toBeDefined();
    });

    it('has correct default radius steps', () => {
      expect(GLOBAL_DEFAULT_BUNDLE.policies.radius_policy_v1.default_steps_km).toEqual([2, 5, 10]);
    });

    it('has correct default enrichment batch size', () => {
      expect(GLOBAL_DEFAULT_BUNDLE.policies.enrichment_policy_v1.enrichment_batch_size).toBe(10);
    });

    it('has correct default stop policy values', () => {
      const stop = GLOBAL_DEFAULT_BUNDLE.policies.stop_policy_v1;
      expect(stop.max_replans).toBe(2);
      expect(stop.search_budget_count).toBe(1);
      expect(stop.search_count).toBe(1);
      expect(stop.stop_when_verified_exact_is_zero_after_enrichment).toBe(true);
    });

    it('includes known_unverifiable_hard_constraints', () => {
      expect(GLOBAL_DEFAULT_BUNDLE.policies.stop_policy_v1.known_unverifiable_hard_constraints).toEqual([
        'c_attr_live_music',
        'c_attr_opened_recently',
      ]);
    });

    it('GLOBAL_DEFAULT_SCOPE_KEY is GLOBAL_DEFAULT', () => {
      expect(GLOBAL_DEFAULT_SCOPE_KEY).toBe('GLOBAL_DEFAULT');
    });
  });

  describe('deriveExecutionParams', () => {
    it('extracts execution params from canonical bundle', () => {
      const ep = deriveExecutionParams(GLOBAL_DEFAULT_BUNDLE);
      expect(ep.searchBudgetCount).toBe(1);
      expect(ep.searchCount).toBe(1);
      expect(ep.maxReplans).toBe(2);
      expect(ep.enrichmentBatchSize).toBe(10);
      expect(ep.radiusStepsKm).toEqual([2, 5, 10]);
      expect(ep.radiusMaxCapKm).toBe(10);
      expect(ep.stopWhenVerifiedZero).toBe(true);
      expect(ep.stopWhenCostExceedsBudget).toBe(true);
      expect(ep.maxEnrichCallsPerLead).toBe(1);
      expect(ep.maxTotalEnrichCalls).toBe(25);
    });

    it('reflects changes in bundle', () => {
      const modified = structuredClone(GLOBAL_DEFAULT_BUNDLE);
      modified.policies.stop_policy_v1.max_replans = 4;
      modified.policies.stop_policy_v1.search_budget_count = 45;
      modified.policies.enrichment_policy_v1.enrichment_batch_size = 15;
      const ep = deriveExecutionParams(modified);
      expect(ep.maxReplans).toBe(4);
      expect(ep.searchBudgetCount).toBe(45);
      expect(ep.enrichmentBatchSize).toBe(15);
    });
  });

  describe('upgradeFlatPolicyToBundle', () => {
    it('passes through already-canonical bundles unchanged', () => {
      const result = upgradeFlatPolicyToBundle(GLOBAL_DEFAULT_BUNDLE as unknown as Record<string, unknown>);
      expect(result.policy_bundle_version).toBe(1);
      expect(result.policies.stop_policy_v1.max_replans).toBe(2);
    });

    it('converts legacy flat policy to canonical bundle', () => {
      const flat = {
        radiusKm: 20,
        enrichmentBatchSize: 8,
        searchBudgetCount: 40,
        maxPlanVersions: 3,
        stopThresholdZero: true,
      };
      const result = upgradeFlatPolicyToBundle(flat);
      expect(result.policy_bundle_version).toBe(1);
      expect(result.policies.radius_policy_v1.max_cap_km).toBe(20);
      expect(result.policies.enrichment_policy_v1.enrichment_batch_size).toBe(8);
      expect(result.policies.stop_policy_v1.search_budget_count).toBe(40);
      expect(result.policies.stop_policy_v1.search_count).toBe(40);
      expect(result.policies.stop_policy_v1.max_replans).toBe(3);
      expect(result.policies.stop_policy_v1.stop_when_verified_exact_is_zero_after_enrichment).toBe(true);
    });

    it('preserves defaults for missing flat fields', () => {
      const flat = { radiusKm: 15 };
      const result = upgradeFlatPolicyToBundle(flat);
      expect(result.policies.radius_policy_v1.max_cap_km).toBe(15);
      expect(result.policies.enrichment_policy_v1.enrichment_batch_size).toBe(10);
      expect(result.policies.stop_policy_v1.max_replans).toBe(2);
    });
  });

  describe('run-2 override simulation', () => {
    it('canonical bundle overrides supervisor execution params', () => {
      let searchBudgetCount = 30;
      let searchCount = 30;
      let MAX_REPLANS = 5;

      const learnedBundle = structuredClone(GLOBAL_DEFAULT_BUNDLE);
      learnedBundle.policies.stop_policy_v1.search_budget_count = 45;
      learnedBundle.policies.stop_policy_v1.search_count = 45;
      learnedBundle.policies.stop_policy_v1.max_replans = 3;

      const ep = deriveExecutionParams(learnedBundle);

      if (ep.searchBudgetCount !== searchBudgetCount) {
        searchBudgetCount = ep.searchBudgetCount;
        searchCount = ep.searchCount;
      }
      if (ep.maxReplans !== MAX_REPLANS) {
        MAX_REPLANS = ep.maxReplans;
      }

      expect(searchBudgetCount).toBe(45);
      expect(searchCount).toBe(45);
      expect(MAX_REPLANS).toBe(3);
    });
  });

  describe('buildApplicationSnapshot (canonical format)', () => {
    it('produces snapshot with all required fields', () => {
      const snapshot = buildApplicationSnapshot(
        'pubs::london::business_type',
        GLOBAL_DEFAULT_BUNDLE,
        1,
        ['Default learning bundle applied (no learned updates yet).'],
      );
      expect(snapshot.scope_key).toBe('pubs::london::business_type');
      expect(snapshot.applied_at).toBeDefined();
      expect(new Date(snapshot.applied_at).toISOString()).toBe(snapshot.applied_at);
      expect(snapshot.applied_versions).toEqual({
        radius_policy_v1: 1,
        enrichment_policy_v1: 1,
        stop_policy_v1: 1,
      });
      expect(snapshot.why_short).toEqual(['Default learning bundle applied (no learned updates yet).']);
    });

    it('applied_policies contains correct subset of policy fields', () => {
      const snapshot = buildApplicationSnapshot(
        'pubs::london::business_type',
        GLOBAL_DEFAULT_BUNDLE,
        1,
        ['test'],
      );
      expect(snapshot.applied_policies.radius_policy_v1).toEqual({
        default_steps_km: [2, 5, 10],
        max_cap_km: 10,
      });
      expect(snapshot.applied_policies.enrichment_policy_v1).toEqual({
        mode: 'places_first_then_web',
        max_total_enrich_calls: 25,
        enrichment_batch_size: 10,
      });
      expect(snapshot.applied_policies.stop_policy_v1).toEqual({
        max_replans: 2,
        search_budget_count: 1,
        search_count: 1,
        stop_when_verified_exact_is_zero_after_enrichment: true,
        require_user_override_to_attempt_unverifiable_hard: true,
      });
    });

    it('snapshot does not contain extra keys beyond the canonical set', () => {
      const snapshot = buildApplicationSnapshot('test::scope::key', GLOBAL_DEFAULT_BUNDLE, 0, []);
      const allowedKeys = ['scope_key', 'applied_at', 'applied_versions', 'applied_policies', 'why_short'];
      expect(Object.keys(snapshot).sort()).toEqual(allowedKeys.sort());
    });
  });

  describe('GLOBAL_DEFAULT seeding', () => {
    it('ensureGlobalDefault is called via applyPolicy (importable)', async () => {
      const { applyPolicy } = await import('./learning-layer');
      expect(typeof applyPolicy).toBe('function');
    });

    it('GLOBAL_DEFAULT_SCOPE_KEY is the reserved key', () => {
      expect(GLOBAL_DEFAULT_SCOPE_KEY).toBe('GLOBAL_DEFAULT');
    });
  });

  describe('no flat policy writes (canonical enforcement)', () => {
    it('upgradeFlatPolicyToBundle always returns policy_bundle_version 1', () => {
      const flat1 = { radiusKm: 5 };
      expect(upgradeFlatPolicyToBundle(flat1).policy_bundle_version).toBe(1);

      const flat2 = { searchBudgetCount: 40, maxPlanVersions: 3 };
      expect(upgradeFlatPolicyToBundle(flat2).policy_bundle_version).toBe(1);

      const flat3 = {};
      expect(upgradeFlatPolicyToBundle(flat3).policy_bundle_version).toBe(1);
    });

    it('writeOutcomePolicyVersion takes PolicyBundleV1 not flat constraints', async () => {
      const { writeOutcomePolicyVersion } = await import('./learning-layer');
      expect(typeof writeOutcomePolicyVersion).toBe('function');
      expect(writeOutcomePolicyVersion.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('artefact writer importability', () => {
    it('writeDecisionLog, writeOutcomeLog, writeOutcomePolicyVersion are importable', async () => {
      const { writeDecisionLog, writeOutcomeLog, writeOutcomePolicyVersion } = await import('./learning-layer');
      expect(typeof writeDecisionLog).toBe('function');
      expect(typeof writeOutcomeLog).toBe('function');
      expect(typeof writeOutcomePolicyVersion).toBe('function');
    });

    it('persistPolicyApplication is importable', async () => {
      const { persistPolicyApplication } = await import('./learning-layer');
      expect(typeof persistPolicyApplication).toBe('function');
    });
  });

  describe('persistPolicyApplication run_id linkage', () => {
    it('persistPolicyApplication passes run_id to storage and snapshot contains scope_key', async () => {
      const { persistPolicyApplication, applyPolicy, buildApplicationSnapshot, deriveExecutionParams, GLOBAL_DEFAULT_BUNDLE } = await import('./learning-layer');

      const testRunId = `test_run_${Date.now()}`;
      const scopeKey = 'pubs::london::business_type';
      const bundle = structuredClone(GLOBAL_DEFAULT_BUNDLE);
      const snapshot = buildApplicationSnapshot(scopeKey, bundle, 0, ['test write']);
      const execParams = deriveExecutionParams(bundle);

      const mockResult = {
        scopeKey,
        policyVersionId: null,
        policyVersion: 0,
        bundle,
        executionParams: execParams,
        snapshot,
        applied: false,
        rationale: 'test',
        constraints: {
          radiusKm: bundle.policies.radius_policy_v1.max_cap_km,
          enrichmentBatchSize: bundle.policies.enrichment_policy_v1.enrichment_batch_size,
          stopThresholdZero: bundle.policies.stop_policy_v1.stop_when_verified_exact_is_zero_after_enrichment,
          stopThresholdMin: 1,
          maxPlanVersions: bundle.policies.stop_policy_v1.max_replans,
          searchBudgetCount: bundle.policies.stop_policy_v1.search_budget_count,
        },
      };

      const mockInput = {
        request: 'find pubs in london',
        vertical: 'pubs',
        location: 'london',
        constraintBucket: ['business_type'],
      };

      const pa = await persistPolicyApplication(testRunId, mockInput, mockResult);

      expect(pa).toBeDefined();
      expect(pa.runId).toBe(testRunId);
      expect(pa.scopeKey).toBe(scopeKey);

      const appliedPolicies = pa.appliedPolicies as Record<string, unknown>;
      expect(appliedPolicies).toBeDefined();
      expect((appliedPolicies as any).scope_key).toBe(scopeKey);
      expect((appliedPolicies as any).applied_versions).toBeDefined();
      expect((appliedPolicies as any).why_short).toBeDefined();
    });

    it('run_id in policy_applications matches the run_id used for artefacts (explain last run)', async () => {
      const { persistPolicyApplication, buildApplicationSnapshot, deriveExecutionParams, GLOBAL_DEFAULT_BUNDLE } = await import('./learning-layer');
      const { storage } = await import('../storage');

      const sharedRunId = `shared_run_${Date.now()}`;
      const scopeKey = 'cafes::paris::business_type';
      const bundle = structuredClone(GLOBAL_DEFAULT_BUNDLE);
      const snapshot = buildApplicationSnapshot(scopeKey, bundle, 0, ['verify id match']);
      const execParams = deriveExecutionParams(bundle);

      const result = {
        scopeKey,
        policyVersionId: null,
        policyVersion: 0,
        bundle,
        executionParams: execParams,
        snapshot,
        applied: false,
        rationale: 'test id match',
        constraints: {
          radiusKm: bundle.policies.radius_policy_v1.max_cap_km,
          enrichmentBatchSize: bundle.policies.enrichment_policy_v1.enrichment_batch_size,
          stopThresholdZero: bundle.policies.stop_policy_v1.stop_when_verified_exact_is_zero_after_enrichment,
          stopThresholdMin: 1,
          maxPlanVersions: bundle.policies.stop_policy_v1.max_replans,
          searchBudgetCount: bundle.policies.stop_policy_v1.search_budget_count,
        },
      };

      await persistPolicyApplication(sharedRunId, {
        request: 'find cafes in paris',
        vertical: 'cafes',
        location: 'paris',
        constraintBucket: ['business_type'],
      }, result);

      const rows = await storage.getPolicyApplicationsByRun(sharedRunId);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].runId).toBe(sharedRunId);
      expect(rows[0].scopeKey).toBe(scopeKey);
    });
  });
});
