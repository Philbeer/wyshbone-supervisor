import { describe, it, expect } from 'vitest';
import { finalizeDelivery, computeRollup } from './finalize-delivery';

describe('finalizeDelivery — single source of truth', () => {
  it('drops leads with verification_status no_evidence', () => {
    const result = finalizeDelivery({
      leads: [
        { name: 'Pass', address: 'a', placeId: 'p1', source: 's', verifications: [
          { constraint_type: 'website_evidence', constraint_value: 'live music', tower_status: 'verified', tower_confidence: 0.9, tower_reasoning: null, source_url: null, quote: null }
        ]},
        { name: 'Fail', address: 'a', placeId: 'p2', source: 's', verifications: [
          { constraint_type: 'website_evidence', constraint_value: 'live music', tower_status: 'no_evidence', tower_confidence: 0.1, tower_reasoning: 'No mention', source_url: null, quote: null }
        ]},
      ],
      structuredConstraints: [{ id: 'c0', type: 'website_evidence', field: 'evidence', operator: 'contains', value: 'live music', hardness: 'hard', evidence_requirement: 'required', label: 'live music' }],
      requestedCount: null,
    });
    expect(result.count).toBe(1);
    expect(result.verifiedLeads[0].name).toBe('Pass');
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].name).toBe('Fail');
  });

  it('drops leads with weak_match — must be fully verified', () => {
    const result = finalizeDelivery({
      leads: [
        { name: 'Weak', address: 'a', placeId: 'p1', source: 's', verifications: [
          { constraint_type: 'website_evidence', constraint_value: 'X', tower_status: 'weak_match', tower_confidence: 0.5, tower_reasoning: null, source_url: null, quote: null }
        ]},
      ],
      structuredConstraints: [{ id: 'c0', type: 'website_evidence', field: 'evidence', operator: 'contains', value: 'X', hardness: 'hard', evidence_requirement: 'required', label: 'X' }],
      requestedCount: null,
    });
    expect(result.count).toBe(0);
    expect(result.dropped[0].rollup_status).toBe('weak_match');
  });

  it('passes location-only queries with no semantic constraints', () => {
    const result = finalizeDelivery({
      leads: [
        { name: 'Lead', address: 'a', placeId: 'p1', source: 's', executor_confidence: 'high', verifications: [] },
      ],
      structuredConstraints: [{ id: 'c0', type: 'location_constraint', field: 'location', operator: 'in', value: 'Sussex', hardness: 'hard', evidence_requirement: 'none', label: 'location' }],
      requestedCount: null,
    });
    expect(result.count).toBe(1);
    expect(result.hasTowerJudgedConstraints).toBe(false);
  });

  it('drops leads when tower-judged constraints exist but no verifications were run', () => {
    const result = finalizeDelivery({
      leads: [
        { name: 'Unchecked', address: 'a', placeId: 'p1', source: 's', verifications: [] },
      ],
      structuredConstraints: [{ id: 'c0', type: 'website_evidence', field: 'evidence', operator: 'contains', value: 'X', hardness: 'hard', evidence_requirement: 'required', label: 'X' }],
      requestedCount: null,
    });
    expect(result.count).toBe(0);
  });

  it('count equals verifiedLeads.length always', () => {
    const result = finalizeDelivery({
      leads: Array.from({ length: 10 }, (_, i) => ({
        name: `L${i}`, address: 'a', placeId: `p${i}`, source: 's',
        verifications: [{ constraint_type: 'website_evidence', constraint_value: 'X', tower_status: i < 6 ? 'verified' as const : 'no_evidence' as const, tower_confidence: 0.9, tower_reasoning: null, source_url: null, quote: null }],
      })),
      structuredConstraints: [{ id: 'c0', type: 'website_evidence', field: 'evidence', operator: 'contains', value: 'X', hardness: 'hard', evidence_requirement: 'required', label: 'X' }],
      requestedCount: null,
    });
    expect(result.count).toBe(result.verifiedLeads.length);
    expect(result.count).toBe(6);
  });

  it('caps to requestedCount AFTER verification filter', () => {
    const result = finalizeDelivery({
      leads: Array.from({ length: 10 }, (_, i) => ({
        name: `L${i}`, address: 'a', placeId: `p${i}`, source: 's',
        verifications: [{ constraint_type: 'website_evidence', constraint_value: 'X', tower_status: 'verified' as const, tower_confidence: 0.9, tower_reasoning: null, source_url: null, quote: null }],
      })),
      structuredConstraints: [{ id: 'c0', type: 'website_evidence', field: 'evidence', operator: 'contains', value: 'X', hardness: 'hard', evidence_requirement: 'required', label: 'X' }],
      requestedCount: 3,
    });
    expect(result.count).toBe(3);
  });

  it('computeRollup returns verified when all constraints pass', () => {
    const rollup = computeRollup(
      {
        name: 'L', address: 'a', placeId: 'p', source: 's',
        verifications: [
          { constraint_type: 'website_evidence', constraint_value: 'X', tower_status: 'verified', tower_confidence: 0.9, tower_reasoning: null, source_url: null, quote: null },
          { constraint_type: 'attribute_check', constraint_value: 'Y', tower_status: 'verified', tower_confidence: 0.8, tower_reasoning: null, source_url: null, quote: null },
        ],
      },
      2,
    );
    expect(rollup).toBe('verified');
  });

  it('computeRollup returns no_evidence when any constraint has null status', () => {
    const rollup = computeRollup(
      {
        name: 'L', address: 'a', placeId: 'p', source: 's',
        verifications: [
          { constraint_type: 'website_evidence', constraint_value: 'X', tower_status: null, tower_confidence: null, tower_reasoning: null, source_url: null, quote: null },
        ],
      },
      1,
    );
    expect(rollup).toBe('no_evidence');
  });
});
