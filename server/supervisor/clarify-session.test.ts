import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createClarifySession,
  getClarifySession,
  closeClarifySession,
  classifyFollowUp,
  applyFollowUp,
  incrementTurnCount,
  renderClarifySummary,
  sessionIsComplete,
  sessionIsAtTurnLimit,
  buildSearchFromSession,
  buildClarifyState,
  isContradictoryNewTask,
  MAX_CLARIFY_TURNS,
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

  describe('Acceptance Test A: pubs → location → refinement → meta trust', () => {
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

    it('step 4: "are these results guaranteed correct" is META_TRUST', () => {
      const session = freshSession({ missingFields: [] });
      session.collectedFields.location = 'west sussex';
      const result = classifyFollowUp('are these results guaranteed correct', session);
      assert.strictEqual(result.classification, 'META_TRUST');
    });

    it('step 4b: "are these results guaranteed correct?" is META_TRUST', () => {
      const session = freshSession({ missingFields: [] });
      session.collectedFields.location = 'west sussex';
      const result = classifyFollowUp('are these results guaranteed correct?', session);
      assert.strictEqual(result.classification, 'META_TRUST');
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

  describe('EXECUTE_NOW classification', () => {
    it('"search now" is EXECUTE_NOW', () => {
      const session = freshSession();
      const result = classifyFollowUp('search now', session);
      assert.strictEqual(result.classification, 'EXECUTE_NOW');
    });

    it('"run it" is EXECUTE_NOW', () => {
      const session = freshSession();
      const result = classifyFollowUp('run it', session);
      assert.strictEqual(result.classification, 'EXECUTE_NOW');
    });

    it('"go ahead" is EXECUTE_NOW', () => {
      const session = freshSession();
      const result = classifyFollowUp('go ahead', session);
      assert.strictEqual(result.classification, 'EXECUTE_NOW');
    });

    it('"yes proceed" is EXECUTE_NOW', () => {
      const session = freshSession();
      const result = classifyFollowUp('yes proceed', session);
      assert.strictEqual(result.classification, 'EXECUTE_NOW');
    });

    it('"do it" is EXECUTE_NOW', () => {
      const session = freshSession();
      const result = classifyFollowUp('do it', session);
      assert.strictEqual(result.classification, 'EXECUTE_NOW');
    });

    it('"search now" is NOT absorbed as a location', () => {
      const session = freshSession();
      const result = classifyFollowUp('search now', session);
      assert.strictEqual(result.classification, 'EXECUTE_NOW');
      assert.strictEqual(session.collectedFields.location, null);
    });
  });

  describe('META_TRUST classification', () => {
    it('"can I trust these results?" is META_TRUST', () => {
      const session = freshSession({ missingFields: [] });
      const result = classifyFollowUp('can I trust these results?', session);
      assert.strictEqual(result.classification, 'META_TRUST');
    });

    it('"how accurate are your results" is META_TRUST', () => {
      const session = freshSession({ missingFields: [] });
      const result = classifyFollowUp('how accurate are your results', session);
      assert.strictEqual(result.classification, 'META_TRUST');
    });

    it('"do you guarantee the data?" is META_TRUST', () => {
      const session = freshSession();
      const result = classifyFollowUp('do you guarantee the data?', session);
      assert.strictEqual(result.classification, 'META_TRUST');
    });

    it('"how do you work" is META_TRUST', () => {
      const session = freshSession();
      const result = classifyFollowUp('how do you work', session);
      assert.strictEqual(result.classification, 'META_TRUST');
    });
  });

  describe('Turn limit', () => {
    it('session starts at turnCount 0', () => {
      const session = freshSession();
      assert.strictEqual(session.turnCount, 0);
      assert.strictEqual(sessionIsAtTurnLimit(session), false);
    });

    it('turnCount increments via incrementTurnCount (not applyFollowUp)', () => {
      const session = freshSession({ missingFields: ['location', 'entity_type'] });
      applyFollowUp(session, { classification: 'ANSWER_TO_MISSING_FIELD', updatedField: 'location', value: 'London' });
      assert.strictEqual(session.turnCount, 0);
      incrementTurnCount(session);
      assert.strictEqual(session.turnCount, 1);
    });

    it('sessionIsAtTurnLimit returns true at max', () => {
      const session = freshSession({ missingFields: ['location', 'entity_type'] });
      for (let i = 0; i < MAX_CLARIFY_TURNS; i++) {
        incrementTurnCount(session);
      }
      assert.strictEqual(sessionIsAtTurnLimit(session), true);
    });
  });

  describe('Attributes accumulation', () => {
    it('multiple refinements accumulate as attributes', () => {
      const session = freshSession({ missingFields: [] });
      session.collectedFields.location = 'west sussex';
      applyFollowUp(session, { classification: 'REFINEMENT', value: 'freehouses' });
      applyFollowUp(session, { classification: 'REFINEMENT', value: 'dog friendly' });
      assert.deepStrictEqual(session.collectedFields.attributes, ['freehouses', 'dog friendly']);
    });

    it('duplicate attributes are not added twice', () => {
      const session = freshSession({ missingFields: [] });
      session.collectedFields.location = 'west sussex';
      applyFollowUp(session, { classification: 'REFINEMENT', value: 'freehouses' });
      applyFollowUp(session, { classification: 'REFINEMENT', value: 'freehouses' });
      assert.deepStrictEqual(session.collectedFields.attributes, ['freehouses']);
    });

    it('renderClarifySummary joins multiple attributes', () => {
      const session = freshSession({ missingFields: [] });
      session.collectedFields.location = 'West Sussex';
      applyFollowUp(session, { classification: 'REFINEMENT', value: 'freehouses' });
      applyFollowUp(session, { classification: 'REFINEMENT', value: 'dog friendly' });
      const summary = renderClarifySummary(session);
      assert.strictEqual(summary, 'Find pubs in West Sussex (freehouses, dog friendly)');
    });
  });

  describe('buildClarifyState', () => {
    it('returns ask_more when fields are missing', () => {
      const session = freshSession();
      const state = buildClarifyState(session);
      assert.strictEqual(state.status, 'ask_more');
      assert.deepStrictEqual(state.missingFields, ['location']);
      assert.strictEqual(state.maxTurns, MAX_CLARIFY_TURNS);
    });

    it('returns ready_to_search when complete', () => {
      const session = freshSession({ missingFields: [] });
      session.collectedFields.location = 'Brighton';
      const state = buildClarifyState(session);
      assert.strictEqual(state.status, 'ready_to_search');
    });

    it('returns turn_limit_reached at cap', () => {
      const session = freshSession({ missingFields: ['location'] });
      for (let i = 0; i < MAX_CLARIFY_TURNS; i++) {
        incrementTurnCount(session);
      }
      const state = buildClarifyState(session);
      assert.strictEqual(state.status, 'turn_limit_reached');
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

  describe('G6: semantic_constraint blocking', () => {
    function g6Session() {
      closeClarifySession('g6-conv');
      return createClarifySession(
        'g6-conv',
        'find the best vibes near council things',
        ['location', 'semantic_constraint'],
        { businessType: null, location: null },
      );
    }

    it('session with location + semantic_constraint missing is NOT complete', () => {
      const session = g6Session();
      assert.strictEqual(sessionIsComplete(session), false);
      const state = buildClarifyState(session);
      assert.strictEqual(state.status, 'ask_more');
    });

    it('providing location alone still leaves session incomplete', () => {
      const session = g6Session();
      applyFollowUp(session, { classification: 'ANSWER_TO_MISSING_FIELD', updatedField: 'location', value: 'Bristol' });
      assert.strictEqual(session.collectedFields.location, 'Bristol');
      assert.strictEqual(sessionIsComplete(session), false, 'Should not be complete — semantic_constraint still missing');
      const state = buildClarifyState(session);
      assert.strictEqual(state.status, 'ask_more');
    });

    it('providing measurable criteria resolves semantic_constraint', () => {
      const session = g6Session();
      session.collectedFields.businessType = 'cafes';
      applyFollowUp(session, { classification: 'ANSWER_TO_MISSING_FIELD', updatedField: 'location', value: 'Bristol' });
      const followUp = classifyFollowUp('live music', session);
      assert.strictEqual(followUp.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(followUp.updatedField, 'semantic_constraint');
      applyFollowUp(session, followUp);
      assert.ok(!session.missingFields.includes('semantic_constraint'), 'semantic_constraint should be resolved');
      assert.ok(session.collectedFields.attributes.includes('live music'), 'attribute should be added');
    });

    it('session becomes complete after location + criteria both provided', () => {
      const session = g6Session();
      session.collectedFields.businessType = 'pubs';
      applyFollowUp(session, { classification: 'ANSWER_TO_MISSING_FIELD', updatedField: 'location', value: 'Leeds' });
      applyFollowUp(session, { classification: 'ANSWER_TO_MISSING_FIELD', updatedField: 'semantic_constraint', value: 'dog friendly' });
      assert.strictEqual(sessionIsComplete(session), true);
      const state = buildClarifyState(session);
      assert.strictEqual(state.status, 'ready_to_search');
    });

    it('EXECUTE_NOW is blocked when semantic_constraint is still missing', () => {
      const session = g6Session();
      session.collectedFields.businessType = 'pubs';
      applyFollowUp(session, { classification: 'ANSWER_TO_MISSING_FIELD', updatedField: 'location', value: 'Bristol' });
      assert.strictEqual(sessionIsComplete(session), false, 'Should not be complete with semantic_constraint missing');
      assert.ok(session.missingFields.includes('semantic_constraint'));
    });

    it('"search now" classifies as EXECUTE_NOW even when blocked', () => {
      const session = g6Session();
      const followUp = classifyFollowUp('search now', session);
      assert.strictEqual(followUp.classification, 'EXECUTE_NOW');
    });

    it('"dog friendly" resolves semantic_constraint when that field is missing', () => {
      const session = g6Session();
      const followUp = classifyFollowUp('dog friendly', session);
      assert.strictEqual(followUp.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(followUp.updatedField, 'semantic_constraint');
    });
  });

  describe('G6 Phase 5: multi-turn 3-step flow', () => {
    function vibesSession() {
      closeClarifySession('g6-multi');
      return createClarifySession(
        'g6-multi',
        'find the best vibes near council things',
        ['location', 'semantic_constraint'],
        { businessType: null, location: null },
      );
    }

    it('step 1: initial state has both location + semantic_constraint missing, status ask_more', () => {
      const session = vibesSession();
      assert.strictEqual(sessionIsComplete(session), false);
      const state = buildClarifyState(session);
      assert.strictEqual(state.status, 'ask_more');
      assert.ok(state.missingFields.includes('location'));
      assert.ok(state.missingFields.includes('semantic_constraint'));
    });

    it('step 2: "Manchester city centre" resolves location but NOT semantic_constraint', () => {
      const session = vibesSession();
      const fu = classifyFollowUp('Manchester city centre', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'location');
      applyFollowUp(session, fu);
      incrementTurnCount(session);
      assert.strictEqual(session.collectedFields.location, 'Manchester city centre');
      assert.ok(!session.missingFields.includes('location'), 'location should be resolved');
      assert.ok(session.missingFields.includes('semantic_constraint'), 'semantic_constraint should still be missing');
      assert.strictEqual(sessionIsComplete(session), false);
      const state = buildClarifyState(session);
      assert.strictEqual(state.status, 'ask_more');
    });

    it('step 3: "lively nightlife, late night" resolves semantic_constraint → ready_to_search', () => {
      const session = vibesSession();
      session.collectedFields.businessType = 'bars';
      applyFollowUp(session, { classification: 'ANSWER_TO_MISSING_FIELD', updatedField: 'location', value: 'Manchester city centre' });
      incrementTurnCount(session);
      const fu = classifyFollowUp('lively nightlife, late night', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
      applyFollowUp(session, fu);
      incrementTurnCount(session);
      assert.ok(!session.missingFields.includes('semantic_constraint'), 'semantic_constraint should be resolved');
      assert.strictEqual(session.missingFields.length, 0);
      assert.strictEqual(sessionIsComplete(session), true);
      const state = buildClarifyState(session);
      assert.strictEqual(state.status, 'ready_to_search');
    });

    it('EXECUTE_NOW after step 2 (location only) is still blocked', () => {
      const session = vibesSession();
      session.collectedFields.businessType = 'pubs';
      applyFollowUp(session, { classification: 'ANSWER_TO_MISSING_FIELD', updatedField: 'location', value: 'Manchester city centre' });
      incrementTurnCount(session);
      const fu = classifyFollowUp('search now', session);
      assert.strictEqual(fu.classification, 'EXECUTE_NOW');
      assert.strictEqual(sessionIsComplete(session), false, 'Should not be complete — semantic_constraint still missing');
    });

    it('EXECUTE_NOW after step 3 (both resolved) allows search', () => {
      const session = vibesSession();
      session.collectedFields.businessType = 'pubs';
      applyFollowUp(session, { classification: 'ANSWER_TO_MISSING_FIELD', updatedField: 'location', value: 'Manchester city centre' });
      applyFollowUp(session, { classification: 'ANSWER_TO_MISSING_FIELD', updatedField: 'semantic_constraint', value: 'lively nightlife' });
      assert.strictEqual(sessionIsComplete(session), true);
    });
  });

  describe('G6 Phase 5: expanded measurable criteria in follow-ups', () => {
    function semanticSession() {
      closeClarifySession('g6-exp');
      return createClarifySession(
        'g6-exp',
        'find the best bars in Bristol',
        ['semantic_constraint'],
        { businessType: 'bars', location: 'Bristol' },
      );
    }

    it('"nightlife" resolves semantic_constraint', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('nightlife', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });

    it('"lively" resolves semantic_constraint', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('lively', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });

    it('"quiet" resolves semantic_constraint', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('quiet', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });

    it('"late night" resolves semantic_constraint', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('late night', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });

    it('"views" resolves semantic_constraint', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('views', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });

    it('"student" resolves semantic_constraint', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('student', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });

    it('"walkable" resolves semantic_constraint', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('walkable', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });

    it('"romantic" resolves semantic_constraint', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('romantic', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });

    it('"scenic" resolves semantic_constraint', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('scenic', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });

    it('"trendy" resolves semantic_constraint', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('trendy', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });

    it('"events" resolves semantic_constraint', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('events', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });

    it('"cosy" resolves semantic_constraint', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('cosy', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });

    it('"lively nightlife with outdoor seating and late night" resolves semantic_constraint (longer reply)', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('lively nightlife with outdoor seating and late night', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });

    it('"good for studying" resolves semantic_constraint', () => {
      const session = semanticSession();
      const fu = classifyFollowUp('good for studying', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'semantic_constraint');
    });
  });

  describe('G4: scope-change escape — contradictory new task', () => {
    function pubsSession() {
      closeClarifySession('g4-conv');
      return createClarifySession(
        'g4-conv',
        'find pubs in west sussex',
        ['location'],
        { businessType: 'pubs', location: null },
      );
    }

    function pubsSessionWithLocation() {
      closeClarifySession('g4-conv');
      return createClarifySession(
        'g4-conv',
        'find pubs in west sussex',
        [],
        { businessType: 'pubs', location: 'West Sussex' },
      );
    }

    it('"cafes in bristol" during pubs session → isContradictoryNewTask true', () => {
      const session = pubsSession();
      assert.strictEqual(isContradictoryNewTask('cafes in bristol', session), true);
    });

    it('"cafes in bristol" during pubs session → classifyFollowUp returns NEW_REQUEST', () => {
      const session = pubsSession();
      const fu = classifyFollowUp('cafes in bristol', session);
      assert.strictEqual(fu.classification, 'NEW_REQUEST');
    });

    it('"find restaurants in Manchester" during pubs session → NEW_REQUEST', () => {
      const session = pubsSession();
      const fu = classifyFollowUp('find restaurants in Manchester', session);
      assert.strictEqual(fu.classification, 'NEW_REQUEST');
    });

    it('"find cafes in Leeds" during pubs+location session → NEW_REQUEST', () => {
      const session = pubsSessionWithLocation();
      const fu = classifyFollowUp('find cafes in Leeds', session);
      assert.strictEqual(fu.classification, 'NEW_REQUEST');
    });

    it('"list breweries in Portland" during pubs session → NEW_REQUEST', () => {
      const session = pubsSession();
      const fu = classifyFollowUp('list breweries in Portland', session);
      assert.strictEqual(fu.classification, 'NEW_REQUEST');
    });

    it('"search for gyms in Birmingham" during pubs session → NEW_REQUEST', () => {
      const session = pubsSession();
      const fu = classifyFollowUp('search for gyms in Birmingham', session);
      assert.strictEqual(fu.classification, 'NEW_REQUEST');
    });

    it('"Bristol" during pubs session with location missing → still ANSWER (not contradictory)', () => {
      const session = pubsSession();
      const fu = classifyFollowUp('Bristol', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'location');
    });

    it('"west sussex" during pubs session → still ANSWER (same context)', () => {
      const session = pubsSession();
      const fu = classifyFollowUp('west sussex', session);
      assert.strictEqual(fu.classification, 'ANSWER_TO_MISSING_FIELD');
      assert.strictEqual(fu.updatedField, 'location');
    });

    it('"dog friendly" during pubs session → still REFINEMENT (not contradictory)', () => {
      const session = pubsSessionWithLocation();
      const fu = classifyFollowUp('dog friendly', session);
      assert.strictEqual(fu.classification, 'REFINEMENT');
    });

    it('"freehouses" during pubs session → still REFINEMENT', () => {
      const session = pubsSessionWithLocation();
      const fu = classifyFollowUp('freehouses', session);
      assert.strictEqual(fu.classification, 'REFINEMENT');
    });

    it('"pubs in Brighton" during pubs session → NOT contradictory (same entity)', () => {
      const session = pubsSession();
      assert.strictEqual(isContradictoryNewTask('pubs in Brighton', session), false);
    });

    it('"find pubs in Brighton" during pubs session → NOT contradictory (same entity)', () => {
      const session = pubsSession();
      assert.strictEqual(isContradictoryNewTask('find pubs in Brighton', session), false);
    });
  });
});
