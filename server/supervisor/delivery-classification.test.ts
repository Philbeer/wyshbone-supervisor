import { describe, it, expect } from 'vitest';
import {
  buildDeliverySummaryPayload,
  determineLeadExactness,
  type DeliverySummaryInput,
  type DeliverySummaryLeadInput,
  type SoftRelaxation,
} from './delivery-summary';

function makeLead(
  name: string,
  placeId: string,
  matchValid?: boolean,
): DeliverySummaryLeadInput {
  return {
    entity_id: placeId,
    place_id: placeId,
    placeId,
    name,
    address: `${name} Address`,
    found_in_plan_version: 1,
    match_valid: matchValid,
  };
}

function makeInput(
  leads: DeliverySummaryLeadInput[],
  hardConstraints: string[] = [],
  requestedCount: number | null = null,
): DeliverySummaryInput {
  return {
    runId: 'test-run',
    userId: 'test-user',
    originalUserGoal: 'Find pubs with live music',
    requestedCount,
    hardConstraints,
    softConstraints: [],
    planVersions: [{ version: 1, changes_made: [] }],
    softRelaxations: [],
    leads,
    finalVerdict: 'completed',
  };
}

describe('delivery classification: evidence-based downgrade', () => {
  it('3 verified + 2 weak → delivered_exact=3, delivered_closest=2', () => {
    const leads = [
      makeLead('Pub A', 'p1', true),
      makeLead('Pub B', 'p2', true),
      makeLead('Pub C', 'p3', true),
      makeLead('Pub D', 'p4', false),
      makeLead('Pub E', 'p5', false),
    ];

    const input = makeInput(leads, ['website_evidence=live music'], 5);
    const payload = buildDeliverySummaryPayload(input);

    expect(payload.delivered_exact.length).toBe(3);
    expect(payload.delivered_closest.length).toBe(2);

    const exactNames = payload.delivered_exact.map(e => e.name);
    expect(exactNames).toContain('Pub A');
    expect(exactNames).toContain('Pub B');
    expect(exactNames).toContain('Pub C');

    const closestNames = payload.delivered_closest.map(e => e.name);
    expect(closestNames).toContain('Pub D');
    expect(closestNames).toContain('Pub E');
  });

  it('weak candidates are not promoted to exact', () => {
    const leads = [
      makeLead('Pub A', 'p1', true),
      makeLead('Pub B', 'p2', false),
      makeLead('Pub C', 'p3', false),
    ];

    const input = makeInput(leads, ['website_evidence=live music'], 3);
    const payload = buildDeliverySummaryPayload(input);

    expect(payload.delivered_exact.length).toBe(1);
    expect(payload.delivered_closest.length).toBe(2);

    for (const entity of payload.delivered_closest) {
      expect(entity.match_valid).toBe(false);
    }
  });

  it('no forced padding of exact results to reach requested count', () => {
    const leads = [
      makeLead('Pub A', 'p1', true),
      makeLead('Pub B', 'p2', true),
      makeLead('Pub C', 'p3', false),
      makeLead('Pub D', 'p4', false),
      makeLead('Pub E', 'p5', false),
    ];

    const input = makeInput(leads, ['website_evidence=live music'], 5);
    const payload = buildDeliverySummaryPayload(input);

    expect(payload.delivered_exact.length).toBe(2);
    expect(payload.delivered_closest.length).toBe(3);
    expect(payload.shortfall).toBe(3);
  });

  it('downgraded leads carry weak_or_missing_evidence violation', () => {
    const leads = [
      makeLead('Pub A', 'p1', false),
    ];

    const input = makeInput(leads, ['website_evidence=live music'], 1);
    const payload = buildDeliverySummaryPayload(input);

    expect(payload.delivered_exact.length).toBe(0);
    expect(payload.delivered_closest.length).toBe(1);
    expect(payload.delivered_closest[0].soft_violations).toContain('weak_or_missing_evidence');
  });

  it('match_valid undefined does not trigger downgrade (non-evidence queries)', () => {
    const leads = [
      makeLead('Pub A', 'p1', undefined),
      makeLead('Pub B', 'p2', undefined),
    ];

    const input = makeInput(leads, [], 2);
    const payload = buildDeliverySummaryPayload(input);

    expect(payload.delivered_exact.length).toBe(2);
    expect(payload.delivered_closest.length).toBe(0);
  });

  it('all verified → all exact, no shortfall', () => {
    const leads = [
      makeLead('Pub A', 'p1', true),
      makeLead('Pub B', 'p2', true),
      makeLead('Pub C', 'p3', true),
    ];

    const input = makeInput(leads, ['website_evidence=live music'], 3);
    const payload = buildDeliverySummaryPayload(input);

    expect(payload.delivered_exact.length).toBe(3);
    expect(payload.delivered_closest.length).toBe(0);
    expect(payload.shortfall).toBe(0);
  });

  it('AFR reproduction: 5 leads, 3 with weak evidence, 2 with none → all closest', () => {
    const leads = [
      makeLead('Norfolk Arms', 'p1', false),
      makeLead('St Marys Gate Inn', 'p2', false),
      makeLead('The Swan Hotel', 'p3', false),
      makeLead('Kings Arms', 'p4', false),
      makeLead('Eagle Inn', 'p5', false),
    ];

    const input = makeInput(leads, ['website_evidence=live music'], 5);
    const payload = buildDeliverySummaryPayload(input);

    expect(payload.delivered_exact.length).toBe(0);
    expect(payload.delivered_closest.length).toBe(5);
    expect(payload.shortfall).toBe(5);
  });
});

describe('determineLeadExactness: evidence-aware', () => {
  it('CVL verified_exact overrides match_valid', () => {
    const lead = makeLead('Pub A', 'p1', false);
    const result = determineLeadExactness(
      lead,
      ['website_evidence=live music'],
      [],
      { lead_place_id: 'p1', lead_name: 'Pub A', verified_exact: true, all_hard_satisfied: true, location_confidence: 'verified_geo' },
    );
    expect(result.match_level).toBe('exact');
  });
});

describe('CVL override through full payload path', () => {
  it('CVL verified_exact=true keeps lead in exact even with match_valid=false', () => {
    const leads = [
      makeLead('Pub A', 'p1', false),
      makeLead('Pub B', 'p2', false),
    ];

    const input: DeliverySummaryInput = {
      ...makeInput(leads, ['website_evidence=live music'], 2),
      cvlLeadVerifications: [
        { lead_place_id: 'p1', lead_name: 'Pub A', verified_exact: true, all_hard_satisfied: true, location_confidence: 'verified_geo' },
      ],
    };

    const payload = buildDeliverySummaryPayload(input);

    expect(payload.delivered_exact.length).toBe(1);
    expect(payload.delivered_exact[0].name).toBe('Pub A');
    expect(payload.delivered_closest.length).toBe(1);
    expect(payload.delivered_closest[0].name).toBe('Pub B');
  });
});
