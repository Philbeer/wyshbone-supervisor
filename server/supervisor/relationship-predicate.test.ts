import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  detectRelationshipPredicate,
  buildRelationshipSummary,
  buildRelationshipDeliveryLanguage,
  sanitizeRelationshipMessage,
} from './relationship-predicate';

describe('Relationship Predicate Detection', () => {
  it('detects "works with" predicate', () => {
    const result = detectRelationshipPredicate('organisations that work with councils');
    assert.strictEqual(result.requires_relationship_evidence, true);
    assert.strictEqual(result.detected_predicate, 'work with');
    assert.strictEqual(result.relationship_target, 'councils');
  });

  it('detects "works with" variant', () => {
    const result = detectRelationshipPredicate('find companies that works with the NHS');
    assert.strictEqual(result.requires_relationship_evidence, true);
    assert.strictEqual(result.detected_predicate, 'works with');
    assert.strictEqual(result.relationship_target, 'nhs');
  });

  it('detects "supplies" predicate', () => {
    const result = detectRelationshipPredicate('firms that supplies schools in kent');
    assert.strictEqual(result.requires_relationship_evidence, true);
    assert.strictEqual(result.detected_predicate, 'supplies');
    assert.ok(result.relationship_target?.includes('schools'));
  });

  it('detects "partners with" predicate', () => {
    const result = detectRelationshipPredicate('agencies that partners with local government');
    assert.strictEqual(result.requires_relationship_evidence, true);
    assert.strictEqual(result.detected_predicate, 'partners with');
    assert.ok(result.relationship_target?.includes('local government'));
  });

  it('detects "clients of" predicate', () => {
    const result = detectRelationshipPredicate('clients of barclays in london');
    assert.strictEqual(result.requires_relationship_evidence, true);
    assert.strictEqual(result.detected_predicate, 'clients of');
    assert.ok(result.relationship_target?.includes('barclays'));
  });

  it('does NOT flag simple business searches', () => {
    const result = detectRelationshipPredicate('find pubs in sussex');
    assert.strictEqual(result.requires_relationship_evidence, false);
    assert.strictEqual(result.detected_predicate, null);
    assert.strictEqual(result.relationship_target, null);
  });

  it('does NOT flag attribute queries', () => {
    const result = detectRelationshipPredicate('find pubs with a beer garden in arundel');
    assert.strictEqual(result.requires_relationship_evidence, false);
  });

  it('does NOT flag location queries', () => {
    const result = detectRelationshipPredicate('find dentists near london');
    assert.strictEqual(result.requires_relationship_evidence, false);
  });
});

describe('Relationship Delivery Language', () => {
  it('returns honest language when zero verified', () => {
    const summary = buildRelationshipSummary(
      { requires_relationship_evidence: true, detected_predicate: 'works with', relationship_target: 'councils' },
      [],
      5,
    );
    const lang = buildRelationshipDeliveryLanguage(summary);
    assert.ok(lang.honest_label.includes('candidates'));
    assert.ok(lang.stop_reason?.includes('could not be verified'));
    assert.ok(lang.stop_reason?.includes('works with councils'));
  });

  it('returns partial language when some verified', () => {
    const summary = buildRelationshipSummary(
      { requires_relationship_evidence: true, detected_predicate: 'works with', relationship_target: 'councils' },
      [{ lead_place_id: 'p1', lead_name: 'A', verdict: 'yes', confidence: 'high', reason: 'website says so', evidence_url: null, evidence_quote: null }],
      5,
    );
    const lang = buildRelationshipDeliveryLanguage(summary);
    assert.ok(lang.honest_label.includes('1 verified'));
    assert.ok(lang.stop_reason?.includes('Only 1 of 5'));
  });

  it('returns clean language when all verified', () => {
    const summary = buildRelationshipSummary(
      { requires_relationship_evidence: true, detected_predicate: 'works with', relationship_target: 'councils' },
      [
        { lead_place_id: 'p1', lead_name: 'A', verdict: 'yes', confidence: 'high', reason: 'ok', evidence_url: null, evidence_quote: null },
        { lead_place_id: 'p2', lead_name: 'B', verdict: 'yes', confidence: 'high', reason: 'ok', evidence_url: null, evidence_quote: null },
      ],
      2,
    );
    const lang = buildRelationshipDeliveryLanguage(summary);
    assert.strictEqual(lang.honest_label, 'verified results');
    assert.strictEqual(lang.stop_reason, null);
  });

  it('returns neutral language when no relationship required', () => {
    const summary = buildRelationshipSummary(
      { requires_relationship_evidence: false, detected_predicate: null, relationship_target: null },
      [],
      5,
    );
    const lang = buildRelationshipDeliveryLanguage(summary);
    assert.strictEqual(lang.honest_label, 'results');
    assert.strictEqual(lang.stop_reason, null);
  });
});

describe('Message Sanitizer', () => {
  it('blocks "I found X results that match" when relationship unverified', () => {
    const summary = buildRelationshipSummary(
      { requires_relationship_evidence: true, detected_predicate: 'works with', relationship_target: 'councils' },
      [],
      5,
    );
    const msg = 'I found 5 results that match your criteria';
    const sanitized = sanitizeRelationshipMessage(msg, summary);
    assert.ok(!sanitized.includes('match'));
    assert.ok(sanitized.includes('could not verify'));
    assert.ok(sanitized.includes('candidates only'));
  });

  it('blocks "These organisations meet your criteria" when relationship unverified', () => {
    const summary = buildRelationshipSummary(
      { requires_relationship_evidence: true, detected_predicate: 'works with', relationship_target: 'councils' },
      [],
      3,
    );
    const msg = 'These organisations meet your criteria perfectly';
    const sanitized = sanitizeRelationshipMessage(msg, summary);
    assert.ok(!sanitized.includes('meet your criteria'));
    assert.ok(sanitized.includes('candidates only'));
  });

  it('passes through neutral messages unchanged', () => {
    const summary = buildRelationshipSummary(
      { requires_relationship_evidence: true, detected_predicate: 'works with', relationship_target: 'councils' },
      [],
      5,
    );
    const msg = 'Run complete. Results are available.';
    const sanitized = sanitizeRelationshipMessage(msg, summary);
    assert.strictEqual(sanitized, msg);
  });

  it('passes through when no relationship evidence required', () => {
    const summary = buildRelationshipSummary(
      { requires_relationship_evidence: false, detected_predicate: null, relationship_target: null },
      [],
      5,
    );
    const msg = 'I found 5 results that match your criteria';
    const sanitized = sanitizeRelationshipMessage(msg, summary);
    assert.strictEqual(sanitized, msg);
  });
});
