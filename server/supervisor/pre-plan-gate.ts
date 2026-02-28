export interface PrePlanGateInput {
  userMessage: string;
  businessType: string;
  location: string;
  verticalId?: string;
}

export interface ClarificationResult {
  clarification_needed: boolean;
  reason: string | null;
  suggested_question: string | null;
  assumptions: string[] | null;
  gate_flags: {
    vertical_mismatch: boolean;
    informational_query: boolean;
    query_suspected_merged: boolean;
  };
}

const VERTICAL_MISMATCH_KEYWORDS: Record<string, string[]> = {
  brewery: [
    'vulnerable adults', 'social care', 'support services', 'benefits',
    'housing', 'charity', 'council services', 'mental health',
    'disability', 'safeguarding', 'domestic abuse', 'homelessness',
    'food bank', 'welfare', 'elderly care', 'youth services',
    'addiction', 'rehabilitation', 'counselling', 'nhs',
  ],
  micropubs: [
    'vulnerable adults', 'social care', 'support services', 'benefits',
    'housing', 'charity', 'council services', 'mental health',
    'disability', 'safeguarding', 'domestic abuse', 'homelessness',
    'food bank', 'welfare', 'elderly care', 'youth services',
  ],
};

const INFORMATIONAL_PREFIXES = [
  /^what (?:is|are|does|do)\b/i,
  /^how (?:do|does|can|should|would|to)\b/i,
  /^why (?:do|does|is|are|should)\b/i,
  /^can (?:you|i|we) (?:explain|tell|help me understand)\b/i,
  /^(?:explain|describe|define)\b/i,
  /^who (?:is|are|provides|offers)\b/i,
  /^where (?:can i|do i|should i)\b/i,
];

const MERGED_QUERY_SIGNALS = [
  /\b(?:in\s+\w+)\s+(?:what|which|how|where|who|find|list|show)\b/i,
  /\b(?:and also|as well as|plus|and find|and search|and look)\b/i,
];

function hasMultipleLocationEntities(msg: string): boolean {
  const locationPattern = /\b(?:in|near|around)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = locationPattern.exec(msg)) !== null) {
    matches.push(m[1].toLowerCase());
  }
  const unique = new Set(matches);
  return unique.size > 1;
}

export function evaluatePrePlanGate(input: PrePlanGateInput): ClarificationResult {
  const msg = input.userMessage.trim();
  const msgLower = msg.toLowerCase();
  const vertical = (input.verticalId || 'general').toLowerCase();

  let verticalMismatch = false;
  let informationalQuery = false;
  let querySuspectedMerged = false;
  let reason: string | null = null;
  let suggestedQuestion: string | null = null;
  let assumptions: string[] | null = null;

  if (vertical !== 'general') {
    const keywords = VERTICAL_MISMATCH_KEYWORDS[vertical] ?? [];
    const matched = keywords.filter(kw => msgLower.includes(kw));
    if (matched.length > 0) {
      verticalMismatch = true;
      reason = `Your query mentions "${matched[0]}" which doesn't align with the current ${vertical} vertical. This may return irrelevant results.`;
      suggestedQuestion = `Did you mean to search across all business types (general), or would you like to stay within ${vertical}?`;
      assumptions = [`Could switch to general vertical and search for "${input.businessType}" as-is`];
    }
  }

  if (!verticalMismatch) {
    for (const re of INFORMATIONAL_PREFIXES) {
      if (re.test(msg)) {
        const hasLeadVerb = /\b(?:find|search|list|show|get|look\s+for|locate)\b/i.test(msg);
        if (!hasLeadVerb) {
          informationalQuery = true;
          reason = `Your message looks like a question rather than a search request. I can search for businesses, but I want to make sure I understand what you need.`;
          suggestedQuestion = `Would you like me to search for "${input.businessType}" in ${input.location}, or are you asking a general question?`;
          assumptions = [`Could interpret as: find ${input.businessType} in ${input.location}`];
          break;
        }
      }
    }
  }

  if (!verticalMismatch && !informationalQuery) {
    for (const re of MERGED_QUERY_SIGNALS) {
      if (re.test(msg)) {
        querySuspectedMerged = true;
        break;
      }
    }
    if (!querySuspectedMerged && hasMultipleLocationEntities(msg)) {
      querySuspectedMerged = true;
    }
    if (querySuspectedMerged) {
      reason = `Your query may contain multiple requests merged together. I want to make sure I search for the right thing.`;
      suggestedQuestion = `Could you confirm: are you looking for "${input.businessType}" in ${input.location}?`;
      assumptions = [`Could run single search for ${input.businessType} in ${input.location}`];
    }
  }

  const clarificationNeeded = verticalMismatch || informationalQuery;

  return {
    clarification_needed: clarificationNeeded,
    reason,
    suggested_question: suggestedQuestion,
    assumptions,
    gate_flags: {
      vertical_mismatch: verticalMismatch,
      informational_query: informationalQuery,
      query_suspected_merged: querySuspectedMerged,
    },
  };
}
