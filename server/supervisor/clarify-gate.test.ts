import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateClarifyGate } from './clarify-gate';

describe('ClarifyGate — subjective criteria & nonsense locations (G6)', () => {

  describe('Subjective / unmeasurable criteria', () => {
    it('"find the best vibes near council things" → clarify_before_run with location + meaning questions', () => {
      const result = evaluateClarifyGate('find the best vibes near council things');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
      assert.ok(result.questions!.some(q => q.includes('measurable')));
      assert.ok(result.questions!.some(q => /location|place|city|town/i.test(q)));
      assert.ok(result.questions!.length >= 2, 'Should have at least two questions (location + meaning of vibes)');
    });

    it('"find the coolest bars in London" → clarify_before_run (subjective)', () => {
      const result = evaluateClarifyGate('find the coolest bars in London');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"show me the nicest restaurants near somewhere" → clarify_before_run', () => {
      const result = evaluateClarifyGate('show me the nicest restaurants near somewhere');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
      assert.ok(result.reason.includes('invalid') || result.reason.includes('nonsensical'));
    });

    it('"find top pubs in Bristol" → clarify_before_run (subjective, no measurable)', () => {
      const result = evaluateClarifyGate('find top pubs in Bristol');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find the most fun cafes in Leeds" → clarify_before_run', () => {
      const result = evaluateClarifyGate('find the most fun cafes in Leeds');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find the best cafes in bristol" → clarify_before_run (subjective "best" without measurable criteria)', () => {
      const result = evaluateClarifyGate('find the best cafes in bristol');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
      assert.ok(result.questions!.some(q => q.includes('measurable')));
      assert.ok(result.missingFields!.includes('semantic_constraint'), 'Should include semantic_constraint in missingFields');
    });

    it('"find best pubs with live music in Brighton" → agent_run (has measurable attribute)', () => {
      const result = evaluateClarifyGate('find best pubs with live music in Brighton');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find dog friendly cafes in Bath" → agent_run (measurable, no subjective)', () => {
      const result = evaluateClarifyGate('find dog friendly cafes in Bath');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('Nonsense / invalid locations', () => {
    it('"find pubs near council things" → clarify_before_run (nonsense location)', () => {
      const result = evaluateClarifyGate('find pubs near council things');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('invalid') || result.reason.includes('nonsensical'));
      assert.ok(result.questions!.some(q => /location|place|city|town/i.test(q)));
      assert.ok(result.missingFields!.includes('location'));
    });

    it('"find restaurants near council stuff" → clarify_before_run', () => {
      const result = evaluateClarifyGate('find restaurants near council stuff');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('invalid') || result.reason.includes('nonsensical'));
    });

    it('"list bars in random whatever" → clarify_before_run', () => {
      const result = evaluateClarifyGate('list bars in random whatever');
      assert.strictEqual(result.route, 'clarify_before_run');
    });

    it('"find cafes near something" → clarify_before_run', () => {
      const result = evaluateClarifyGate('find cafes near something');
      assert.strictEqual(result.route, 'clarify_before_run');
    });

    it('nonsense location question explicitly says the phrase is not a real place', () => {
      const result = evaluateClarifyGate('find pubs near council things');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.questions!.some(q => /isn't a real place|not a real place|not a place/i.test(q)));
    });
  });

  describe('Vague proximity with real location', () => {
    it('"find pubs near the council in Leeds" → clarify_before_run with proximity + location confirmation questions', () => {
      const result = evaluateClarifyGate('find pubs near the council in Leeds');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('vague proximity'));
      assert.ok(result.questions!.some(q => q.includes('council') && (q.includes('distance') || q.includes('building') || q.includes('vague'))));
      assert.ok(result.questions!.some(q => q.includes('Leeds')));
      assert.ok(!result.missingFields || !result.missingFields.includes('location'), 'Should NOT mark location as missing when Leeds is present');
    });

    it('"find restaurants near the town hall in Birmingham" → clarify_before_run', () => {
      const result = evaluateClarifyGate('find restaurants near the town hall in Birmingham');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('vague proximity'));
      assert.ok(result.questions!.some(q => q.includes('Birmingham')));
    });

    it('"find bars near the local authority in Manchester" → clarify_before_run', () => {
      const result = evaluateClarifyGate('find bars near the local authority in Manchester');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('vague proximity'));
    });

    it('"find cafes in Leeds near the council" → clarify_before_run (location-first pattern)', () => {
      const result = evaluateClarifyGate('find cafes in Leeds near the council');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('vague proximity'));
      assert.ok(result.questions!.some(q => q.includes('Leeds')));
    });

    it('"find pubs close to council offices in Bristol" → clarify_before_run', () => {
      const result = evaluateClarifyGate('find pubs close to council offices in Bristol');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('vague proximity'));
      assert.ok(result.questions!.some(q => q.includes('Bristol')));
    });
  });

  describe('Sanitised parsedFields — no nonsense stored', () => {
    it('"find the best vibes near council things" → parsedFields.location is null (not "council things")', () => {
      const result = evaluateClarifyGate('find the best vibes near council things');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.parsedFields!.location, null, 'Should NOT store nonsense location');
    });

    it('"find the best vibes near council things" → parsedFields.businessType strips subjective words', () => {
      const result = evaluateClarifyGate('find the best vibes near council things');
      assert.strictEqual(result.route, 'clarify_before_run');
      const bt = result.parsedFields!.businessType;
      if (bt) {
        assert.ok(!/\bbest\b/i.test(bt), `businessType should not contain "best": got "${bt}"`);
        assert.ok(!/\bvibes?\b/i.test(bt), `businessType should not contain "vibes": got "${bt}"`);
      }
    });

    it('"find the best cafes in bristol" → parsedFields.location is "bristol" (valid location preserved)', () => {
      const result = evaluateClarifyGate('find the best cafes in bristol');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.parsedFields!.location, 'Should preserve valid location');
      assert.ok(/bristol/i.test(result.parsedFields!.location!));
    });

    it('"find the best cafes in bristol" → parsedFields.businessType does not contain "best"', () => {
      const result = evaluateClarifyGate('find the best cafes in bristol');
      const bt = result.parsedFields!.businessType;
      if (bt) {
        assert.ok(!/\bbest\b/i.test(bt), `businessType should not contain "best": got "${bt}"`);
      }
    });

    it('"find pubs near council things" → parsedFields.location is null', () => {
      const result = evaluateClarifyGate('find pubs near council things');
      assert.strictEqual(result.parsedFields!.location, null);
    });
  });

  describe('Normal queries still run (no false positives)', () => {
    it('"find cafes in Bristol" → agent_run', () => {
      const result = evaluateClarifyGate('find cafes in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"cafes in Bristol" → agent_run', () => {
      const result = evaluateClarifyGate('cafes in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find pubs in West Sussex" → agent_run', () => {
      const result = evaluateClarifyGate('find pubs in West Sussex');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find 10 micropubs in Brighton" → agent_run', () => {
      const result = evaluateClarifyGate('find 10 micropubs in Brighton');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"list restaurants in Manchester" → agent_run', () => {
      const result = evaluateClarifyGate('list restaurants in Manchester');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"show me breweries in Portland" → agent_run', () => {
      const result = evaluateClarifyGate('show me breweries in Portland');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"best practices for marketing" → direct_response (not search)', () => {
      const result = evaluateClarifyGate('best practices for marketing');
      assert.notStrictEqual(result.route, 'clarify_before_run');
    });
  });

  describe('Combined subjective + nonsense', () => {
    it('"find the best vibes near council things" → both reasons present', () => {
      const result = evaluateClarifyGate('find the best vibes near council things');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
      assert.ok(result.reason.includes('invalid') || result.reason.includes('nonsensical'));
      assert.ok(result.questions!.length >= 2);
    });

    it('"find the best vibes near council things" → missingFields includes both location and semantic_constraint', () => {
      const result = evaluateClarifyGate('find the best vibes near council things');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.missingFields!.includes('location'), 'Should include location in missingFields');
      assert.ok(result.missingFields!.includes('semantic_constraint'), 'Should include semantic_constraint in missingFields');
    });
  });
});
