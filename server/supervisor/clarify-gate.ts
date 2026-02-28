import { RELATIONSHIP_PREDICATES } from './relationship-predicate';

export type ClarifyRoute = 'direct_response' | 'clarify_before_run' | 'agent_run';

export type ClarifyMissingField = 'location' | 'entity_type' | 'relationship_clarification';

export interface ClarifyGateResult {
  route: ClarifyRoute;
  reason: string;
  questions?: string[];
  missingFields?: ClarifyMissingField[];
  parsedFields?: {
    businessType: string | null;
    location: string | null;
  };
}

const DIRECT_RESPONSE_PATTERNS = [
  /^what (?:is|are|does|do)\b/i,
  /^how (?:do|does|can|should|would|to)\b/i,
  /^why (?:do|does|is|are|should)\b/i,
  /^can (?:you|i|we) (?:explain|tell|help me understand)\b/i,
  /^(?:explain|describe|define)\b/i,
  /^(?:tell me about|what's the difference|how much|is it possible)\b/i,
  /^(?:do you|are you|can you)\b/i,
  /^(?:thanks|thank you|cheers|ok|okay|got it|understood|sure)\b/i,
  /^(?:who are you|what can you do|how do you work)\b/i,
];

const LEAD_FINDING_VERBS = /\b(?:find|search|list|show|get|look\s+for|locate|discover|identify|give me|pull|fetch|source)\b/i;

const VAGUE_ENTITY_TYPES = [
  'organisations', 'organizations', 'companies', 'businesses',
  'places', 'things', 'groups', 'entities', 'providers',
  'firms', 'outfits', 'establishments',
];

const LOCATION_INDICATOR = /\b(?:in|near|around|across|throughout|within)\s+\w/i;
const EXPLICIT_LOCATION = /\b(?:in|near|around|across|throughout|within)\s+\w[\w\s,'-]*/i;

const FALSE_PRIOR_CONTEXT = [
  /\b(?:earlier you said|you (?:mentioned|told me|said)|as you (?:noted|pointed out)|last time you|previously you)\b/i,
  /\b(?:remember when you|you already|you were saying|like you said)\b/i,
];

function hasLeadFindingVerb(msg: string): boolean {
  return LEAD_FINDING_VERBS.test(msg);
}

const NOUN_PHRASE_SEARCH = /\b(?:list of|number of)\s+\w/i;

function hasSearchIntent(msg: string): boolean {
  if (hasLeadFindingVerb(msg)) return true;
  if (NOUN_PHRASE_SEARCH.test(msg) && LOCATION_INDICATOR.test(msg)) return true;
  if (LOCATION_INDICATOR.test(msg) && /\b\w+(?:s|ers|ies|ors)\b/i.test(msg)) return true;
  return false;
}

function isDirectResponse(msg: string): boolean {
  const trimmed = msg.trim();
  if (trimmed.length < 3) return true;

  if (hasSearchIntent(trimmed)) return false;

  for (const pattern of DIRECT_RESPONSE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  if (!LOCATION_INDICATOR.test(trimmed)) {
    const looksLikeQuestion = /\?$/.test(trimmed.trim());
    if (looksLikeQuestion) return true;
  }

  return false;
}

function isMissingLocation(msg: string): boolean {
  if (EXPLICIT_LOCATION.test(msg)) return false;

  const knownRegions = /\b(?:UK|US|USA|England|Scotland|Wales|Ireland|London|Manchester|Birmingham|Bristol|Leeds|Sheffield|Liverpool|Newcastle|Edinburgh|Glasgow|Cardiff|Belfast|Sussex|Surrey|Kent|Essex|Devon|Cornwall|Norfolk|Suffolk|Yorkshire|Lancashire|Dorset|Hampshire|Somerset|Wiltshire|Berkshire|Oxfordshire|Cambridgeshire|Nottinghamshire|Derbyshire|Leicestershire|Warwickshire|Staffordshire|Shropshire|Herefordshire|Worcestershire|Gloucestershire|Lincolnshire|Rutland|Northamptonshire|Bedfordshire|Hertfordshire|Buckinghamshire|Middlesex|Merseyside|Tyneside)\b/i;
  if (knownRegions.test(msg)) return false;

  return true;
}

function hasVagueEntityType(msg: string): boolean {
  const lower = msg.toLowerCase();
  for (const vague of VAGUE_ENTITY_TYPES) {
    if (lower.includes(vague)) {
      const sectorIndicator = /\b(?:in the|sector|industry|field|area of|specialising|specializing|that (?:do|provide|offer|make|sell)|for)\b/i;
      if (!sectorIndicator.test(msg)) {
        return true;
      }
    }
  }
  return false;
}

function hasRelationshipPredicate(msg: string): boolean {
  const lower = msg.toLowerCase();
  for (const predicate of RELATIONSHIP_PREDICATES) {
    if (lower.includes(predicate)) return true;
  }
  return false;
}

function isMalformedInput(msg: string): boolean {
  const trimmed = msg.trim();

  const noSpaceBetweenSentences = /[a-z][A-Z][a-z]/;
  const multipleQuestions = (trimmed.match(/\?/g) || []).length >= 2;
  const multipleLeadVerbs = (trimmed.match(LEAD_FINDING_VERBS) || []).length >= 2;

  if (noSpaceBetweenSentences.test(trimmed)) return true;
  if (multipleQuestions && multipleLeadVerbs) return true;

  const verbMatches = trimmed.match(/\b(?:find|search|list|show|get|locate)\b/gi) || [];
  if (verbMatches.length >= 2) {
    const compoundVerb = /\b(?:find and list|find and show|search and list|list and find|find or search)\b/i;
    if (!compoundVerb.test(trimmed)) return true;
  }

  return false;
}

function hasMixedIntent(msg: string): boolean {
  const lower = msg.toLowerCase();

  const conjunctionSplit = lower.split(/\b(?:and also|also find|and find|and search|plus find|as well as find)\b/);
  if (conjunctionSplit.length >= 2) return true;

  return false;
}

function hasFalsePriorContext(msg: string): boolean {
  for (const pattern of FALSE_PRIOR_CONTEXT) {
    if (pattern.test(msg)) return true;
  }
  return false;
}

function extractBusinessType(msg: string): string | null {
  const lower = msg.toLowerCase();
  const verbMatch = lower.match(/\b(?:find|search|list|show|get|look\s+for|locate|discover|identify|give me|pull|fetch|source)\s+(?:\d+\s+)?(.+?)(?:\s+(?:in|near|around|across|throughout|within)\b|$)/i);
  if (verbMatch) {
    let bt = verbMatch[1].trim();
    bt = bt.replace(/\b(?:for me|please|thanks|thank you)\b/gi, '').trim();
    if (bt && bt.length > 1 && bt.length < 60) return bt;
  }
  return null;
}

function extractLocation(msg: string): string | null {
  const locMatch = msg.match(/\b(?:in|near|around|across|throughout|within)\s+([A-Z][\w\s,'-]+)/i);
  if (locMatch) {
    let loc = locMatch[1].trim();
    loc = loc.replace(/\s+(?:please|thanks|thank you)$/i, '').trim();
    if (loc && loc.length > 1 && loc.length < 60) return loc;
  }
  return null;
}

export function evaluateClarifyGate(userMessage: string): ClarifyGateResult {
  const msg = userMessage.trim();

  if (isDirectResponse(msg)) {
    return {
      route: 'direct_response',
      reason: 'Message is a question, explanation request, or meta/trust query — no agent execution needed.',
    };
  }

  const questions: string[] = [];
  const reasons: string[] = [];
  const missing: ClarifyMissingField[] = [];

  if (hasFalsePriorContext(msg)) {
    reasons.push('references prior context that may not exist');
    questions.push('I don\'t have memory of a previous conversation on this topic. Could you restate what you\'re looking for?');
  }

  if (isMalformedInput(msg)) {
    reasons.push('input appears malformed or contains multiple concatenated requests');
    questions.push('It looks like your message may contain multiple requests joined together. Could you separate them so I handle each one correctly?');
  }

  if (hasMixedIntent(msg)) {
    reasons.push('message contains mixed intent (question + search, or multiple searches)');
    if (!questions.some(q => q.includes('multiple requests'))) {
      questions.push('Your message seems to contain more than one request. Could you tell me which one to tackle first?');
    }
  }

  if (hasRelationshipPredicate(msg)) {
    reasons.push('contains a relationship predicate that cannot be verified by search alone');
    questions.push('You\'re asking about a relationship between entities (e.g. "works with", "supplies"). I can find businesses in a location, but I can\'t verify relationships between them. Would you like me to search for the target entity type in a specific location instead?');
    missing.push('relationship_clarification');
  }

  if (hasVagueEntityType(msg) && !hasRelationshipPredicate(msg)) {
    reasons.push('entity type is vague without a sector qualifier');
    questions.push('Could you be more specific about the type of business? For example, instead of "organisations", could you specify a sector like "care providers" or "marketing agencies"?');
    missing.push('entity_type');
  }

  if (isMissingLocation(msg) && hasLeadFindingVerb(msg)) {
    reasons.push('no clear location specified');
    questions.push('Which city, region, or country should I search in?');
    missing.push('location');
  }

  if (questions.length > 0) {
    return {
      route: 'clarify_before_run',
      reason: `Clarification needed: ${reasons.join('; ')}.`,
      questions: questions.slice(0, 3),
      missingFields: missing,
      parsedFields: {
        businessType: extractBusinessType(msg),
        location: extractLocation(msg),
      },
    };
  }

  return {
    route: 'agent_run',
    reason: 'Intent is clear and runnable — proceeding with agent execution.',
  };
}