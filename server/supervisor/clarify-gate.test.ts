import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateClarifyGate } from './clarify-gate';

describe('ClarifyGate — tightened gate: only empty, nonsense, or multiple concatenated requests trigger clarify', () => {

  describe('Empty input → clarify_before_run with triggerCategory=empty', () => {
    it('empty string → clarify_before_run', () => {
      const result = evaluateClarifyGate('');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'empty');
    });

    it('whitespace-only string → clarify_before_run', () => {
      const result = evaluateClarifyGate('   ');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'empty');
    });
  });

  describe('Nonsense/unintelligible input → clarify_before_run with triggerCategory=malformed', () => {
    it('"asdfgh jklzxcv qwerty" → clarify_before_run (gibberish)', () => {
      const result = evaluateClarifyGate('asdfgh jklzxcv qwerty');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'malformed');
    });

    it('"zzzz xxxx yyyy wwww" → clarify_before_run (nonsense words)', () => {
      const result = evaluateClarifyGate('zzzz xxxx yyyy wwww');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'malformed');
    });

    it('"bloop flarp snorkel wagwag" → clarify_before_run (nonsense)', () => {
      const result = evaluateClarifyGate('bloop flarp snorkel wagwag');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'malformed');
    });
  });

  describe('Multiple concatenated requests → clarify_before_run with triggerCategory=multiple_requests', () => {
    it('"find pubs in LeedsShow me cafes in Bristol" → clarify_before_run (no space between sentences)', () => {
      const result = evaluateClarifyGate('find pubs in LeedsShow me cafes in Bristol');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'multiple_requests');
    });

    it('"find pubs in Leeds and also find cafes in Bristol" → clarify_before_run (mixed intent)', () => {
      const result = evaluateClarifyGate('find pubs in Leeds and also find cafes in Bristol');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'multiple_requests');
    });

    it('"find pubs in Leeds and find restaurants in Manchester" → clarify_before_run', () => {
      const result = evaluateClarifyGate('find pubs in Leeds and find restaurants in Manchester');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'multiple_requests');
    });

    it('"list bars in Brighton plus find cafes in Bath" → clarify_before_run', () => {
      const result = evaluateClarifyGate('list bars in Brighton plus find cafes in Bath');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.strictEqual(result.triggerCategory, 'multiple_requests');
    });
  });

  describe('Normal single requests proceed to agent_run (no false positives)', () => {
    it('"find cafes in Bristol" → agent_run', () => {
      const result = evaluateClarifyGate('find cafes in Bristol');
      assert.strictEqual(result.route, 'agent_run');
      assert.strictEqual(result.triggerCategory, undefined);
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

    it('"find 5 pubs in Arundel" → agent_run', () => {
      const result = evaluateClarifyGate('find 5 pubs in Arundel');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find 5 pubs in Arundel with emails" → agent_run', () => {
      const result = evaluateClarifyGate('find 5 pubs in Arundel with emails');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('Imperfect but single requests now proceed to agent_run (gate relaxed)', () => {
    it('"find the best cafes in Bristol" → agent_run (subjective now allowed through)', () => {
      const result = evaluateClarifyGate('find the best cafes in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find nice pubs in Bristol" → agent_run (subjective now allowed through)', () => {
      const result = evaluateClarifyGate('find nice pubs in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find good cafes in Manchester" → agent_run (subjective now allowed through)', () => {
      const result = evaluateClarifyGate('find good cafes in Manchester');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find top pubs in Bristol" → agent_run (subjective now allowed through)', () => {
      const result = evaluateClarifyGate('find top pubs in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find the coolest bars in London" → agent_run (subjective now allowed through)', () => {
      const result = evaluateClarifyGate('find the coolest bars in London');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find the most fun cafes in Leeds" → agent_run (subjective now allowed through)', () => {
      const result = evaluateClarifyGate('find the most fun cafes in Leeds');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find best pubs with live music in Brighton" → agent_run (subjective + measurable, allowed through)', () => {
      const result = evaluateClarifyGate('find best pubs with live music in Brighton');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find dog friendly cafes in Bath" → agent_run (measurable, no subjective)', () => {
      const result = evaluateClarifyGate('find dog friendly cafes in Bath');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find pubs near council things" → agent_run (imperfect location, single request)', () => {
      const result = evaluateClarifyGate('find pubs near council things');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find restaurants near council stuff" → agent_run (imperfect location, single request)', () => {
      const result = evaluateClarifyGate('find restaurants near council stuff');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find pubs near the council in Leeds" → agent_run (vague proximity with real location, allowed through)', () => {
      const result = evaluateClarifyGate('find pubs near the council in Leeds');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find cafes in Leeds near the council" → agent_run (location-first vague proximity, allowed through)', () => {
      const result = evaluateClarifyGate('find cafes in Leeds near the council');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"Find good cafes" → agent_run (missing location, allowed through)', () => {
      const result = evaluateClarifyGate('Find good cafes');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find places with good atmosphere in Leeds" → agent_run (vague entity + subjective, allowed)', () => {
      const result = evaluateClarifyGate('find places with good atmosphere in Leeds');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find cafes good for studying in Bristol" → agent_run (measurable)', () => {
      const result = evaluateClarifyGate('find cafes good for studying in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find great cafes in Bristol" → agent_run (subjective allowed through)', () => {
      const result = evaluateClarifyGate('Find great cafes in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find cool bars in Leeds" → agent_run (subjective allowed through)', () => {
      const result = evaluateClarifyGate('Find cool bars in Leeds');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find lovely cafes in Bath" → agent_run (subjective allowed through)', () => {
      const result = evaluateClarifyGate('Find lovely cafes in Bath');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find decent pubs in Manchester" → agent_run (subjective allowed through)', () => {
      const result = evaluateClarifyGate('Find decent pubs in Manchester');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find chill bars in Brighton" → agent_run (subjective allowed through)', () => {
      const result = evaluateClarifyGate('Find chill bars in Brighton');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find best bars with nightlife in Manchester" → agent_run', () => {
      const result = evaluateClarifyGate('find best bars with nightlife in Manchester');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find nicest scenic restaurants in Cornwall" → agent_run', () => {
      const result = evaluateClarifyGate('find nicest scenic restaurants in Cornwall');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find good pubs with live music in Bristol" → agent_run', () => {
      const result = evaluateClarifyGate('find good pubs with live music in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find nice bars with outdoor seating in Leeds" → agent_run', () => {
      const result = evaluateClarifyGate('find nice bars with outdoor seating in Leeds');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('Measurable-only queries still run (no false positives)', () => {
    it('"find cafes in Bristol that are quiet" → agent_run', () => {
      const result = evaluateClarifyGate('find cafes in Bristol that are quiet');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find lively bars in Manchester" → agent_run', () => {
      const result = evaluateClarifyGate('find lively bars in Manchester');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find cosy pubs with live music in Bristol" → agent_run', () => {
      const result = evaluateClarifyGate('find cosy pubs with live music in Bristol');
      assert.strictEqual(result.route, 'agent_run');
    });
  });

  describe('Direct response routing preserved', () => {
    it('"best practices for marketing" → direct_response (not search)', () => {
      const result = evaluateClarifyGate('best practices for marketing');
      assert.notStrictEqual(result.route, 'clarify_before_run');
    });

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

  describe('triggerCategory diagnostic field', () => {
    it('empty input has triggerCategory=empty', () => {
      const result = evaluateClarifyGate('');
      assert.strictEqual(result.triggerCategory, 'empty');
    });

    it('nonsense input has triggerCategory=malformed', () => {
      const result = evaluateClarifyGate('qwertyuiop asdfghjkl zxcvbnm');
      assert.strictEqual(result.triggerCategory, 'malformed');
    });

    it('concatenated requests have triggerCategory=multiple_requests', () => {
      const result = evaluateClarifyGate('find pubs in LeedsShow me cafes in Bristol');
      assert.strictEqual(result.triggerCategory, 'multiple_requests');
    });

    it('agent_run has no triggerCategory', () => {
      const result = evaluateClarifyGate('find pubs in Bristol');
      assert.strictEqual(result.triggerCategory, undefined);
    });

    it('direct_response has no triggerCategory', () => {
      const result = evaluateClarifyGate('What is Wyshbone?');
      assert.strictEqual(result.triggerCategory, undefined);
    });
  });

  describe('Short valid inputs are NOT misclassified as nonsense', () => {
    it('"pubs in UK" → agent_run (short but valid)', () => {
      const result = evaluateClarifyGate('pubs in UK');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"cafes London" → agent_run (short but valid)', () => {
      const result = evaluateClarifyGate('cafes London');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"find pubs" → agent_run (short but valid)', () => {
      const result = evaluateClarifyGate('find pubs');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"bars Brighton" → agent_run (short but valid)', () => {
      const result = evaluateClarifyGate('bars Brighton');
      assert.strictEqual(result.route, 'agent_run');
    });

    it('"restaurants" → agent_run (single word but valid noun)', () => {
      const result = evaluateClarifyGate('restaurants');
      assert.strictEqual(result.route, 'agent_run');
    });
  });
});
