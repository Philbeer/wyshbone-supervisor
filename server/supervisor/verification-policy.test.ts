import { describe, it, expect } from 'vitest';
import {
  deriveVerificationPolicy,
  deriveVerificationPolicyFromConstraintTypes,
  deriveVerificationPolicyFromLegacyConstraints,
  type VerificationPolicy,
  type VerificationPolicyResult,
} from './verification-policy';
import type { MissionPlan, ConstraintPlanMapping } from './mission-planner';
import type { MissionConstraintType } from './mission-schema';

function makePlanWithMappings(mappings: Array<{ constraint_type: MissionConstraintType }>): MissionPlan {
  return {
    constraint_mappings: mappings as ConstraintPlanMapping[],
  } as MissionPlan;
}

describe('Verification Policy', () => {
  describe('deriveVerificationPolicy (from MissionPlan)', () => {
    it('returns DIRECTORY_VERIFIED for discovery-only (no actionable constraints)', () => {
      const result = deriveVerificationPolicy(makePlanWithMappings([]));
      expect(result.verification_policy).toBe('DIRECTORY_VERIFIED');
      expect(result.reason).toContain('entity discovery');
    });

    it('returns DIRECTORY_VERIFIED for text_compare constraints', () => {
      const result = deriveVerificationPolicy(makePlanWithMappings([
        { constraint_type: 'text_compare' },
      ]));
      expect(result.verification_policy).toBe('DIRECTORY_VERIFIED');
    });

    it('returns DIRECTORY_VERIFIED for numeric_range constraints', () => {
      const result = deriveVerificationPolicy(makePlanWithMappings([
        { constraint_type: 'numeric_range' },
      ]));
      expect(result.verification_policy).toBe('DIRECTORY_VERIFIED');
    });

    it('returns DIRECTORY_VERIFIED for ranking constraints', () => {
      const result = deriveVerificationPolicy(makePlanWithMappings([
        { constraint_type: 'ranking' },
      ]));
      expect(result.verification_policy).toBe('DIRECTORY_VERIFIED');
    });

    it('returns WEBSITE_VERIFIED for attribute_check constraint', () => {
      const result = deriveVerificationPolicy(makePlanWithMappings([
        { constraint_type: 'attribute_check' },
      ]));
      expect(result.verification_policy).toBe('WEBSITE_VERIFIED');
      expect(result.reason).toContain('attribute_check');
    });

    it('returns WEBSITE_VERIFIED for status_check constraint', () => {
      const result = deriveVerificationPolicy(makePlanWithMappings([
        { constraint_type: 'status_check' },
      ]));
      expect(result.verification_policy).toBe('WEBSITE_VERIFIED');
    });

    it('returns WEBSITE_VERIFIED for website_evidence constraint', () => {
      const result = deriveVerificationPolicy(makePlanWithMappings([
        { constraint_type: 'website_evidence' },
      ]));
      expect(result.verification_policy).toBe('WEBSITE_VERIFIED');
    });

    it('returns WEBSITE_VERIFIED for time_constraint', () => {
      const result = deriveVerificationPolicy(makePlanWithMappings([
        { constraint_type: 'time_constraint' },
      ]));
      expect(result.verification_policy).toBe('WEBSITE_VERIFIED');
    });

    it('returns RELATIONSHIP_VERIFIED for relationship_check constraint', () => {
      const result = deriveVerificationPolicy(makePlanWithMappings([
        { constraint_type: 'relationship_check' },
      ]));
      expect(result.verification_policy).toBe('RELATIONSHIP_VERIFIED');
      expect(result.reason).toContain('relationship');
    });

    it('relationship_check takes precedence over website evidence', () => {
      const result = deriveVerificationPolicy(makePlanWithMappings([
        { constraint_type: 'attribute_check' },
        { constraint_type: 'relationship_check' },
      ]));
      expect(result.verification_policy).toBe('RELATIONSHIP_VERIFIED');
    });

    it('website evidence takes precedence over directory-only', () => {
      const result = deriveVerificationPolicy(makePlanWithMappings([
        { constraint_type: 'text_compare' },
        { constraint_type: 'attribute_check' },
      ]));
      expect(result.verification_policy).toBe('WEBSITE_VERIFIED');
    });
  });

  describe('deriveVerificationPolicyFromConstraintTypes', () => {
    it('returns DIRECTORY_VERIFIED for empty array', () => {
      const result = deriveVerificationPolicyFromConstraintTypes([]);
      expect(result.verification_policy).toBe('DIRECTORY_VERIFIED');
    });

    it('returns WEBSITE_VERIFIED for attribute_check', () => {
      const result = deriveVerificationPolicyFromConstraintTypes(['attribute_check']);
      expect(result.verification_policy).toBe('WEBSITE_VERIFIED');
    });

    it('returns RELATIONSHIP_VERIFIED for relationship_check', () => {
      const result = deriveVerificationPolicyFromConstraintTypes(['relationship_check']);
      expect(result.verification_policy).toBe('RELATIONSHIP_VERIFIED');
    });
  });

  describe('deriveVerificationPolicyFromLegacyConstraints', () => {
    it('returns DIRECTORY_VERIFIED for basic constraints', () => {
      const result = deriveVerificationPolicyFromLegacyConstraints([
        'COUNT_MIN', 'LOCATION_EQUALS', 'CATEGORY_EQUALS',
      ]);
      expect(result.verification_policy).toBe('DIRECTORY_VERIFIED');
    });

    it('returns DIRECTORY_VERIFIED for NAME_STARTS_WITH', () => {
      const result = deriveVerificationPolicyFromLegacyConstraints([
        'CATEGORY_EQUALS', 'LOCATION_EQUALS', 'NAME_STARTS_WITH',
      ]);
      expect(result.verification_policy).toBe('DIRECTORY_VERIFIED');
    });

    it('returns WEBSITE_VERIFIED for HAS_ATTRIBUTE', () => {
      const result = deriveVerificationPolicyFromLegacyConstraints([
        'CATEGORY_EQUALS', 'LOCATION_EQUALS', 'HAS_ATTRIBUTE',
      ]);
      expect(result.verification_policy).toBe('WEBSITE_VERIFIED');
    });

    it('returns WEBSITE_VERIFIED for STATUS_CHECK', () => {
      const result = deriveVerificationPolicyFromLegacyConstraints([
        'CATEGORY_EQUALS', 'STATUS_CHECK',
      ]);
      expect(result.verification_policy).toBe('WEBSITE_VERIFIED');
    });

    it('returns WEBSITE_VERIFIED for WEBSITE_EVIDENCE', () => {
      const result = deriveVerificationPolicyFromLegacyConstraints([
        'CATEGORY_EQUALS', 'WEBSITE_EVIDENCE',
      ]);
      expect(result.verification_policy).toBe('WEBSITE_VERIFIED');
    });

    it('returns WEBSITE_VERIFIED for TIME_CONSTRAINT', () => {
      const result = deriveVerificationPolicyFromLegacyConstraints([
        'CATEGORY_EQUALS', 'TIME_CONSTRAINT',
      ]);
      expect(result.verification_policy).toBe('WEBSITE_VERIFIED');
    });

    it('returns RELATIONSHIP_VERIFIED for RELATIONSHIP_CHECK', () => {
      const result = deriveVerificationPolicyFromLegacyConstraints([
        'CATEGORY_EQUALS', 'LOCATION_EQUALS', 'RELATIONSHIP_CHECK',
      ]);
      expect(result.verification_policy).toBe('RELATIONSHIP_VERIFIED');
    });

    it('RELATIONSHIP_CHECK takes precedence over HAS_ATTRIBUTE', () => {
      const result = deriveVerificationPolicyFromLegacyConstraints([
        'HAS_ATTRIBUTE', 'RELATIONSHIP_CHECK',
      ]);
      expect(result.verification_policy).toBe('RELATIONSHIP_VERIFIED');
    });

    it('unknown legacy types are ignored gracefully', () => {
      const result = deriveVerificationPolicyFromLegacyConstraints([
        'UNKNOWN_TYPE' as any,
      ]);
      expect(result.verification_policy).toBe('DIRECTORY_VERIFIED');
    });
  });
});
