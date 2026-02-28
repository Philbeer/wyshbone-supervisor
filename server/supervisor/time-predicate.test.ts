import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  detectTimePredicate,
  inferHardness,
  buildTimePredicateContract,
  resolveProxyChoice,
  buildClarifyQuestion,
  buildHonestyLine,
  getSupportedProxyIds,
} from './time-predicate';

describe('Time Predicate — detection', () => {
  it('"opened recently" → predicate=opened, window=null', () => {
    const result = detectTimePredicate('find dentists in Texas that opened recently');
    assert.ok(result !== null);
    assert.strictEqual(result!.predicate, 'opened');
    assert.strictEqual(result!.window, null);
    assert.strictEqual(result!.window_days, null);
  });

  it('"opened in the last 12 months" → predicate=opened, window="12 months"', () => {
    const result = detectTimePredicate('find 10 pubs in Manchester opened in the last 12 months');
    assert.ok(result !== null);
    assert.strictEqual(result!.predicate, 'opened');
    assert.strictEqual(result!.window, '12 months');
    assert.strictEqual(result!.window_days, 360);
  });

  it('"opened in last 6 months" → window="6 months", window_days=180', () => {
    const result = detectTimePredicate('find 10 cafes in Brighton opened in last 6 months');
    assert.ok(result !== null);
    assert.strictEqual(result!.predicate, 'opened');
    assert.strictEqual(result!.window, '6 months');
    assert.strictEqual(result!.window_days, 180);
  });

  it('"newly opened" → predicate=opened, window=null', () => {
    const result = detectTimePredicate('find newly opened restaurants in Leeds');
    assert.ok(result !== null);
    assert.strictEqual(result!.predicate, 'opened');
    assert.strictEqual(result!.window, null);
  });

  it('"just opened" → predicate=opened, window=null', () => {
    const result = detectTimePredicate('find pubs that just opened in Manchester');
    assert.ok(result !== null);
    assert.strictEqual(result!.predicate, 'opened');
    assert.strictEqual(result!.window, null);
  });

  it('"opened this year" → predicate=opened, window="this year"', () => {
    const result = detectTimePredicate('find cafes opened this year in Bristol');
    assert.ok(result !== null);
    assert.strictEqual(result!.predicate, 'opened');
    assert.strictEqual(result!.window, 'this year');
    assert.strictEqual(result!.window_days, 365);
  });

  it('"new restaurants" → predicate=opened', () => {
    const result = detectTimePredicate('find new restaurants in Birmingham');
    assert.ok(result !== null);
    assert.strictEqual(result!.predicate, 'opened');
  });

  it('"closed recently" → predicate=closed', () => {
    const result = detectTimePredicate('find pubs that closed recently in London');
    assert.ok(result !== null);
    assert.strictEqual(result!.predicate, 'closed');
  });

  it('"renovated in the last 2 years" → predicate=renovated, window="2 years"', () => {
    const result = detectTimePredicate('find hotels renovated in the last 2 years in Bath');
    assert.ok(result !== null);
    assert.strictEqual(result!.predicate, 'renovated');
    assert.strictEqual(result!.window, '2 years');
    assert.strictEqual(result!.window_days, 730);
  });

  it('no time predicate in "find cafes in Bristol" → null', () => {
    const result = detectTimePredicate('find cafes in Bristol');
    assert.strictEqual(result, null);
  });

  it('no time predicate in "find dog friendly pubs in Leeds" → null', () => {
    const result = detectTimePredicate('find dog friendly pubs in Leeds');
    assert.strictEqual(result, null);
  });

  it('"started in the last 3 weeks" → window_days=21', () => {
    const result = detectTimePredicate('find businesses started in the last 3 weeks in London');
    assert.ok(result !== null);
    assert.strictEqual(result!.window, '3 weeks');
    assert.strictEqual(result!.window_days, 21);
  });
});

describe('Time Predicate — hardness inference', () => {
  it('"must have opened in last 12 months" → hard', () => {
    assert.strictEqual(inferHardness('find cafes in Bristol, must have opened in last 12 months'), 'hard');
  });

  it('"definitely opened recently" → hard', () => {
    assert.strictEqual(inferHardness('find definitely opened recently pubs in Leeds'), 'hard');
  });

  it('"opened recently" (no hard signal) → soft', () => {
    assert.strictEqual(inferHardness('find dentists in Texas that opened recently'), 'soft');
  });

  it('"opened in the last 12 months" (no hard signal) → soft', () => {
    assert.strictEqual(inferHardness('find pubs in Manchester opened in the last 12 months'), 'soft');
  });
});

describe('Time Predicate — contract building', () => {
  it('"find dentists in Texas that opened recently" → contract with proxy, can_execute=false', () => {
    const contract = buildTimePredicateContract('find dentists in Texas that opened recently');
    assert.ok(contract !== null);
    assert.strictEqual(contract!.type, 'time_predicate');
    assert.strictEqual(contract!.predicate, 'opened');
    assert.strictEqual(contract!.verifiability, 'proxy');
    assert.strictEqual(contract!.can_execute, false);
    assert.ok(contract!.why_blocked !== null);
    assert.ok(contract!.required_inputs_missing.includes('time_window'));
    assert.ok(contract!.proxy_options.length > 0);
  });

  it('"find 10 pubs in Manchester opened in last 12 months" → window parsed, proxy options available', () => {
    const contract = buildTimePredicateContract('find 10 pubs in Manchester opened in last 12 months');
    assert.ok(contract !== null);
    assert.strictEqual(contract!.window, '12 months');
    assert.strictEqual(contract!.window_days, 360);
    assert.strictEqual(contract!.can_execute, false);
    assert.ok(contract!.proxy_options.some(p => p.id === 'recent_reviews' && p.supported));
    assert.ok(contract!.proxy_options.some(p => p.id === 'news_mention' && p.supported));
  });

  it('"find cafes opened in last 6 months, must have" → hard + can_execute=false', () => {
    const contract = buildTimePredicateContract('find 10 cafes in Brighton, must have opened in last 6 months');
    assert.ok(contract !== null);
    assert.strictEqual(contract!.hardness, 'hard');
    assert.strictEqual(contract!.can_execute, false);
    assert.ok(contract!.why_blocked!.includes('cannot be verified'));
  });

  it('no time predicate → returns null', () => {
    const contract = buildTimePredicateContract('find cafes in Bristol');
    assert.strictEqual(contract, null);
  });

  it('with chosen_proxy=recent_reviews but ambiguous window → can_execute=false (window needed)', () => {
    const contract = buildTimePredicateContract(
      'find pubs in Leeds opened recently',
      { chosen_proxy: 'recent_reviews' },
    );
    assert.ok(contract !== null);
    assert.strictEqual(contract!.can_execute, false);
    assert.ok(contract!.why_blocked!.includes('ambiguous'));
    assert.ok(contract!.required_inputs_missing.includes('time_window'));
  });

  it('with chosen_proxy=recent_reviews AND explicit window → can_execute=true', () => {
    const contract = buildTimePredicateContract(
      'find pubs in Leeds opened recently',
      { chosen_proxy: 'recent_reviews', window: '12 months', window_days: 360 },
    );
    assert.ok(contract !== null);
    assert.strictEqual(contract!.can_execute, true);
    assert.strictEqual(contract!.chosen_proxy, 'recent_reviews');
    assert.strictEqual(contract!.why_blocked, null);
    assert.strictEqual(contract!.window, '12 months');
  });

  it('with chosen_proxy=companies_house_incorp (unsupported) → can_execute=false', () => {
    const contract = buildTimePredicateContract(
      'find pubs in Leeds opened recently',
      { chosen_proxy: 'companies_house_incorp' },
    );
    assert.ok(contract !== null);
    assert.strictEqual(contract!.can_execute, false);
    assert.ok(contract!.why_blocked!.includes('not supported'));
  });
});

describe('Time Predicate — proxy resolution', () => {
  function baseContract(): NonNullable<ReturnType<typeof buildTimePredicateContract>> {
    return buildTimePredicateContract('find pubs in Manchester opened in last 12 months')!;
  }

  it('user chooses "recent_reviews" → can_execute=true', () => {
    const resolved = resolveProxyChoice(baseContract(), 'recent_reviews');
    assert.strictEqual(resolved.can_execute, true);
    assert.strictEqual(resolved.chosen_proxy, 'recent_reviews');
    assert.strictEqual(resolved.why_blocked, null);
  });

  it('user chooses "news_mention" → can_execute=true', () => {
    const resolved = resolveProxyChoice(baseContract(), 'news_mention');
    assert.strictEqual(resolved.can_execute, true);
    assert.strictEqual(resolved.chosen_proxy, 'news_mention');
  });

  it('user chooses "no proxies" → hard+unverifiable, can_execute=false, STOP', () => {
    const resolved = resolveProxyChoice(baseContract(), 'no proxies');
    assert.strictEqual(resolved.can_execute, false);
    assert.strictEqual(resolved.hardness, 'hard');
    assert.strictEqual(resolved.verifiability, 'unverifiable');
    assert.ok(resolved.why_blocked!.includes('rejected all proxy'));
  });

  it('user chooses null → same as "no proxies"', () => {
    const resolved = resolveProxyChoice(baseContract(), null);
    assert.strictEqual(resolved.can_execute, false);
    assert.strictEqual(resolved.verifiability, 'unverifiable');
  });

  it('user chooses "none" → same as "no proxies"', () => {
    const resolved = resolveProxyChoice(baseContract(), 'none');
    assert.strictEqual(resolved.can_execute, false);
    assert.strictEqual(resolved.verifiability, 'unverifiable');
  });

  it('user chooses unsupported proxy → can_execute=false with explanation', () => {
    const resolved = resolveProxyChoice(baseContract(), 'new_listing');
    assert.strictEqual(resolved.can_execute, false);
    assert.ok(resolved.why_blocked!.includes('not supported'));
  });
});

describe('Time Predicate — clarify question', () => {
  it('produces a question listing supported proxies', () => {
    const contract = buildTimePredicateContract('find pubs in Manchester opened in last 12 months')!;
    const question = buildClarifyQuestion(contract);
    assert.ok(question.includes('guarantee'));
    assert.ok(question.includes('recent'));
    assert.ok(question.includes('news') || question.includes('web'));
    assert.ok(question.includes('stop'));
  });

  it('question includes the window when specified', () => {
    const contract = buildTimePredicateContract('find pubs opened in last 12 months in Leeds')!;
    const question = buildClarifyQuestion(contract);
    assert.ok(question.includes('12 months'));
  });

  it('question says "recently" when window is null', () => {
    const contract = buildTimePredicateContract('find pubs opened recently in Leeds')!;
    const question = buildClarifyQuestion(contract);
    assert.ok(question.includes('recently'));
  });

  it('question asks for window when window is ambiguous', () => {
    const contract = buildTimePredicateContract('find pubs opened recently in Leeds')!;
    const question = buildClarifyQuestion(contract);
    assert.ok(question.includes('how recently') || question.includes('specify a window'), `Question should ask for window: ${question}`);
  });

  it('question does NOT ask for window when window is explicit', () => {
    const contract = buildTimePredicateContract('find pubs opened in last 12 months in Leeds')!;
    const question = buildClarifyQuestion(contract);
    assert.ok(!question.includes('how recently'), `Question should not ask for window when explicit: ${question}`);
  });
});

describe('Time Predicate — honesty line', () => {
  it('returns honesty line when proxy is chosen', () => {
    const contract = buildTimePredicateContract(
      'find pubs in Leeds opened recently',
      { chosen_proxy: 'recent_reviews' },
    )!;
    const line = buildHonestyLine(contract);
    assert.ok(line !== null);
    assert.ok(line!.includes("can't be guaranteed"));
    assert.ok(line!.includes('recent reviews'));
  });

  it('returns null when no proxy chosen', () => {
    const contract = buildTimePredicateContract('find pubs in Leeds opened recently')!;
    const line = buildHonestyLine(contract);
    assert.strictEqual(line, null);
  });
});

describe('Time Predicate — supported proxy IDs', () => {
  it('returns only supported proxies', () => {
    const ids = getSupportedProxyIds();
    assert.ok(ids.includes('recent_reviews'));
    assert.ok(ids.includes('news_mention'));
    assert.ok(!ids.includes('new_listing'));
    assert.ok(!ids.includes('companies_house_incorp'));
  });
});

describe('Time Predicate — acceptance scenarios', () => {
  it('Scenario A: "Find dentists in Texas that opened recently" → proxy, can_execute=false until proxy + window accepted', () => {
    const contract = buildTimePredicateContract('Find dentists in Texas that opened recently');
    assert.ok(contract !== null);
    assert.strictEqual(contract!.verifiability, 'proxy');
    assert.strictEqual(contract!.can_execute, false);
    const withProxy = buildTimePredicateContract(
      'Find dentists in Texas that opened recently',
      { chosen_proxy: 'recent_reviews' },
    );
    assert.strictEqual(withProxy!.can_execute, false, 'Still blocked — window is ambiguous');
    const withBoth = buildTimePredicateContract(
      'Find dentists in Texas that opened recently',
      { chosen_proxy: 'recent_reviews', window: '12 months', window_days: 360 },
    );
    assert.strictEqual(withBoth!.can_execute, true, 'Unblocked — proxy + window both provided');
  });

  it('Scenario B: "Find 10 pubs in Manchester opened in last 12 months" → clarify prompt with proxy options', () => {
    const contract = buildTimePredicateContract('Find 10 pubs in Manchester opened in last 12 months');
    assert.ok(contract !== null);
    assert.strictEqual(contract!.window, '12 months');
    const question = buildClarifyQuestion(contract!);
    assert.ok(question.includes('12 months'));
    assert.ok(question.length > 20);
  });

  it('Scenario C: "Find 10 cafes in Brighton, must have opened in last 6 months, no proxies" → STOP', () => {
    const contract = buildTimePredicateContract('Find 10 cafes in Brighton, must have opened in last 6 months');
    assert.ok(contract !== null);
    assert.strictEqual(contract!.hardness, 'hard');
    const stopped = resolveProxyChoice(contract!, 'no proxies');
    assert.strictEqual(stopped.can_execute, false);
    assert.strictEqual(stopped.verifiability, 'unverifiable');
    assert.ok(stopped.why_blocked!.includes('rejected'));
  });

  it('Scenario D: "Find pubs in Leeds opened recently" — time predicate does not override G1-G7 location rules', () => {
    const contract = buildTimePredicateContract('Find pubs in Leeds opened recently');
    assert.ok(contract !== null);
    assert.strictEqual(contract!.predicate, 'opened');
    assert.strictEqual(contract!.type, 'time_predicate');
  });

  it('Scenario E: user clarifies "use news mentions" + window → can_execute=true', () => {
    const contract = buildTimePredicateContract(
      'find pubs opened recently in Bristol',
      { chosen_proxy: 'news_mention', window: '12 months', window_days: 360 },
    );
    assert.ok(contract !== null);
    assert.strictEqual(contract!.can_execute, true);
    assert.strictEqual(contract!.chosen_proxy, 'news_mention');
    const honesty = buildHonestyLine(contract!);
    assert.ok(honesty !== null);
    assert.ok(honesty!.includes("can't be guaranteed"));
  });

  it('Scenario E variant: user clarifies "use new_listing" (unsupported) → still blocked', () => {
    const contract = buildTimePredicateContract('find pubs opened recently in Bristol');
    assert.ok(contract !== null);
    const resolved = resolveProxyChoice(contract!, 'new_listing');
    assert.strictEqual(resolved.can_execute, false);
    assert.ok(resolved.why_blocked!.includes('not supported'));
  });
});
