import { describe, it, expect } from 'vitest';
import { verifyLeads, type VerifiableLead } from './cvl';
import type { StructuredConstraint } from './goal-to-constraints';

function makeLead(overrides: Partial<VerifiableLead> = {}): VerifiableLead {
  return {
    name: 'Test Dental',
    address: '123 High Street, Crawley',
    phone: '01234 567890',
    website: 'https://test.com',
    placeId: 'place_1',
    source: 'google_places',
    lat: null,
    lng: null,
    ...overrides,
  };
}

function makeLocationConstraint(
  hard: boolean,
  location: string = 'sussex',
): StructuredConstraint {
  return {
    id: 'c_location',
    type: 'LOCATION_EQUALS',
    field: 'location',
    operator: '=',
    value: location,
    hard,
    rationale: `Location must be ${location}`,
  };
}

function makeCategoryConstraint(): StructuredConstraint {
  return {
    id: 'c_category',
    type: 'CATEGORY_EQUALS',
    field: 'business_type',
    operator: '=',
    value: 'dentists',
    hard: true,
    rationale: 'Business type is dentists',
  };
}

describe('CVL SEARCH_BOUNDED status for SOFT location constraints', () => {
  it('SOFT location + geo-verified lead => verified_exact=true, location_confidence=verified_geo', () => {
    const lead = makeLead({ lat: 51.1092, lng: -0.1872 });
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(false)];
    const result = verifyLeads([lead], constraints, null, 30, 1);

    expect(result.verified_exact_count).toBe(1);
    expect(result.leadVerifications[0].verified_exact).toBe(true);
    expect(result.leadVerifications[0].location_confidence).toBe('verified_geo');
    expect(result.summary.location_breakdown.verified_geo_count).toBe(1);
    expect(result.summary.location_breakdown.search_bounded_count).toBe(0);
  });

  it('SOFT location + no lat/lng => search_bounded status, verified_exact=true (soft satisfied)', () => {
    const lead = makeLead({ lat: null, lng: null });
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(false)];
    const result = verifyLeads([lead], constraints, null, 30, 1);

    expect(result.verified_exact_count).toBe(1);
    expect(result.leadVerifications[0].verified_exact).toBe(true);
    expect(result.leadVerifications[0].location_confidence).toBe('search_bounded');
    expect(result.summary.location_breakdown.search_bounded_count).toBe(1);
    expect(result.summary.location_breakdown.verified_geo_count).toBe(0);

    const locCheck = result.leadVerifications[0].constraint_checks.find(c => c.constraint_type === 'LOCATION_EQUALS');
    expect(locCheck?.status).toBe('search_bounded');
    expect(locCheck?.confidence).toBe('medium');
  });

  it('SOFT location + out_of_area lead => verified_exact=false, location_confidence=out_of_area', () => {
    const lead = makeLead({ lat: 53.4808, lng: -2.2426 });
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(false)];
    const result = verifyLeads([lead], constraints, null, 30, 1);

    expect(result.verified_exact_count).toBe(0);
    expect(result.leadVerifications[0].verified_exact).toBe(false);
    expect(result.leadVerifications[0].location_confidence).toBe('out_of_area');
    expect(result.summary.location_breakdown.out_of_area_count).toBe(1);
  });

  it('SOFT location + unknown region + no lat/lng => search_bounded, verified_exact=true', () => {
    const lead = makeLead({ lat: null, lng: null });
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(false, 'atlantis')];
    const result = verifyLeads([lead], constraints, null, 30, 1);

    expect(result.verified_exact_count).toBe(1);
    expect(result.leadVerifications[0].verified_exact).toBe(true);
    expect(result.leadVerifications[0].location_confidence).toBe('search_bounded');
  });
});

describe('CVL SEARCH_BOUNDED status for HARD location constraints', () => {
  it('HARD location + geo-verified lead => verified_exact=true, location_confidence=verified_geo', () => {
    const lead = makeLead({ lat: 51.1092, lng: -0.1872 });
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(true, 'west sussex')];
    const result = verifyLeads([lead], constraints, null, 30, 1);

    expect(result.verified_exact_count).toBe(1);
    expect(result.leadVerifications[0].verified_exact).toBe(true);
    expect(result.leadVerifications[0].all_hard_satisfied).toBe(true);
    expect(result.leadVerifications[0].location_confidence).toBe('verified_geo');
  });

  it('HARD location + no lat/lng => UNKNOWN (not search_bounded), verified_exact=false', () => {
    const lead = makeLead({ lat: null, lng: null });
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(true, 'west sussex')];
    const result = verifyLeads([lead], constraints, null, 30, 1);

    expect(result.verified_exact_count).toBe(0);
    expect(result.leadVerifications[0].verified_exact).toBe(false);
    expect(result.leadVerifications[0].all_hard_satisfied).toBe(false);
    expect(result.leadVerifications[0].location_confidence).toBe('unknown');

    const locCheck = result.leadVerifications[0].constraint_checks.find(c => c.constraint_type === 'LOCATION_EQUALS');
    expect(locCheck?.status).toBe('unknown');
    expect(locCheck?.hard).toBe(true);
  });

  it('HARD location + out_of_area lead => verified_exact=false', () => {
    const lead = makeLead({ lat: 53.4808, lng: -2.2426 });
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(true, 'west sussex')];
    const result = verifyLeads([lead], constraints, null, 30, 1);

    expect(result.verified_exact_count).toBe(0);
    expect(result.leadVerifications[0].verified_exact).toBe(false);
    expect(result.leadVerifications[0].all_hard_satisfied).toBe(false);
    expect(result.leadVerifications[0].location_confidence).toBe('out_of_area');
  });

  it('HARD location + unknown region => UNKNOWN, not SEARCH_BOUNDED', () => {
    const lead = makeLead({ lat: 51.0, lng: -0.5 });
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(true, 'atlantis')];
    const result = verifyLeads([lead], constraints, null, 30, 1);

    expect(result.verified_exact_count).toBe(0);
    expect(result.leadVerifications[0].verified_exact).toBe(false);
    expect(result.leadVerifications[0].all_hard_satisfied).toBe(false);

    const locCheck = result.leadVerifications[0].constraint_checks.find(c => c.constraint_type === 'LOCATION_EQUALS');
    expect(locCheck?.status).toBe('unknown');
  });
});

describe('CVL location_breakdown in summary', () => {
  it('mixed verification results produce correct location_breakdown', () => {
    const leads = [
      makeLead({ name: 'A', placeId: 'p1', lat: 51.1092, lng: -0.1872 }),
      makeLead({ name: 'B', placeId: 'p2', lat: null, lng: null }),
      makeLead({ name: 'C', placeId: 'p3', lat: 53.4808, lng: -2.2426 }),
    ];
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(false)];
    const result = verifyLeads(leads, constraints, null, 30, 3);

    expect(result.summary.location_breakdown.verified_geo_count).toBe(1);
    expect(result.summary.location_breakdown.search_bounded_count).toBe(1);
    expect(result.summary.location_breakdown.out_of_area_count).toBe(1);
    expect(result.summary.location_breakdown.unknown_count).toBe(0);

    expect(result.verified_exact_count).toBe(2);
  });

  it('no location constraint => all leads have location_confidence=not_applicable', () => {
    const leads = [makeLead({ lat: 51.1, lng: -0.1 })];
    const constraints = [makeCategoryConstraint()];
    const result = verifyLeads(leads, constraints, null, 30, 1);

    expect(result.leadVerifications[0].location_confidence).toBe('not_applicable');
    expect(result.summary.location_breakdown.verified_geo_count).toBe(0);
    expect(result.summary.location_breakdown.search_bounded_count).toBe(0);
  });

  it('constraint_results include leads_search_bounded count', () => {
    const leads = [
      makeLead({ name: 'A', placeId: 'p1', lat: null, lng: null }),
      makeLead({ name: 'B', placeId: 'p2', lat: 51.1092, lng: -0.1872 }),
    ];
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(false)];
    const result = verifyLeads(leads, constraints, null, 30, 2);

    const locResult = result.summary.constraint_results.find(cr => cr.constraint_type === 'LOCATION_EQUALS');
    expect(locResult?.leads_search_bounded).toBe(1);
    expect(locResult?.leads_passing).toBe(1);
    expect(locResult?.status).toBe('search_bounded');
  });
});

describe('CVL Sussex dentists acceptance test', () => {
  it('Sussex dentists with soft location + geo-verified leads => all verified_exact', () => {
    const sussexCoords = [
      { name: 'Sussex Dental Group - Crawley', lat: 51.1092, lng: -0.1872, placeId: 'p1' },
      { name: 'Gateway Dental | Burgess Hill', lat: 50.9535, lng: -0.1283, placeId: 'p2' },
      { name: 'Old Mill Dental Surgery', lat: 50.8900, lng: -0.3180, placeId: 'p3' },
      { name: 'Eastbourne Dental Clinic', lat: 50.7684, lng: 0.2905, placeId: 'p4' },
      { name: 'Brighton Smile Centre', lat: 50.8225, lng: -0.1372, placeId: 'p5' },
    ];

    const leads = sussexCoords.map(c => makeLead({ ...c }));
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(false)];
    const result = verifyLeads(leads, constraints, null, 30, 5);

    expect(result.verified_exact_count).toBe(5);
    for (const lv of result.leadVerifications) {
      expect(lv.verified_exact).toBe(true);
      expect(lv.location_confidence).toBe('verified_geo');
    }
    expect(result.summary.location_breakdown.verified_geo_count).toBe(5);
    expect(result.summary.location_breakdown.search_bounded_count).toBe(0);
    expect(result.summary.location_breakdown.out_of_area_count).toBe(0);
  });

  it('Sussex dentists without lat/lng => search_bounded, still verified_exact (soft)', () => {
    const leads = [
      makeLead({ name: 'A Dental', placeId: 'p1', lat: null, lng: null }),
      makeLead({ name: 'B Dental', placeId: 'p2', lat: null, lng: null }),
    ];
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(false)];
    const result = verifyLeads(leads, constraints, null, 30, 2);

    expect(result.verified_exact_count).toBe(2);
    for (const lv of result.leadVerifications) {
      expect(lv.verified_exact).toBe(true);
      expect(lv.location_confidence).toBe('search_bounded');
    }
  });

  it('Hard "must be in West Sussex" + no lat/lng => NOT verified_exact', () => {
    const leads = [
      makeLead({ name: 'A Dental', placeId: 'p1', lat: null, lng: null }),
    ];
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(true, 'west sussex')];
    const result = verifyLeads(leads, constraints, null, 30, 1);

    expect(result.verified_exact_count).toBe(0);
    expect(result.leadVerifications[0].verified_exact).toBe(false);
    expect(result.leadVerifications[0].location_confidence).toBe('unknown');
  });
});

describe('CVL searchWasBounded flag', () => {
  it('SOFT location + no lat/lng + searchWasBounded=true => search_bounded, verified_exact=true', () => {
    const lead = makeLead({ lat: null, lng: null });
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(false)];
    const result = verifyLeads([lead], constraints, null, 30, 1, undefined, true);

    expect(result.verified_exact_count).toBe(1);
    expect(result.leadVerifications[0].location_confidence).toBe('search_bounded');
  });

  it('SOFT location + no lat/lng + searchWasBounded=false => unknown, verified_exact=false', () => {
    const lead = makeLead({ lat: null, lng: null });
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(false)];
    const result = verifyLeads([lead], constraints, null, 30, 1, undefined, false);

    expect(result.verified_exact_count).toBe(0);
    expect(result.leadVerifications[0].verified_exact).toBe(false);
    expect(result.leadVerifications[0].location_confidence).toBe('unknown');

    const locCheck = result.leadVerifications[0].constraint_checks.find(c => c.constraint_type === 'LOCATION_EQUALS');
    expect(locCheck?.status).toBe('unknown');
    expect(locCheck?.reason).toContain('not bounded');
  });

  it('SOFT location + geo-verified lead + searchWasBounded=false => still verified_geo (geo overrides)', () => {
    const lead = makeLead({ lat: 51.1092, lng: -0.1872 });
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(false)];
    const result = verifyLeads([lead], constraints, null, 30, 1, undefined, false);

    expect(result.verified_exact_count).toBe(1);
    expect(result.leadVerifications[0].location_confidence).toBe('verified_geo');
  });

  it('SOFT location + out_of_area lead + searchWasBounded=false => still out_of_area', () => {
    const lead = makeLead({ lat: 53.4808, lng: -2.2426 });
    const constraints = [makeCategoryConstraint(), makeLocationConstraint(false)];
    const result = verifyLeads([lead], constraints, null, 30, 1, undefined, false);

    expect(result.verified_exact_count).toBe(0);
    expect(result.leadVerifications[0].location_confidence).toBe('out_of_area');
  });
});
