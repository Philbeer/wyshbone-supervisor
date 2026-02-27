import { describe, it, expect } from 'vitest';
import { buildRequestedCount, DEFAULT_LEADS_TARGET, type RequestedCountCanonical } from './goal-to-constraints';
import { buildCapabilityCheck } from './cvl';
import type { StructuredConstraint } from './goal-to-constraints';

describe('buildRequestedCount', () => {
  it('returns "explicit" when user provides a number', () => {
    const rc = buildRequestedCount(15);
    expect(rc.requested_count_user).toBe('explicit');
    expect(rc.requested_count_value).toBe(15);
    expect(rc.requested_count_effective).toBe(15);
  });

  it('returns "any" with DEFAULT_LEADS_TARGET when user provides null', () => {
    const rc = buildRequestedCount(null);
    expect(rc.requested_count_user).toBe('any');
    expect(rc.requested_count_value).toBeNull();
    expect(rc.requested_count_effective).toBe(DEFAULT_LEADS_TARGET);
    expect(rc.requested_count_effective).toBe(20);
  });

  it('returns "any" for zero count', () => {
    const rc = buildRequestedCount(0);
    expect(rc.requested_count_user).toBe('any');
    expect(rc.requested_count_value).toBeNull();
    expect(rc.requested_count_effective).toBe(DEFAULT_LEADS_TARGET);
  });

  it('requested_count_effective is always a positive number', () => {
    const cases: (number | null)[] = [null, 0, 1, 5, 50, 200];
    for (const input of cases) {
      const rc = buildRequestedCount(input);
      expect(rc.requested_count_effective).toBeGreaterThan(0);
      expect(typeof rc.requested_count_effective).toBe('number');
    }
  });
});

describe('Regression: "find micropubs in sussex" (no count)', () => {
  it('constraints_extracted includes requested_count_user="any" and requested_count_effective=20', () => {
    const rc = buildRequestedCount(null);
    expect(rc.requested_count_user).toBe('any');
    expect(rc.requested_count_effective).toBe(20);
  });

  it('no CATEGORY_EQUALS constraint for "micropubs" causes no blocking_hard', () => {
    const constraints: StructuredConstraint[] = [
      { id: 'c_location', type: 'LOCATION_EQUALS', field: 'location', operator: '=', value: 'sussex', hard: false, rationale: 'User specified location: sussex' },
    ];
    const cap = buildCapabilityCheck(constraints);
    expect(cap.blocking_hard_constraints).toHaveLength(0);
  });

  it('Tower payload has non-null target_count when count not specified', () => {
    const rc = buildRequestedCount(null);
    const successCriteria = {
      mission_type: 'leadgen',
      target_count: rc.requested_count_effective,
      requested_count_user: rc.requested_count_user,
      requested_count_effective: rc.requested_count_effective,
      user_specified_count: false,
    };
    expect(successCriteria.target_count).toBe(20);
    expect(successCriteria.requested_count_user).toBe('any');
    expect(successCriteria.requested_count_effective).toBe(20);
    expect(successCriteria.target_count).not.toBeNull();
    expect(successCriteria.target_count).not.toBeUndefined();
  });

  it('Tower payload has explicit count when user specifies a number', () => {
    const rc = buildRequestedCount(10);
    const successCriteria = {
      mission_type: 'leadgen',
      target_count: rc.requested_count_effective,
      requested_count_user: rc.requested_count_user,
      requested_count_effective: rc.requested_count_effective,
      user_specified_count: true,
    };
    expect(successCriteria.target_count).toBe(10);
    expect(successCriteria.requested_count_user).toBe('explicit');
    expect(successCriteria.requested_count_effective).toBe(10);
  });
});
