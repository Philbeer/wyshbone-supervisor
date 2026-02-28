import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  extractAllConstraints,
  extractAttributes,
  preExecutionConstraintGate,
  resolveFollowUp,
  detectNoProxySignal,
  detectProxySelection,
  buildConstraintGateMessage,
  storePendingContract,
  getPendingContract,
  clearPendingContract,
  type ConstraintContract,
  type AttributeConstraint,
} from './constraint-gate';
import { type TimePredicateContract } from './time-predicate';

describe('Constraint Gate — compound extraction', () => {
  it('extracts time_predicate from "opened in the last 12 months"', () => {
    const constraints = extractAllConstraints('Find 10 pubs in Manchester that opened in the last 12 months');
    assert.ok(constraints.length >= 1);
    const tp = constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp, 'time_predicate constraint must exist');
    assert.strictEqual(tp.predicate, 'opened');
    assert.strictEqual(tp.window, '12 months');
  });

  it('extracts live_music attribute from "have live music"', () => {
    const constraints = extractAllConstraints('Find 10 pubs in Bristol that have live music');
    assert.ok(constraints.length >= 1);
    const attr = constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.ok(attr, 'attribute constraint must exist');
    assert.strictEqual(attr.attribute, 'live_music');
  });

  it('extracts BOTH time_predicate AND live_music from compound request', () => {
    const constraints = extractAllConstraints('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    assert.ok(constraints.length >= 2, `Expected >=2 constraints, got ${constraints.length}`);
    const tp = constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    const attr = constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.ok(tp, 'time_predicate constraint must exist');
    assert.ok(attr, 'attribute constraint must exist');
    assert.strictEqual(tp.predicate, 'opened');
    assert.strictEqual(attr.attribute, 'live_music');
  });

  it('extracts multiple attributes (live music + beer garden)', () => {
    const constraints = extractAllConstraints('Find pubs in Leeds with live music and a beer garden');
    const attrs = constraints.filter(c => c.type === 'attribute') as AttributeConstraint[];
    assert.ok(attrs.length >= 2, `Expected >=2 attribute constraints, got ${attrs.length}`);
    const attrNames = attrs.map(a => a.attribute);
    assert.ok(attrNames.includes('live_music'));
    assert.ok(attrNames.includes('beer_garden'));
  });

  it('returns empty array for plain search with no constraints', () => {
    const constraints = extractAllConstraints('Find 10 pubs in Manchester');
    assert.strictEqual(constraints.length, 0);
  });
});

describe('Constraint Gate — preExecutionConstraintGate', () => {
  it('Case 1: "Find 10 pubs in Manchester that opened in the last 12 months" → can_execute=false, asks for proxy', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Manchester that opened in the last 12 months');
    assert.strictEqual(contract.can_execute, false, 'must NOT execute — time predicate requires proxy');
    assert.ok(contract.clarify_questions.length > 0, 'must ask clarification questions');
    assert.strictEqual(contract.stop_recommended, false, 'should not stop — just needs proxy selection');
    assert.ok(contract.why_blocked !== null);
  });

  it('Case 2: "Find 10 cafes in Brighton that just opened, no proxies, must be certain" → STOP', () => {
    const contract = preExecutionConstraintGate('Find 10 cafes in Brighton that just opened, no proxies, must be certain');
    assert.strictEqual(contract.can_execute, false, 'must NOT execute');
    assert.strictEqual(contract.stop_recommended, true, 'must recommend stop');
    assert.ok(contract.why_blocked !== null);
    assert.ok(contract.why_blocked!.includes('cannot be verified'));
  });

  it('Case 4: compound "opened in the last 12 months and have live music" → can_execute=false, constraints has BOTH', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    assert.strictEqual(contract.can_execute, false, 'must NOT execute — time predicate blocks');
    const tp = contract.constraints.find(c => c.type === 'time_predicate');
    const attr = contract.constraints.find(c => c.type === 'attribute');
    assert.ok(tp, 'time_predicate must be in constraints');
    assert.ok(attr, 'attribute must be in constraints');
    assert.ok(contract.clarify_questions.length > 0, 'must ask about proxy');
  });

  it('plain search with no constraints → can_execute=true', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Manchester');
    assert.strictEqual(contract.can_execute, true);
    assert.strictEqual(contract.why_blocked, null);
    assert.strictEqual(contract.stop_recommended, false);
    assert.strictEqual(contract.constraints.length, 0);
  });

  it('"no proxies" in message → hard+unverifiable on time predicate', () => {
    const contract = preExecutionConstraintGate('Find pubs in Leeds opened recently, no proxies');
    const tp = contract.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.hardness, 'hard');
    assert.strictEqual(tp.verifiability, 'unverifiable');
    assert.strictEqual(tp.can_execute, false);
    assert.strictEqual(contract.stop_recommended, true);
  });

  it('"must be guaranteed" → hard time predicate', () => {
    const contract = preExecutionConstraintGate('Find cafes in London that opened recently, must be guaranteed');
    const tp = contract.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.hardness, 'hard');
  });
});

describe('Constraint Gate — no-proxy signal detection', () => {
  it('"no proxies" → true', () => assert.ok(detectNoProxySignal('no proxies')));
  it('"no proxy" → true', () => assert.ok(detectNoProxySignal('no proxy')));
  it('"must be certain" → true', () => assert.ok(detectNoProxySignal('must be certain')));
  it('"must be guaranteed" → true', () => assert.ok(detectNoProxySignal('must be guaranteed')));
  it('"don\'t use proxies" → true', () => assert.ok(detectNoProxySignal("don't use proxies")));
  it('"use recent reviews" → false', () => assert.strictEqual(detectNoProxySignal('use recent reviews'), false));
  it('"search now" → false', () => assert.strictEqual(detectNoProxySignal('search now'), false));
});

describe('Constraint Gate — proxy selection detection', () => {
  it('"use recent reviews proxy" → recent_reviews', () => {
    assert.strictEqual(detectProxySelection('use recent reviews proxy'), 'recent_reviews');
  });
  it('"use first reviews proxy" → recent_reviews', () => {
    assert.strictEqual(detectProxySelection('use first reviews proxy'), 'recent_reviews');
  });
  it('"use news mention proxy" → news_mention', () => {
    assert.strictEqual(detectProxySelection('use news mention proxy'), 'news_mention');
  });
  it('"option 1" → recent_reviews', () => {
    assert.strictEqual(detectProxySelection('option 1'), 'recent_reviews');
  });
  it('"option 2" → news_mention', () => {
    assert.strictEqual(detectProxySelection('option 2'), 'news_mention');
  });
  it('"first option" → recent_reviews', () => {
    assert.strictEqual(detectProxySelection('first option'), 'recent_reviews');
  });
  it('no proxy mention → null', () => {
    assert.strictEqual(detectProxySelection('just search already'), null);
  });
});

describe('Constraint Gate — Case 3: two-turn proxy acceptance', () => {
  it('Turn 1: "Find dentists in Texas that opened recently" → blocked', () => {
    const contract = preExecutionConstraintGate('Find dentists in Texas that opened recently');
    assert.strictEqual(contract.can_execute, false);
    assert.ok(contract.clarify_questions.length > 0);
    assert.strictEqual(contract.stop_recommended, false);
  });

  it('Turn 2: "Opened recently means last 6 months. Use first reviews proxy." → resolves', () => {
    const initial = preExecutionConstraintGate('Find dentists in Texas that opened recently');
    assert.strictEqual(initial.can_execute, false);

    const resolved = resolveFollowUp(initial, 'Opened recently means last 6 months. Use first reviews proxy.');
    assert.strictEqual(resolved.can_execute, true, 'must be executable after proxy + window provided');
    assert.strictEqual(resolved.stop_recommended, false);

    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.chosen_proxy, 'recent_reviews');
    assert.strictEqual(tp.window, '6 months');
    assert.strictEqual(tp.window_days, 180);
    assert.strictEqual(tp.can_execute, true);
  });

  it('Turn 2 with proxy but no window → still blocked for window', () => {
    const initial = preExecutionConstraintGate('Find dentists in Texas that opened recently');
    const resolved = resolveFollowUp(initial, 'Use recent reviews proxy');
    assert.strictEqual(resolved.can_execute, false, 'must block — window still ambiguous');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.chosen_proxy, 'recent_reviews');
    assert.ok(tp.why_blocked!.includes('ambiguous'));
  });

  it('Turn 2 with window but no proxy → still blocked for proxy', () => {
    const initial = preExecutionConstraintGate('Find dentists in Texas that opened recently');
    const resolved = resolveFollowUp(initial, 'I mean the last 6 months');
    assert.strictEqual(resolved.can_execute, false, 'must block — no proxy selected');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.window, '6 months');
    assert.strictEqual(tp.chosen_proxy, null);
  });

  it('Turn 2 with "no proxies" → STOP recommended', () => {
    const initial = preExecutionConstraintGate('Find dentists in Texas that opened recently');
    const resolved = resolveFollowUp(initial, 'No proxies, I need certain data');
    assert.strictEqual(resolved.can_execute, false);
    assert.strictEqual(resolved.stop_recommended, true);
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.hardness, 'hard');
    assert.strictEqual(tp.verifiability, 'unverifiable');
  });
});

describe('Constraint Gate — compound constraints with follow-up', () => {
  it('compound time+attribute: follow-up resolves time, attribute stays', () => {
    const initial = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    assert.strictEqual(initial.can_execute, false);
    assert.ok(initial.constraints.length >= 2);

    const resolved = resolveFollowUp(initial, 'Use recent reviews proxy');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.chosen_proxy, 'recent_reviews');
    assert.strictEqual(tp.can_execute, true, 'time predicate resolved — window was explicit');

    const attr = resolved.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.ok(attr, 'attribute constraint must persist');
    assert.strictEqual(attr.attribute, 'live_music');

    assert.strictEqual(resolved.can_execute, true, 'all constraints resolved');
  });
});

describe('Constraint Gate — pending contract store', () => {
  it('stores and retrieves a pending contract', () => {
    const contract = preExecutionConstraintGate('Find pubs in Manchester opened in the last 12 months');
    storePendingContract('conv-1', 'Find pubs in Manchester opened in the last 12 months', contract);

    const retrieved = getPendingContract('conv-1');
    assert.ok(retrieved);
    assert.strictEqual(retrieved!.originalMessage, 'Find pubs in Manchester opened in the last 12 months');
    assert.strictEqual(retrieved!.contract.can_execute, false);

    clearPendingContract('conv-1');
    assert.strictEqual(getPendingContract('conv-1'), null);
  });

  it('returns null for non-existent conversation', () => {
    assert.strictEqual(getPendingContract('conv-nonexistent'), null);
  });
});

describe('Constraint Gate — message building', () => {
  it('stop message includes reason', () => {
    const contract = preExecutionConstraintGate('Find cafes in Brighton that just opened, no proxies, must be certain');
    const msg = buildConstraintGateMessage(contract);
    assert.ok(msg.includes('stop'));
    assert.ok(msg.includes('cannot be verified'));
  });

  it('clarification message lists questions', () => {
    const contract = preExecutionConstraintGate('Find pubs in Manchester that opened in the last 12 months');
    const msg = buildConstraintGateMessage(contract);
    assert.ok(msg.includes('clarify') || msg.includes('proxy') || msg.includes('guarantee'));
  });
});

describe('Constraint Gate — edge cases', () => {
  it('attribute-only constraint with soft hardness → can_execute=true (post-search verification)', () => {
    const contract = preExecutionConstraintGate('Find pubs in Leeds with live music');
    assert.strictEqual(contract.can_execute, true, 'attribute alone should not block — verifiable post-search');
    const attr = contract.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.ok(attr);
    assert.strictEqual(attr.can_verify_post_search, true);
  });

  it('"newly opened" with no window → blocks for both proxy and window', () => {
    const contract = preExecutionConstraintGate('Find newly opened restaurants in Brighton');
    assert.strictEqual(contract.can_execute, false);
    const tp = contract.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.ok(tp.required_inputs_missing.includes('time_window'));
  });

  it('"just opened" + "no proxies" → STOP immediately', () => {
    const contract = preExecutionConstraintGate('Find cafes that just opened in Manchester, no proxies');
    assert.strictEqual(contract.can_execute, false);
    assert.strictEqual(contract.stop_recommended, true);
  });

  it('explicit window + explicit proxy choice in initial message → does NOT auto-select proxy', () => {
    const contract = preExecutionConstraintGate('Find pubs opened in the last 12 months in Manchester');
    assert.strictEqual(contract.can_execute, false, 'no proxy selected yet');
    const tp = contract.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.chosen_proxy, null);
  });
});

describe('Constraint Gate — Chrome QA failure cases', () => {
  it('QA Case 1: time predicate search executes without clarification → BLOCKED', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Manchester that opened in the last 12 months');
    assert.strictEqual(contract.can_execute, false, 'QA FAIL: system must NOT execute with unresolved time predicate');
    assert.ok(contract.constraints.some(c => c.type === 'time_predicate'), 'time_predicate constraint must be extracted');
    assert.ok(contract.clarify_questions.length > 0, 'must ask for proxy choice');
  });

  it('QA Case 2: "no proxies" ignored → BLOCKED + STOP', () => {
    const contract = preExecutionConstraintGate('Find 10 cafes in Brighton that just opened, no proxies, must be certain');
    assert.strictEqual(contract.can_execute, false, 'QA FAIL: system must NOT execute when user says no proxies');
    assert.strictEqual(contract.stop_recommended, true, 'QA FAIL: must recommend stop');
  });

  it('QA Case 3: system loses compound requirements → BOTH preserved', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    const types = contract.constraints.map(c => c.type);
    assert.ok(types.includes('time_predicate'), 'QA FAIL: time_predicate lost');
    assert.ok(types.includes('attribute'), 'QA FAIL: live_music attribute lost');
    assert.ok(contract.constraints.length >= 2, 'QA FAIL: compound constraints not all extracted');
  });

  it('QA Case 4: system proceeds to tools despite unresolved constraints → BLOCKED', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Manchester that opened in the last 12 months');
    assert.strictEqual(contract.can_execute, false, 'QA FAIL: gate must block before any tools run');
  });
});
