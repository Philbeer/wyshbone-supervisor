import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluatePrePlanGate } from './pre-plan-gate';

describe('Pre-Plan Gate', () => {
  describe('A) Vertical mismatch guard', () => {
    it('blocks brewery vertical when message mentions vulnerable adults', () => {
      const result = evaluatePrePlanGate({
        userMessage: 'what organisations support vulnerable adults in leeds',
        businessType: 'organisations',
        location: 'leeds',
        verticalId: 'brewery',
      });
      assert.strictEqual(result.clarification_needed, true);
      assert.strictEqual(result.gate_flags.vertical_mismatch, true);
      assert.ok(result.reason?.includes('vulnerable adults'));
      assert.ok(result.suggested_question?.includes('brewery'));
    });

    it('blocks brewery vertical when message mentions social care', () => {
      const result = evaluatePrePlanGate({
        userMessage: 'find social care providers in manchester',
        businessType: 'social care providers',
        location: 'manchester',
        verticalId: 'brewery',
      });
      assert.strictEqual(result.clarification_needed, true);
      assert.strictEqual(result.gate_flags.vertical_mismatch, true);
    });

    it('passes when vertical is general', () => {
      const result = evaluatePrePlanGate({
        userMessage: 'what organisations support vulnerable adults in leeds',
        businessType: 'organisations',
        location: 'leeds',
        verticalId: 'general',
      });
      assert.strictEqual(result.gate_flags.vertical_mismatch, false);
    });

    it('passes when vertical matches message content', () => {
      const result = evaluatePrePlanGate({
        userMessage: 'find breweries in leeds',
        businessType: 'breweries',
        location: 'leeds',
        verticalId: 'brewery',
      });
      assert.strictEqual(result.clarification_needed, false);
      assert.strictEqual(result.gate_flags.vertical_mismatch, false);
    });
  });

  describe('B) Informational query detection', () => {
    it('blocks pure informational queries', () => {
      const result = evaluatePrePlanGate({
        userMessage: 'what is a micropub',
        businessType: 'micropub',
        location: 'Local',
        verticalId: 'general',
      });
      assert.strictEqual(result.clarification_needed, true);
      assert.strictEqual(result.gate_flags.informational_query, true);
    });

    it('passes when informational query also has lead verb', () => {
      const result = evaluatePrePlanGate({
        userMessage: 'what are the best micropubs to find in sussex',
        businessType: 'micropubs',
        location: 'sussex',
        verticalId: 'general',
      });
      assert.strictEqual(result.clarification_needed, false);
      assert.strictEqual(result.gate_flags.informational_query, false);
    });

    it('passes for normal search requests', () => {
      const result = evaluatePrePlanGate({
        userMessage: 'find micropubs in sussex',
        businessType: 'micropubs',
        location: 'sussex',
        verticalId: 'general',
      });
      assert.strictEqual(result.clarification_needed, false);
    });
  });

  describe('C) Merged query detection', () => {
    it('flags merged queries with "and also"', () => {
      const result = evaluatePrePlanGate({
        userMessage: 'find pubs in london and also what breweries are in manchester',
        businessType: 'pubs',
        location: 'london',
        verticalId: 'general',
      });
      assert.strictEqual(result.gate_flags.query_suspected_merged, true);
    });

    it('flags queries with multiple location entities', () => {
      const result = evaluatePrePlanGate({
        userMessage: 'find pubs in London and restaurants in Manchester',
        businessType: 'pubs',
        location: 'London',
        verticalId: 'general',
      });
      assert.strictEqual(result.gate_flags.query_suspected_merged, true);
    });

    it('does not flag simple single-location queries', () => {
      const result = evaluatePrePlanGate({
        userMessage: 'find micropubs in sussex',
        businessType: 'micropubs',
        location: 'sussex',
        verticalId: 'general',
      });
      assert.strictEqual(result.gate_flags.query_suspected_merged, false);
    });

    it('merged queries do not block (only flag)', () => {
      const result = evaluatePrePlanGate({
        userMessage: 'find pubs in london and also breweries',
        businessType: 'pubs',
        location: 'london',
        verticalId: 'general',
      });
      assert.strictEqual(result.clarification_needed, false);
      assert.strictEqual(result.gate_flags.query_suspected_merged, true);
    });
  });
});
