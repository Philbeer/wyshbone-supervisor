/**
 * Fast-path detector for obvious chat messages.
 * Narrow by design: only matches short, unambiguous greetings/thanks/ack.
 * When in doubt, return false and let the LLM router handle it.
 */
export function isObviousChat(message: string): boolean {
  const trimmed = (message || '').trim().toLowerCase();

  // Empty or suspiciously long — not obvious chat
  if (trimmed.length === 0 || trimmed.length > 60) return false;

  // Single-word or 2-3 word greetings/acks
  const patterns = [
    /^(hi|hello|hey|yo|sup|howdy|hiya|heya|morning|afternoon|evening)[\s!.?]*$/,
    /^(thanks|thank\s*you|ta|cheers|thx|ty|much\s+appreciated)[\s!.?]*$/,
    /^(ok|okay|cool|sure|nice|great|awesome|got\s+it|understood|perfect|brilliant|lovely|fab)[\s!.?]*$/,
    /^(bye|goodbye|cya|see\s*ya|later|ciao)[\s!.?]*$/,
    /^(yes|yeah|yep|nope|no)[\s!.?]*$/,
  ];

  return patterns.some(p => p.test(trimmed));
}
