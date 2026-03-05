import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  validateCanonicalIntent,
  parseAndValidateIntentJSON,
  type CanonicalIntent,
} from './canonical-intent';
import { getIntentExtractorMode } from './intent-shadow';

describe('CanonicalIntent — schema validation', () => {
  const validIntent: CanonicalIntent = {
    action: 'find_businesses',
    business_type: 'pubs',
    location: 'Arundel',
    country: 'UK',
    count: 10,
    constraints: [
      {
        type: 'attribute',
        raw: 'serve food',
        hardness: 'hard',
        evidence_mode: 'website_text',
        clarify_if_needed: false,
        value: 'food',
      },
    ],
    delivery_requirements: { email: false, phone: false, website: false },
    confidence: 0.9,
    raw_input: 'find 10 pubs in Arundel that serve food',
  };

  it('accepts a valid intent object', () => {
    const result = validateCanonicalIntent(validIntent);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.errors, []);
    assert.ok(result.intent);
    assert.strictEqual(result.intent!.action, 'find_businesses');
  });

  it('rejects null input', () => {
    const result = validateCanonicalIntent(null);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects invalid action enum', () => {
    const bad = { ...validIntent, action: 'hack_the_planet' };
    const result = validateCanonicalIntent(bad);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('action')));
  });

  it('rejects constraint with invalid type enum', () => {
    const bad = {
      ...validIntent,
      constraints: [{ type: 'magic_spell', raw: 'abracadabra', hardness: 'hard', evidence_mode: 'unknown', clarify_if_needed: true }],
    };
    const result = validateCanonicalIntent(bad);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('type')));
  });

  it('rejects constraint with invalid hardness enum', () => {
    const bad = {
      ...validIntent,
      constraints: [{ type: 'attribute', raw: 'food', hardness: 'medium', evidence_mode: 'website_text', clarify_if_needed: false }],
    };
    const result = validateCanonicalIntent(bad);
    assert.strictEqual(result.ok, false);
  });

  it('rejects constraint with invalid evidence_mode enum', () => {
    const bad = {
      ...validIntent,
      constraints: [{ type: 'attribute', raw: 'food', hardness: 'hard', evidence_mode: 'telepathy', clarify_if_needed: false }],
    };
    const result = validateCanonicalIntent(bad);
    assert.strictEqual(result.ok, false);
  });

  it('rejects missing required top-level fields', () => {
    const result = validateCanonicalIntent({ action: 'find_businesses' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
  });
});

describe('CanonicalIntent — JSON parsing', () => {
  it('parses valid JSON string', () => {
    const json = JSON.stringify({
      action: 'find_businesses',
      business_type: 'restaurants',
      location: 'London',
      country: 'UK',
      count: null,
      constraints: [],
      delivery_requirements: { email: true, phone: false, website: false },
      confidence: 0.8,
      raw_input: 'find restaurants in London with email',
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
    const result = parseAndValidateIntentJSON('{"action": "find_businesses", "business_type":');
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors[0].includes('JSON parse error'));
    assert.strictEqual(result.intent, null);
  });

  it('rejects JSON with valid structure but wrong enum values throughout', () => {
    const json = JSON.stringify({
      action: 'find_businesses',
      business_type: 'pubs',
      location: 'Leeds',
      country: 'UK',
      count: null,
      constraints: [
        { type: 'attribute', raw: 'food', hardness: 'hard', evidence_mode: 'website_text', clarify_if_needed: false },
        { type: 'telekinesis', raw: 'move things', hardness: 'hard', evidence_mode: 'mind_power', clarify_if_needed: true },
      ],
      delivery_requirements: { email: false, phone: false, website: false },
      confidence: 0.5,
      raw_input: 'test',
    });
    const result = parseAndValidateIntentJSON(json);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('type') || e.includes('evidence_mode')));
  });
});

describe('CanonicalIntent — constraint classification expectations', () => {
  it('"serve food" should be attribute + website_text, not relationship', () => {
    const intent: CanonicalIntent = {
      action: 'find_businesses',
      business_type: 'pubs',
      location: 'Arundel',
      country: 'UK',
      count: null,
      constraints: [
        {
          type: 'attribute',
          raw: 'serve food',
          hardness: 'hard',
          evidence_mode: 'website_text',
          clarify_if_needed: false,
          value: 'food',
        },
      ],
      delivery_requirements: { email: false, phone: false, website: false },
      confidence: 0.95,
      raw_input: 'find pubs in Arundel that serve food',
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
        action: 'find_businesses',
        business_type: 'cafes',
        location: 'Brighton',
        country: 'UK',
        count: null,
        constraints: [
          {
            type: 'time',
            raw: 'opened in last 6 months',
            hardness: 'soft',
            evidence_mode: mode,
            clarify_if_needed: true,
            value: '6 months',
          },
        ],
        delivery_requirements: { email: false, phone: false, website: false },
        confidence: 0.7,
        raw_input: 'find cafes in Brighton opened in last 6 months',
      };
      const result = validateCanonicalIntent(intent);
      assert.strictEqual(result.ok, true, `evidence_mode=${mode} should be valid`);
      assert.strictEqual(result.intent!.constraints[0].type, 'time');
    }
  });

  it('unknown phrases should produce unknown_constraint with clarify_if_needed=true', () => {
    const intent: CanonicalIntent = {
      action: 'find_businesses',
      business_type: 'shops',
      location: 'Leeds',
      country: 'UK',
      count: null,
      constraints: [
        {
          type: 'unknown_constraint',
          raw: 'with good vibes',
          hardness: 'soft',
          evidence_mode: 'unknown',
          clarify_if_needed: true,
        },
      ],
      delivery_requirements: { email: false, phone: false, website: false },
      confidence: 0.4,
      raw_input: 'find shops in Leeds with good vibes',
    };
    const result = validateCanonicalIntent(intent);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.intent!.constraints[0].type, 'unknown_constraint');
    assert.strictEqual(result.intent!.constraints[0].clarify_if_needed, true);
    assert.strictEqual(result.intent!.constraints[0].evidence_mode, 'unknown');
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
