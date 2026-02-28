import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateClarifyGate } from './clarify-gate';

describe('ClarifyGate — subjective criteria & nonsense locations (G6)', () => {

  describe('Subjective / unmeasurable criteria', () => {
    it('"find the best vibes near council things" → clarify_before_run', () => {
      const result = evaluateClarifyGate('find the best vibes near council things');
      assert.strictEqual(result.route, 'clarify_before_run');
      assert.ok(result.reason.includes('subjective'));
      assert.ok(result.questions!.some(q => q.includes('measurable')));
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
      assert.ok(result.questions!.some(q => q.includes('location')));
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
  });

  describe('Normal queries still run', () => {
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
  });
});
