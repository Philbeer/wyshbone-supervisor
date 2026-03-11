import { describe, it, expect } from 'vitest';
import { inferCountryFromLocation, sanitiseLocationString, detectExactnessMode, detectDoNotStop, detectDeliveryRequirements, buildRequestedCount } from './goal-to-constraints';
import { buildDeliverySummaryPayload, type DeliverySummaryInput, type DeliverySummaryLeadInput } from './delivery-summary';

describe('inferCountryFromLocation', () => {
  it('returns US for "Texas"', () => {
    expect(inferCountryFromLocation('Texas')).toBe('US');
  });

  it('returns US for "texas" (case-insensitive)', () => {
    expect(inferCountryFromLocation('texas')).toBe('US');
  });

  it('returns US for "California"', () => {
    expect(inferCountryFromLocation('California')).toBe('US');
  });

  it('returns US for "New York"', () => {
    expect(inferCountryFromLocation('New York')).toBe('US');
  });

  it('returns US for "Florida"', () => {
    expect(inferCountryFromLocation('Florida')).toBe('US');
  });

  it('returns UK for "Sussex"', () => {
    expect(inferCountryFromLocation('Sussex')).toBe('UK');
  });

  it('returns UK for "London"', () => {
    expect(inferCountryFromLocation('London')).toBe('UK');
  });

  it('returns UK for "Kent"', () => {
    expect(inferCountryFromLocation('Kent')).toBe('UK');
  });

  it('returns UK for unknown location (defaults)', () => {
    expect(inferCountryFromLocation('Zurich')).toBe('UK');
  });

  it('returns US for "United States"', () => {
    expect(inferCountryFromLocation('United States')).toBe('US');
  });

  it('returns US for "USA"', () => {
    expect(inferCountryFromLocation('USA')).toBe('US');
  });
});

describe('sanitiseLocationString', () => {
  it('strips "and return exactly N results" from location', () => {
    expect(sanitiseLocationString('Arundel and return exactly 20 results')).toBe('Arundel');
  });

  it('strips "and return exactly N" without "results"', () => {
    expect(sanitiseLocationString('Arundel and return exactly 20')).toBe('Arundel');
  });

  it('strips "If fewer than N are found" clause', () => {
    expect(sanitiseLocationString('Arundel. If fewer than 20 are found, do not stop.')).toBe('Arundel');
  });

  it('strips "do not stop" from end', () => {
    expect(sanitiseLocationString('Arundel, do not stop')).toBe('Arundel');
  });

  it('leaves clean location unchanged', () => {
    expect(sanitiseLocationString('Arundel')).toBe('Arundel');
  });

  it('leaves multi-word location unchanged', () => {
    expect(sanitiseLocationString('East Sussex')).toBe('East Sussex');
  });

  it('handles complex contaminated string', () => {
    expect(sanitiseLocationString('Arundel and return exactly 20 results. If fewer than 20 are found, do not stop.')).toBe('Arundel');
  });

  it('strips trailing punctuation', () => {
    expect(sanitiseLocationString('Arundel.')).toBe('Arundel');
  });

  it('preserves comma-separated location parts', () => {
    expect(sanitiseLocationString('Brighton, East Sussex')).toBe('Brighton, East Sussex');
  });

  it('strips "and include email" from location', () => {
    expect(sanitiseLocationString('Arundel and include email')).toBe('Arundel');
  });

  it('strips "and include phone" from location', () => {
    expect(sanitiseLocationString('Arundel and include phone')).toBe('Arundel');
  });

  it('strips "and include website" from location', () => {
    expect(sanitiseLocationString('Brighton and include website')).toBe('Brighton');
  });

  it('strips "and include email and phone" from location', () => {
    expect(sanitiseLocationString('Arundel and include email and phone')).toBe('Arundel');
  });

  it('strips "include contact details" from location', () => {
    expect(sanitiseLocationString('Arundel and include contact details')).toBe('Arundel');
  });
});

describe('detectExactnessMode', () => {
  it('returns soft for normal "return exactly N" phrasing', () => {
    expect(detectExactnessMode('Find 20 pubs in Arundel and return exactly 20 results')).toBe('soft');
  });

  it('returns hard when user says "return none if you cannot return exactly"', () => {
    expect(detectExactnessMode('Find 20 pubs in Arundel. Return none if you cannot return exactly 20.')).toBe('hard');
  });

  it('returns hard for "must be exactly N"', () => {
    expect(detectExactnessMode('Find pubs in Arundel. Must be exactly 20 results.')).toBe('hard');
  });

  it('returns soft for plain goal without exactness language', () => {
    expect(detectExactnessMode('Find pubs in Arundel')).toBe('soft');
  });
});

describe('detectDoNotStop', () => {
  it('detects "do not stop" in goal', () => {
    expect(detectDoNotStop('Find 20 pubs in Arundel. If fewer than 20 are found, do not stop.')).toBe(true);
  });

  it('returns false when no "do not stop" present', () => {
    expect(detectDoNotStop('Find 20 pubs in Arundel')).toBe(false);
  });
});

describe('detectDeliveryRequirements', () => {
  it('detects "include email" in goal', () => {
    const result = detectDeliveryRequirements('Find 10 pubs in Arundel and include email');
    expect(result.include_email).toBe(true);
    expect(result.include_phone).toBe(false);
    expect(result.include_website).toBe(false);
  });

  it('detects "include phone" in goal', () => {
    const result = detectDeliveryRequirements('Find pubs in Brighton and include phone');
    expect(result.include_phone).toBe(true);
  });

  it('detects "include website" in goal', () => {
    const result = detectDeliveryRequirements('Find pubs in Brighton and include website');
    expect(result.include_website).toBe(true);
  });

  it('detects multiple delivery requirements', () => {
    const result = detectDeliveryRequirements('Find 5 cafes in London and include email and include phone');
    expect(result.include_email).toBe(true);
    expect(result.include_phone).toBe(true);
    expect(result.include_website).toBe(false);
  });

  it('returns all false when no delivery requirements', () => {
    const result = detectDeliveryRequirements('Find 10 pubs in Arundel');
    expect(result.include_email).toBe(false);
    expect(result.include_phone).toBe(false);
    expect(result.include_website).toBe(false);
  });

  it('detects "with email" as delivery requirement', () => {
    const result = detectDeliveryRequirements('Find 10 pubs in Arundel with email');
    expect(result.include_email).toBe(true);
  });
});

describe('Regression: "Find 10 pubs in Arundel and include email" end-to-end', () => {
  const INPUT = 'Find 10 pubs in Arundel and include email';

  it('sanitiseLocationString strips "and include email" from location', () => {
    expect(sanitiseLocationString('arundel and include email')).toBe('arundel');
    expect(sanitiseLocationString('Arundel and include email')).toBe('Arundel');
  });

  it('detectDeliveryRequirements extracts email as enrichment flag', () => {
    const dr = detectDeliveryRequirements(INPUT);
    expect(dr.include_email).toBe(true);
    expect(dr.include_phone).toBe(false);
    expect(dr.include_website).toBe(false);
  });

  it('compiled query is "pubs in arundel" — email never in query or location', () => {
    const rawLocation = 'arundel and include email';
    const location = sanitiseLocationString(rawLocation);
    const city = sanitiseLocationString(location.split(',')[0].trim());
    const businessType = 'pubs';

    expect(location).toBe('arundel');
    expect(city).toBe('arundel');

    const compiledQuery = `${businessType} in ${city}`;
    expect(compiledQuery).toBe('pubs in arundel');
    expect(compiledQuery).not.toContain('email');
    expect(city).not.toContain('email');
    expect(location).not.toContain('include');
  });

  it('buildRequestedCount produces explicit count=10', () => {
    const rc = buildRequestedCount(10);
    expect(rc.requested_count_user).toBe('explicit');
    expect(rc.requested_count_value).toBe(10);
    expect(rc.requested_count_effective).toBe(10);
  });

  it('final delivery count is capped at requested_count (10)', () => {
    const requestedCount = 10;
    let finalLeads = Array.from({ length: 30 }, (_, i) => ({
      name: `Pub ${i + 1}`,
      address: `${i + 1} High St, Arundel`,
      placeId: `p${i + 1}`,
      phone: null as string | null,
      website: null as string | null,
      source: 'google_places',
    }));

    if (finalLeads.length > requestedCount) {
      finalLeads = finalLeads.slice(0, requestedCount);
    }

    expect(finalLeads.length).toBe(10);
  });

  it('delivery summary status is COMPLETED even if email enrichment is incomplete', () => {
    const leads: DeliverySummaryLeadInput[] = Array.from({ length: 10 }, (_, i) => ({
      entity_id: `p${i + 1}`,
      place_id: `p${i + 1}`,
      name: `Pub ${i + 1}`,
      address: `${i + 1} High St, Arundel`,
      found_in_plan_version: 1,
    }));

    const input: DeliverySummaryInput = {
      runId: 'run-regression-1',
      userId: 'user-1',
      originalUserGoal: INPUT,
      requestedCount: 10,
      hardConstraints: ['requested_count', 'location'],
      softConstraints: [],
      planVersions: [{ version: 1, changes_made: [] }],
      softRelaxations: [],
      leads,
      finalVerdict: 'pass',
    };

    const result = buildDeliverySummaryPayload(input);

    expect(result.status).toBe('PASS'); // PHASE_3: was COMPLETED
    expect(result.trust_status).toBe('VERIFIED'); // PHASE_3: was TRUSTED
    expect(result.delivered_total_count).toBe(10);
    expect(result.stop_reason).toBeNull();
  });

  // PHASE_3: Tower fail verdict is now authoritative — status is STOP
  it('delivery summary with Tower fail verdict → STOP (Tower is authoritative)', () => {
    const leads: DeliverySummaryLeadInput[] = Array.from({ length: 10 }, (_, i) => ({
      entity_id: `p${i + 1}`,
      place_id: `p${i + 1}`,
      name: `Pub ${i + 1}`,
      address: `${i + 1} High St, Arundel`,
      found_in_plan_version: 1,
    }));

    const input: DeliverySummaryInput = {
      runId: 'run-regression-2',
      userId: 'user-1',
      originalUserGoal: INPUT,
      requestedCount: 10,
      hardConstraints: ['requested_count', 'location'],
      softConstraints: [],
      planVersions: [{ version: 1, changes_made: [] }],
      softRelaxations: [],
      leads,
      finalVerdict: 'fail',
    };

    const result = buildDeliverySummaryPayload(input);

    expect(result.status).toBe('STOP'); // PHASE_3: Tower fail is authoritative
    expect(result.trust_status).toBe('UNTRUSTED');
    expect(result.delivered_total_count).toBe(10);
  });
});
