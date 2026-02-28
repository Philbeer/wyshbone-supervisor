import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createClarifySession,
  getClarifySession,
  closeClarifySession,
  classifyFollowUp,
  applyFollowUp,
  renderClarifySummary,
  sessionIsComplete,
  buildSearchFromSession,
} from './clarify-session';

const CONV_ID = 'test-conv-001';

function freshSession(opts?: { missingFields?: any[]; businessType?: string | null; location?: string | null }) {
  closeClarifySession(CONV_ID);
  return createClarifySession(
    CONV_ID,
    'thanks, can you find pubs for me?',
    opts?.missingFields ?? ['location'],
    { businessType: opts?.businessType ?? 'pubs', location: opts?.location ?? null },
  );
}

describe('ClarifySession', () => {

  describe('Acceptance Test A: pubs → location → refinement → new request', () => {
    it('step 1: "west sussex" is ANSWER_TO_MISSING_FIELD for location', () => {
      const session = freshSession();
      const result = classifyFollowUp('west sussex', session);
      assert.strictEqual(result.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(result.updatedField, 'location');
      assert.strictEqual(result.value, 'west sussex');
    });

    it('step 2: after location answered, summary includes pubs + west sussex', () => {
      const session = freshSession();
      const result = classifyFollowUp('west sussex', session);
      applyFollowUp(session, result);
      const summary = renderClarifySummary(session);
      assert.ok(summary.toLowerCase().includes('pubs'), `summary should contain pubs: ${summary}`);
      assert.ok(summary.toLowerCase().includes('west sussex'), `summary should contain west sussex: ${summary}`);
      assert.strictEqual(sessionIsComplete(session), true);
    });

    it('step 3: "freehouses" is REFINEMENT', () => {
      const session = freshSession({ missingFields: [] });
      session.collectedFields.location = 'west sussex';
      const result = classifyFollowUp('freehouses', session);
      assert.strictEqual(result.classification, 'REFINEMENT');
    });

    it('step 3b: after refinement, summary has no repetition', () => {
      const session = freshSession({ missingFields: [] });
      session.collectedFields.location = 'west sussex';
      const refResult = classifyFollowUp('freehouses', session);
      applyFollowUp(session, refResult);
      const summary = renderClarifySummary(session);
      assert.ok(summary.toLowerCase().includes('pubs'), `summary should contain pubs: ${summary}`);
      assert.ok(summary.toLowerCase().includes('west sussex'), `summary should contain west sussex: ${summary}`);
      assert.ok(summary.toLowerCase().includes('freehouses'), `summary should contain freehouses: ${summary}`);
      const pubsCount = (summary.toLowerCase().match(/pubs/g) || []).length;
      assert.strictEqual(pubsCount, 1, `"pubs" should appear exactly once: ${summary}`);
    });

    it('step 4: "are these results guaranteed correct" is NEW_REQUEST', () => {
      const session = freshSession({ missingFields: [] });
      session.collectedFields.location = 'west sussex';
      const result = classifyFollowUp('are these results guaranteed correct', session);
      assert.strictEqual(result.classification, 'NEW_REQUEST');
    });

    it('step 4b: "are these results guaranteed correct?" is NEW_REQUEST', () => {
      const session = freshSession({ missingFields: [] });
      session.collectedFields.location = 'west sussex';
      const result = classifyFollowUp('are these results guaranteed correct?', session);
      assert.strictEqual(result.classification, 'NEW_REQUEST');
    });
  });

  describe('Acceptance Test B: organisations + relationship → confirmation → new request', () => {
    it('"any, just research it" is ANSWER_TO_MISSING_FIELD for relationship_clarification', () => {
      closeClarifySession(CONV_ID);
      const session = createClarifySession(
        CONV_ID,
        'find organisations that work with the local authority in blackpool',
        ['relationship_clarification'],
        { businessType: 'organisations that work with the local authority', location: 'blackpool' },
      );
      const result = classifyFollowUp('any, just research it', session);
      assert.strictEqual(result.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(result.updatedField, 'relationship_clarification');
    });

    it('"can you help me with sales" is NEW_REQUEST', () => {
      closeClarifySession(CONV_ID);
      const session = createClarifySession(
        CONV_ID,
        'find organisations that work with the local authority in blackpool',
        ['relationship_clarification'],
        { businessType: 'organisations that work with the local authority', location: 'blackpool' },
      );
      const result = classifyFollowUp('can you help me with sales', session);
      assert.strictEqual(result.classification, 'NEW_REQUEST');
    });
  });

  describe('Session lifecycle', () => {
    it('creates and retrieves a session', () => {
      freshSession();
      const retrieved = getClarifySession(CONV_ID);
      assert.ok(retrieved !== null);
      assert.strictEqual(retrieved!.originalUserRequest, 'thanks, can you find pubs for me?');
    });

    it('closing a session removes it', () => {
      freshSession();
      closeClarifySession(CONV_ID);
      assert.strictEqual(getClarifySession(CONV_ID), null);
    });

    it('buildSearchFromSession returns structured params', () => {
      const session = freshSession({ missingFields: [] });
      session.collectedFields.location = 'Brighton';
      const params = buildSearchFromSession(session);
      assert.strictEqual(params.businessType, 'pubs');
      assert.strictEqual(params.location, 'Brighton');
    });
  });

  describe('Follow-up classification edge cases', () => {
    it('"Bristol" is ANSWER_TO_MISSING_FIELD for location', () => {
      const session = freshSession();
      const result = classifyFollowUp('Bristol', session);
      assert.strictEqual(result.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(result.updatedField, 'location');
    });

    it('"dog friendly" is REFINEMENT', () => {
      const session = freshSession({ missingFields: [] });
      const result = classifyFollowUp('dog friendly', session);
      assert.strictEqual(result.classification, 'REFINEMENT');
    });

    it('"what does a lead generation agent do" is NEW_REQUEST', () => {
      const session = freshSession({ missingFields: [] });
      const result = classifyFollowUp('what does a lead generation agent do', session);
      assert.strictEqual(result.classification, 'NEW_REQUEST');
    });

    it('"find breweries in Leeds" is NEW_REQUEST (full new search)', () => {
      const session = freshSession({ missingFields: [] });
      const result = classifyFollowUp('find breweries in Leeds', session);
      assert.strictEqual(result.classification, 'NEW_REQUEST');
    });

    it('"London?" is ANSWER_TO_MISSING_FIELD for location (question format)', () => {
      const session = freshSession();
      const result = classifyFollowUp('London?', session);
      assert.strictEqual(result.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(result.updatedField, 'location');
    });

    it('"is London ok?" is ANSWER_TO_MISSING_FIELD for location', () => {
      const session = freshSession();
      const result = classifyFollowUp('is London ok?', session);
      assert.strictEqual(result.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(result.updatedField, 'location');
    });

    it('"UK?" is ANSWER_TO_MISSING_FIELD for location', () => {
      const session = freshSession();
      const result = classifyFollowUp('UK?', session);
      assert.strictEqual(result.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(result.updatedField, 'location');
    });
  });

  describe('renderClarifySummary never duplicates raw input', () => {
    it('renders from structured fields only', () => {
      const session = freshSession();
      applyFollowUp(session, { classification: 'ANSWER_TO_MISSING_FIELD', updatedField: 'location', value: 'West Sussex' });
      const summary = renderClarifySummary(session);
      assert.strictEqual(summary, 'Find pubs in West Sussex');
    });

    it('with attribute, renders cleanly', () => {
      const session = freshSession({ missingFields: [] });
      session.collectedFields.location = 'West Sussex';
      applyFollowUp(session, { classification: 'REFINEMENT', value: 'freehouses' });
      const summary = renderClarifySummary(session);
      assert.strictEqual(summary, 'Find pubs in West Sussex (freehouses)');
    });
  });
});
