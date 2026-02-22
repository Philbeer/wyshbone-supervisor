import { describe, it, expect } from 'vitest';
import { deriveScopeKey, mergePolicy, type PolicyConstraints } from './learning-layer';

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

  describe('mergePolicy', () => {
    it('applies stored policy values over defaults', () => {
      const stored = { radiusKm: 25, searchBudgetCount: 50 };
      const merged = mergePolicy(DEFAULT_POLICY, stored);
      expect(merged.radiusKm).toBe(25);
      expect(merged.searchBudgetCount).toBe(50);
      expect(merged.enrichmentBatchSize).toBe(5);
      expect(merged.stopThresholdZero).toBe(false);
    });

    it('ignores invalid types in stored policy', () => {
      const stored = { radiusKm: 'invalid', searchBudgetCount: null };
      const merged = mergePolicy(DEFAULT_POLICY, stored as any);
      expect(merged.radiusKm).toBe(0);
      expect(merged.searchBudgetCount).toBe(30);
    });

    it('applies stopThresholdZero boolean', () => {
      const stored = { stopThresholdZero: true };
      const merged = mergePolicy(DEFAULT_POLICY, stored);
      expect(merged.stopThresholdZero).toBe(true);
    });
  });

  describe('policy alters plan parameters (run 2 scenario)', () => {
    it('stored policy with higher searchBudgetCount overrides default', () => {
      const storedPolicy = { searchBudgetCount: 50, radiusKm: 10, enrichmentBatchSize: 8 };
      const merged = mergePolicy(DEFAULT_POLICY, storedPolicy);
      expect(merged.searchBudgetCount).toBe(50);
      expect(merged.searchBudgetCount).toBeGreaterThan(DEFAULT_POLICY.searchBudgetCount);
      expect(merged.radiusKm).toBe(10);
      expect(merged.enrichmentBatchSize).toBe(8);
    });

    it('policy with maxPlanVersions alters replan ceiling', () => {
      const storedPolicy = { maxPlanVersions: 4 };
      const merged = mergePolicy(DEFAULT_POLICY, storedPolicy);
      expect(merged.maxPlanVersions).toBe(4);
      expect(merged.maxPlanVersions).toBeGreaterThan(DEFAULT_POLICY.maxPlanVersions);
    });

    it('simulates run-2 override flow: stored policy changes searchBudgetCount and MAX_REPLANS', () => {
      let searchBudgetCount = 30;
      let searchCount = searchBudgetCount;
      let MAX_REPLANS = 5;

      const storedPolicyData = { searchBudgetCount: 45, maxPlanVersions: 3, enrichmentBatchSize: 7 };
      const merged = mergePolicy(DEFAULT_POLICY, storedPolicyData);

      if (merged.searchBudgetCount !== searchBudgetCount) {
        searchBudgetCount = merged.searchBudgetCount;
        searchCount = merged.searchBudgetCount;
      }
      if (merged.maxPlanVersions !== MAX_REPLANS) {
        MAX_REPLANS = merged.maxPlanVersions;
      }

      expect(searchBudgetCount).toBe(45);
      expect(searchCount).toBe(45);
      expect(MAX_REPLANS).toBe(3);
    });

    it('run-1 without stored policy uses defaults', () => {
      let searchBudgetCount = 30;
      let MAX_REPLANS = 5;

      const merged = mergePolicy(DEFAULT_POLICY, {});

      expect(merged.searchBudgetCount).toBe(30);
      expect(merged.maxPlanVersions).toBe(2);

      expect(searchBudgetCount).toBe(30);
      expect(MAX_REPLANS).toBe(5);
    });
  });

  describe('decision_log and outcome_log artefact types', () => {
    it('writeDecisionLog and writeOutcomeLog are importable functions', async () => {
      const { writeDecisionLog, writeOutcomeLog } = await import('./learning-layer');
      expect(typeof writeDecisionLog).toBe('function');
      expect(typeof writeOutcomeLog).toBe('function');
    });

    it('writeOutcomePolicyVersion is importable', async () => {
      const { writeOutcomePolicyVersion } = await import('./learning-layer');
      expect(typeof writeOutcomePolicyVersion).toBe('function');
    });

    it('persistPolicyApplication is importable', async () => {
      const { persistPolicyApplication } = await import('./learning-layer');
      expect(typeof persistPolicyApplication).toBe('function');
    });
  });
});
