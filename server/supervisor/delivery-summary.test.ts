import { describe, it, expect } from 'vitest';
import {
  buildDeliverySummaryPayload,
  determineLeadExactness,
  DeliverySummaryInput,
  DeliverySummaryLeadInput,
  CvlLeadVerification,
  SoftRelaxation,
} from './delivery-summary';

function makeLead(name: string, address: string, placeId: string): DeliverySummaryLeadInput {
  return { entity_id: placeId, place_id: placeId, name, address, found_in_plan_version: 1 };
}

function makeCvlLv(
  placeId: string,
  name: string,
  locationConfidence: CvlLeadVerification['location_confidence'],
  verifiedExact = true,
): CvlLeadVerification {
  return {
    lead_place_id: placeId,
    lead_name: name,
    verified_exact: verifiedExact,
    all_hard_satisfied: true,
    location_confidence: locationConfidence,
  };
}

function baseInput(overrides: Partial<DeliverySummaryInput> = {}): DeliverySummaryInput {
  return {
    runId: 'run-1',
    userId: 'user-1',
    originalUserGoal: 'find dentists in Sussex',
    requestedCount: 30,
    hardConstraints: [],
    softConstraints: ['location=Sussex'],
    planVersions: [{ version: 1, changes_made: [] }],
    softRelaxations: [],
    leads: [],
    finalVerdict: 'pass',
    ...overrides,
  };
}

function assertArrayCountInvariant(result: ReturnType<typeof buildDeliverySummaryPayload>) {
  expect(result.delivered_exact_count).toBe(result.delivered_exact.length);
  expect(result.delivered_total_count).toBe(result.delivered_exact.length + result.delivered_closest.length);
}

describe('determineLeadExactness (single helper)', () => {
  const lead = makeLead('Test Dental', '10 High St', 'p1');

  it('CVL verified_exact=true → exact, no heuristic used', () => {
    const cvl = makeCvlLv('p1', 'Test Dental', 'search_bounded', true);
    const result = determineLeadExactness(lead, ['category=plumber'], [], cvl);
    expect(result.match_level).toBe('exact');
    expect(result.soft_violations).toEqual([]);
  });

  it('CVL verified_exact=false, all_hard_satisfied=true → closest with soft violations', () => {
    const cvl: CvlLeadVerification = {
      lead_place_id: 'p1',
      lead_name: 'Test Dental',
      verified_exact: false,
      all_hard_satisfied: true,
      location_confidence: 'out_of_area',
    };
    const softRelax: SoftRelaxation[] = [
      { constraint: 'location', from: 'Sussex', to: 'wider', reason: 'expand', plan_version: 2 },
    ];
    const result = determineLeadExactness(lead, [], softRelax, cvl);
    expect(result.match_level).toBe('closest');
    expect(result.soft_violations).toContain('location');
  });

  it('CVL verified_exact=false, all_hard_satisfied=false → closest with hard constraint names', () => {
    const cvl: CvlLeadVerification = {
      lead_place_id: 'p1',
      lead_name: 'Test Dental',
      verified_exact: false,
      all_hard_satisfied: false,
      location_confidence: 'unknown',
    };
    const result = determineLeadExactness(lead, ['category=plumber'], [], cvl);
    expect(result.match_level).toBe('closest');
    expect(result.soft_violations).toContain('category=plumber');
  });

  it('no CVL → heuristic fallback: hard constraint violation', () => {
    const result = determineLeadExactness(lead, ['category=plumber'], [], null);
    expect(result.match_level).toBe('closest');
  });

  it('no CVL → heuristic fallback: no relaxations → exact', () => {
    const result = determineLeadExactness(lead, [], [], null);
    expect(result.match_level).toBe('exact');
  });

  it('no CVL → heuristic fallback: location substring match', () => {
    const sussexLead = makeLead('Dental', '10 High St, West Sussex', 'p2');
    const locRelax: SoftRelaxation = {
      constraint: 'location', from: 'Sussex', to: 'wider', reason: 'expand', plan_version: 2,
    };
    const result = determineLeadExactness(sussexLead, [], [locRelax], null);
    expect(result.match_level).toBe('exact');
  });

  it('no CVL → heuristic fallback: location substring miss', () => {
    const noSussexLead = makeLead('Dental', '10 High St, Brighton, BN1', 'p2');
    const locRelax: SoftRelaxation = {
      constraint: 'location', from: 'Sussex', to: 'wider', reason: 'expand', plan_version: 2,
    };
    const result = determineLeadExactness(noSussexLead, [], [locRelax], null);
    expect(result.match_level).toBe('closest');
  });

  it('CVL takes precedence: lead would fail heuristic but CVL says exact', () => {
    const noSussexLead = makeLead('Dental', '10 High St, Brighton, BN1', 'p2');
    const cvl = makeCvlLv('p2', 'Dental', 'search_bounded', true);
    const locRelax: SoftRelaxation = {
      constraint: 'location', from: 'Sussex', to: 'wider', reason: 'expand', plan_version: 2,
    };
    const result = determineLeadExactness(noSussexLead, [], [locRelax], cvl);
    expect(result.match_level).toBe('exact');
  });

  it('CVL takes precedence: lead would pass heuristic but CVL says not exact', () => {
    const sussexLead = makeLead('Dental', '10 High St, West Sussex', 'p2');
    const cvl: CvlLeadVerification = {
      lead_place_id: 'p2',
      lead_name: 'Dental',
      verified_exact: false,
      all_hard_satisfied: true,
      location_confidence: 'out_of_area',
    };
    const locRelax: SoftRelaxation = {
      constraint: 'location', from: 'Sussex', to: 'wider', reason: 'expand', plan_version: 2,
    };
    const result = determineLeadExactness(sussexLead, [], [locRelax], cvl);
    expect(result.match_level).toBe('closest');
  });
});

describe('buildDeliverySummaryPayload', () => {
  describe('Sussex regression: CVL verifies all 30 leads but only 11 have Sussex in address', () => {
    const sussexLeads = [
      makeLead('Sussex Dental Group - Crawley', '123 High St, Crawley, West Sussex', 'p1'),
      makeLead('Old Mill Dental Surgery', '45 Mill Lane, East Sussex', 'p2'),
      makeLead('Gateway Dental', '10 Gateway Rd, Burgess Hill, West Sussex', 'p3'),
      makeLead('Sussex Implant Centre', '88 Church Rd, Sussex', 'p4'),
      makeLead('Sussex Dental Group - West Hove', '12 Hove Park, West Sussex', 'p5'),
      makeLead('S3 Dental Haywards Heath', '5 South Rd, Haywards Heath, RH16 3UF', 'p6'),
      makeLead('Burgess Hill Dental', '22 Station Rd, Burgess Hill, RH15 9AA', 'p7'),
      makeLead('Hassocks Dental Surgery', '3 Keymer Rd, Hassocks, BN6 8AG', 'p8'),
      makeLead('Dentalessence', '14 London Rd, Brighton, BN1 4JA', 'p9'),
      makeLead('Heathfield Dental Clinic', '7 High St, Heathfield, TN21 8LU', 'p10'),
      makeLead('Rudgwick Dental Practice', '1 Church St, Rudgwick, RH12 3EB', 'p11'),
      makeLead('Crawley Smiles', '90 Queensway, Crawley, RH10 1EJ', 'p12'),
      makeLead('Horsham Dental Centre', '6 Albion Way, Horsham, RH12 1BG', 'p13'),
      makeLead('East Grinstead Dental', '4 Railway Approach, East Grinstead, RH19 1BP', 'p14'),
      makeLead('Lindfield Dental Practice', '2 Denmans Ln, Lindfield, RH16 2JN', 'p15'),
      makeLead('Bognor Regis Dental', '55 High St, Bognor Regis, PO21 1RY', 'p16'),
      makeLead('Chichester Dental', '11 Eastgate, Chichester, PO19 1EJ', 'p17'),
      makeLead('Worthing Dental', '33 Warwick St, Worthing, BN11 3DJ', 'p18'),
      makeLead('Littlehampton Dental', '8 Beach Rd, Littlehampton, BN17 5JL', 'p19'),
      makeLead('Arundel Dental Care', '2 Tarrant St, Arundel, BN18 9DG', 'p20'),
      makeLead('Steyning Dental', '15 High St, Steyning, BN44 3GG', 'p21'),
      makeLead('Shoreham Dental', '7 Brunswick Rd, Shoreham, BN43 5WA', 'p22'),
      makeLead('Pulborough Dental', '3 Lower St, Pulborough, RH20 2BW', 'p23'),
      makeLead('Billingshurst Dental', '12 High St, Billingshurst, RH14 9NY', 'p24'),
      makeLead('Petworth Dental', '5 Lombard St, Petworth, GU28 0AG', 'p25'),
      makeLead('Midhurst Dental', '9 North St, Midhurst, GU29 9DG', 'p26'),
      makeLead('Storrington Dental', '4 West St, Storrington, RH20 4DZ', 'p27'),
      makeLead('Henfield Dental', '6 High St, Henfield, BN5 9DB', 'p28'),
      makeLead('Uckfield Dental', '10 High St, Uckfield, TN22 1AG', 'p29'),
      makeLead('Crowborough Dental', '8 Beacon Rd, Crowborough, TN6 1AB', 'p30'),
    ];

    const cvlVerifications: CvlLeadVerification[] = sussexLeads.map(l =>
      makeCvlLv(l.place_id!, l.name, 'search_bounded')
    );

    const locationRelaxation: SoftRelaxation = {
      constraint: 'location',
      from: 'Sussex',
      to: 'wider Sussex area',
      reason: 'Expand search area',
      plan_version: 2,
    };

    it('with CVL: all 30 leads should be delivered_exact when CVL says search_bounded', () => {
      const input = baseInput({
        leads: sussexLeads,
        softRelaxations: [locationRelaxation],
        cvlVerifiedExactCount: 30,
        cvlLeadVerifications: cvlVerifications,
      });

      const result = buildDeliverySummaryPayload(input);

      expect(result.delivered_exact.length).toBe(30);
      expect(result.delivered_closest.length).toBe(0);
      expect(result.delivered_exact_count).toBe(30);
      expect(result.delivered_total_count).toBe(30);
      expect(result.shortfall).toBe(0);
      expect(result.status).toBe('PASS');
      assertArrayCountInvariant(result);
    });

    it('with CVL verified_geo: all 30 leads should be delivered_exact', () => {
      const geoVerifications = sussexLeads.map(l =>
        makeCvlLv(l.place_id!, l.name, 'verified_geo')
      );
      const input = baseInput({
        leads: sussexLeads,
        softRelaxations: [locationRelaxation],
        cvlVerifiedExactCount: 30,
        cvlLeadVerifications: geoVerifications,
      });

      const result = buildDeliverySummaryPayload(input);

      expect(result.delivered_exact.length).toBe(30);
      expect(result.delivered_closest.length).toBe(0);
      assertArrayCountInvariant(result);
    });

    it('without CVL: falls back to substring matching (11 exact, 19 closest)', () => {
      const input = baseInput({
        leads: sussexLeads,
        softRelaxations: [locationRelaxation],
      });

      const result = buildDeliverySummaryPayload(input);

      const addressesWithSussex = sussexLeads.filter(l => l.address.toLowerCase().includes('sussex')).length;
      expect(result.delivered_exact.length).toBe(addressesWithSussex);
      expect(result.delivered_closest.length).toBe(30 - addressesWithSussex);
      assertArrayCountInvariant(result);
    });

    it('CVL out_of_area leads go to delivered_closest', () => {
      const mixed = [
        makeCvlLv('p1', sussexLeads[0].name, 'search_bounded'),
        makeCvlLv('p2', sussexLeads[1].name, 'out_of_area', false),
        makeCvlLv('p3', sussexLeads[2].name, 'verified_geo'),
      ];
      const input = baseInput({
        leads: sussexLeads.slice(0, 3),
        softRelaxations: [locationRelaxation],
        cvlVerifiedExactCount: 2,
        cvlLeadVerifications: mixed,
      });

      const result = buildDeliverySummaryPayload(input);

      expect(result.delivered_exact.length).toBe(2);
      expect(result.delivered_closest.length).toBe(1);
      expect(result.delivered_closest[0].name).toBe('Old Mill Dental Surgery');
      assertArrayCountInvariant(result);
    });

    it('CVL unknown location leads go to delivered_closest', () => {
      const unknownVerifications = sussexLeads.map(l =>
        makeCvlLv(l.place_id!, l.name, 'unknown', false)
      );
      const input = baseInput({
        leads: sussexLeads,
        softRelaxations: [locationRelaxation],
        cvlVerifiedExactCount: 0,
        cvlLeadVerifications: unknownVerifications,
      });

      const result = buildDeliverySummaryPayload(input);

      expect(result.delivered_exact.length).toBe(0);
      expect(result.delivered_closest.length).toBe(30);
      assertArrayCountInvariant(result);
    });
  });

  describe('non-location constraints still work correctly', () => {
    it('prefix constraint uses substring fallback (no CVL needed)', () => {
      const leads = [
        makeLead('ABC Dental', '10 High St', 'p1'),
        makeLead('XYZ Dental', '20 Low St', 'p2'),
      ];
      const prefixRelax: SoftRelaxation = {
        constraint: 'prefix',
        from: 'abc',
        to: 'any',
        reason: 'Expand prefix',
        plan_version: 2,
      };
      const input = baseInput({
        leads,
        softRelaxations: [prefixRelax],
        requestedCount: 2,
      });

      const result = buildDeliverySummaryPayload(input);

      expect(result.delivered_exact.length).toBe(1);
      expect(result.delivered_exact[0].name).toBe('ABC Dental');
      expect(result.delivered_closest.length).toBe(1);
      expect(result.delivered_closest[0].name).toBe('XYZ Dental');
      assertArrayCountInvariant(result);
    });

    it('name/category constraint still uses substring matching', () => {
      const leads = [
        makeLead('Brighton Dental Surgery', '10 High St, Brighton', 'p1'),
        makeLead('Brighton Eye Clinic', '20 High St, Brighton', 'p2'),
      ];
      const catRelax: SoftRelaxation = {
        constraint: 'business_type',
        from: 'dental',
        to: 'healthcare',
        reason: 'Broaden category',
        plan_version: 2,
      };
      const input = baseInput({
        leads,
        softRelaxations: [catRelax],
        requestedCount: 2,
      });

      const result = buildDeliverySummaryPayload(input);

      expect(result.delivered_exact.length).toBe(1);
      expect(result.delivered_exact[0].name).toBe('Brighton Dental Surgery');
      expect(result.delivered_closest.length).toBe(1);
      assertArrayCountInvariant(result);
    });

    it('mixed location + non-location: CVL decides all constraints when present', () => {
      const leads = [
        makeLead('ABC Dental', '10 High St, Crawley, RH10', 'p1'),
        makeLead('XYZ Dental', '20 Low St, Horsham, RH12', 'p2'),
      ];
      const locRelax: SoftRelaxation = {
        constraint: 'location',
        from: 'Sussex',
        to: 'wider area',
        reason: 'Expand',
        plan_version: 2,
      };
      const prefixRelax: SoftRelaxation = {
        constraint: 'prefix',
        from: 'abc',
        to: 'any',
        reason: 'Expand prefix',
        plan_version: 2,
      };
      const cvlLvs: CvlLeadVerification[] = [
        makeCvlLv('p1', 'ABC Dental', 'search_bounded', true),
        makeCvlLv('p2', 'XYZ Dental', 'search_bounded', false),
      ];
      const input = baseInput({
        leads,
        softRelaxations: [locRelax, prefixRelax],
        cvlVerifiedExactCount: 1,
        cvlLeadVerifications: cvlLvs,
        requestedCount: 2,
      });

      const result = buildDeliverySummaryPayload(input);

      expect(result.delivered_exact.length).toBe(1);
      expect(result.delivered_exact[0].name).toBe('ABC Dental');
      expect(result.delivered_closest.length).toBe(1);
      expect(result.delivered_closest[0].name).toBe('XYZ Dental');
      assertArrayCountInvariant(result);
    });
  });

  describe('no-relaxation and hard-constraint cases', () => {
    it('no soft relaxations: all leads are exact', () => {
      const leads = [
        makeLead('Dental A', 'Addr A', 'p1'),
        makeLead('Dental B', 'Addr B', 'p2'),
      ];
      const input = baseInput({
        leads,
        softRelaxations: [],
        requestedCount: 2,
      });

      const result = buildDeliverySummaryPayload(input);

      expect(result.delivered_exact.length).toBe(2);
      expect(result.delivered_closest.length).toBe(0);
      expect(result.status).toBe('PASS');
      assertArrayCountInvariant(result);
    });

    it('hard constraint violation: heuristic fallback puts lead in closest', () => {
      const leads = [makeLead('Dental A', 'Addr A', 'p1')];
      const input = baseInput({
        leads,
        hardConstraints: ['category=plumber'],
        requestedCount: 1,
      });

      const result = buildDeliverySummaryPayload(input);

      expect(result.delivered_exact.length).toBe(0);
      expect(result.delivered_closest.length).toBe(1);
      assertArrayCountInvariant(result);
    });

    it('hard constraint violation ignored when CVL says verified_exact', () => {
      const leads = [makeLead('Dental A', 'Addr A', 'p1')];
      const cvlLvs: CvlLeadVerification[] = [
        makeCvlLv('p1', 'Dental A', 'verified_geo', true),
      ];
      const input = baseInput({
        leads,
        hardConstraints: ['category=plumber'],
        cvlVerifiedExactCount: 1,
        cvlLeadVerifications: cvlLvs,
        requestedCount: 1,
      });

      const result = buildDeliverySummaryPayload(input);

      expect(result.delivered_exact.length).toBe(1);
      assertArrayCountInvariant(result);
    });
  });

  describe('CVL not_applicable location passes', () => {
    it('not_applicable location confidence is treated as passing', () => {
      const leads = [makeLead('Online Biz', 'Virtual', 'p1')];
      const locRelax: SoftRelaxation = {
        constraint: 'location',
        from: 'London',
        to: 'UK',
        reason: 'Expand',
        plan_version: 2,
      };
      const cvlLvs: CvlLeadVerification[] = [
        makeCvlLv('p1', 'Online Biz', 'not_applicable', true),
      ];
      const input = baseInput({
        leads,
        softRelaxations: [locRelax],
        cvlVerifiedExactCount: 1,
        cvlLeadVerifications: cvlLvs,
        requestedCount: 1,
      });

      const result = buildDeliverySummaryPayload(input);

      expect(result.delivered_exact.length).toBe(1);
      assertArrayCountInvariant(result);
    });
  });

  describe('cvl_verified_exact_count preserves raw CVL count', () => {
    it('stores the original CVL count separately from array length', () => {
      const leads = [
        makeLead('Dental A', 'Brighton', 'p1'),
        makeLead('Dental B', 'Crawley', 'p2'),
      ];
      const cvlLvs: CvlLeadVerification[] = [
        makeCvlLv('p1', 'Dental A', 'search_bounded', true),
        makeCvlLv('p2', 'Dental B', 'out_of_area', false),
      ];
      const input = baseInput({
        leads,
        softRelaxations: [{
          constraint: 'location',
          from: 'Sussex',
          to: 'wider',
          reason: 'expand',
          plan_version: 2,
        }],
        cvlVerifiedExactCount: 1,
        cvlLeadVerifications: cvlLvs,
        requestedCount: 2,
      });

      const result = buildDeliverySummaryPayload(input);

      expect(result.cvl_verified_exact_count).toBe(1);
      expect(result.delivered_exact_count).toBe(1);
      expect(result.delivered_exact.length).toBe(1);
      assertArrayCountInvariant(result);
    });
  });

  describe('invariant: exact_count === delivered_exact.length across all scenarios', () => {
    it('empty leads', () => {
      const result = buildDeliverySummaryPayload(baseInput({ leads: [] }));
      assertArrayCountInvariant(result);
    });

    it('all CVL exact', () => {
      const leads = [makeLead('A', 'Addr', 'p1'), makeLead('B', 'Addr', 'p2')];
      const cvl = leads.map(l => makeCvlLv(l.place_id!, l.name, 'verified_geo', true));
      const result = buildDeliverySummaryPayload(baseInput({
        leads, cvlVerifiedExactCount: 2, cvlLeadVerifications: cvl, requestedCount: 2,
      }));
      assertArrayCountInvariant(result);
    });

    it('all CVL closest', () => {
      const leads = [makeLead('A', 'Addr', 'p1'), makeLead('B', 'Addr', 'p2')];
      const cvl = leads.map(l => makeCvlLv(l.place_id!, l.name, 'out_of_area', false));
      const result = buildDeliverySummaryPayload(baseInput({
        leads, cvlVerifiedExactCount: 0, cvlLeadVerifications: cvl, requestedCount: 2,
        softRelaxations: [{ constraint: 'location', from: 'X', to: 'Y', reason: 'r', plan_version: 2 }],
      }));
      assertArrayCountInvariant(result);
    });

    it('mixed CVL and no-CVL leads (partial coverage)', () => {
      const leads = [makeLead('A', 'London', 'p1'), makeLead('B', 'Brighton', 'p2')];
      const cvl = [makeCvlLv('p1', 'A', 'verified_geo', true)];
      const result = buildDeliverySummaryPayload(baseInput({
        leads, cvlVerifiedExactCount: 1, cvlLeadVerifications: cvl, requestedCount: 2,
      }));
      assertArrayCountInvariant(result);
    });

    it('heuristic fallback only', () => {
      const leads = [
        makeLead('A', 'London, Sussex', 'p1'),
        makeLead('B', 'Brighton', 'p2'),
      ];
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        softRelaxations: [{ constraint: 'location', from: 'Sussex', to: 'wider', reason: 'r', plan_version: 2 }],
        requestedCount: 2,
      }));
      assertArrayCountInvariant(result);
    });
  });

  describe('D) Hard truth contract — ERROR and trust_status', () => {
    it('Tower error verdict → status=ERROR, trust_status=UNTRUSTED', () => {
      const leads = [makeLead('Pub A', '1 High St, Leeds', 'p1')];
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        finalVerdict: 'error',
        requestedCount: null,
      }));
      expect(result.status).toBe('ERROR');
      expect(result.trust_status).toBe('UNTRUSTED');
    });

    it('Tower fail verdict → status=STOP, trust_status=UNTRUSTED', () => {
      const leads = [makeLead('Pub A', '1 High St, Leeds', 'p1')];
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        finalVerdict: 'fail',
      }));
      expect(result.status).toBe('STOP');
      expect(result.trust_status).toBe('UNTRUSTED');
    });

    it('Tower stop verdict → status=STOP, trust_status=UNTRUSTED', () => {
      const leads = [makeLead('Pub A', '1 High St, Leeds', 'p1')];
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        finalVerdict: 'stop',
      }));
      expect(result.status).toBe('STOP');
      expect(result.trust_status).toBe('UNTRUSTED');
    });

    it('PASS verdict with leads → trust_status=TRUSTED', () => {
      const leads = [makeLead('Pub A', '1 High St, Leeds', 'p1')];
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        finalVerdict: 'pass',
        requestedCount: null,
      }));
      expect(result.status).toBe('PASS');
      expect(result.trust_status).toBe('TRUSTED');
    });

    it('PARTIAL verdict → trust_status=TRUSTED', () => {
      const leads = [makeLead('Pub A', '1 High St, Leeds', 'p1')];
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        finalVerdict: 'pass',
        requestedCount: 5,
      }));
      expect(result.status).toBe('PARTIAL');
      expect(result.trust_status).toBe('TRUSTED');
    });

    it('never emits PASS when finalVerdict is error', () => {
      const leads = Array.from({ length: 30 }, (_, i) =>
        makeLead(`Pub ${i}`, `${i} High St`, `p${i}`)
      );
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        finalVerdict: 'error',
        requestedCount: 30,
      }));
      expect(result.status).not.toBe('PASS');
      expect(result.status).toBe('ERROR');
      expect(result.trust_status).toBe('UNTRUSTED');
    });
  });

  describe('E) Relationship predicate enforcement', () => {
    it('demotes all exact leads to closest when relationship unverified', () => {
      const leads = [
        makeLead('County Councils Network', '10 Smith Sq, London', 'p1'),
        makeLead('Council Support Ltd', '20 High St, Leeds', 'p2'),
      ];
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        finalVerdict: 'pass',
        requestedCount: null,
        relationshipContext: {
          requires_relationship_evidence: true,
          detected_predicate: 'works with',
          relationship_target: 'councils',
          verified_relationship_count: 0,
        },
      }));
      expect(result.delivered_exact.length).toBe(0);
      expect(result.delivered_closest.length).toBe(2);
      expect(result.delivered_closest[0].soft_violations).toContain('relationship_not_verified');
      expect(result.status).toBe('STOP');
      expect(result.stop_reason).toContain('works with councils');
      expect(result.stop_reason).toContain('could not be verified');
      expect(result.relationship_context?.requires_relationship_evidence).toBe(true);
    });

    it('passes normally when no relationship evidence required', () => {
      const leads = [makeLead('Pub A', '1 High St, Leeds', 'p1')];
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        finalVerdict: 'pass',
        requestedCount: null,
      }));
      expect(result.delivered_exact.length).toBe(1);
      expect(result.delivered_closest.length).toBe(0);
      expect(result.status).toBe('PASS');
      expect(result.relationship_context).toBeNull();
    });

    it('includes relationship context in output even when leads exist', () => {
      const leads = [makeLead('A Corp', '1 Main St', 'p1')];
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        finalVerdict: 'pass',
        requestedCount: null,
        relationshipContext: {
          requires_relationship_evidence: true,
          detected_predicate: 'supplies',
          relationship_target: 'schools',
          verified_relationship_count: 0,
        },
      }));
      expect(result.relationship_context).toBeDefined();
      expect(result.relationship_context?.detected_predicate).toBe('supplies');
      expect(result.relationship_context?.relationship_target).toBe('schools');
    });
  });

  describe('terminal state consistency (Bug Fix 3)', () => {
    it('Tower PASS with delivered leads → status PASS or PARTIAL, never STOP', () => {
      const leads = Array.from({ length: 10 }, (_, i) =>
        makeLead(`Pub ${i + 1}`, `${i + 1} High St`, `p${i + 1}`)
      );
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        finalVerdict: 'pass',
        requestedCount: 10,
      }));
      expect(result.status).not.toBe('STOP');
      expect(['PASS', 'PARTIAL']).toContain(result.status);
      expect(result.trust_status).toBe('TRUSTED');
    });

    it('Tower PASS with 0 verified exact but leads delivered → not STOP', () => {
      const leads = Array.from({ length: 10 }, (_, i) =>
        makeLead(`Pub ${i + 1}`, `${i + 1} High St`, `p${i + 1}`)
      );
      const cvlVerifications = leads.map(l =>
        makeCvlLv(l.place_id!, l.name, 'unknown', false)
      );
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        finalVerdict: 'pass',
        requestedCount: 10,
        cvlVerifiedExactCount: 0,
        cvlLeadVerifications: cvlVerifications,
      }));
      expect(result.status).not.toBe('STOP');
      expect(['PASS', 'PARTIAL']).toContain(result.status);
    });

    it('Tower STOP → status STOP regardless of lead count', () => {
      const leads = Array.from({ length: 10 }, (_, i) =>
        makeLead(`Pub ${i + 1}`, `${i + 1} High St`, `p${i + 1}`)
      );
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        finalVerdict: 'stop',
        requestedCount: 10,
      }));
      expect(result.status).toBe('STOP');
      expect(result.trust_status).toBe('UNTRUSTED');
    });

    it('Tower PASS with verified exact >= requested → status PASS', () => {
      const leads = Array.from({ length: 10 }, (_, i) =>
        makeLead(`Pub ${i + 1}`, `${i + 1} High St`, `p${i + 1}`)
      );
      const cvlVerifications = leads.map(l =>
        makeCvlLv(l.place_id!, l.name, 'verified_geo', true)
      );
      const result = buildDeliverySummaryPayload(baseInput({
        leads,
        finalVerdict: 'pass',
        requestedCount: 10,
        cvlVerifiedExactCount: 10,
        cvlLeadVerifications: cvlVerifications,
      }));
      expect(result.status).toBe('PASS');
      expect(result.trust_status).toBe('TRUSTED');
    });
  });
});
