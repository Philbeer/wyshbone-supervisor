import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateClarifyGate } from './clarify-gate';

describe('ClarifyGate — subjective criteria & nonsense locations (G6)', () => {

  describe('Subjective / unmeasurable criteria', () => {
    it('"find the best vibes near council things" → clarify_before_run with location + meaning questions', () => {
      const result = evaluateClarifyGate('find the best vibes near council things');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
      assert.ok(result.questions!.some(q => q.includes('Pick one') || q.includes('measurable')));
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
      assert.ok(result.questions!.some(q => q.includes('Pick one') || q.includes('measurable')));
      assert.ok(result.missingFields!.includes('semantic_constraint'), 'Should include semantic_constraint in missingFields');
    });

    it('"find best pubs with live music in Brighton" → clarify_before_run (subjective "best" still unresolved)', () => {
      const result = evaluateClarifyGate('find best pubs with live music in Brighton');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
      assert.ok(result.missingFields!.includes('semantic_constraint'));
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

  describe('Expanded subjective criteria (G6 Phase 5)', () => {
    it('"find nice pubs in Bristol" → clarify_before_run (subjective "nice")', () => {
      const result = evaluateClarifyGate('find nice pubs in Bristol');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find good cafes in Manchester" → clarify_before_run (subjective "good")', () => {
      const result = evaluateClarifyGate('find good cafes in Manchester');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find places with good atmosphere in Leeds" → clarify_before_run', () => {
      const result = evaluateClarifyGate('find places with good atmosphere in Leeds');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find cafes good for studying in Bristol" → agent_run (measurable)', () => {
      const result = evaluateClarifyGate('find cafes good for studying in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('Subjective terms always trigger clarification regardless of measurable attributes (Batch 1)', () => {
    it('"find best bars with nightlife in Manchester" → clarify_before_run (subjective "best" unresolved)', () => {
      const result = evaluateClarifyGate('find best bars with nightlife in Manchester');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find top lively pubs in Leeds" → clarify_before_run (subjective "top" unresolved)', () => {
      const result = evaluateClarifyGate('find top lively pubs in Leeds');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find nicest romantic restaurants in Bath" → clarify_before_run (subjective "nicest" unresolved)', () => {
      const result = evaluateClarifyGate('find nicest romantic restaurants in Bath');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find best trendy cafes in Brighton" → clarify_before_run (subjective "best" unresolved)', () => {
      const result = evaluateClarifyGate('find best trendy cafes in Brighton');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find best walkable pubs in York" → clarify_before_run (subjective "best" unresolved)', () => {
      const result = evaluateClarifyGate('find best walkable pubs in York');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find top student bars in Leeds" → clarify_before_run (subjective "top" unresolved)', () => {
      const result = evaluateClarifyGate('find top student bars in Leeds');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find best cafes with views in Edinburgh" → clarify_before_run (subjective "best" unresolved)', () => {
      const result = evaluateClarifyGate('find best cafes with views in Edinburgh');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find nicest scenic restaurants in Cornwall" → clarify_before_run (subjective "nicest" unresolved)', () => {
      const result = evaluateClarifyGate('find nicest scenic restaurants in Cornwall');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find good pubs with live music in Bristol" → clarify_before_run (subjective "good" unresolved)', () => {
      const result = evaluateClarifyGate('find good pubs with live music in Bristol');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });

    it('"find nice bars with outdoor seating in Leeds" → clarify_before_run (subjective "nice" unresolved)', () => {
      const result = evaluateClarifyGate('find nice bars with outdoor seating in Leeds');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
    });
  });

  describe('Measurable-only queries still run (no false positives)', () => {
    it('"find cafes in Bristol that are quiet" → agent_run (quiet is measurable, no subjective)', () => {
      const result = evaluateClarifyGate('find cafes in Bristol that are quiet');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find lively bars in Manchester" → agent_run (lively is measurable)', () => {
      const result = evaluateClarifyGate('find lively bars in Manchester');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find cosy pubs with live music in Bristol" → agent_run (cosy + live music are measurable)', () => {
      const result = evaluateClarifyGate('find cosy pubs with live music in Bristol');
      assert.strictEqual(result.route, 'agent_run');
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

describe('ClarifyGate — Batch 1 mandatory subjective predicate tests', () => {
  it('"Find nice bars in Manchester" → CLARIFY', () => {
    const result = evaluateClarifyGate('Find nice bars in Manchester');
    assert.strictEqual(result.route, 'clarify_before_run');
    assert.ok(result.reason.includes('subjective'));
    assert.ok(result.missingFields!.includes('semantic_constraint'));
  });

  it('"Find best pubs in Leeds" → CLARIFY', () => {
    const result = evaluateClarifyGate('Find best pubs in Leeds');
    assert.strictEqual(result.route, 'clarify_before_run');
    assert.ok(result.reason.includes('subjective'));
    assert.ok(result.missingFields!.includes('semantic_constraint'));
  });

  it('"Find good cafes" → CLARIFY', () => {
    const result = evaluateClarifyGate('Find good cafes');
    assert.strictEqual(result.route, 'clarify_before_run');
    assert.ok(result.reason.includes('subjective'));
    assert.ok(result.missingFields!.includes('semantic_constraint'));
  });

  it('"Find lively bars in Manchester" → RUN (measurable, not subjective)', () => {
    const result = evaluateClarifyGate('Find lively bars in Manchester');
    assert.strictEqual(result.route, 'agent_run');
  });

  it('"Find cosy pubs with live music in Bristol" → RUN (measurable, not subjective)', () => {
    const result = evaluateClarifyGate('Find cosy pubs with live music in Bristol');
    assert.strictEqual(result.route, 'agent_run');
  });

  it('"Find nice pubs with live music in Bristol" → CLARIFY (subjective "nice" unresolved)', () => {
    const result = evaluateClarifyGate('Find nice pubs with live music in Bristol');
    assert.strictEqual(result.route, 'clarify_before_run');
    assert.ok(result.reason.includes('subjective'));
    assert.ok(result.missingFields!.includes('semantic_constraint'));
  });

  it('clarify question asks specifically about the detected subjective term', () => {
    const result = evaluateClarifyGate('Find nice bars in Manchester');
    assert.ok(result.questions!.some(q => q.includes("'nice'")), 'Should mention the specific subjective term');
  });

  it('"Find great cafes in Bristol" → CLARIFY (expanded subjective term "great")', () => {
    const result = evaluateClarifyGate('Find great cafes in Bristol');
    assert.strictEqual(result.route, 'clarify_before_run');
    assert.ok(result.reason.includes('subjective'));
  });

  it('"Find cool bars in Leeds" → CLARIFY (expanded subjective term "cool")', () => {
    const result = evaluateClarifyGate('Find cool bars in Leeds');
    assert.strictEqual(result.route, 'clarify_before_run');
    assert.ok(result.reason.includes('subjective'));
  });

  it('"Find lovely cafes in Bath" → CLARIFY (expanded subjective term "lovely")', () => {
    const result = evaluateClarifyGate('Find lovely cafes in Bath');
    assert.strictEqual(result.route, 'clarify_before_run');
    assert.ok(result.reason.includes('subjective'));
  });

  it('"Find decent pubs in Manchester" → CLARIFY (expanded subjective term "decent")', () => {
    const result = evaluateClarifyGate('Find decent pubs in Manchester');
    assert.strictEqual(result.route, 'clarify_before_run');
    assert.ok(result.reason.includes('subjective'));
  });

  it('"Find chill bars in Brighton" → CLARIFY (expanded subjective term "chill")', () => {
    const result = evaluateClarifyGate('Find chill bars in Brighton');
    assert.strictEqual(result.route, 'clarify_before_run');
    assert.ok(result.reason.includes('subjective'));
  });
});

describe('ClarifyGate — meta/trust about Wyshbone routes to direct_response', () => {
  it('"What is Wyshbone and can it lie?" → direct_response', () => {
    const result = evaluateClarifyGate('What is Wyshbone and can it lie?');
    assert.strictEqual(result.route, 'direct_response');
  });

  it('"What is Wyshbone?" → direct_response', () => {
    const result = evaluateClarifyGate('What is Wyshbone?');
    assert.strictEqual(result.route, 'direct_response');
  });

  it('"Can it lie?" → direct_response', () => {
    const result = evaluateClarifyGate('Can it lie?');
    assert.strictEqual(result.route, 'direct_response');
  });

  it('"Is Wyshbone trustworthy?" → direct_response', () => {
    const result = evaluateClarifyGate('Is Wyshbone trustworthy?');
    assert.strictEqual(result.route, 'direct_response');
  });
});
