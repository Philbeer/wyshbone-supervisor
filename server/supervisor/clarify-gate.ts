import { RELATIONSHIP_PREDICATES } from './relationship-predicate';

export type ClarifyRoute = 'direct_response' | 'clarify_before_run' | 'agent_run';

export type ClarifyMissingField = 'location' | 'entity_type' | 'relationship_clarification' | 'semantic_constraint';

export interface ClarifyGateResult {
  route: ClarifyRoute;
  reason: string;
  questions?: string[];
  missingFields?: ClarifyMissingField[];
  parsedFields?: {
    businessType: string | null;
    location: string | null;
    count: number | null;
    timeFilter: string | null;
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

const META_TRUST_PATTERNS = [
  /\b(?:can i trust|do you guarantee|are (?:these|the|your) (?:results?|leads?|data) (?:accurate|correct|reliable|verified))\b/i,
  /\b(?:how (?:accurate|reliable|trustworthy|correct)|is (?:this|it|the data) (?:accurate|correct|reliable|verified))\b/i,
  /\b(?:guarantee|guaranteed)\b/i,
  /\b(?:can you be trusted|should i trust|why should i trust|how can i trust)\b/i,
  /\b(?:what (?:is|are) your (?:sources?|data|methodology|accuracy))\b/i,
  /\b(?:how do you work|what do you do|who are you|what are you)\b/i,
  /\b(?:are you (?:a bot|an ai|real|automated)|how does (?:this|it) work)\b/i,
  /\b(?:what is wyshbone|what'?s wyshbone|tell me about wyshbone|explain wyshbone)\b/i,
  /\b(?:can (?:it|you|wyshbone) (?:lie|make (?:things |stuff )?up|hallucinate|fabricate|be wrong|mislead))\b/i,
  /\b(?:does (?:it|wyshbone) (?:lie|make (?:things |stuff )?up|hallucinate|fabricate|mislead))\b/i,
  /\b(?:will (?:it|you|wyshbone) (?:lie|make (?:things |stuff )?up|hallucinate|fabricate|mislead))\b/i,
  /\b(?:is (?:it|wyshbone) (?:honest|truthful|reliable|accurate|trustworthy))\b/i,
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

function isMetaTrust(msg: string): boolean {
  for (const pattern of META_TRUST_PATTERNS) {
    if (pattern.test(msg)) return true;
  }
  return false;
}

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

  if (isMetaTrust(trimmed)) return true;

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

const KNOWN_REGIONS = /\b(?:UK|US|USA|England|Scotland|Wales|Ireland|London|Manchester|Birmingham|Bristol|Leeds|Sheffield|Liverpool|Newcastle|Edinburgh|Glasgow|Cardiff|Belfast|Sussex|East Sussex|West Sussex|Surrey|Kent|Essex|Devon|Cornwall|Norfolk|Suffolk|Yorkshire|Lancashire|Dorset|Hampshire|Somerset|Wiltshire|Berkshire|Oxfordshire|Cambridgeshire|Nottinghamshire|Derbyshire|Leicestershire|Warwickshire|Staffordshire|Shropshire|Herefordshire|Worcestershire|Gloucestershire|Lincolnshire|Rutland|Northamptonshire|Bedfordshire|Hertfordshire|Buckinghamshire|Middlesex|Merseyside|Tyneside|Berlin|Paris|Madrid|Barcelona|Rome|Milan|Amsterdam|Munich|Hamburg|Frankfurt|Vienna|Prague|Warsaw|Lisbon|Dublin|Brussels|Zurich|Geneva|Stockholm|Copenhagen|Oslo|Helsinki|Athens|Budapest|Bucharest|New York|Los Angeles|Chicago|Houston|Phoenix|Philadelphia|San Francisco|Seattle|Denver|Boston|Nashville|Portland|Las Vegas|Miami|Atlanta|Dallas|Austin|San Diego|San Jose|Sacramento|Orlando|Tampa|Minneapolis|St Louis|Pittsburgh|Cincinnati|Cleveland|Baltimore|Milwaukee|Raleigh|Charlotte|Memphis|Louisville|Richmond|Norfolk|Blackpool|Brighton|Bath|Oxford|Cambridge|Exeter|Plymouth|Norwich|Nottingham|Leicester|Derby|Reading|Southampton|Portsmouth|York|Chester|Durham|Carlisle|Lancaster|Worcester|Gloucester|Lincoln|Ipswich|Canterbury|Dover|Hastings|Eastbourne|Bournemouth|Swindon|Cheltenham|Coventry|Wolverhampton|Bolton|Preston|Stoke|Telford|Shrewsbury|Hereford)\b/i;

const SUBJECTIVE_CRITERIA = /\b(?:best|top|coolest|nicest|most\s+fun|most\s+popular|most\s+interesting|greatest|finest|ultimate|amazing|awesome|incredible|fantastic|perfect|ideal|favourite|favorite|chillest|trendiest|hippest|dopest|sickest|vibes?|vibe-?y|vibey|nice|good\s+atmosphere|great\s+atmosphere|great(?!\s+(?:for|at|with))|cool(?!est)|lovely|decent|chill(?!est)|good(?!\s+for\s+studying))\b/i;

const MEASURABLE_ATTRIBUTES = /\b(?:live\s*music|craft\s*beer|real\s*ale|cask\s*ale|dog\s*friendly|family\s*friendly|late[- ]?\s*night|cheap|budget|expensive|premium|cosy|cozy|quiet|outdoor\s*seating|beer\s*garden|rooftop|waterfront|riverside|seafront|free\s*wifi|wheelchair|accessible|parking|vegan|vegetarian|gluten\s*free|halal|kosher|organic|independent|chain|gastropub|wine\s*bar|cocktail\s*bar|sports?\s*bar|micro\s*pub|tap\s*room|free\s*house|food\s*served|nightlife|lively|romantic|trendy|walkable|events|student|views|scenic|good\s+for\s+studying)\b/i;

const NONSENSE_LOCATION_WORDS = /\b(?:things?|stuff|whatsits?|thingamajigs?|doohickeys?|bits|pieces|whatnots?|whatchamacallits?|doodads?|gizmos?|widgets?|nonsense|blah|asdf|test|nowhere|somewhere|anywhere|whatever|idk|dunno|nothing|something)\b/i;

function extractSubjectiveTerm(msg: string): string | null {
  const match = msg.match(SUBJECTIVE_CRITERIA);
  if (!match) return null;
  return match[0].trim();
}

function hasSubjectiveCriteria(msg: string): boolean {
  return SUBJECTIVE_CRITERIA.test(msg);
}

const VAGUE_PROXIMITY_NOUNS = /\b(?:council|local\s+authority|government|town\s+hall|civic\s+centre|civic\s+center|council\s+offices?|council\s+buildings?)\b/i;

function hasNonsenseLocation(msg: string): boolean {
  const locMatch = msg.match(/\b(?:in|near|around|across|throughout|within)\s+([A-Za-z][\w\s,'-]*?)(?:\s+(?:in|near|around|across|throughout|within)\b|$)/i);
  if (!locMatch) return false;

  let loc = locMatch[1].trim();
  loc = loc.replace(/\s+(?:please|thanks|thank you)$/i, '').trim();
  loc = loc.replace(/^(?:the|a|an)\s+/i, '').trim();

  if (!loc || loc.length < 2) return false;
  if (KNOWN_REGIONS.test(loc)) return false;

  if (NONSENSE_LOCATION_WORDS.test(loc)) return true;

  const words = loc.split(/\s+/).filter(w => !/^(?:the|a|an)$/i.test(w));
  const PLACEHOLDER_NOUNS = /\b(?:council|random|local|some|any|those|these|my|our|your)\b/i;
  if (words.length <= 3 && words.some(w => PLACEHOLDER_NOUNS.test(w)) && !KNOWN_REGIONS.test(loc)) {
    return true;
  }

  return false;
}

function detectVagueProximityWithRealLocation(msg: string): { vaguePhrase: string; realLocation: string } | null {
  const proximityFirst = /\b((?:near|around|close\s+to|by)\s+(?:the\s+)?(?:council|local\s+authority|government|town\s+hall|civic\s+centre|civic\s+center|council\s+offices?|council\s+buildings?))\b.*?\b(?:in|around)\s+([\w][\w\s,'-]+)/i;
  const match1 = msg.match(proximityFirst);
  if (match1) {
    const realLoc = match1[2].trim().replace(/\s+(?:please|thanks|thank you)$/i, '').trim();
    if (KNOWN_REGIONS.test(realLoc)) {
      return { vaguePhrase: match1[1].trim(), realLocation: realLoc };
    }
  }

  const locationFirst = /\b(?:in|around)\s+([\w][\w\s,'-]+?)\s+(?:near|around|close\s+to|by)\s+((?:the\s+)?(?:council|local\s+authority|government|town\s+hall|civic\s+centre|civic\s+center|council\s+offices?|council\s+buildings?))\b/i;
  const match2 = msg.match(locationFirst);
  if (match2) {
    const realLoc = match2[1].trim().replace(/\s+(?:please|thanks|thank you)$/i, '').trim();
    if (KNOWN_REGIONS.test(realLoc)) {
      return { vaguePhrase: `near ${match2[2].trim()}`, realLocation: realLoc };
    }
  }

  return null;
}

function isMissingLocation(msg: string): boolean {
  if (EXPLICIT_LOCATION.test(msg)) return false;

  if (KNOWN_REGIONS.test(msg)) return false;

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

const TEMPORAL_DISQUALIFIERS = /\b(?:months?|years?|days?|weeks?|hours?|minutes?|ago|since|last|past|recent|recently|old|new|opened|closed|started|founded|established)\b/i;
const COUNT_NEAR_SEARCH = /\b(?:find|show|get|give me|list|pull|fetch|source|locate|discover|identify)\s+(\d+)\b/i;
const COUNT_BEFORE_NOUN = /\b(\d+)\s+(?!months?\b|years?\b|days?\b|weeks?\b|hours?\b|minutes?\b)\w+/i;

function extractCount(msg: string): number | null {
  const searchMatch = msg.match(COUNT_NEAR_SEARCH);
  if (searchMatch) {
    const n = parseInt(searchMatch[1], 10);
    if (n >= 1 && n <= 500) return n;
  }

  const nounMatch = msg.match(COUNT_BEFORE_NOUN);
  if (nounMatch) {
    const n = parseInt(nounMatch[1], 10);
    if (n >= 1 && n <= 500) {
      const idx = msg.indexOf(nounMatch[0]);
      const surrounding = msg.substring(Math.max(0, idx - 20), idx + nounMatch[0].length + 20);
      if (TEMPORAL_DISQUALIFIERS.test(surrounding)) return null;
      if (LEAD_FINDING_VERBS.test(msg)) return n;
    }
  }

  return null;
}

const TIME_FILTER_PATTERN = /\b(?:(?:in|within|over)\s+(?:the\s+)?(?:last|past)\s+\d+\s+(?:months?|years?|weeks?|days?)|opened|closed|started|founded|established)\s+(?:in\s+(?:the\s+)?(?:last|past)\s+)?\d*\s*(?:months?|years?|weeks?|days?)?\b/i;
const TIME_FILTER_SIMPLE = /\b(?:(?:last|past)\s+\d+\s+(?:months?|years?|weeks?|days?)|(?:opened|started|founded|established)\s+(?:in\s+(?:the\s+)?)?(?:last|past)?\s*\d+\s*(?:months?|years?|weeks?|days?))\b/i;

function extractTimeFilter(msg: string): string | null {
  const match = msg.match(TIME_FILTER_SIMPLE) || msg.match(TIME_FILTER_PATTERN);
  if (match) return match[0].trim();
  return null;
}

function extractBusinessType(msg: string): string | null {
  const lower = msg.toLowerCase();
  const verbMatch = lower.match(/\b(?:find|search|list|show|get|look\s+for|locate|discover|identify|give me|pull|fetch|source)\s+(?:\d+\s+)?(.+?)(?:\s+(?:in|near|around|across|throughout|within)\b|$)/i);
  if (verbMatch) {
    let bt = verbMatch[1].trim();
    bt = bt.replace(/\b(?:for me|please|thanks|thank you)\b/gi, '').trim();
    bt = bt.replace(/\b(?:that\s+)?(?:opened|started|founded|established)\s+(?:in\s+(?:the\s+)?)?(?:last|past)?\s*\d*\s*(?:months?|years?|weeks?|days?)\s*(?:ago)?\b/gi, '').trim();
    if (bt && bt.length > 1 && bt.length < 60) return bt;
  }
  return null;
}

function extractLocation(msg: string): string | null {
  const locMatch = msg.match(/\b(?:in|near|around|across|throughout|within)\s+([A-Z][\w\s,'-]+)/i);
  if (locMatch) {
    let loc = locMatch[1].trim();
    loc = loc.replace(/\s+(?:please|thanks|thank you)$/i, '').trim();
    loc = loc.replace(/\s+(?:that\s+)?(?:opened|started|founded|established)\b.*$/i, '').trim();
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

  if (hasSearchIntent(msg) && hasSubjectiveCriteria(msg)) {
    reasons.push('query contains subjective/unmeasurable criteria');
    const subjectiveTerm = extractSubjectiveTerm(msg) || 'that';
    questions.push(`What do you mean by '${subjectiveTerm}'? Pick 1–2 measurable attributes: cosy, lively, upscale, traditional, live music, craft beer, quiet, late-night, family-friendly, cheap, dog-friendly, outdoor seating, etc.`);
    missing.push('semantic_constraint');
  }

  const vagueProximity = detectVagueProximityWithRealLocation(msg);
  if (vagueProximity) {
    reasons.push('location contains a vague proximity reference alongside a real location');
    questions.push(`"${vagueProximity.vaguePhrase}" is vague — do you mean within a specific distance of a particular council building, or just generally in ${vagueProximity.realLocation}? Which building do you mean?`);
    questions.push(`Just to confirm — is ${vagueProximity.realLocation} the right area to search?`);
  } else if (hasSearchIntent(msg) && hasNonsenseLocation(msg)) {
    reasons.push('location appears invalid or nonsensical');
    questions.push('That phrase isn\'t a real place I can search. Please provide a concrete location — a city, town, postcode, or area.');
    missing.push('location');
  }

  if (hasVagueEntityType(msg) && !hasRelationshipPredicate(msg)) {
    reasons.push('entity type is vague without a sector qualifier');
    questions.push('Could you be more specific about the type of business? For example, instead of "organisations", could you specify a sector like "care providers" or "marketing agencies"?');
    missing.push('entity_type');
  }

  if (isMissingLocation(msg) && hasLeadFindingVerb(msg) && !hasNonsenseLocation(msg)) {
    reasons.push('no clear location specified');
    questions.push('Which city, region, or country should I search in?');
    missing.push('location');
  }

  if (questions.length > 0) {
    const rawLoc = extractLocation(msg);
    const locationIsInvalid = missing.includes('location');
    const sanitisedLocation = locationIsInvalid ? null : rawLoc;

    const rawBT = extractBusinessType(msg);
    const btContainsSubjective = rawBT ? SUBJECTIVE_CRITERIA.test(rawBT) : false;
    let sanitisedBusinessType = rawBT;
    if (btContainsSubjective && rawBT) {
      const SUBJECTIVE_GLOBAL = /\b(?:best|top|coolest|nicest|most\s+fun|most\s+popular|most\s+interesting|greatest|finest|ultimate|amazing|awesome|incredible|fantastic|perfect|ideal|favourite|favorite|chillest|trendiest|hippest|dopest|sickest|vibes?|vibe-?y|vibey|nice|great|cool|lovely|decent|chill|good)\b/gi;
      let cleaned = rawBT.replace(SUBJECTIVE_GLOBAL, '').replace(/\b(?:the|a|an)\b/gi, '').replace(/\s+/g, ' ').trim();
      sanitisedBusinessType = cleaned.length > 1 ? cleaned : null;
    }

    return {
      route: 'clarify_before_run',
      reason: `Clarification needed: ${reasons.join('; ')}.`,
      questions: questions.slice(0, 3),
      missingFields: missing,
      parsedFields: {
        businessType: sanitisedBusinessType,
        location: sanitisedLocation,
        count: extractCount(msg),
        timeFilter: extractTimeFilter(msg),
      },
    };
  }

  return {
    route: 'agent_run',
    reason: 'Intent is clear and runnable — proceeding with agent execution.',
  };
}
