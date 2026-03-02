import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  extractAllConstraints,
  extractAttributes,
  preExecutionConstraintGate,
  resolveFollowUp,
  detectNoProxySignal,
  detectProxySelection,
  detectBestEffort,
  detectLiveMusicChoice,
  detectMustBeCertain,
  isCertainVerifiable,
  applyCertaintyGate,
  buildConstraintGateMessage,
  storePendingContract,
  getPendingContract,
  clearPendingContract,
  detectSubjectiveTerms,
  hasMeasurableCriteria,
  detectRelationshipStrategyChoice,
  type ConstraintContract,
  type AttributeConstraint,
  type SubjectivePredicateConstraint,
  type NumericAmbiguityConstraint,
  type RelationshipPredicateConstraint,
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
    assert.strictEqual(attr.requires_clarification, true, 'live_music must require clarification');
    assert.strictEqual(attr.chosen_verification, null, 'no verification chosen yet');
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

  it('non-blocking attributes do not require clarification', () => {
    const constraints = extractAllConstraints('Find pubs in Leeds with a beer garden');
    const attr = constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.ok(attr);
    assert.strictEqual(attr.requires_clarification, false, 'beer_garden should not block');
  });
});

describe('Constraint Gate — preExecutionConstraintGate', () => {
  it('Case 1: time-only "Find 10 pubs in Manchester opened in last 12 months" → can_execute=false, asks for proxy', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Manchester that opened in the last 12 months');
    assert.strictEqual(contract.can_execute, false, 'must NOT execute — time predicate requires proxy');
    assert.ok(contract.clarify_questions.length > 0, 'must ask clarification questions');
    assert.strictEqual(contract.stop_recommended, false, 'should not stop — just needs proxy selection');
    assert.ok(contract.why_blocked !== null);
  });

  it('Case 1 message includes A/B/C options for time predicate', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Manchester that opened in the last 12 months');
    const msg = buildConstraintGateMessage(contract);
    assert.ok(msg.includes('A)'), 'must include option A');
    assert.ok(msg.includes('B)'), 'must include option B');
    assert.ok(msg.includes('C)'), 'must include option C');
    assert.ok(msg.includes('news mentions'), 'must mention news mentions proxy');
    assert.ok(msg.includes('first reviews'), 'must mention first reviews proxy');
    assert.ok(msg.includes('Best-effort'), 'must mention best-effort option');
  });

  it('Case 2: "just opened, no proxies, must be certain" → STOP', () => {
    const contract = preExecutionConstraintGate('Find 10 cafes in Brighton that just opened, no proxies, must be certain');
    assert.strictEqual(contract.can_execute, false, 'must NOT execute');
    assert.strictEqual(contract.stop_recommended, true, 'must recommend stop');
    assert.ok(contract.why_blocked !== null);
    assert.ok(contract.why_blocked!.includes('cannot be'));
  });

  it('Case 3: compound "opened in the last 12 months and have live music" → can_execute=false, BOTH in constraints, time surfaced first', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    assert.strictEqual(contract.can_execute, false, 'must NOT execute — both need clarification');
    const tp = contract.constraints.find(c => c.type === 'time_predicate');
    const attr = contract.constraints.find(c => c.type === 'attribute');
    assert.ok(tp, 'time_predicate must be in constraints');
    assert.ok(attr, 'attribute must be in constraints');
    assert.strictEqual(contract.clarify_questions.length, 1, 'only ONE question at a time — time predicate first');
    assert.ok(contract.clarify_questions[0].includes('opening dates') || contract.clarify_questions[0].includes('guarantee') || contract.clarify_questions[0].includes('proxy'), 'first question must be about time predicate');
  });

  it('Case 3 compound: after resolving time, live music question surfaces next', () => {
    const initial = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    assert.strictEqual(initial.clarify_questions.length, 1, 'one question at a time');
    const resolved = resolveFollowUp(initial, 'Use news mentions proxy');
    assert.strictEqual(resolved.can_execute, false, 'live music still unresolved');
    assert.strictEqual(resolved.clarify_questions.length, 1, 'now live music question surfaces');
    assert.ok(resolved.clarify_questions[0].includes('website') || resolved.clarify_questions[0].includes('Live music') || resolved.clarify_questions[0].includes('live music'), 'question must be about live music');
  });

  it('live music only → can_execute=false, asks verification question', () => {
    const contract = preExecutionConstraintGate('Find pubs in Leeds with live music');
    assert.strictEqual(contract.can_execute, false, 'live music must block until user chooses verification');
    assert.strictEqual(contract.clarify_questions.length, 1);
    const msg = buildConstraintGateMessage(contract);
    assert.ok(msg.includes('A)'), 'must include option A (verify via website)');
    assert.ok(msg.includes('B)'), 'must include option B (best-effort)');
    assert.ok(msg.includes('website') || msg.includes('listings'), 'must mention website/listings verification');
  });

  it('plain search with no constraints → can_execute=true', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Manchester');
    assert.strictEqual(contract.can_execute, true);
    assert.strictEqual(contract.why_blocked, null);
    assert.strictEqual(contract.stop_recommended, false);
    assert.strictEqual(contract.constraints.length, 0);
  });

  it('"no proxies" in message → hard+unverifiable on time predicate → STOP', () => {
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
    assert.strictEqual(contract.stop_recommended, true);
  });
});

describe('Constraint Gate — signal detection', () => {
  it('"no proxies" → true', () => assert.ok(detectNoProxySignal('no proxies')));
  it('"no proxy" → true', () => assert.ok(detectNoProxySignal('no proxy')));
  it('"must be certain" → false (handled by detectMustBeCertain, not detectNoProxySignal)', () => assert.strictEqual(detectNoProxySignal('must be certain'), false));
  it('"must be guaranteed" → false (handled by detectMustBeCertain)', () => assert.strictEqual(detectNoProxySignal('must be guaranteed'), false));
  it('"don\'t use proxies" → true', () => assert.ok(detectNoProxySignal("don't use proxies")));
  it('"use recent reviews" → false', () => assert.strictEqual(detectNoProxySignal('use recent reviews'), false));

  it('"best-effort" → best effort detected', () => assert.ok(detectBestEffort('best-effort is fine')));
  it('"unverified is ok" → best effort detected', () => assert.ok(detectBestEffort('unverified is ok')));
  it('"option C" → best effort detected', () => assert.ok(detectBestEffort('option C')));
  it('"C)" → best effort detected', () => assert.ok(detectBestEffort('C)')));

  it('"use news mentions proxy" → news_mention', () => {
    assert.strictEqual(detectProxySelection('use news mentions proxy'), 'news_mention');
  });
  it('"use recent reviews proxy" → recent_reviews', () => {
    assert.strictEqual(detectProxySelection('use recent reviews proxy'), 'recent_reviews');
  });
  it('"best effort" does NOT select a proxy', () => {
    assert.strictEqual(detectProxySelection('best effort, unverified is ok'), null);
  });

  it('"verify via website" → website_verify for live music', () => {
    assert.strictEqual(detectLiveMusicChoice('verify via website'), 'website_verify');
  });
  it('"A)" → website_verify for live music', () => {
    assert.strictEqual(detectLiveMusicChoice('A)'), 'website_verify');
  });
  it('"B)" → best_effort for live music', () => {
    assert.strictEqual(detectLiveMusicChoice('B)'), 'best_effort');
  });
  it('"best effort" → best_effort for live music', () => {
    assert.strictEqual(detectLiveMusicChoice('best effort'), 'best_effort');
  });
});

describe('Constraint Gate — bare A/B/C option responses for time predicates', () => {
  it('"A)" alone selects news_mention proxy', () => {
    const initial = preExecutionConstraintGate('Find pubs in Manchester that opened in the last 12 months');
    const resolved = resolveFollowUp(initial, 'A)');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.chosen_proxy, 'news_mention');
    assert.strictEqual(resolved.can_execute, true);
  });

  it('"B)" alone selects recent_reviews proxy', () => {
    const initial = preExecutionConstraintGate('Find pubs in Manchester that opened in the last 12 months');
    const resolved = resolveFollowUp(initial, 'B)');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.chosen_proxy, 'recent_reviews');
    assert.strictEqual(resolved.can_execute, true);
  });

  it('"C)" alone selects best-effort', () => {
    const initial = preExecutionConstraintGate('Find pubs in Manchester that opened in the last 12 months');
    const resolved = resolveFollowUp(initial, 'C)');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.chosen_proxy, 'best_effort');
    assert.strictEqual(resolved.can_execute, true);
  });
});

describe('Constraint Gate — best-effort does not conflict with hard language', () => {
  it('hard language + best-effort follow-up → resolves, does NOT stop', () => {
    const initial = preExecutionConstraintGate('Find cafes in London that must have opened in the last 12 months');
    assert.strictEqual(initial.can_execute, false);
    const tp0 = initial.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.strictEqual(tp0.hardness, 'hard');

    const resolved = resolveFollowUp(initial, 'Best-effort, unverified is OK');
    assert.strictEqual(resolved.can_execute, true, 'best-effort must override hard language');
    assert.strictEqual(resolved.stop_recommended, false, 'must NOT stop');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.strictEqual(tp.chosen_proxy, 'best_effort');
    assert.strictEqual(tp.hardness, 'soft', 'best-effort softens hardness');
  });
});

describe('Constraint Gate — two-turn proxy acceptance', () => {
  it('Turn 1: "Find dentists in Texas that opened recently" → blocked', () => {
    const contract = preExecutionConstraintGate('Find dentists in Texas that opened recently');
    assert.strictEqual(contract.can_execute, false);
    assert.ok(contract.clarify_questions.length > 0);
    assert.strictEqual(contract.stop_recommended, false);
  });

  it('Turn 2: proxy choice with window → resolves', () => {
    const initial = preExecutionConstraintGate('Find dentists in Texas that opened recently');
    const resolved = resolveFollowUp(initial, 'Last 6 months. Use first reviews proxy.');
    assert.strictEqual(resolved.can_execute, true, 'must be executable after proxy + window provided');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.chosen_proxy, 'recent_reviews');
    assert.strictEqual(tp.window, '6 months');
    assert.strictEqual(tp.can_execute, true);
  });

  it('Turn 2: best-effort choice → resolves without proxy', () => {
    const initial = preExecutionConstraintGate('Find pubs in Manchester that opened in the last 12 months');
    const resolved = resolveFollowUp(initial, 'Best-effort, unverified is OK');
    assert.strictEqual(resolved.can_execute, true, 'best-effort must resolve the constraint');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.chosen_proxy, 'best_effort');
  });

  it('Turn 2: "no proxies" → STOP', () => {
    const initial = preExecutionConstraintGate('Find dentists in Texas that opened recently');
    const resolved = resolveFollowUp(initial, 'No proxies, I need certain data');
    assert.strictEqual(resolved.can_execute, false);
    assert.strictEqual(resolved.stop_recommended, true);
  });

  it('Turn 2: proxy but no window → still blocked for window', () => {
    const initial = preExecutionConstraintGate('Find dentists in Texas that opened recently');
    const resolved = resolveFollowUp(initial, 'Use recent reviews proxy');
    assert.strictEqual(resolved.can_execute, false, 'must block — window still ambiguous');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.chosen_proxy, 'recent_reviews');
  });

  it('Turn 2: window but no proxy → still blocked for proxy', () => {
    const initial = preExecutionConstraintGate('Find dentists in Texas that opened recently');
    const resolved = resolveFollowUp(initial, 'I mean the last 6 months');
    assert.strictEqual(resolved.can_execute, false, 'must block — no proxy selected');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.window, '6 months');
    assert.strictEqual(tp.chosen_proxy, null);
  });
});

describe('Constraint Gate — live music follow-up resolution', () => {
  it('live music: "verify via website" resolves', () => {
    const initial = preExecutionConstraintGate('Find pubs in Leeds with live music');
    assert.strictEqual(initial.can_execute, false);
    const resolved = resolveFollowUp(initial, 'Verify via website');
    assert.strictEqual(resolved.can_execute, true);
    const attr = resolved.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.ok(attr);
    assert.strictEqual(attr.chosen_verification, 'website_verify');
  });

  it('live music: "best effort" resolves', () => {
    const initial = preExecutionConstraintGate('Find pubs in Leeds with live music');
    const resolved = resolveFollowUp(initial, 'Best-effort, unverified is OK');
    assert.strictEqual(resolved.can_execute, true);
    const attr = resolved.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.strictEqual(attr.chosen_verification, 'best_effort');
  });

  it('live music: "A)" resolves to website_verify', () => {
    const initial = preExecutionConstraintGate('Find pubs in Leeds with live music');
    const resolved = resolveFollowUp(initial, 'A)');
    assert.strictEqual(resolved.can_execute, true);
    const attr = resolved.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.strictEqual(attr.chosen_verification, 'website_verify');
  });

  it('live music: "B)" resolves to best_effort', () => {
    const initial = preExecutionConstraintGate('Find pubs in Leeds with live music');
    const resolved = resolveFollowUp(initial, 'B)');
    assert.strictEqual(resolved.can_execute, true);
    const attr = resolved.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.strictEqual(attr.chosen_verification, 'best_effort');
  });
});

describe('Constraint Gate — sequential compound follow-up', () => {
  it('compound: time resolved first, then live music resolved second (two turns)', () => {
    const initial = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    assert.strictEqual(initial.can_execute, false);
    assert.strictEqual(initial.clarify_questions.length, 1, 'only time question first');

    const afterTime = resolveFollowUp(initial, 'Use news mentions proxy');
    assert.strictEqual(afterTime.can_execute, false, 'live music still unresolved');
    const tp = afterTime.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.strictEqual(tp.chosen_proxy, 'news_mention');
    assert.strictEqual(tp.can_execute, true);
    const attrMid = afterTime.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.strictEqual(attrMid.chosen_verification, null, 'live music not yet processed — was suppressed');
    assert.strictEqual(afterTime.clarify_questions.length, 1, 'now live music question surfaces');

    const afterLive = resolveFollowUp(afterTime, 'Verify via website');
    assert.strictEqual(afterLive.can_execute, true, 'both resolved');
    const attr = afterLive.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.strictEqual(attr.chosen_verification, 'website_verify');
  });

  it('compound: resolving time only → still blocked on live music, live music untouched', () => {
    const initial = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    const resolved = resolveFollowUp(initial, 'Use recent reviews proxy');
    assert.strictEqual(resolved.can_execute, false, 'live music still unresolved');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.strictEqual(tp.can_execute, true);
    const attr = resolved.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.strictEqual(attr.chosen_verification, null, 'live music not yet resolved');
  });

  it('compound: best-effort for time, then verify for live music (two turns)', () => {
    const initial = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    const afterTime = resolveFollowUp(initial, 'C)');
    const tp = afterTime.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.strictEqual(tp.chosen_proxy, 'best_effort');
    assert.strictEqual(afterTime.can_execute, false, 'live music still unresolved');

    const afterLive = resolveFollowUp(afterTime, 'A)');
    const attr = afterLive.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.strictEqual(attr.chosen_verification, 'website_verify');
    assert.strictEqual(afterLive.can_execute, true);
  });
});

describe('Constraint Gate — resolved constraint stability', () => {
  it('resolved time proxy is NOT overwritten by later best-effort for live music', () => {
    const initial = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    const afterTime = resolveFollowUp(initial, 'Use news mentions proxy');
    const tp1 = afterTime.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.strictEqual(tp1.chosen_proxy, 'news_mention');
    assert.strictEqual(tp1.can_execute, true);

    const afterLive = resolveFollowUp(afterTime, 'Best-effort, unverified is OK');
    const tp2 = afterLive.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.strictEqual(tp2.chosen_proxy, 'news_mention', 'time proxy must NOT be overwritten');
    const attr = afterLive.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.strictEqual(attr.chosen_verification, 'best_effort');
    assert.strictEqual(afterLive.can_execute, true);
  });

  it('resolved subjective is NOT re-surfaced after resolution', () => {
    const initial = preExecutionConstraintGate('Find nice pubs in Bristol that opened in the last 12 months');
    assert.strictEqual(initial.clarify_questions.length, 1);
    assert.ok(initial.clarify_questions[0].includes("'nice'"));

    const afterSubj = resolveFollowUp(initial, 'lively');
    assert.ok(!afterSubj.clarify_questions.some(q => q.includes("'nice'")), 'subjective question must not reappear');
    const sp = afterSubj.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    assert.strictEqual(sp.can_execute, true, 'subjective marked resolved');
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
    assert.ok(msg.includes('cannot be'));
  });

  it('time-only clarification message has A/B/C options', () => {
    const contract = preExecutionConstraintGate('Find pubs in Manchester that opened in the last 12 months');
    const msg = buildConstraintGateMessage(contract);
    assert.ok(msg.includes('A)'));
    assert.ok(msg.includes('B)'));
    assert.ok(msg.includes('C)'));
  });

  it('live-music-only clarification message has A/B options', () => {
    const contract = preExecutionConstraintGate('Find pubs in Leeds with live music');
    const msg = buildConstraintGateMessage(contract);
    assert.ok(msg.includes('A)'));
    assert.ok(msg.includes('B)'));
  });

  it('compound clarification shows single question (sequential)', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    const msg = buildConstraintGateMessage(contract);
    assert.ok(msg.includes('one thing'), 'single question phrasing');
    assert.ok(!msg.includes('1.'), 'must NOT have bullet list — only one question');
  });
});

describe('Constraint Gate — edge cases', () => {
  it('non-blocking attribute (beer garden) does NOT block', () => {
    const contract = preExecutionConstraintGate('Find pubs in Leeds with a beer garden');
    assert.strictEqual(contract.can_execute, true, 'beer garden should not block');
  });

  it('"newly opened" with no window → blocks for proxy and window', () => {
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
});

describe('Constraint Gate — subjective predicate extraction (Batch 1)', () => {
  it('"Find nice bars in Manchester" → extracts subjective_predicate, can_execute=false', () => {
    const contract = preExecutionConstraintGate('Find nice bars in Manchester');
    assert.strictEqual(contract.can_execute, false);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate');
    assert.ok(sp, 'subjective_predicate constraint must exist');
    assert.strictEqual(sp!.type, 'subjective_predicate');
    if (sp!.type === 'subjective_predicate') {
      assert.strictEqual(sp!.verifiability, 'unverifiable');
      assert.strictEqual(sp!.hardness, 'soft');
      assert.ok(sp!.required_inputs_missing.includes('definition_of_nice'));
      assert.ok(sp!.why_blocked.includes('subjective'));
      assert.ok(sp!.suggested_rephrase !== null);
      assert.ok(sp!.clarification_options.length > 0, 'must include clarification options');
    }
  });

  it('"Find best pubs in Leeds" → extracts numeric_ambiguity (ranking)', () => {
    const contract = preExecutionConstraintGate('Find best pubs in Leeds');
    assert.strictEqual(contract.can_execute, false);
    const na = contract.constraints.find(c => c.type === 'numeric_ambiguity') as NumericAmbiguityConstraint;
    assert.ok(na, 'numeric_ambiguity constraint must exist');
    assert.strictEqual(na.category, 'ranking');
  });

  it('"Find good cafes" → extracts subjective_predicate', () => {
    const contract = preExecutionConstraintGate('Find good cafes');
    assert.strictEqual(contract.can_execute, false);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate');
    assert.ok(sp, 'subjective_predicate constraint must exist');
  });

  it('"Find lively bars in Manchester" → no subjective_predicate, can_execute=true', () => {
    const contract = preExecutionConstraintGate('Find lively bars in Manchester');
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate');
    assert.strictEqual(sp, undefined, 'lively is measurable, not subjective');
    assert.strictEqual(contract.can_execute, true);
  });

  it('"Find cosy pubs with live music" → no subjective_predicate (cosy is measurable)', () => {
    const contract = preExecutionConstraintGate('Find cosy pubs with live music');
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate');
    assert.strictEqual(sp, undefined, 'cosy is measurable, not subjective');
  });

  it('"Find nice pubs with live music" → subjective_predicate extracted (nice unresolved)', () => {
    const contract = preExecutionConstraintGate('Find nice pubs with live music');
    assert.strictEqual(contract.can_execute, false);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate');
    assert.ok(sp, 'subjective_predicate constraint must exist even alongside measurable attributes');
  });

  it('"nice pubs opened recently" → both subjective_predicate AND time_predicate extracted, but only subjective surfaced', () => {
    const contract = preExecutionConstraintGate('Find nice pubs opened recently');
    assert.strictEqual(contract.can_execute, false);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate');
    const tp = contract.constraints.find(c => c.type === 'time_predicate');
    assert.ok(sp, 'subjective_predicate must exist');
    assert.ok(tp, 'time_predicate must exist (stored, not surfaced yet)');
    assert.strictEqual(contract.clarify_questions.length, 1, 'only subjective question surfaced — time suppressed');
    assert.ok(contract.clarify_questions[0].includes("'nice'"), 'surfaced question must be about the subjective term');
  });

  it('"Find 10 pubs in Manchester" → no subjective_predicate (plain search)', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Manchester');
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate');
    assert.strictEqual(sp, undefined);
    assert.strictEqual(contract.can_execute, true);
  });

  it('subjective_predicate clarify question mentions the detected term', () => {
    const contract = preExecutionConstraintGate('Find nice bars in Manchester');
    assert.ok(contract.clarify_questions.some(q => q.includes("'nice'")), 'Should reference the subjective term');
  });
});

describe('Constraint Gate — acceptance tests (exact QA scenarios)', () => {
  it('ACCEPTANCE: compound "Find 10 pubs in Bristol that opened in the last 12 months and have live music" → sequential clarification, no searching, no tools', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    assert.strictEqual(contract.can_execute, false, 'MUST NOT execute');
    assert.ok(contract.constraints.length >= 2, 'both constraints extracted');
    assert.strictEqual(contract.clarify_questions.length, 1, 'one question at a time — time predicate first');
    assert.strictEqual(contract.stop_recommended, false, 'not a stop — clarification needed');
  });

  it('ACCEPTANCE: time-only "Find 10 pubs in Manchester opened in last 12 months" → clarification, no searching', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Manchester opened in last 12 months');
    assert.strictEqual(contract.can_execute, false, 'MUST NOT execute');
    assert.ok(contract.clarify_questions.length >= 1, 'must ask clarification');
    assert.strictEqual(contract.stop_recommended, false);
    const msg = buildConstraintGateMessage(contract);
    assert.ok(msg.includes('A)'), 'must have option A');
    assert.ok(msg.includes('B)'), 'must have option B');
    assert.ok(msg.includes('C)'), 'must have option C');
  });

  it('ACCEPTANCE: explicit refusal "just opened, no proxies, must be certain" → STOP, no searching', () => {
    const contract = preExecutionConstraintGate('Find 10 cafes in Brighton that just opened, no proxies, must be certain');
    assert.strictEqual(contract.can_execute, false, 'MUST NOT execute');
    assert.strictEqual(contract.stop_recommended, true, 'MUST recommend stop');
    const msg = buildConstraintGateMessage(contract);
    assert.ok(msg.includes('stop'), 'stop message must say stop');
  });
});

describe('Batch 2 QA — detectNoProxySignal', () => {
  it('"no proxies" detected', () => {
    assert.strictEqual(detectNoProxySignal('Find 10 pubs that just opened, no proxies'), true);
  });

  it('"must be certain" detected via detectMustBeCertain (not detectNoProxySignal)', () => {
    assert.strictEqual(detectNoProxySignal('Find cafes opened recently, must be certain'), false);
    assert.strictEqual(detectMustBeCertain('Find cafes opened recently, must be certain'), true);
  });

  it('"don\'t guess" detected', () => {
    assert.strictEqual(detectNoProxySignal("Find pubs in Leeds opened last year, don't guess"), true);
  });

  it('normal request without no-proxy signal', () => {
    assert.strictEqual(detectNoProxySignal('Find 10 pubs in Manchester opened in the last 12 months'), false);
  });

  it('Test 3 scenario: original request has "no proxies" → detectNoProxySignal returns true, even though synthetic message loses that signal', () => {
    const originalRequest = 'Find 10 cafes in Brighton that just opened, no proxies';
    const syntheticMsg = 'find cafes in Brighton';
    assert.strictEqual(detectNoProxySignal(originalRequest), true);
    assert.strictEqual(detectNoProxySignal(syntheticMsg), false);
  });

  it('Test 3b scenario: original request has "must be certain" → detectMustBeCertain returns true, detectNoProxySignal returns false', () => {
    const originalRequest = 'Find 10 cafes in Brighton that just opened, must be certain';
    assert.strictEqual(detectMustBeCertain(originalRequest), true);
    assert.strictEqual(detectNoProxySignal(originalRequest), false);
  });
});

describe('detectMustBeCertain', () => {
  it('detects "must be certain"', () => {
    assert.strictEqual(detectMustBeCertain('Find pubs opened recently, must be certain'), true);
  });

  it('detects "must be guaranteed"', () => {
    assert.strictEqual(detectMustBeCertain('I need pubs that opened last year, must be guaranteed'), true);
  });

  it('detects "must be verified"', () => {
    assert.strictEqual(detectMustBeCertain('Find cafes, must be verified'), true);
  });

  it('detects "need to be certain"', () => {
    assert.strictEqual(detectMustBeCertain('I need to be certain about the opening date'), true);
  });

  it('detects "require certainty"', () => {
    assert.strictEqual(detectMustBeCertain('I require certainty on the opening dates'), true);
  });

  it('detects "has to be certain"', () => {
    assert.strictEqual(detectMustBeCertain('The data has to be certain'), true);
  });

  it('detects "i need certainty"', () => {
    assert.strictEqual(detectMustBeCertain('I need certainty on this'), true);
  });

  it('detects "certainty is required"', () => {
    assert.strictEqual(detectMustBeCertain('Certainty is required for these results'), true);
  });

  it('detects "only if you\'re certain"', () => {
    assert.strictEqual(detectMustBeCertain("Only if you're certain"), true);
  });

  it('does NOT trigger on normal requests', () => {
    assert.strictEqual(detectMustBeCertain('Find 10 pubs in Manchester opened in the last 12 months'), false);
  });

  it('does NOT trigger on best-effort requests', () => {
    assert.strictEqual(detectMustBeCertain('Find pubs, best effort is fine'), false);
  });
});

describe('isCertainVerifiable', () => {
  it('returns false for time_predicate constraints', () => {
    const tp: TimePredicateContract = {
      type: 'time_predicate',
      predicate: 'opened',
      window: '12 months',
      window_days: 365,
      reference_date: 'now',
      hardness: 'hard',
      verifiability: 'proxy',
      required_inputs_missing: [],
      can_execute: false,
      why_blocked: null,
      suggested_rephrase: null,
      proxy_options: [],
      chosen_proxy: null,
    };
    assert.strictEqual(isCertainVerifiable(tp), false);
  });

  it('returns false for live_music attribute', () => {
    const attr: AttributeConstraint = {
      type: 'attribute',
      attribute: 'live_music',
      verifiability: 'proxy',
      requires_clarification: true,
      chosen_verification: null,
      hardness: 'soft',
    };
    assert.strictEqual(isCertainVerifiable(attr), false);
  });

  it('returns true for verifiable attributes like beer_garden', () => {
    const attr: AttributeConstraint = {
      type: 'attribute',
      attribute: 'beer_garden',
      verifiability: 'verifiable',
      requires_clarification: false,
      chosen_verification: null,
      hardness: 'soft',
    };
    assert.strictEqual(isCertainVerifiable(attr), true);
  });
});

describe('preExecutionConstraintGate — must be certain', () => {
  it('blocks execution with stop_recommended when "must be certain" + time predicate', () => {
    const result = preExecutionConstraintGate('Find 10 pubs in Manchester opened in the last 12 months, must be certain');
    assert.strictEqual(result.can_execute, false);
    assert.strictEqual(result.stop_recommended, true);
    assert.ok(result.why_blocked);
    assert.ok(result.why_blocked!.includes('certainty'));
    const tp = result.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(tp);
    assert.strictEqual(tp.must_be_certain, true);
    assert.strictEqual(tp.can_execute, false);
  });

  it('blocks execution when "must be guaranteed" + time predicate', () => {
    const result = preExecutionConstraintGate('Find cafes that opened in the last 6 months, must be guaranteed');
    assert.strictEqual(result.can_execute, false);
    assert.strictEqual(result.stop_recommended, true);
  });

  it('does NOT block when "must be certain" but no unverifiable constraints', () => {
    const result = preExecutionConstraintGate('Find pubs with a beer garden, must be certain');
    assert.strictEqual(result.can_execute, true);
    assert.strictEqual(result.stop_recommended, false);
  });

  it('sets must_be_certain on all constraints when detected in initial message', () => {
    const result = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music, must be certain');
    for (const c of result.constraints) {
      assert.strictEqual(c.must_be_certain, true);
    }
    assert.strictEqual(result.can_execute, false);
    assert.strictEqual(result.stop_recommended, true);
  });

  it('STOP message includes alternatives text', () => {
    const result = preExecutionConstraintGate('Find pubs that opened in the last 12 months, must be certain');
    const msg = buildConstraintGateMessage(result);
    assert.ok(msg.includes('stop here') || msg.includes('certainty'), `Expected STOP message to mention "stop here" or "certainty", got: ${msg.substring(0, 200)}`);
  });
});

describe('resolveFollowUp — must be certain as follow-up', () => {
  it('follow-up "must be certain" after clarify question → blocks with STOP', () => {
    const initial = preExecutionConstraintGate('Find 10 pubs in Manchester opened in the last 12 months');
    assert.strictEqual(initial.can_execute, false);
    assert.strictEqual(initial.stop_recommended, false);

    const resolved = resolveFollowUp(initial, 'must be certain');
    assert.strictEqual(resolved.can_execute, false);
    assert.strictEqual(resolved.stop_recommended, true);
    assert.ok(resolved.why_blocked);
    assert.ok(resolved.why_blocked!.includes('certainty'));
  });

  it('follow-up "I need certainty" → blocks with STOP', () => {
    const initial = preExecutionConstraintGate('Find 10 pubs in Manchester opened in the last 12 months');
    const resolved = resolveFollowUp(initial, 'I need certainty');
    assert.strictEqual(resolved.can_execute, false);
    assert.strictEqual(resolved.stop_recommended, true);
  });

  it('follow-up "best effort" still works normally (no certainty block)', () => {
    const initial = preExecutionConstraintGate('Find 10 pubs in Manchester opened in the last 12 months');
    const resolved = resolveFollowUp(initial, 'best effort is fine');
    assert.strictEqual(resolved.can_execute, true);
    assert.strictEqual(resolved.stop_recommended, false);
  });

  it('follow-up "option B" (proxy selection) still works normally', () => {
    const initial = preExecutionConstraintGate('Find 10 pubs in Manchester opened in the last 12 months');
    const resolved = resolveFollowUp(initial, 'option B');
    assert.strictEqual(resolved.can_execute, true);
    assert.strictEqual(resolved.stop_recommended, false);
  });
});

describe('applyCertaintyGate', () => {
  it('blocks contract with unverifiable must_be_certain constraints', () => {
    const contract: ConstraintContract = {
      constraints: [{
        type: 'time_predicate',
        predicate: 'opened',
        window: '12 months',
        window_days: 365,
        reference_date: 'now',
        hardness: 'soft',
        verifiability: 'proxy',
        required_inputs_missing: [],
        can_execute: false,
        why_blocked: null,
        suggested_rephrase: null,
        proxy_options: [],
        chosen_proxy: null,
        must_be_certain: true,
      }],
      can_execute: false,
      why_blocked: null,
      clarify_questions: ['Some question'],
      stop_recommended: false,
    };
    const result = applyCertaintyGate(contract);
    assert.strictEqual(result.can_execute, false);
    assert.strictEqual(result.stop_recommended, true);
    assert.ok(result.why_blocked!.includes('certainty'));
    assert.strictEqual(result.clarify_questions.length, 0);
  });

  it('passes through contract with only verifiable must_be_certain constraints', () => {
    const contract: ConstraintContract = {
      constraints: [{
        type: 'attribute',
        attribute: 'beer_garden',
        verifiability: 'verifiable',
        requires_clarification: false,
        chosen_verification: null,
        hardness: 'soft',
        must_be_certain: true,
      }],
      can_execute: true,
      why_blocked: null,
      clarify_questions: [],
      stop_recommended: false,
    };
    const result = applyCertaintyGate(contract);
    assert.strictEqual(result.can_execute, true);
    assert.strictEqual(result.stop_recommended, false);
  });
});

describe('detectSubjectiveTerms', () => {
  it('detects "nice" from "Find nice bars in Manchester"', () => {
    const terms = detectSubjectiveTerms('Find nice bars in Manchester');
    assert.ok(terms.includes('nice'));
  });

  it('"best" no longer in subjective (moved to numeric_ambiguity)', () => {
    const terms = detectSubjectiveTerms('Find best pubs in Leeds');
    assert.strictEqual(terms.length, 0, 'bare "best" is now numeric_ambiguity, not subjective');
  });

  it('detects "good" from "Find good cafes"', () => {
    const terms = detectSubjectiveTerms('Find good cafes');
    assert.ok(terms.includes('good'));
  });

  it('detects multiple terms from "Find nice trendy bars"', () => {
    const terms = detectSubjectiveTerms('Find nice trendy bars');
    assert.ok(terms.includes('nice'));
    assert.ok(terms.includes('trendy'));
  });

  it('detects expanded terms: popular, fancy, high-end, recommended, quality', () => {
    assert.ok(detectSubjectiveTerms('popular bars').includes('popular'));
    assert.ok(detectSubjectiveTerms('fancy restaurants').includes('fancy'));
    assert.ok(detectSubjectiveTerms('high-end pubs').includes('high-end'));
    assert.ok(detectSubjectiveTerms('recommended cafes').includes('recommended'));
    assert.ok(detectSubjectiveTerms('quality pubs').includes('quality'));
  });

  it('returns empty for "lively bars in Manchester" (lively is measurable)', () => {
    const terms = detectSubjectiveTerms('Find lively bars in Manchester');
    assert.strictEqual(terms.length, 0);
  });

  it('returns empty for "cosy pubs with live music" (all measurable)', () => {
    const terms = detectSubjectiveTerms('Find cosy pubs with live music');
    assert.strictEqual(terms.length, 0);
  });

  it('does not false-positive on "good for studying"', () => {
    const terms = detectSubjectiveTerms('Find cafes good for studying');
    assert.strictEqual(terms.length, 0);
  });

  it('does not false-positive on "good guinness"', () => {
    const terms = detectSubjectiveTerms('Find pubs with good guinness');
    assert.strictEqual(terms.length, 0);
  });
});

describe('hasMeasurableCriteria', () => {
  it('detects "live music" as measurable', () => {
    assert.ok(hasMeasurableCriteria('Find pubs with live music'));
  });

  it('detects "cosy" as measurable', () => {
    assert.ok(hasMeasurableCriteria('Find cosy pubs'));
  });

  it('detects "dog friendly" as measurable', () => {
    assert.ok(hasMeasurableCriteria('Find dog friendly cafes'));
  });

  it('detects "quiet" as measurable', () => {
    assert.ok(hasMeasurableCriteria('Find quiet bars'));
  });

  it('detects "good guinness" as measurable', () => {
    assert.ok(hasMeasurableCriteria('Find pubs with good guinness'));
  });

  it('returns false for "nice bars" (nice is not measurable)', () => {
    assert.strictEqual(hasMeasurableCriteria('Find nice bars'), false);
  });

  it('returns false for plain "pubs in Manchester"', () => {
    assert.strictEqual(hasMeasurableCriteria('Find pubs in Manchester'), false);
  });
});

describe('Constraint Gate — Batch 1 Layer 2 regression tests', () => {
  it('A) "Find nice bars in Manchester" → CLARIFY, asks what "nice" means, no RUN', () => {
    const contract = preExecutionConstraintGate('Find nice bars in Manchester');
    assert.strictEqual(contract.can_execute, false);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    assert.ok(sp);
    assert.ok(sp.label.includes('nice'));
    assert.ok(sp.required_inputs_missing.includes('definition_of_nice'));
    assert.ok(contract.clarify_questions.some(q => q.includes("'nice'")));
  });

  it('B) "Find good pubs in Leeds" → CLARIFY', () => {
    const contract = preExecutionConstraintGate('Find good pubs in Leeds');
    assert.strictEqual(contract.can_execute, false);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    assert.ok(sp);
    assert.ok(sp.label.includes('good'));
  });

  it('C) "Find lively bars in Manchester" → RUN (no clarify)', () => {
    const contract = preExecutionConstraintGate('Find lively bars in Manchester');
    assert.strictEqual(contract.can_execute, true);
    assert.strictEqual(contract.constraints.length, 0);
  });

  it('D) "Find nice pubs in Bristol with live music" → CLARIFY for "nice" (must not RUN)', () => {
    const contract = preExecutionConstraintGate('Find nice pubs in Bristol with live music');
    assert.strictEqual(contract.can_execute, false);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    assert.ok(sp, 'subjective_predicate must exist even with measurable live music');
    assert.strictEqual(sp.label, 'nice');
  });

  it('E) "Find nice pubs in Bristol that opened in last 12 months" → CLARIFY subjective only, time stored but suppressed', () => {
    const contract = preExecutionConstraintGate('Find nice pubs in Bristol that opened in last 12 months');
    assert.strictEqual(contract.can_execute, false);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    const tp = contract.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.ok(sp, 'subjective_predicate must exist');
    assert.ok(tp, 'time_predicate must exist (stored, not surfaced)');
    assert.strictEqual(contract.clarify_questions.length, 1, 'only subjective question surfaced');
    assert.ok(contract.clarify_questions[0].includes("'nice'"), 'surfaced question must be about the subjective term');
    assert.ok(!contract.clarify_questions.some(q => q.includes('proxy') || q.includes('news mentions')), 'time proxy question must NOT appear while subjective is unresolved');
  });

  it('subjective_predicate includes suggested_rephrase', () => {
    const contract = preExecutionConstraintGate('Find nice bars in Manchester');
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    assert.ok(sp.suggested_rephrase);
    assert.ok(sp.suggested_rephrase!.length > 0);
  });
});

describe('Constraint Gate — Batch 1 spec contract tests', () => {
  it('"Find nice bars in Manchester" → CLARIFY (can_execute false, type subjective_predicate, required_inputs_missing includes definition_of_nice)', () => {
    const contract = preExecutionConstraintGate('Find nice bars in Manchester');
    assert.strictEqual(contract.can_execute, false);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    assert.ok(sp);
    assert.strictEqual(sp.type, 'subjective_predicate');
    assert.strictEqual(sp.verifiability, 'unverifiable');
    assert.strictEqual(sp.hardness, 'soft');
    assert.strictEqual(sp.can_execute, false);
    assert.ok(sp.required_inputs_missing.includes('definition_of_nice'));
    assert.ok(sp.why_blocked.includes('subjective'));
  });

  it('"Find good pubs in Leeds" → CLARIFY', () => {
    const contract = preExecutionConstraintGate('Find good pubs in Leeds');
    assert.strictEqual(contract.can_execute, false);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    assert.ok(sp);
    assert.ok(sp.required_inputs_missing.includes('definition_of_good'));
  });

  it('"Find lively bars in Manchester" → RUN (no subjective constraints produced)', () => {
    const contract = preExecutionConstraintGate('Find lively bars in Manchester');
    assert.strictEqual(contract.can_execute, true);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate');
    assert.strictEqual(sp, undefined);
    assert.strictEqual(contract.constraints.length, 0);
  });

  it('"Find nice pubs in Bristol that opened last year" → CLARIFY for nice, and still contains the time predicate constraint', () => {
    const contract = preExecutionConstraintGate('Find nice pubs in Bristol that opened in the last 12 months');
    assert.strictEqual(contract.can_execute, false);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    const tp = contract.constraints.find(c => c.type === 'time_predicate');
    assert.ok(sp, 'subjective predicate must exist');
    assert.ok(tp, 'time predicate must still be present');
    assert.ok(sp.required_inputs_missing.includes('definition_of_nice'));
  });

  it('"Find best bars in Soho" → CLARIFY (numeric_ambiguity)', () => {
    const contract = preExecutionConstraintGate('Find best bars in Soho');
    assert.strictEqual(contract.can_execute, false);
    const na = contract.constraints.find(c => c.type === 'numeric_ambiguity') as NumericAmbiguityConstraint;
    assert.ok(na, 'best is now numeric_ambiguity');
    assert.strictEqual(na.category, 'ranking');
  });

  it('"Find bars with good cocktails in Manchester" → CLARIFY (good is subjective)', () => {
    const contract = preExecutionConstraintGate('Find bars with good cocktails in Manchester');
    assert.strictEqual(contract.can_execute, false);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    assert.ok(sp, 'good is subjective even though cocktails is a noun');
    assert.ok(sp.required_inputs_missing.includes('definition_of_good'));
  });

  it('multiple subjective terms combine into one gate with all definitions missing', () => {
    const contract = preExecutionConstraintGate('Find nice trendy bars in Manchester');
    assert.strictEqual(contract.can_execute, false);
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    assert.ok(sp);
    assert.ok(sp.required_inputs_missing.includes('definition_of_nice'));
    assert.ok(sp.required_inputs_missing.includes('definition_of_trendy'));
  });

  it('clarification_options includes minimum required options', () => {
    const contract = preExecutionConstraintGate('Find nice bars in Manchester');
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    assert.ok(sp);
    assert.ok(sp.clarification_options.includes('Lively'));
    assert.ok(sp.clarification_options.includes('Quiet'));
    assert.ok(sp.clarification_options.includes('Cosy'));
    assert.ok(sp.clarification_options.includes('Late-night'));
    assert.ok(sp.clarification_options.includes('Live music'));
    assert.ok(sp.clarification_options.includes('Good for food'));
    assert.ok(sp.clarification_options.includes('Beer garden'));
    assert.ok(sp.clarification_options.includes('Dog friendly'));
  });

  it('suggested rephrase preserves user location', () => {
    const contract = preExecutionConstraintGate('Find nice bars in Manchester');
    const sp = contract.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    assert.ok(sp.suggested_rephrase);
    assert.ok(sp.suggested_rephrase!.includes('Manchester'), 'rephrase should preserve location');
  });

  it('variant terms detected: nicer, better, best rated', () => {
    assert.ok(detectSubjectiveTerms('Find nicer bars').includes('nicer'));
    assert.ok(detectSubjectiveTerms('Find better pubs').includes('better'));
    assert.ok(detectSubjectiveTerms('Find best rated cafes').includes('best rated'));
  });
});

describe('Constraint Gate — Batch 1 subjective follow-up resolution', () => {
  it('follow-up with measurable criteria resolves subjective constraint', () => {
    const initial = preExecutionConstraintGate('Find nice bars in Manchester');
    assert.strictEqual(initial.can_execute, false);
    const resolved = resolveFollowUp(initial, 'I mean lively bars');
    const sp = resolved.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    assert.ok(sp);
    assert.strictEqual(sp.can_execute, true, 'subjective constraint must be resolved after measurable answer');
    assert.strictEqual(resolved.can_execute, true);
  });

  it('follow-up without measurable criteria does NOT resolve subjective constraint', () => {
    const initial = preExecutionConstraintGate('Find nice bars in Manchester');
    const resolved = resolveFollowUp(initial, 'I mean really nice ones');
    assert.strictEqual(resolved.can_execute, false);
  });

  it('follow-up "cosy" resolves subjective constraint', () => {
    const initial = preExecutionConstraintGate('Find good pubs in Leeds');
    const resolved = resolveFollowUp(initial, 'cosy');
    assert.strictEqual(resolved.can_execute, true);
  });

  it('follow-up "5 by reviews" resolves numeric_ambiguity ranking constraint', () => {
    const initial = preExecutionConstraintGate('Find best bars in Soho');
    assert.strictEqual(initial.can_execute, false);
    const resolved = resolveFollowUp(initial, 'best 5 by reviews');
    assert.strictEqual(resolved.can_execute, true);
  });

  it('follow-up "dog friendly" resolves subjective constraint', () => {
    const initial = preExecutionConstraintGate('Find nice cafes in Bristol');
    const resolved = resolveFollowUp(initial, 'dog friendly');
    assert.strictEqual(resolved.can_execute, true);
  });

  it('compound: subjective + time, resolving only subjective does NOT fully resolve', () => {
    const initial = preExecutionConstraintGate('Find nice pubs in Bristol that opened recently');
    assert.strictEqual(initial.can_execute, false);
    assert.strictEqual(initial.clarify_questions.length, 1, 'only subjective question shown initially');
    const resolved = resolveFollowUp(initial, 'lively');
    assert.strictEqual(resolved.can_execute, false, 'time predicate still unresolved');
    const sp = resolved.constraints.find(c => c.type === 'subjective_predicate') as SubjectivePredicateConstraint;
    assert.strictEqual(sp.can_execute, true, 'subjective part resolved');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate');
    assert.ok(tp, 'time predicate still present');
    assert.ok(resolved.clarify_questions.length >= 1, 'time predicate question now surfaced after subjective resolved');
    assert.ok(resolved.clarify_questions.some(q => q.includes('proxy') || q.includes('opening dates') || q.includes('news mentions')), 'time proxy question appears');
  });
});

describe('Constraint Gate — subjective priority suppression', () => {
  it('subjective + time: only subjective question surfaced, time suppressed', () => {
    const contract = preExecutionConstraintGate('Find nice pubs in Bristol that opened in the last 12 months');
    assert.strictEqual(contract.can_execute, false);
    assert.strictEqual(contract.clarify_questions.length, 1);
    assert.ok(contract.clarify_questions[0].includes("'nice'"));
    assert.ok(!contract.clarify_questions.some(q => q.includes('proxy') || q.includes('news mentions')));
    assert.ok(contract.constraints.some(c => c.type === 'time_predicate'), 'time predicate stored in contract');
  });

  it('subjective + live music: only subjective question surfaced, live music suppressed', () => {
    const contract = preExecutionConstraintGate('Find nice pubs in Bristol with live music');
    assert.strictEqual(contract.can_execute, false);
    assert.strictEqual(contract.clarify_questions.length, 1);
    assert.ok(contract.clarify_questions[0].includes("'nice'"));
    assert.ok(!contract.clarify_questions.some(q => q.includes('reliably verified') || q.includes('Verify via website')), 'live music verification question must not appear');
    assert.ok(contract.constraints.some(c => c.type === 'attribute'), 'live music attribute stored in contract');
  });

  it('subjective + time + live music: only subjective surfaced, others suppressed', () => {
    const contract = preExecutionConstraintGate('Find nice pubs in Bristol that opened in the last 12 months with live music');
    assert.strictEqual(contract.can_execute, false);
    assert.strictEqual(contract.clarify_questions.length, 1);
    assert.ok(contract.clarify_questions[0].includes("'nice'"));
    assert.ok(contract.constraints.some(c => c.type === 'time_predicate'), 'time stored');
    assert.ok(contract.constraints.some(c => c.type === 'attribute'), 'attribute stored');
  });

  it('after subjective resolved, time predicate question surfaces', () => {
    const initial = preExecutionConstraintGate('Find nice pubs in Bristol that opened in the last 12 months');
    assert.strictEqual(initial.clarify_questions.length, 1);
    const resolved = resolveFollowUp(initial, 'lively');
    assert.strictEqual(resolved.can_execute, false, 'time predicate still blocks');
    assert.ok(resolved.clarify_questions.some(q => q.includes('proxy') || q.includes('opening dates') || q.includes('news mentions')), 'time question now surfaces');
    assert.ok(!resolved.clarify_questions.some(q => q.includes("'nice'")), 'subjective question gone');
  });

  it('after subjective resolved, live music question surfaces', () => {
    const initial = preExecutionConstraintGate('Find nice pubs in Bristol with live music');
    assert.strictEqual(initial.clarify_questions.length, 1);
    const resolved = resolveFollowUp(initial, 'cosy');
    assert.strictEqual(resolved.can_execute, false, 'live music still blocks');
    assert.ok(resolved.clarify_questions.some(q => q.includes('website') || q.includes('Live music') || q.includes('live music')), 'live music question now surfaces');
  });

  it('no subjective: time + live music → only time surfaces first (sequential)', () => {
    const contract = preExecutionConstraintGate('Find pubs in Bristol that opened in the last 12 months with live music');
    assert.strictEqual(contract.can_execute, false);
    assert.strictEqual(contract.clarify_questions.length, 1, 'only time predicate question surfaces first');
    assert.ok(contract.clarify_questions[0].includes('opening dates') || contract.clarify_questions[0].includes('guarantee') || contract.clarify_questions[0].includes('proxy'), 'time predicate question first');
  });

  it('stop_recommended suppressed while subjective unresolved', () => {
    const contract = preExecutionConstraintGate('Find nice pubs in Bristol that opened recently, no proxies');
    assert.strictEqual(contract.can_execute, false);
    assert.strictEqual(contract.stop_recommended, false, 'stop suppressed — subjective must resolve first');
    assert.strictEqual(contract.clarify_questions.length, 1);
    assert.ok(contract.clarify_questions[0].includes("'nice'"));
  });
});

describe('Constraint Gate — Batch 3: numeric ambiguity detection', () => {
  it('"Find a few pubs in Bristol" → CLARIFY (fuzzy_quantity)', () => {
    const contract = preExecutionConstraintGate('Find a few pubs in Bristol');
    assert.strictEqual(contract.can_execute, false);
    assert.strictEqual(contract.clarify_questions.length, 1);
    const na = contract.constraints.find(c => c.type === 'numeric_ambiguity') as NumericAmbiguityConstraint;
    assert.ok(na);
    assert.strictEqual(na.category, 'fuzzy_quantity');
    assert.strictEqual(na.label, 'a few');
    assert.strictEqual(na.verifiability, 'unverifiable');
    assert.strictEqual(na.hardness, 'soft');
    assert.strictEqual(na.can_execute, false);
    assert.ok(na.why_blocked.includes('undefined quantity'));
  });

  it('"Find top pubs in Bristol" → CLARIFY (ranking)', () => {
    const contract = preExecutionConstraintGate('Find top pubs in Bristol');
    assert.strictEqual(contract.can_execute, false);
    const na = contract.constraints.find(c => c.type === 'numeric_ambiguity') as NumericAmbiguityConstraint;
    assert.ok(na);
    assert.strictEqual(na.category, 'ranking');
    assert.strictEqual(na.label, 'top');
  });

  it('"Find top 5 pubs in Bristol" → RUN (count provided)', () => {
    const contract = preExecutionConstraintGate('Find top 5 pubs in Bristol');
    assert.strictEqual(contract.can_execute, true);
    assert.ok(!contract.constraints.some(c => c.type === 'numeric_ambiguity'));
  });

  it('"Find best 10 cafes in London" → RUN (count provided)', () => {
    const contract = preExecutionConstraintGate('Find best 10 cafes in London');
    assert.strictEqual(contract.can_execute, true);
    assert.ok(!contract.constraints.some(c => c.type === 'numeric_ambiguity'));
  });

  it('"Find cheap pubs in Bristol" → CLARIFY (numeric_adjective)', () => {
    const contract = preExecutionConstraintGate('Find cheap pubs in Bristol');
    assert.strictEqual(contract.can_execute, false);
    const na = contract.constraints.find(c => c.type === 'numeric_ambiguity') as NumericAmbiguityConstraint;
    assert.ok(na);
    assert.strictEqual(na.category, 'numeric_adjective');
    assert.strictEqual(na.label, 'cheap');
  });

  it('"Find best pubs in Bristol" → CLARIFY (ranking, not subjective)', () => {
    const contract = preExecutionConstraintGate('Find best pubs in Bristol');
    assert.strictEqual(contract.can_execute, false);
    assert.ok(!contract.constraints.some(c => c.type === 'subjective_predicate'), 'best no longer subjective');
    assert.ok(contract.constraints.some(c => c.type === 'numeric_ambiguity'), 'best is numeric_ambiguity');
  });

  it('"best rated" stays subjective', () => {
    const contract = preExecutionConstraintGate('Find best rated pubs in Bristol');
    assert.ok(contract.constraints.some(c => c.type === 'subjective_predicate'));
  });

  it('"Find many restaurants in Leeds" → CLARIFY', () => {
    const contract = preExecutionConstraintGate('Find many restaurants in Leeds');
    assert.strictEqual(contract.can_execute, false);
    const na = contract.constraints.find(c => c.type === 'numeric_ambiguity') as NumericAmbiguityConstraint;
    assert.ok(na);
    assert.strictEqual(na.category, 'fuzzy_quantity');
  });

  it('"Find several bars in London" → CLARIFY', () => {
    const contract = preExecutionConstraintGate('Find several bars in London');
    assert.strictEqual(contract.can_execute, false);
    const na = contract.constraints.find(c => c.type === 'numeric_ambiguity') as NumericAmbiguityConstraint;
    assert.ok(na);
    assert.strictEqual(na.category, 'fuzzy_quantity');
  });

  it('"Find large pubs in Manchester" → CLARIFY', () => {
    const contract = preExecutionConstraintGate('Find large pubs in Manchester');
    assert.strictEqual(contract.can_execute, false);
    const na = contract.constraints.find(c => c.type === 'numeric_ambiguity') as NumericAmbiguityConstraint;
    assert.ok(na);
    assert.strictEqual(na.category, 'numeric_adjective');
  });

  it('"Find 10 pubs in Bristol" → RUN (explicit count, no ambiguity)', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Bristol');
    assert.strictEqual(contract.can_execute, true);
    assert.ok(!contract.constraints.some(c => c.type === 'numeric_ambiguity'));
  });

  it('"Find pubs in Bristol" → RUN (no quantity at all)', () => {
    const contract = preExecutionConstraintGate('Find pubs in Bristol');
    assert.strictEqual(contract.can_execute, true);
  });
});

describe('Constraint Gate — Batch 3: numeric ambiguity priority ordering', () => {
  it('subjective suppresses numeric_ambiguity', () => {
    const contract = preExecutionConstraintGate('Find nice cheap pubs in Bristol');
    assert.strictEqual(contract.clarify_questions.length, 1);
    assert.ok(contract.clarify_questions[0].includes("'nice'"), 'subjective first');
    assert.ok(contract.constraints.some(c => c.type === 'numeric_ambiguity'), 'numeric stored');
  });

  it('numeric_ambiguity suppresses time predicate', () => {
    const contract = preExecutionConstraintGate('Find a few pubs in Bristol that opened in the last 12 months');
    assert.strictEqual(contract.clarify_questions.length, 1);
    assert.ok(contract.clarify_questions[0].includes('few'), 'numeric question first');
    assert.ok(contract.constraints.some(c => c.type === 'time_predicate'), 'time stored');
  });

  it('numeric_ambiguity suppresses live music', () => {
    const contract = preExecutionConstraintGate('Find cheap pubs in Bristol with live music');
    assert.strictEqual(contract.clarify_questions.length, 1);
    assert.ok(contract.clarify_questions[0].includes('cheap'), 'numeric question first');
    assert.ok(contract.constraints.some(c => c.type === 'attribute'), 'live music stored');
  });

  it('full chain: subjective → numeric → time → live music (4 turns)', () => {
    const c1 = preExecutionConstraintGate('Find nice cheap pubs in Bristol that opened in the last 12 months with live music');
    assert.strictEqual(c1.clarify_questions.length, 1);
    assert.ok(c1.clarify_questions[0].includes("'nice'"), 'turn 1: subjective');

    const c2 = resolveFollowUp(c1, 'lively');
    assert.strictEqual(c2.clarify_questions.length, 1);
    assert.ok(c2.clarify_questions[0].includes('cheap'), 'turn 2: numeric');

    const c3 = resolveFollowUp(c2, 'under £5 per pint');
    assert.strictEqual(c3.clarify_questions.length, 1);
    assert.ok(c3.clarify_questions[0].includes('opening dates') || c3.clarify_questions[0].includes('proxy'), 'turn 3: time');

    const c4 = resolveFollowUp(c3, 'Use news mentions proxy');
    assert.strictEqual(c4.clarify_questions.length, 1);
    assert.ok(c4.clarify_questions[0].includes('Live music') || c4.clarify_questions[0].includes('live music'), 'turn 4: live music');

    const c5 = resolveFollowUp(c4, 'Verify via website');
    assert.strictEqual(c5.can_execute, true, 'all 4 layers resolved');
  });
});

describe('Constraint Gate — Batch 3: numeric ambiguity resolution', () => {
  it('number resolves fuzzy quantity', () => {
    const initial = preExecutionConstraintGate('Find a few pubs in Bristol');
    const resolved = resolveFollowUp(initial, '5');
    assert.strictEqual(resolved.can_execute, true);
    const na = resolved.constraints.find(c => c.type === 'numeric_ambiguity') as NumericAmbiguityConstraint;
    assert.strictEqual(na.can_execute, true);
  });

  it('count + metric resolves ranking', () => {
    const initial = preExecutionConstraintGate('Find top pubs in Bristol');
    const resolved = resolveFollowUp(initial, 'top 5 by rating');
    assert.strictEqual(resolved.can_execute, true);
  });

  it('threshold resolves numeric adjective', () => {
    const initial = preExecutionConstraintGate('Find cheap pubs in Bristol');
    const resolved = resolveFollowUp(initial, 'under £5 per pint');
    assert.strictEqual(resolved.can_execute, true);
  });

  it('non-numeric follow-up does NOT resolve', () => {
    const initial = preExecutionConstraintGate('Find cheap pubs in Bristol');
    const resolved = resolveFollowUp(initial, 'I want good ones');
    assert.strictEqual(resolved.can_execute, false);
  });

  it('resolved numeric not re-surfaced', () => {
    const initial = preExecutionConstraintGate('Find a few pubs in Bristol');
    const resolved = resolveFollowUp(initial, '10');
    assert.strictEqual(resolved.can_execute, true);
    assert.ok(!resolved.clarify_questions.some(q => q.includes('few')), 'numeric question gone');
  });

  it('ranking: "by rating" alone does NOT resolve (no count)', () => {
    const initial = preExecutionConstraintGate('Find top pubs in Bristol');
    const resolved = resolveFollowUp(initial, 'by rating');
    assert.strictEqual(resolved.can_execute, false, 'count is required for ranking');
  });

  it('ranking: "good ratings" does NOT resolve (no count)', () => {
    const initial = preExecutionConstraintGate('Find best pubs in Bristol');
    const resolved = resolveFollowUp(initial, 'good ratings');
    assert.strictEqual(resolved.can_execute, false, 'count is required for ranking');
  });

  it('numeric_adjective: "rating based" does NOT resolve cheap', () => {
    const initial = preExecutionConstraintGate('Find cheap pubs in Bristol');
    const resolved = resolveFollowUp(initial, 'rating based');
    assert.strictEqual(resolved.can_execute, false, 'threshold is required for numeric adjective');
  });

  it('fuzzy_quantity: "lots of them" does NOT resolve', () => {
    const initial = preExecutionConstraintGate('Find a few pubs in Bristol');
    const resolved = resolveFollowUp(initial, 'lots of them');
    assert.strictEqual(resolved.can_execute, false, 'specific number is required');
  });
});

describe('Constraint Gate — Batch 4: relationship predicate gating', () => {
  it('"Find pubs in Bristol and the landlord name" → CLARIFY', () => {
    const contract = preExecutionConstraintGate('Find pubs in Bristol and the landlord name');
    assert.strictEqual(contract.can_execute, false);
    assert.strictEqual(contract.clarify_questions.length, 1);
    const rp = contract.constraints.find(c => c.type === 'relationship_predicate');
    assert.ok(rp, 'relationship_predicate constraint must exist');
    assert.strictEqual(rp.type, 'relationship_predicate');
    assert.strictEqual(rp.verifiability, 'proxy');
    assert.strictEqual(rp.hardness, 'soft');
    assert.strictEqual(rp.can_execute, false);
    assert.ok(rp.why_blocked.includes('not reliably available'));
    assert.ok(contract.clarify_questions[0].includes('Official sources only'));
    assert.ok(contract.clarify_questions[0].includes('Skip relationship fields'));
  });

  it('"Find dentists in Texas and the practice manager" → CLARIFY', () => {
    const contract = preExecutionConstraintGate('Find dentists in Texas and the practice manager');
    assert.strictEqual(contract.can_execute, false);
    const rp = contract.constraints.find(c => c.type === 'relationship_predicate');
    assert.ok(rp, 'relationship_predicate constraint must exist');
    assert.strictEqual(rp.can_execute, false);
    assert.ok(contract.clarify_questions.length > 0);
  });

  it('"Find breweries in Sussex owned by AB InBev" → CLARIFY', () => {
    const contract = preExecutionConstraintGate('Find breweries in Sussex owned by AB InBev');
    assert.strictEqual(contract.can_execute, false);
    const rp = contract.constraints.find(c => c.type === 'relationship_predicate');
    assert.ok(rp, 'relationship_predicate constraint must exist');
    assert.strictEqual(rp.can_execute, false);
    assert.ok(contract.clarify_questions.length > 0);
  });

  it('after choosing "Skip if uncertain" → can_execute=true, strategy stored', () => {
    const initial = preExecutionConstraintGate('Find pubs in Bristol and the landlord name');
    assert.strictEqual(initial.can_execute, false);
    const resolved = resolveFollowUp(initial, 'Option D — skip if uncertain');
    assert.strictEqual(resolved.can_execute, true, 'must execute after strategy chosen');
    const rp = resolved.constraints.find(c => c.type === 'relationship_predicate') as any;
    assert.ok(rp);
    assert.strictEqual(rp.chosen_relationship_strategy, 'skip_if_uncertain');
    assert.strictEqual(rp.can_execute, true);
  });

  it('"Option A" resolves to official_only', () => {
    const initial = preExecutionConstraintGate('Find pubs in Bristol and the owner name');
    const resolved = resolveFollowUp(initial, 'Option A');
    assert.strictEqual(resolved.can_execute, true);
    const rp = resolved.constraints.find(c => c.type === 'relationship_predicate') as any;
    assert.strictEqual(rp.chosen_relationship_strategy, 'official_only');
  });

  it('"Option B" resolves to best_effort_web', () => {
    const initial = preExecutionConstraintGate('Find pubs in Bristol and the manager');
    const resolved = resolveFollowUp(initial, 'Option B');
    assert.strictEqual(resolved.can_execute, true);
    const rp = resolved.constraints.find(c => c.type === 'relationship_predicate') as any;
    assert.strictEqual(rp.chosen_relationship_strategy, 'best_effort_web');
  });

  it('"Option C" resolves to two_plus_sources', () => {
    const initial = preExecutionConstraintGate('Find breweries in Sussex owned by AB InBev');
    const resolved = resolveFollowUp(initial, 'Option C');
    assert.strictEqual(resolved.can_execute, true);
    const rp = resolved.constraints.find(c => c.type === 'relationship_predicate') as any;
    assert.strictEqual(rp.chosen_relationship_strategy, 'two_plus_sources');
  });

  it('plain search without relationship → can_execute=true, no relationship constraint', () => {
    const contract = preExecutionConstraintGate('Find pubs in Bristol');
    assert.strictEqual(contract.can_execute, true);
    assert.ok(!contract.constraints.some(c => c.type === 'relationship_predicate'));
  });

  it('detects "owned by" as relationship predicate', () => {
    const contract = preExecutionConstraintGate('Find restaurants in London owned by Jamie Oliver');
    assert.strictEqual(contract.can_execute, false);
    const rp = contract.constraints.find(c => c.type === 'relationship_predicate');
    assert.ok(rp);
  });

  it('detects "run by" as relationship predicate', () => {
    const contract = preExecutionConstraintGate('Find hotels in Edinburgh run by Hilton');
    assert.strictEqual(contract.can_execute, false);
    const rp = contract.constraints.find(c => c.type === 'relationship_predicate');
    assert.ok(rp);
  });

  it('detects "head brewer" role as relationship predicate', () => {
    const contract = preExecutionConstraintGate('Find breweries in Kent and the head brewer');
    assert.strictEqual(contract.can_execute, false);
    const rp = contract.constraints.find(c => c.type === 'relationship_predicate');
    assert.ok(rp);
  });

  it('detects "decision maker" role as relationship predicate', () => {
    const contract = preExecutionConstraintGate('Find offices in Birmingham and the decision maker');
    assert.strictEqual(contract.can_execute, false);
    const rp = contract.constraints.find(c => c.type === 'relationship_predicate');
    assert.ok(rp);
  });

  it('detects "freehouse" as relationship predicate', () => {
    const contract = preExecutionConstraintGate('Find freehouse pubs in Devon');
    assert.strictEqual(contract.can_execute, false);
    const rp = contract.constraints.find(c => c.type === 'relationship_predicate');
    assert.ok(rp);
  });

  it('detects "tied house" as relationship predicate', () => {
    const contract = preExecutionConstraintGate('Find tied house pubs in Cornwall');
    assert.strictEqual(contract.can_execute, false);
    const rp = contract.constraints.find(c => c.type === 'relationship_predicate');
    assert.ok(rp);
  });
});

describe('Constraint Gate — Batch 4: relationship predicate priority ordering', () => {
  it('subjective suppresses relationship predicate', () => {
    const contract = preExecutionConstraintGate('Find nice pubs in Bristol and the landlord name');
    assert.strictEqual(contract.clarify_questions.length, 1);
    assert.ok(contract.clarify_questions[0].includes("'nice'"), 'subjective first');
    assert.ok(contract.constraints.some(c => c.type === 'relationship_predicate'), 'relationship stored');
  });

  it('numeric suppresses relationship predicate', () => {
    const contract = preExecutionConstraintGate('Find a few pubs in Bristol and the landlord name');
    assert.strictEqual(contract.clarify_questions.length, 1);
    assert.ok(contract.clarify_questions[0].includes('few'), 'numeric first');
    assert.ok(contract.constraints.some(c => c.type === 'relationship_predicate'), 'relationship stored');
  });

  it('relationship predicate suppresses time predicate', () => {
    const contract = preExecutionConstraintGate('Find pubs in Bristol and the landlord name that opened in the last 12 months');
    assert.strictEqual(contract.clarify_questions.length, 1);
    assert.ok(contract.clarify_questions[0].includes('Official sources only') || contract.clarify_questions[0].includes('relationship'), 'relationship question first');
    assert.ok(contract.constraints.some(c => c.type === 'time_predicate'), 'time stored');
  });

  it('after relationship resolved, time predicate surfaces', () => {
    const initial = preExecutionConstraintGate('Find pubs in Bristol and the landlord name that opened in the last 12 months');
    const resolved = resolveFollowUp(initial, 'Option D');
    assert.strictEqual(resolved.can_execute, false, 'time predicate still blocks');
    const rp = resolved.constraints.find(c => c.type === 'relationship_predicate') as any;
    assert.strictEqual(rp.can_execute, true);
    assert.ok(resolved.clarify_questions.some(q => q.includes('opening dates') || q.includes('proxy')), 'time question surfaces');
  });

  it('full chain: subjective → numeric → relationship → time (4 turns)', () => {
    const c1 = preExecutionConstraintGate('Find nice cheap pubs in Bristol and the landlord name that opened in the last 12 months');
    assert.strictEqual(c1.clarify_questions.length, 1);
    assert.ok(c1.clarify_questions[0].includes("'nice'"), 'turn 1: subjective');

    const c2 = resolveFollowUp(c1, 'lively');
    assert.strictEqual(c2.clarify_questions.length, 1);
    assert.ok(c2.clarify_questions[0].includes('cheap'), 'turn 2: numeric');

    const c3 = resolveFollowUp(c2, 'under £5 per pint');
    assert.strictEqual(c3.clarify_questions.length, 1);
    assert.ok(c3.clarify_questions[0].includes('Official sources only') || c3.clarify_questions[0].includes('relationship'), 'turn 3: relationship');

    const c4 = resolveFollowUp(c3, 'Option D');
    assert.strictEqual(c4.clarify_questions.length, 1);
    assert.ok(c4.clarify_questions[0].includes('opening dates') || c4.clarify_questions[0].includes('proxy'), 'turn 4: time');

    const c5 = resolveFollowUp(c4, 'Use news mentions proxy');
    assert.strictEqual(c5.can_execute, true, 'all layers resolved');
  });

  it('relationship predicate suppresses live music attribute', () => {
    const contract = preExecutionConstraintGate('Find pubs in Bristol and the landlord name with live music');
    assert.strictEqual(contract.clarify_questions.length, 1);
    assert.ok(contract.clarify_questions[0].includes('Official sources only') || contract.clarify_questions[0].includes('relationship'), 'relationship question first, not live music');
    assert.ok(contract.constraints.some(c => c.type === 'attribute'), 'live music stored');
    assert.ok(contract.constraints.some(c => c.type === 'relationship_predicate'), 'relationship stored');
  });

  it('after relationship resolved, live music surfaces (no time predicate)', () => {
    const contract = preExecutionConstraintGate('Find pubs in Bristol and the landlord name with live music');
    const resolved = resolveFollowUp(contract, 'Option D');
    assert.strictEqual(resolved.can_execute, false, 'live music still blocks');
    assert.ok(resolved.clarify_questions.some(q => q.includes('Live music') || q.includes('live music') || q.includes('website')), 'live music question surfaces');
  });

  it('resolved relationship NOT re-surfaced', () => {
    const initial = preExecutionConstraintGate('Find pubs in Bristol and the landlord name');
    const resolved = resolveFollowUp(initial, 'Option A');
    assert.strictEqual(resolved.can_execute, true);
    assert.ok(!resolved.clarify_questions.some(q => q.includes('relationship') || q.includes('Official sources')));
    const rp = resolved.constraints.find(c => c.type === 'relationship_predicate') as any;
    assert.strictEqual(rp.can_execute, true);
    assert.strictEqual(rp.chosen_relationship_strategy, 'official_only');
  });
});
