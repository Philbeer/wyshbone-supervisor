import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  validateCanonicalIntent,
  parseAndValidateIntentJSON,
  type CanonicalIntent,
} from './canonical-intent';
import { getIntentExtractorMode } from './intent-shadow';

describe('CanonicalIntent v2 — schema validation', () => {
  const validIntent: CanonicalIntent = {
    mission_type: 'find_businesses',
    entity_kind: 'pubs',
    entity_category: 'hospitality',
    location_text: 'Arundel',
    geo_mode: 'city',
    radius_km: null,
    requested_count: 10,
    default_count_policy: 'explicit',
    constraints: [
      {
        type: 'attribute',
        raw: 'serve food',
        hardness: 'hard',
        evidence_mode: 'website_text',
        clarify_if_needed: false,
        clarify_question: null,
      },
    ],
    plan_template_hint: 'search_and_verify',
    preferred_evidence_order: ['website_text', 'google_places'],
  };

  it('accepts a valid v2 intent object', () => {
    const result = validateCanonicalIntent(validIntent);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.errors, []);
    assert.ok(result.intent);
    assert.strictEqual(result.intent!.mission_type, 'find_businesses');
    assert.strictEqual(result.intent!.entity_kind, 'pubs');
    assert.strictEqual(result.intent!.entity_category, 'hospitality');
    assert.strictEqual(result.intent!.location_text, 'Arundel');
    assert.strictEqual(result.intent!.geo_mode, 'city');
    assert.strictEqual(result.intent!.requested_count, 10);
    assert.strictEqual(result.intent!.default_count_policy, 'explicit');
    assert.strictEqual(result.intent!.plan_template_hint, 'search_and_verify');
  });

  it('rejects null input', () => {
    const result = validateCanonicalIntent(null);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects invalid mission_type enum', () => {
    const bad = { ...validIntent, mission_type: 'hack_the_planet' };
    const result = validateCanonicalIntent(bad);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('mission_type')));
  });

  it('rejects invalid geo_mode enum', () => {
    const bad = { ...validIntent, geo_mode: 'galactic' };
    const result = validateCanonicalIntent(bad);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('geo_mode')));
  });

  it('rejects invalid default_count_policy enum', () => {
    const bad = { ...validIntent, default_count_policy: 'yolo' };
    const result = validateCanonicalIntent(bad);
    assert.strictEqual(result.ok, false);
  });

  it('rejects invalid plan_template_hint enum', () => {
    const bad = { ...validIntent, plan_template_hint: 'magic' };
    const result = validateCanonicalIntent(bad);
    assert.strictEqual(result.ok, false);
  });

  it('rejects constraint with invalid type enum', () => {
    const bad = {
      ...validIntent,
      constraints: [{ type: 'magic_spell', raw: 'abracadabra', hardness: 'hard', evidence_mode: 'unknown', clarify_if_needed: true, clarify_question: null }],
    };
    const result = validateCanonicalIntent(bad);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('type')));
  });

  it('rejects constraint with invalid hardness enum', () => {
    const bad = {
      ...validIntent,
      constraints: [{ type: 'attribute', raw: 'food', hardness: 'medium', evidence_mode: 'website_text', clarify_if_needed: false, clarify_question: null }],
    };
    const result = validateCanonicalIntent(bad);
    assert.strictEqual(result.ok, false);
  });

  it('rejects constraint with invalid evidence_mode enum', () => {
    const bad = {
      ...validIntent,
      constraints: [{ type: 'attribute', raw: 'food', hardness: 'hard', evidence_mode: 'telepathy', clarify_if_needed: false, clarify_question: null }],
    };
    const result = validateCanonicalIntent(bad);
    assert.strictEqual(result.ok, false);
  });

  it('rejects missing required top-level fields', () => {
    const result = validateCanonicalIntent({ mission_type: 'find_businesses' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it('accepts null entity_kind and entity_category', () => {
    const intent = { ...validIntent, entity_kind: null, entity_category: null };
    const result = validateCanonicalIntent(intent);
    assert.strictEqual(result.ok, true);
  });

  it('accepts radius_km when geo_mode is radius', () => {
    const intent = { ...validIntent, geo_mode: 'radius' as const, radius_km: 10 };
    const result = validateCanonicalIntent(intent);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.intent!.radius_km, 10);
  });

  it('accepts empty preferred_evidence_order', () => {
    const intent = { ...validIntent, preferred_evidence_order: [] as any[] };
    const result = validateCanonicalIntent(intent);
    assert.strictEqual(result.ok, true);
  });
});

describe('CanonicalIntent v2 — old shape rejection', () => {
  it('rejects old shape with action field', () => {
    const old = {
      action: 'find_businesses',
      business_type: 'pubs',
      location: 'Arundel',
      country: 'UK',
      count: 10,
      constraints: [],
      delivery_requirements: { email: false, phone: false, website: false },
      confidence: 0.9,
      raw_input: 'find pubs in Arundel',
    };
    const result = validateCanonicalIntent(old);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('Old schema fields detected'));
    assert.ok(result.errors[0].includes('action'));
    assert.ok(result.errors[0].includes('business_type'));
  });

  it('rejects old shape even with some v2 fields mixed in', () => {
    const mixed = {
      mission_type: 'find_businesses',
      entity_kind: 'pubs',
      action: 'find_businesses',
      business_type: 'pubs',
      location_text: 'Arundel',
      geo_mode: 'city',
      radius_km: null,
      requested_count: 10,
      default_count_policy: 'explicit',
      constraints: [],
      plan_template_hint: 'simple_search',
      preferred_evidence_order: [],
    };
    const result = validateCanonicalIntent(mixed);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('Old schema fields detected'));
  });

  it('rejects object with only delivery_requirements from old shape', () => {
    const obj = {
      mission_type: 'find_businesses',
      entity_kind: 'pubs',
      entity_category: null,
      location_text: 'Arundel',
      geo_mode: 'city',
      radius_km: null,
      requested_count: null,
      default_count_policy: 'page_1',
      constraints: [],
      plan_template_hint: 'simple_search',
      preferred_evidence_order: [],
      delivery_requirements: { email: true, phone: false, website: false },
    };
    const result = validateCanonicalIntent(obj);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('delivery_requirements'));
  });

  it('rejects object with only confidence from old shape', () => {
    const obj = {
      mission_type: 'find_businesses',
      entity_kind: 'pubs',
      entity_category: null,
      location_text: 'Arundel',
      geo_mode: 'city',
      radius_km: null,
      requested_count: null,
      default_count_policy: 'page_1',
      constraints: [],
      plan_template_hint: 'simple_search',
      preferred_evidence_order: [],
      confidence: 0.9,
    };
    const result = validateCanonicalIntent(obj);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('confidence'));
  });

  it('rejects object with only raw_input from old shape', () => {
    const obj = {
      mission_type: 'find_businesses',
      entity_kind: 'pubs',
      entity_category: null,
      location_text: 'Arundel',
      geo_mode: 'city',
      radius_km: null,
      requested_count: null,
      default_count_policy: 'page_1',
      constraints: [],
      plan_template_hint: 'simple_search',
      preferred_evidence_order: [],
      raw_input: 'hello',
    };
    const result = validateCanonicalIntent(obj);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('raw_input'));
  });

  it('rejects object with old "location" field (not location_text)', () => {
    const obj = {
      mission_type: 'find_businesses',
      entity_kind: 'pubs',
      entity_category: null,
      location: 'Arundel',
      location_text: 'Arundel',
      geo_mode: 'city',
      radius_km: null,
      requested_count: null,
      default_count_policy: 'page_1',
      constraints: [],
      plan_template_hint: 'simple_search',
      preferred_evidence_order: [],
    };
    const result = validateCanonicalIntent(obj);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('location'));
  });

  it('rejects object with old "count" field (not requested_count)', () => {
    const obj = {
      mission_type: 'find_businesses',
      entity_kind: 'pubs',
      entity_category: null,
      location_text: 'Arundel',
      geo_mode: 'city',
      radius_km: null,
      requested_count: 5,
      count: 5,
      default_count_policy: 'explicit',
      constraints: [],
      plan_template_hint: 'simple_search',
      preferred_evidence_order: [],
    };
    const result = validateCanonicalIntent(obj);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('count'));
  });
});

describe('CanonicalIntent v2 — JSON parsing', () => {
  it('parses valid v2 JSON string', () => {
    const json = JSON.stringify({
      mission_type: 'find_businesses',
      entity_kind: 'restaurants',
      entity_category: 'hospitality',
      location_text: 'London',
      geo_mode: 'city',
      radius_km: null,
      requested_count: null,
      default_count_policy: 'page_1',
      constraints: [],
      plan_template_hint: 'simple_search',
      preferred_evidence_order: ['google_places'],
    });
    const result = parseAndValidateIntentJSON(json);
    assert.strictEqual(result.ok, true);
    assert.ok(result.intent);
  });

  it('rejects invalid JSON safely', () => {
    const result = parseAndValidateIntentJSON('not json at all {{{');
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('JSON parse error'));
    assert.strictEqual(result.intent, null);
  });

  it('rejects empty string', () => {
    const result = parseAndValidateIntentJSON('');
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('JSON parse error'));
  });

  it('rejects valid JSON that does not match schema', () => {
    const result = parseAndValidateIntentJSON('{"foo": "bar"}');
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects truncated / partial JSON safely', () => {
    const result = parseAndValidateIntentJSON('{"mission_type": "find_businesses", "entity_kind":');
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('JSON parse error'));
    assert.strictEqual(result.intent, null);
  });

  it('rejects old-shape JSON via parsing path', () => {
    const json = JSON.stringify({
      action: 'find_businesses',
      business_type: 'pubs',
      location: 'Arundel',
      country: 'UK',
      count: 10,
      constraints: [],
      delivery_requirements: { email: false, phone: false, website: false },
      confidence: 0.9,
      raw_input: 'find pubs in Arundel',
    });
    const result = parseAndValidateIntentJSON(json);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('Old schema fields detected'));
  });
});

describe('CanonicalIntent v2 — constraint classification expectations', () => {
  it('"serve food" should be attribute + website_text, not relationship', () => {
    const intent: CanonicalIntent = {
      mission_type: 'find_businesses',
      entity_kind: 'pubs',
      entity_category: 'hospitality',
      location_text: 'Arundel',
      geo_mode: 'city',
      radius_km: null,
      requested_count: null,
      default_count_policy: 'page_1',
      constraints: [
        {
          type: 'attribute',
          raw: 'serve food',
          hardness: 'hard',
          evidence_mode: 'website_text',
          clarify_if_needed: false,
          clarify_question: null,
        },
      ],
      plan_template_hint: 'search_and_verify',
      preferred_evidence_order: ['website_text'],
    };
    const result = validateCanonicalIntent(intent);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.intent!.constraints[0].type, 'attribute');
    assert.strictEqual(result.intent!.constraints[0].evidence_mode, 'website_text');
    assert.notStrictEqual(result.intent!.constraints[0].type, 'relationship');
  });

  it('"opened in last 6 months" should be time constraint with web_search/news/registry evidence', () => {
    const validModes = ['web_search', 'news', 'registry'] as const;
    for (const mode of validModes) {
      const intent: CanonicalIntent = {
        mission_type: 'find_businesses',
        entity_kind: 'cafes',
        entity_category: 'hospitality',
        location_text: 'Brighton',
        geo_mode: 'city',
        radius_km: null,
        requested_count: null,
        default_count_policy: 'page_1',
        constraints: [
          {
            type: 'time',
            raw: 'opened in last 6 months',
            hardness: 'soft',
            evidence_mode: mode,
            clarify_if_needed: true,
            clarify_question: 'How should we verify the opening date?',
          },
        ],
        plan_template_hint: 'search_and_verify',
        preferred_evidence_order: [mode],
      };
      const result = validateCanonicalIntent(intent);
      assert.strictEqual(result.ok, true, `evidence_mode=${mode} should be valid`);
      assert.strictEqual(result.intent!.constraints[0].type, 'time');
    }
  });

  it('unknown phrases should produce unknown_constraint with clarify_if_needed=true', () => {
    const intent: CanonicalIntent = {
      mission_type: 'find_businesses',
      entity_kind: 'shops',
      entity_category: 'retail',
      location_text: 'Leeds',
      geo_mode: 'city',
      radius_km: null,
      requested_count: null,
      default_count_policy: 'page_1',
      constraints: [
        {
          type: 'unknown_constraint',
          raw: 'with good vibes',
          hardness: 'soft',
          evidence_mode: 'unknown',
          clarify_if_needed: true,
          clarify_question: 'What do you mean by "good vibes"? Can you describe what you are looking for?',
        },
      ],
      plan_template_hint: 'simple_search',
      preferred_evidence_order: [],
    };
    const result = validateCanonicalIntent(intent);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.intent!.constraints[0].type, 'unknown_constraint');
    assert.strictEqual(result.intent!.constraints[0].clarify_if_needed, true);
    assert.strictEqual(result.intent!.constraints[0].evidence_mode, 'unknown');
    assert.ok(result.intent!.constraints[0].clarify_question);
  });

  it('constraint with clarify_if_needed=false must accept clarify_question=null', () => {
    const intent: CanonicalIntent = {
      mission_type: 'find_businesses',
      entity_kind: 'pubs',
      entity_category: 'hospitality',
      location_text: 'Bristol',
      geo_mode: 'city',
      radius_km: null,
      requested_count: 5,
      default_count_policy: 'explicit',
      constraints: [
        {
          type: 'attribute',
          raw: 'beer garden',
          hardness: 'hard',
          evidence_mode: 'website_text',
          clarify_if_needed: false,
          clarify_question: null,
        },
      ],
      plan_template_hint: 'search_and_verify',
      preferred_evidence_order: ['website_text', 'google_places'],
    };
    const result = validateCanonicalIntent(intent);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.intent!.constraints[0].clarify_question, null);
  });
});

describe('Intent extractor feature flag', () => {
  let originalEnv: string | undefined;

  it('defaults to off when env is not set', () => {
    originalEnv = process.env.INTENT_EXTRACTOR_MODE;
    delete process.env.INTENT_EXTRACTOR_MODE;
    assert.strictEqual(getIntentExtractorMode(), 'off');
    if (originalEnv !== undefined) process.env.INTENT_EXTRACTOR_MODE = originalEnv;
    else delete process.env.INTENT_EXTRACTOR_MODE;
  });

  it('returns shadow when set to shadow', () => {
    originalEnv = process.env.INTENT_EXTRACTOR_MODE;
    process.env.INTENT_EXTRACTOR_MODE = 'shadow';
    assert.strictEqual(getIntentExtractorMode(), 'shadow');
    if (originalEnv !== undefined) process.env.INTENT_EXTRACTOR_MODE = originalEnv;
    else delete process.env.INTENT_EXTRACTOR_MODE;
  });

  it('returns active when set to active', () => {
    originalEnv = process.env.INTENT_EXTRACTOR_MODE;
    process.env.INTENT_EXTRACTOR_MODE = 'active';
    assert.strictEqual(getIntentExtractorMode(), 'active');
    if (originalEnv !== undefined) process.env.INTENT_EXTRACTOR_MODE = originalEnv;
    else delete process.env.INTENT_EXTRACTOR_MODE;
  });

  it('returns strict when set to strict', () => {
    originalEnv = process.env.INTENT_EXTRACTOR_MODE;
    process.env.INTENT_EXTRACTOR_MODE = 'strict';
    assert.strictEqual(getIntentExtractorMode(), 'strict');
    if (originalEnv !== undefined) process.env.INTENT_EXTRACTOR_MODE = originalEnv;
    else delete process.env.INTENT_EXTRACTOR_MODE;
  });

  it('returns off for unrecognised values', () => {
    originalEnv = process.env.INTENT_EXTRACTOR_MODE;
    process.env.INTENT_EXTRACTOR_MODE = 'banana';
    assert.strictEqual(getIntentExtractorMode(), 'off');
    if (originalEnv !== undefined) process.env.INTENT_EXTRACTOR_MODE = originalEnv;
    else delete process.env.INTENT_EXTRACTOR_MODE;
  });

  it('handles case insensitivity', () => {
    originalEnv = process.env.INTENT_EXTRACTOR_MODE;
    process.env.INTENT_EXTRACTOR_MODE = 'SHADOW';
    assert.strictEqual(getIntentExtractorMode(), 'shadow');
    if (originalEnv !== undefined) process.env.INTENT_EXTRACTOR_MODE = originalEnv;
    else delete process.env.INTENT_EXTRACTOR_MODE;
  });
});
