import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { evaluateClarifyGate, evaluateClarifyGateFromIntent, checkLocationValidity, _setLocationValidityOverride, extractBusinessType, extractLocation, extractCount, extractTimeFilter } from './clarify-gate';
import type { CanonicalIntent } from './canonical-intent';

const MOCK_FICTIONAL = new Set(['narnia', 'mordor', 'hogwarts', 'wakanda', 'westeros', 'nowhere']);
const MOCK_NONSENSE = new Set(['amazingville']);
const MOCK_AMBIGUOUS = new Set(['grimbleshire']);

before(() => {
  _setLocationValidityOverride(async (loc: string) => {
    const lower = loc.toLowerCase();
    if (MOCK_FICTIONAL.has(lower)) return { verdict: 'fictional' as const, confidence: 1, reason: 'mock' };
    if (MOCK_NONSENSE.has(lower)) return { verdict: 'nonsense' as const, confidence: 1, reason: 'mock' };
    if (MOCK_AMBIGUOUS.has(lower)) return { verdict: 'ambiguous' as const, confidence: 0.4, reason: 'mock' };
    return { verdict: 'real' as const, confidence: 1, reason: 'mock' };
  });
});

after(() => {
  _setLocationValidityOverride(null);
});

describe('ClarifyGate — tightened gate: only empty, nonsense, or multiple concatenated requests trigger clarify', () => {

  describe('Empty input → clarify_before_run with triggerCategory=empty', () => {
    it('empty string → clarify_before_run', async () => {
      const result = await evaluateClarifyGate('');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'empty');
    });

    it('whitespace-only string → clarify_before_run', async () => {
      const result = await evaluateClarifyGate('   ');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'empty');
    });
  });

  describe('Nonsense/unintelligible input → clarify_before_run with triggerCategory=malformed', () => {
    it('"asdfgh jklzxcv qwerty" → clarify_before_run (gibberish)', async () => {
      const result = await evaluateClarifyGate('asdfgh jklzxcv qwerty');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'malformed');
    });

    it('"zzzz xxxx yyyy wwww" → clarify_before_run (nonsense words)', async () => {
      const result = await evaluateClarifyGate('zzzz xxxx yyyy wwww');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'malformed');
    });

    it('"bloop flarp snorkel wagwag" → clarify_before_run (nonsense)', async () => {
      const result = await evaluateClarifyGate('bloop flarp snorkel wagwag');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'malformed');
    });
  });

  describe('Multiple concatenated requests → clarify_before_run with triggerCategory=multiple_requests', () => {
    it('"find pubs in LeedsShow me cafes in Bristol" → clarify_before_run (no space between sentences)', async () => {
      const result = await evaluateClarifyGate('find pubs in LeedsShow me cafes in Bristol');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'multiple_requests');
    });

    it('"find pubs in Leeds and also find cafes in Bristol" → clarify_before_run (mixed intent)', async () => {
      const result = await evaluateClarifyGate('find pubs in Leeds and also find cafes in Bristol');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'multiple_requests');
    });

    it('"find pubs in Leeds and find restaurants in Manchester" → clarify_before_run', async () => {
      const result = await evaluateClarifyGate('find pubs in Leeds and find restaurants in Manchester');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'multiple_requests');
    });

    it('"list bars in Brighton plus find cafes in Bath" → clarify_before_run', async () => {
      const result = await evaluateClarifyGate('list bars in Brighton plus find cafes in Bath');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'multiple_requests');
    });
  });

  describe('Normal single requests proceed to agent_run (no false positives)', () => {
    it('"find cafes in Bristol" → agent_run', async () => {
      const result = await evaluateClarifyGate('find cafes in Bristol');
      assert.strictEqual(result.route, 'agent_run');
      assert.strictEqual(result.triggerCategory, undefined);
    });

    it('"cafes in Bristol" → agent_run', async () => {
      const result = await evaluateClarifyGate('cafes in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find pubs in West Sussex" → agent_run', async () => {
      const result = await evaluateClarifyGate('find pubs in West Sussex');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find 10 micropubs in Brighton" → agent_run', async () => {
      const result = await evaluateClarifyGate('find 10 micropubs in Brighton');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"list restaurants in Manchester" → agent_run', async () => {
      const result = await evaluateClarifyGate('list restaurants in Manchester');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"show me breweries in Portland" → agent_run', async () => {
      const result = await evaluateClarifyGate('show me breweries in Portland');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find 5 pubs in Arundel" → agent_run', async () => {
      const result = await evaluateClarifyGate('find 5 pubs in Arundel');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find 5 pubs in Arundel with emails" → agent_run', async () => {
      const result = await evaluateClarifyGate('find 5 pubs in Arundel with emails');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('Imperfect but single requests now proceed to agent_run (gate relaxed)', () => {
    it('"find the best cafes in Bristol" → agent_run (subjective now allowed through)', async () => {
      const result = await evaluateClarifyGate('find the best cafes in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find nice pubs in Bristol" → agent_run (subjective now allowed through)', async () => {
      const result = await evaluateClarifyGate('find nice pubs in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find good cafes in Manchester" → agent_run (subjective now allowed through)', async () => {
      const result = await evaluateClarifyGate('find good cafes in Manchester');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find top pubs in Bristol" → agent_run (subjective now allowed through)', async () => {
      const result = await evaluateClarifyGate('find top pubs in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find the coolest bars in London" → agent_run (subjective now allowed through)', async () => {
      const result = await evaluateClarifyGate('find the coolest bars in London');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find the most fun cafes in Leeds" → agent_run (subjective now allowed through)', async () => {
      const result = await evaluateClarifyGate('find the most fun cafes in Leeds');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find best pubs with live music in Brighton" → agent_run (subjective + measurable, allowed through)', async () => {
      const result = await evaluateClarifyGate('find best pubs with live music in Brighton');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find dog friendly cafes in Bath" → agent_run (measurable, no subjective)', async () => {
      const result = await evaluateClarifyGate('find dog friendly cafes in Bath');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find pubs near council things" → agent_run (imperfect location, single request)', async () => {
      const result = await evaluateClarifyGate('find pubs near council things');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find restaurants near council stuff" → agent_run (imperfect location, single request)', async () => {
      const result = await evaluateClarifyGate('find restaurants near council stuff');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find pubs near the council in Leeds" → agent_run (vague proximity with real location, allowed through)', async () => {
      const result = await evaluateClarifyGate('find pubs near the council in Leeds');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find cafes in Leeds near the council" → agent_run (location-first vague proximity, allowed through)', async () => {
      const result = await evaluateClarifyGate('find cafes in Leeds near the council');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"Find good cafes" → clarify_before_run (missing location, entity discovery requires location)', async () => {
      const result = await evaluateClarifyGate('Find good cafes');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.deepStrictEqual(result.missingFields, ['location']);
      assert.deepStrictEqual(result.questions, ['Where should I search?']);
    });

    it('"find places with good atmosphere in Leeds" → agent_run (vague entity + subjective, allowed)', async () => {
      const result = await evaluateClarifyGate('find places with good atmosphere in Leeds');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find cafes good for studying in Bristol" → agent_run (measurable)', async () => {
      const result = await evaluateClarifyGate('find cafes good for studying in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find great cafes in Bristol" → agent_run (subjective allowed through)', async () => {
      const result = await evaluateClarifyGate('Find great cafes in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find cool bars in Leeds" → agent_run (subjective allowed through)', async () => {
      const result = await evaluateClarifyGate('Find cool bars in Leeds');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find lovely cafes in Bath" → agent_run (subjective allowed through)', async () => {
      const result = await evaluateClarifyGate('Find lovely cafes in Bath');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find decent pubs in Manchester" → agent_run (subjective allowed through)', async () => {
      const result = await evaluateClarifyGate('Find decent pubs in Manchester');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find chill bars in Brighton" → agent_run (subjective allowed through)', async () => {
      const result = await evaluateClarifyGate('Find chill bars in Brighton');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find best bars with nightlife in Manchester" → agent_run', async () => {
      const result = await evaluateClarifyGate('find best bars with nightlife in Manchester');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find nicest scenic restaurants in Cornwall" → agent_run', async () => {
      const result = await evaluateClarifyGate('find nicest scenic restaurants in Cornwall');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find good pubs with live music in Bristol" → agent_run', async () => {
      const result = await evaluateClarifyGate('find good pubs with live music in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find nice bars with outdoor seating in Leeds" → agent_run', async () => {
      const result = await evaluateClarifyGate('find nice bars with outdoor seating in Leeds');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('Measurable-only queries still run (no false positives)', () => {
    it('"find cafes in Bristol that are quiet" → agent_run', async () => {
      const result = await evaluateClarifyGate('find cafes in Bristol that are quiet');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find lively bars in Manchester" → agent_run', async () => {
      const result = await evaluateClarifyGate('find lively bars in Manchester');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find cosy pubs with live music in Bristol" → agent_run', async () => {
      const result = await evaluateClarifyGate('find cosy pubs with live music in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('Direct response routing preserved', () => {
    it('"best practices for marketing" → direct_response (not search)', async () => {
      const result = await evaluateClarifyGate('best practices for marketing');
      assert.notStrictEqual(result.route, 'clarify_before_run');
    });

    it('"What is Wyshbone and can it lie?" → direct_response', async () => {
      const result = await evaluateClarifyGate('What is Wyshbone and can it lie?');
      assert.strictEqual(result.route, 'direct_response');
    });

    it('"What is Wyshbone?" → direct_response', async () => {
      const result = await evaluateClarifyGate('What is Wyshbone?');
      assert.strictEqual(result.route, 'direct_response');
    });

    it('"Can it lie?" → direct_response', async () => {
      const result = await evaluateClarifyGate('Can it lie?');
      assert.strictEqual(result.route, 'direct_response');
    });

    it('"Is Wyshbone trustworthy?" → direct_response', async () => {
      const result = await evaluateClarifyGate('Is Wyshbone trustworthy?');
      assert.strictEqual(result.route, 'direct_response');
    });
  });

  describe('triggerCategory diagnostic field', () => {
    it('empty input has triggerCategory=empty', async () => {
      const result = await evaluateClarifyGate('');
      assert.strictEqual(result.triggerCategory, 'empty');
    });

    it('nonsense input has triggerCategory=malformed', async () => {
      const result = await evaluateClarifyGate('qwertyuiop asdfghjkl zxcvbnm');
      assert.strictEqual(result.triggerCategory, 'malformed');
    });

    it('concatenated requests have triggerCategory=multiple_requests', async () => {
      const result = await evaluateClarifyGate('find pubs in LeedsShow me cafes in Bristol');
      assert.strictEqual(result.triggerCategory, 'multiple_requests');
    });

    it('agent_run has no triggerCategory', async () => {
      const result = await evaluateClarifyGate('find pubs in Bristol');
      assert.strictEqual(result.triggerCategory, undefined);
    });

    it('direct_response has no triggerCategory', async () => {
      const result = await evaluateClarifyGate('What is Wyshbone?');
      assert.strictEqual(result.triggerCategory, undefined);
    });
  });

  describe('Short valid inputs are NOT misclassified as nonsense', () => {
    it('"pubs in UK" → agent_run (short but valid)', async () => {
      const result = await evaluateClarifyGate('pubs in UK');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"cafes London" → agent_run (short but valid)', async () => {
      const result = await evaluateClarifyGate('cafes London');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find pubs" → clarify_before_run (entity discovery missing location)', async () => {
      const result = await evaluateClarifyGate('find pubs');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.deepStrictEqual(result.missingFields, ['location']);
      assert.deepStrictEqual(result.questions, ['Where should I search?']);
    });

    it('"bars Brighton" → agent_run (short but valid)', async () => {
      const result = await evaluateClarifyGate('bars Brighton');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"restaurants" → agent_run (single word but valid noun)', async () => {
      const result = await evaluateClarifyGate('restaurants');
      assert.strictEqual(result.route, 'agent_run');
    });
  });
});

describe('Intent preview extractors — regex-based field extraction for intent_preview artefacts', () => {

  describe('extractBusinessType', () => {
    it('extracts entity from "find gyms in London"', async () => {
      assert.strictEqual(extractBusinessType('find gyms in London'), 'gyms');
    });

    it('extracts entity from "list restaurants in Manchester"', async () => {
      assert.strictEqual(extractBusinessType('list restaurants in Manchester'), 'restaurants');
    });

    it('extracts entity with count from "find 10 micropubs in Brighton"', async () => {
      assert.strictEqual(extractBusinessType('find 10 micropubs in Brighton'), 'micropubs');
    });

    it('strips time filter from entity: "find gyms in London that opened in the last 6 months"', async () => {
      const bt = extractBusinessType('find gyms in London that opened in the last 6 months');
      assert.strictEqual(bt, 'gyms');
    });

    it('returns null for empty string', async () => {
      assert.strictEqual(extractBusinessType(''), null);
    });
  });

  describe('extractLocation', () => {
    it('extracts "London" from "find gyms in London"', async () => {
      assert.strictEqual(extractLocation('find gyms in London'), 'London');
    });

    it('extracts "West Sussex" from "find pubs in West Sussex"', async () => {
      assert.strictEqual(extractLocation('find pubs in West Sussex'), 'West Sussex');
    });

    it('returns null when no location present', async () => {
      assert.strictEqual(extractLocation('find pubs'), null);
    });
  });

  describe('extractCount', () => {
    it('extracts 10 from "find 10 pubs in Leeds"', async () => {
      assert.strictEqual(extractCount('find 10 pubs in Leeds'), 10);
    });

    it('returns null when no count present', async () => {
      assert.strictEqual(extractCount('find pubs in Leeds'), null);
    });

    it('does not extract temporal numbers: "last 6 months" should not return 6', async () => {
      const count = extractCount('find gyms in London that opened in the last 6 months');
      assert.strictEqual(count, null);
    });
  });

  describe('extractTimeFilter', () => {
    it('extracts "last 6 months" from "opened in the last 6 months"', async () => {
      const tf = extractTimeFilter('find gyms in London that opened in the last 6 months');
      assert.ok(tf !== null, 'timeFilter should not be null');
      assert.ok(tf!.includes('last'), `timeFilter "${tf}" should contain "last"`);
      assert.ok(tf!.includes('6'), `timeFilter "${tf}" should contain "6"`);
      assert.ok(tf!.includes('month'), `timeFilter "${tf}" should contain "month"`);
    });

    it('returns null when no time filter present', async () => {
      assert.strictEqual(extractTimeFilter('find pubs in Bristol'), null);
    });
  });

  describe('clarify_before_run produces preview-compatible parsedFields', () => {
    it('multiple_requests route includes parsedFields with extracted data', async () => {
      const result = await evaluateClarifyGate('find pubs in Leeds and also find cafes in Bristol');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.parsedFields, 'parsedFields should exist');
      assert.ok(result.parsedFields!.businessType !== undefined, 'businessType should be defined');
      assert.ok(result.parsedFields!.location !== undefined, 'location should be defined');
    });

    it('empty input route includes parsedFields (all null)', async () => {
      const result = await evaluateClarifyGate('');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.parsedFields, 'parsedFields should exist');
      assert.strictEqual(result.parsedFields!.businessType, null);
      assert.strictEqual(result.parsedFields!.location, null);
    });

    it('extractors work independently on clarify_before_run messages', async () => {
      const msg = 'find pubs in LeedsShow me cafes in Bristol';
      const result = await evaluateClarifyGate(msg);
      assert.strictEqual(result.route, 'clarify_before_run');
      const bt = extractBusinessType(msg);
      const loc = extractLocation(msg);
      assert.ok(bt !== null || loc !== null, 'at least one field should be extracted from malformed input');
    });
  });
});

function makeIntent(overrides: Partial<CanonicalIntent>): CanonicalIntent {
  return {
    mission_type: 'find_businesses',
    entity_kind: 'venue',
    entity_category: 'pubs',
    location_text: null,
    geo_mode: 'unspecified',
    radius_km: null,
    requested_count: null,
    default_count_policy: 'page_1',
    constraints: [],
    plan_template_hint: 'simple_search',
    preferred_evidence_order: ['google_places'],
    ...overrides,
  };
}

describe('ClarifyGateFromIntent — entity discovery missing-location gate', () => {

  describe('find_businesses without location triggers clarify', () => {
    it('"Find breweries" with no location → clarify_before_run', async () => {
      const intent = makeIntent({ entity_category: 'breweries', location_text: null });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find breweries');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.deepStrictEqual(result.missingFields, ['location']);
      assert.deepStrictEqual(result.questions, ['Where should I search?']);
    });

    it('"Find dentists" with no location → clarify_before_run', async () => {
      const intent = makeIntent({ entity_category: 'dentists', location_text: null });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find dentists');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.deepStrictEqual(result.missingFields, ['location']);
    });

    it('"Find pubs" with empty-string location → clarify_before_run', async () => {
      const intent = makeIntent({ entity_category: 'pubs', location_text: '' });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find pubs');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.deepStrictEqual(result.missingFields, ['location']);
    });
  });

  describe('deep_research without location triggers clarify', () => {
    it('"Research breweries" with no location → clarify_before_run', async () => {
      const intent = makeIntent({ mission_type: 'deep_research', entity_category: 'breweries', location_text: null });
      const result = await evaluateClarifyGateFromIntent(intent, 'Research breweries');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.deepStrictEqual(result.missingFields, ['location']);
    });
  });

  describe('find_businesses WITH location proceeds to agent_run', () => {
    it('"Find breweries in Brighton" → agent_run', async () => {
      const intent = makeIntent({ entity_category: 'breweries', location_text: 'Brighton' });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find breweries in Brighton');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('global-by-design queries bypass missing-location gate', () => {
    it('"largest breweries in the world" → agent_run (global scope)', async () => {
      const intent = makeIntent({ entity_category: 'breweries', location_text: null });
      const result = await evaluateClarifyGateFromIntent(intent, 'largest breweries in the world');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find companies worldwide" → agent_run (global scope)', async () => {
      const intent = makeIntent({ entity_category: 'companies', location_text: null });
      const result = await evaluateClarifyGateFromIntent(intent, 'find companies worldwide');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"breweries around the world" → agent_run (global scope)', async () => {
      const intent = makeIntent({ entity_category: 'breweries', location_text: null });
      const result = await evaluateClarifyGateFromIntent(intent, 'breweries around the world');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('monitor mission type bypasses missing-location gate', () => {
    it('monitor mission without location → agent_run', async () => {
      const intent = makeIntent({ mission_type: 'monitor', entity_category: 'breweries', location_text: null });
      const result = await evaluateClarifyGateFromIntent(intent, 'monitor breweries');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('clarify result contains correct parsedFields', () => {
    it('parsedFields include business type from intent', async () => {
      const intent = makeIntent({ entity_category: 'breweries', location_text: null, requested_count: 10 });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find 10 breweries');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.parsedFields?.businessType, 'breweries');
      assert.strictEqual(result.parsedFields?.location, null);
      assert.strictEqual(result.parsedFields?.count, 10);
      assert.strictEqual(result.semantic_source, 'canonical');
    });
  });
});

describe('ClarifyGate regex — entity discovery missing-location gate', () => {

  it('"Find breweries" → clarify_before_run', async () => {
    const result = await evaluateClarifyGate('Find breweries');
    assert.strictEqual(result.route, 'clarify_before_run');
    assert.deepStrictEqual(result.missingFields, ['location']);
    assert.deepStrictEqual(result.questions, ['Where should I search?']);
  });

  it('"Find dentists" → clarify_before_run', async () => {
    const result = await evaluateClarifyGate('Find dentists');
    assert.strictEqual(result.route, 'clarify_before_run');
    assert.deepStrictEqual(result.missingFields, ['location']);
  });

  it('"Find breweries in Brighton" → agent_run', async () => {
    const result = await evaluateClarifyGate('Find breweries in Brighton');
    assert.strictEqual(result.route, 'agent_run');
  });

  it('"largest breweries in the world" → agent_run (global-by-design bypass)', async () => {
    const result = await evaluateClarifyGate('largest breweries in the world');
    assert.strictEqual(result.route, 'agent_run');
  });
});

// CLARIFY_GATE_FIX: Tests for fictional/unrecognised location handling
describe('ClarifyGate — location validity and refuse route', () => {

  describe('checkLocationValidity', () => {
    it('Narnia → fictional', async () => {
      assert.strictEqual(await checkLocationValidity('Narnia'), 'fictional');
    });

    it('Mordor → fictional', async () => {
      assert.strictEqual(await checkLocationValidity('Mordor'), 'fictional');
    });

    it('Hogwarts → fictional', async () => {
      assert.strictEqual(await checkLocationValidity('Hogwarts'), 'fictional');
    });

    it('Wakanda → fictional', async () => {
      assert.strictEqual(await checkLocationValidity('Wakanda'), 'fictional');
    });

    it('Brighton → recognised', async () => {
      assert.strictEqual(await checkLocationValidity('Brighton'), 'recognised');
    });

    it('York → recognised', async () => {
      assert.strictEqual(await checkLocationValidity('York'), 'recognised');
    });

    it('London → recognised', async () => {
      assert.strictEqual(await checkLocationValidity('London'), 'recognised');
    });

    it('West Sussex → recognised', async () => {
      assert.strictEqual(await checkLocationValidity('West Sussex'), 'recognised');
    });

    it('Arundel → recognised (LLM confirms it is a real place)', async () => {
      assert.strictEqual(await checkLocationValidity('Arundel'), 'recognised');
    });

    it('null → unrecognised', async () => {
      assert.strictEqual(await checkLocationValidity(null), 'unrecognised');
    });

    it('empty string → unrecognised', async () => {
      assert.strictEqual(await checkLocationValidity(''), 'unrecognised');
    });

    it('"nowhere" → fictional', async () => {
      assert.strictEqual(await checkLocationValidity('nowhere'), 'fictional');
    });
  });

  describe('Regex gate: fictional locations → refuse', () => {
    it('"Find pubs in Narnia" → refuse', async () => {
      const result = await evaluateClarifyGate('Find pubs in Narnia');
      assert.strictEqual(result.route, 'refuse');
      assert.strictEqual(result.triggerCategory, 'fictional_location');
      assert.ok(result.questions![0].includes('not a real location'));
    });

    it('"Find cafes in Mordor" → refuse', async () => {
      const result = await evaluateClarifyGate('Find cafes in Mordor');
      assert.strictEqual(result.route, 'refuse');
      assert.strictEqual(result.triggerCategory, 'fictional_location');
    });

    it('"Find restaurants in Hogwarts" → refuse', async () => {
      const result = await evaluateClarifyGate('Find restaurants in Hogwarts');
      assert.strictEqual(result.route, 'refuse');
      assert.strictEqual(result.triggerCategory, 'fictional_location');
    });

    it('"Find bars in Westeros" → refuse', async () => {
      const result = await evaluateClarifyGate('Find bars in Westeros');
      assert.strictEqual(result.route, 'refuse');
      assert.strictEqual(result.triggerCategory, 'fictional_location');
    });
  });

  describe('Regex gate: real locations still proceed', () => {
    it('"Find cafes in York" → agent_run', async () => {
      const result = await evaluateClarifyGate('Find cafes in York');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"Find pubs in Arundel" → agent_run (unrecognised but not fictional)', async () => {
      const result = await evaluateClarifyGate('Find pubs in Arundel');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"Find 5 pubs in Arundel" → agent_run', async () => {
      const result = await evaluateClarifyGate('find 5 pubs in Arundel');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('Intent gate: fictional locations → refuse', () => {
    it('"Find pubs in Narnia" with canonical intent → refuse', async () => {
      const intent = makeIntent({ entity_category: 'pubs', location_text: 'Narnia' });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find pubs in Narnia');
      assert.strictEqual(result.route, 'refuse');
      assert.strictEqual(result.triggerCategory, 'fictional_location');
      assert.ok(result.questions![0].includes('not a real location'));
    });

    it('"Find breweries in Mordor" with canonical intent → refuse', async () => {
      const intent = makeIntent({ entity_category: 'breweries', location_text: 'Mordor' });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find breweries in Mordor');
      assert.strictEqual(result.route, 'refuse');
      assert.strictEqual(result.triggerCategory, 'fictional_location');
    });
  });

  describe('Intent gate: real locations still proceed', () => {
    it('"Find cafes in York" with canonical intent → agent_run', async () => {
      const intent = makeIntent({ entity_category: 'cafes', location_text: 'York' });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find cafes in York');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"Find pubs in Arundel" with canonical intent → agent_run (unrecognised but no delegatedClarify)', async () => {
      const intent = makeIntent({ entity_category: 'pubs', location_text: 'Arundel' });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find pubs in Arundel');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('Fictional locations refuse even with monitoring intent', () => {
    it('"monitor pubs in Narnia" regex → refuse (fictional beats monitoring)', async () => {
      const result = await evaluateClarifyGate('monitor pubs in Narnia');
      assert.strictEqual(result.route, 'refuse');
      assert.strictEqual(result.triggerCategory, 'fictional_location');
    });

    it('"monitor pubs in Narnia" intent → refuse (fictional beats monitoring)', async () => {
      const intent = makeIntent({ entity_category: 'pubs', location_text: 'Narnia' });
      (intent as any).mission_type = 'monitor';
      const result = await evaluateClarifyGateFromIntent(intent, 'monitor pubs in Narnia');
      assert.strictEqual(result.route, 'refuse');
      assert.strictEqual(result.triggerCategory, 'fictional_location');
    });

    it('"monitor pubs in Brighton" regex → agent_run (real location + monitoring)', async () => {
      const result = await evaluateClarifyGate('monitor pubs in Brighton');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('delegatedClarify signal is honoured', () => {
    it('delegatedClarify + unrecognised location → clarify_before_run', async () => {
      const intent = makeIntent({ entity_category: 'pubs', location_text: 'Grimbleshire' });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find pubs in Grimbleshire', {
        delegatedClarify: true,
        delegatedClarifyReason: 'Router flagged unrecognised location',
      });
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'unrecognised_location');
      assert.ok(result.questions![0].includes('Grimbleshire'));
    });

    it('delegatedClarify + recognised location → agent_run (not overridden)', async () => {
      const intent = makeIntent({ entity_category: 'pubs', location_text: 'Brighton' });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find pubs in Brighton', {
        delegatedClarify: true,
      });
      assert.strictEqual(result.route, 'agent_run');
    });

    it('delegatedClarify + fictional location → refuse (refuse takes priority)', async () => {
      const intent = makeIntent({ entity_category: 'pubs', location_text: 'Narnia' });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find pubs in Narnia', {
        delegatedClarify: true,
      });
      assert.strictEqual(result.route, 'refuse');
    });

    it('delegatedClarify + no location → clarify_before_run', async () => {
      const intent = makeIntent({ entity_category: 'pubs', location_text: null });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find pubs', {
        delegatedClarify: true,
        delegatedClarifyReason: 'Router flagged missing location',
      });
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.deepStrictEqual(result.missingFields, ['location']);
    });

    it('no delegatedClarify + unrecognised location → agent_run (not blocked)', async () => {
      const intent = makeIntent({ entity_category: 'pubs', location_text: 'Grimbleshire' });
      const result = await evaluateClarifyGateFromIntent(intent, 'Find pubs in Grimbleshire');
      assert.strictEqual(result.route, 'agent_run');
    });
  });
});
