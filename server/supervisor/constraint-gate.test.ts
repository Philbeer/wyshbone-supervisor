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

  it('Case 3: compound "opened in the last 12 months and have live music" → can_execute=false, BOTH in constraints', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    assert.strictEqual(contract.can_execute, false, 'must NOT execute — both need clarification');
    const tp = contract.constraints.find(c => c.type === 'time_predicate');
    const attr = contract.constraints.find(c => c.type === 'attribute');
    assert.ok(tp, 'time_predicate must be in constraints');
    assert.ok(attr, 'attribute must be in constraints');
    assert.strictEqual(contract.clarify_questions.length, 2, 'must ask TWO questions (time + live music)');
  });

  it('Case 3 compound message includes both bullets in ONE bubble', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    const msg = buildConstraintGateMessage(contract);
    assert.ok(msg.includes('1.'), 'must include bullet 1');
    assert.ok(msg.includes('2.'), 'must include bullet 2');
    assert.ok(msg.includes('opening dates') || msg.includes('guarantee'), 'must reference time predicate');
    assert.ok(msg.includes('Live music') || msg.includes('live music'), 'must reference live music');
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
  it('"must be certain" → true', () => assert.ok(detectNoProxySignal('must be certain')));
  it('"must be guaranteed" → true', () => assert.ok(detectNoProxySignal('must be guaranteed')));
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

describe('Constraint Gate — compound follow-up', () => {
  it('compound: resolving BOTH time + live music in one follow-up', () => {
    const initial = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    assert.strictEqual(initial.can_execute, false);
    assert.strictEqual(initial.clarify_questions.length, 2);

    const resolved = resolveFollowUp(initial, 'Use news mentions proxy. Verify live music via website.');
    assert.strictEqual(resolved.can_execute, true, 'must resolve — both answered');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.strictEqual(tp.chosen_proxy, 'news_mention');
    const attr = resolved.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.strictEqual(attr.chosen_verification, 'website_verify');
  });

  it('compound: resolving time only → still blocked on live music', () => {
    const initial = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    const resolved = resolveFollowUp(initial, 'Use recent reviews proxy');
    assert.strictEqual(resolved.can_execute, false, 'live music still unresolved');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.strictEqual(tp.can_execute, true);
    const attr = resolved.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.strictEqual(attr.chosen_verification, null, 'live music not yet resolved');
  });

  it('compound: best-effort for time, verify for live music', () => {
    const initial = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    const resolved = resolveFollowUp(initial, 'C) for time. A) for live music.');
    const tp = resolved.constraints.find(c => c.type === 'time_predicate') as TimePredicateContract;
    assert.strictEqual(tp.chosen_proxy, 'best_effort');
    const attr = resolved.constraints.find(c => c.type === 'attribute') as AttributeConstraint;
    assert.strictEqual(attr.chosen_verification, 'website_verify');
    assert.strictEqual(resolved.can_execute, true);
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

  it('compound clarification is ONE message with two bullets', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    const msg = buildConstraintGateMessage(contract);
    assert.ok(msg.includes('1.'), 'must have bullet 1');
    assert.ok(msg.includes('2.'), 'must have bullet 2');
    assert.ok(!msg.includes('3.'), 'must NOT have bullet 3 — only 2 questions');
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

describe('Constraint Gate — acceptance tests (exact QA scenarios)', () => {
  it('ACCEPTANCE: compound "Find 10 pubs in Bristol that opened in the last 12 months and have live music" → clarification, no searching, no tools', () => {
    const contract = preExecutionConstraintGate('Find 10 pubs in Bristol that opened in the last 12 months and have live music');
    assert.strictEqual(contract.can_execute, false, 'MUST NOT execute');
    assert.ok(contract.constraints.length >= 2, 'both constraints extracted');
    assert.strictEqual(contract.clarify_questions.length, 2, 'both questions asked');
    assert.strictEqual(contract.stop_recommended, false, 'not a stop — clarification needed');
    const msg = buildConstraintGateMessage(contract);
    assert.ok(msg.includes('1.'), 'compound message has bullet 1');
    assert.ok(msg.includes('2.'), 'compound message has bullet 2');
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
