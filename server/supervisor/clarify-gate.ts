import { RELATIONSHIP_PREDICATES } from './relationship-predicate';
import type { CanonicalIntent } from './canonical-intent';
import type { SemanticSource } from './constraint-gate';

// CLARIFY_GATE_FIX: Added 'refuse' as distinct outcome for fictional/nonsensical locations
export type ClarifyRoute = 'direct_response' | 'clarify_before_run' | 'agent_run' | 'refuse';

// CLARIFY_GATE_FIX: Added 'fictional_location' and 'unrecognised_location' trigger categories
export type ClarifyTriggerCategory = 'empty' | 'multiple_requests' | 'malformed' | 'unknown' | 'fictional_location' | 'unrecognised_location';

export type ClarifyMissingField = 'location' | 'entity_type' | 'relationship_clarification' | 'semantic_constraint';

// CLARIFY_GATE_FIX: Options bag for evaluateClarifyGateFromIntent
export interface ClarifyGateOptions {
  delegatedClarify?: boolean;
  delegatedClarifyReason?: string;
}

// CLARIFY_GATE_FIX: Location validity result
export type LocationValidity = 'recognised' | 'unrecognised' | 'fictional';

const LOCATION_VALIDITY_SYSTEM_PROMPT = `You are a location validity checker for a B2B lead generation system. Your job is to determine whether a given location name refers to a real place where real businesses could plausibly operate.

Respond with EXACTLY one JSON object:
{ "verdict": "real" | "fictional" | "ambiguous" | "nonsense", "confidence": 0.0-1.0, "reason": "brief explanation" }

Rules:
- "real": Any real place on Earth where businesses could operate — including obscure villages, hamlets, small towns, historical places that still exist. Examples: "Little Snoring" (real Norfolk village), "Trumpington" (real Cambridge suburb), "Narborough" (real Norfolk village), "Llanfairpwllgwyngyll" (real Welsh town), "Arundel" (real West Sussex town).
- "fictional": Places from books, films, TV, games, mythology, or pure invention. Examples: "Narnia", "Mordor", "Hogwarts", "Wakanda", "Gotham", "Westeros", "Tatooine", "Hyrule".
- "nonsense": Strings that are not place names at all — gibberish, common English words used as locations, or obviously made-up words. Examples: "nowhere", "amazingville", "asdfgh", "things", "blah blah".
- "ambiguous": The name could be real but you are not confident enough to say — it sounds plausible but you cannot confirm. This is rare; most real-sounding places ARE real.

IMPORTANT: When in doubt between "real" and "ambiguous", lean toward "real". Obscure but real places must NOT be blocked. Only clearly fictional or nonsensical inputs should be flagged.

Return ONLY the JSON object. No markdown, no explanation outside the JSON.`;

async function callLLMForLocationValidity(location: string, entityType?: string | null): Promise<{ verdict: 'real' | 'fictional' | 'ambiguous' | 'nonsense'; confidence: number; reason: string }> {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const userPrompt = entityType
    ? `Location: "${location}"\nBusiness type being searched: "${entityType}"\n\nIs "${location}" a real place where ${entityType} could plausibly operate?`
    : `Location: "${location}"\n\nIs "${location}" a real place where businesses could plausibly operate?`;

  try {
    if (openaiKey) {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: openaiKey });
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: LOCATION_VALIDITY_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      });
      const text = response.choices[0]?.message?.content || '{}';
      return JSON.parse(text);
    }

    if (anthropicKey) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 200,
          temperature: 0,
          system: LOCATION_VALIDITY_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt + '\n\nReturn ONLY valid JSON.' }],
        }),
      });
      const data = await response.json() as any;
      const text = data.content?.[0]?.text || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { verdict: 'real', confidence: 0.5, reason: 'LLM response unparseable — defaulting to real' };
    }
  } catch (err) {
    console.error(`[CLARIFY_GATE] LLM location validity call failed:`, err);
  }

  return { verdict: 'real', confidence: 0.5, reason: 'No LLM key available or call failed — defaulting to real (safe fallback)' };
}

export interface ClarifyGateResult {
  route: ClarifyRoute;
  reason: string;
  triggerCategory?: ClarifyTriggerCategory;
  questions?: string[];
  missingFields?: ClarifyMissingField[];
  parsedFields?: {
    businessType: string | null;
    location: string | null;
    count: number | null;
    timeFilter: string | null;
  };
  semantic_source?: SemanticSource;
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

const LEAD_FINDING_VERBS = /\b(?:find|search|list|show|get|look\s+for|locate|discover|identify|give me|pull|fetch|source|monitor|check|checking|watch|alert|notify|track)\b/i;

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

const MONITORING_VERBS = /\b(?:keep\s+checking|monitor|watch\s+for|alert\s+me|notify\s+me|track|let\s+me\s+know|keep\s+an?\s+eye|ongoing|recurring|check\s+every)\b/i;

function hasMonitoringIntent(msg: string): boolean {
  return MONITORING_VERBS.test(msg);
}

const NOUN_PHRASE_SEARCH = /\b(?:list of|number of)\s+\w/i;

function hasSearchIntent(msg: string): boolean {
  if (hasLeadFindingVerb(msg)) return true;
  if (hasMonitoringIntent(msg)) return true;
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

const SUBJECTIVE_CRITERIA = /\b(?:best|top|coolest|nicest|most\s+fun|most\s+popular|most\s+interesting|greatest|finest|ultimate|amazing|awesome|incredible|fantastic|perfect|ideal|favourite|favorite|chillest|trendiest|hippest|dopest|sickest|vibes?|vibe-?y|vibey|nice|good\s+atmosphere|great\s+atmosphere|great(?!\s+(?:for|at|with))|cool(?!est)|lovely|decent|chill(?!est)|good(?!\s+(?:for\s+studying|guinness|beer))|popular|fancy|high[- ]?end|recommended|quality|trendy)\b/i;

const MEASURABLE_ATTRIBUTES = /\b(?:live\s*music|craft\s*beer|real\s*ale|cask\s*ale|dog\s*friendly|family\s*friendly|late[- ]?\s*night|open\s*late|cheap|budget|expensive|premium|cosy|cozy|quiet|outdoor\s*seating|beer\s*garden|rooftop|waterfront|riverside|seafront|free\s*wifi|wheelchair|accessible|parking|vegan|vegetarian|gluten\s*free|halal|kosher|organic|independent|chain|gastropub|wine\s*bar|cocktail\s*bar|sports?\s*bar|micro\s*pub|tap\s*room|free\s*house|food\s*served|nightlife|lively|romantic|walkable|events|student|views|scenic|good\s+for\s+studying|good\s+guinness|good\s+beer|has\s+food)\b/i;

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

const GLOBAL_SCOPE_PATTERN = /\b(?:in the world|worldwide|globally|around the world|across the globe|on earth|international(?:ly)?|every country|all countries)\b/i;

function isGlobalByDesign(msg: string): boolean {
  return GLOBAL_SCOPE_PATTERN.test(msg);
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

function isNonsenseInput(msg: string): boolean {
  const trimmed = msg.trim();

  if (hasSearchIntent(trimmed)) return false;
  if (KNOWN_REGIONS.test(trimmed)) return false;

  const COMMON_WORDS = /\b(?:find|search|list|show|get|look|locate|discover|identify|give|pull|fetch|source|the|a|an|in|on|at|to|for|of|with|and|or|but|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|shall|should|can|could|may|might|must|need|me|my|i|you|your|we|our|they|their|it|its|this|that|these|those|not|no|yes|please|thanks|thank|near|around|across|throughout|within|from|by|about|how|what|where|when|why|who|which|if|then|than|also|just|only|very|so|too|all|any|some|each|every|much|many|more|most|other|new|old|best|good|nice|great|big|small|long|short|high|low|first|last|next|open|close|make|take|come|go|see|know|think|want|tell|ask|use|try|put|call|keep|let|begin|start|end|stop|help|turn|move|play|run|work|live|feel|say|hear|read|write|eat|drink|buy|sell|pay|send|set|sit|stand|cut|hold|bring|carry|pick|drop|fall|rise|grow|change|follow|lead|leave|add|meet|serve|wait|stay|pass|spend|build|talk|walk|drive|fly|draw|break|teach|learn|look|study|plan|check|join|wish|watch|cook|sing|dance|swim|fight|push|pull|rest|sleep|wake|clean|wash|cross|cover|press|reach|lift|throw|catch|hang|feed|fit|fill|pour|mix|spread|lay|raise|lower|wear|light|heat|cool|test|fix|repair|save|apply|note|view|share|post|sign|sort|mark|name|form|link|count|match|rate|fund|track|place|point|state|order|charge|claim|report|present|offer|support|create|design|develop|manage|provide|include|consider|appear|expect|suggest|require|produce|affect|promise|handle|express|concern|involve|receive|notice|choose|deliver|pubs?|cafes?|bars?|restaurants?|shops?|hotels?|offices?|stores?|venues?|clubs?|salons?|studios?|breweries|bakeries|agencies|clinics?|pharmacies|gyms?|spas?|gardens?|markets?|galleries|theatres?|theaters?|cinemas?|libraries|museums?|schools?|churches|mosques?|temples?|companies|businesses|organisations?|organizations?|providers?|firms?|establishments?|places?|email|phone|website|music|food|beer|wine|coffee|tea|dog|friendly|family|outdoor|indoor|seating|parking|wifi|vegan|vegetarian|organic|independent|chain|craft|real|ale|cask|micro|tap|room|free|house|sports?|cocktail|gastro|late|night|quiet|cosy|cozy|lively|romantic|scenic|budget|cheap|expensive|premium|luxury)\b/i;

  const words = trimmed.split(/\s+/);
  const recognisableCount = words.filter(w => COMMON_WORDS.test(w) || KNOWN_REGIONS.test(w) || /^\d+$/.test(w)).length;
  const ratio = recognisableCount / words.length;

  if (words.length >= 3 && ratio < 0.25) return true;

  if (words.length <= 2 && !/[a-zA-Z]{2,}/.test(trimmed)) return true;

  return false;
}

const TEMPORAL_DISQUALIFIERS = /\b(?:months?|years?|days?|weeks?|hours?|minutes?|ago|since|last|past|recent|recently|old|new|opened|closed|started|founded|established)\b/i;
const COUNT_NEAR_SEARCH = /\b(?:find|show|get|give me|list|pull|fetch|source|locate|discover|identify)\s+(\d+)\b/i;
const COUNT_BEFORE_NOUN = /\b(\d+)\s+(?!months?\b|years?\b|days?\b|weeks?\b|hours?\b|minutes?\b)\w+/i;

/** @deprecated Use canonical intent extractor instead. Only called as fallback when LLM extraction is unavailable. */
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

/** @deprecated Use canonical intent extractor instead. Only called as fallback when LLM extraction is unavailable. */
function extractTimeFilter(msg: string): string | null {
  const match = msg.match(TIME_FILTER_SIMPLE) || msg.match(TIME_FILTER_PATTERN);
  if (match) return match[0].trim();
  return null;
}

/** @deprecated Use canonical intent extractor instead. Only called as fallback when LLM extraction is unavailable. */
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

/** @deprecated Use canonical intent extractor instead. Only called as fallback when LLM extraction is unavailable. */
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

type LocationValidityFn = (location: string, entityType?: string | null) => Promise<{ verdict: 'real' | 'fictional' | 'ambiguous' | 'nonsense'; confidence: number; reason: string }>;
let _locationValidityOverride: LocationValidityFn | null = null;

export function _setLocationValidityOverride(fn: LocationValidityFn | null): void {
  _locationValidityOverride = fn;
}

export async function checkLocationValidity(location: string | null | undefined, entityType?: string | null): Promise<LocationValidity> {
  if (!location || !location.trim()) return 'unrecognised';
  const loc = location.trim();

  if (KNOWN_REGIONS.test(loc)) return 'recognised';

  const llmResult = _locationValidityOverride
    ? await _locationValidityOverride(loc, entityType)
    : await callLLMForLocationValidity(loc, entityType);
  console.log(`[CLARIFY_GATE] LLM location validity for "${loc}": verdict=${llmResult.verdict} confidence=${llmResult.confidence} reason="${llmResult.reason}"`);

  if (llmResult.verdict === 'fictional' || llmResult.verdict === 'nonsense') return 'fictional';
  if (llmResult.verdict === 'real') return 'recognised';
  if (llmResult.verdict === 'ambiguous') return 'unrecognised';

  return 'unrecognised';
}

export { extractBusinessType, extractLocation, extractCount, extractTimeFilter, hasMonitoringIntent };

export async function evaluateClarifyGate(userMessage: string): Promise<ClarifyGateResult> {
  const msg = userMessage.trim();

  if (!msg || msg.length === 0) {
    return {
      route: 'clarify_before_run',
      reason: 'Clarification needed: input is empty.',
      triggerCategory: 'empty',
      questions: ['It looks like your message was empty. What would you like me to search for?'],
      missingFields: [],
      parsedFields: { businessType: null, location: null, count: null, timeFilter: null },
    };
  }

  if (isDirectResponse(msg)) {
    return {
      route: 'direct_response',
      reason: 'Message is a question, explanation request, or meta/trust query — no agent execution needed.',
    };
  }

  if (isNonsenseInput(msg)) {
    return {
      route: 'clarify_before_run',
      reason: 'Clarification needed: input appears to be nonsense or unintelligible.',
      triggerCategory: 'malformed',
      questions: ['I couldn\'t understand that message. Could you rephrase what you\'re looking for? For example: "Find 10 pubs in Brighton"'],
      missingFields: [],
      parsedFields: { businessType: null, location: null, count: null, timeFilter: null },
    };
  }

  const malformed = isMalformedInput(msg);
  const mixed = hasMixedIntent(msg);

  if (malformed || mixed) {
    const questions: string[] = [];

    if (malformed) {
      questions.push('It looks like your message may contain multiple requests joined together. Could you separate them so I handle each one correctly?');
    }
    if (mixed && !malformed) {
      questions.push('Your message seems to contain more than one request. Could you tell me which one to tackle first?');
    }

    return {
      route: 'clarify_before_run',
      reason: `Clarification needed: ${malformed ? 'input appears malformed or contains multiple concatenated requests' : 'message contains multiple searches'}.`,
      triggerCategory: 'multiple_requests',
      questions: questions.slice(0, 3),
      missingFields: [],
      parsedFields: {
        businessType: extractBusinessType(msg),
        location: extractLocation(msg),
        count: extractCount(msg),
        timeFilter: extractTimeFilter(msg),
      },
    };
  }

  // CLARIFY_GATE_FIX: Check location validity for fictional/unrecognised locations
  const regexLoc = extractLocation(msg);
  if (regexLoc && hasSearchIntent(msg)) {
    const bt = extractBusinessType(msg);
    const locValidity = await checkLocationValidity(regexLoc, bt);
    if (locValidity === 'fictional') {
      console.log(`[CLARIFY_GATE] route=refuse — fictional location detected: "${regexLoc}"`);
      return {
        route: 'refuse',
        reason: `Refused: "${regexLoc}" is not a real location.`,
        triggerCategory: 'fictional_location',
        questions: [`"${regexLoc}" is not a real location. Please provide a real place — for example: "Find pubs in Brighton"`],
        parsedFields: {
          businessType: bt,
          location: regexLoc,
          count: extractCount(msg),
          timeFilter: extractTimeFilter(msg),
        },
      };
    }
  }

  if (hasMonitoringIntent(msg)) {
    const bt = extractBusinessType(msg);
    const loc = extractLocation(msg);
    const count = extractCount(msg);
    const timeFilter = extractTimeFilter(msg);
    console.log(`[CLARIFY_GATE] route=agent_run — monitoring verb detected (regex early exit) bt=${bt} loc=${loc}`);
    return {
      route: 'agent_run',
      reason: `Monitoring verb detected — proceeding with agent execution.`,
      parsedFields: {
        businessType: bt,
        location: loc,
        count,
        timeFilter,
      },
      semantic_source: 'fallback_regex',
    };
  }

  if (hasSearchIntent(msg) && isMissingLocation(msg) && !isGlobalByDesign(msg)) {
    const bt = extractBusinessType(msg);
    if (bt) {
      console.log(`[CLARIFY_GATE] route=clarify_before_run — entity discovery missing location (regex) bt=${bt}`);
      return {
        route: 'clarify_before_run',
        reason: 'Clarification needed: entity discovery query is missing a location constraint.',
        questions: ['Where should I search?'],
        missingFields: ['location'],
        parsedFields: {
          businessType: bt,
          location: null,
          count: extractCount(msg),
          timeFilter: extractTimeFilter(msg),
        },
      };
    }
  }

  return {
    route: 'agent_run',
    reason: 'Intent is clear and runnable — proceeding with agent execution.',
  };
}

// CLARIFY_GATE_FIX: Added options parameter for delegatedClarify signal
export async function evaluateClarifyGateFromIntent(intent: CanonicalIntent, rawMsg: string, options?: ClarifyGateOptions): Promise<ClarifyGateResult> {
  const msg = rawMsg.trim();

  if (intent.location_text?.trim()) {
    const locValidity = await checkLocationValidity(intent.location_text, intent.entity_category);
    if (locValidity === 'fictional') {
      const locName = intent.location_text.trim();
      const timeConstraintFict = intent.constraints.find(c => c.type === 'time');
      console.log(`[CLARIFY_GATE] semantic_source=canonical route=refuse — fictional location: "${locName}"`);
      return {
        route: 'refuse',
        reason: `Refused: "${locName}" is not a real location.`,
        triggerCategory: 'fictional_location',
        questions: [`"${locName}" is not a real location. Please provide a real place — for example: "Find pubs in Brighton"`],
        parsedFields: {
          businessType: intent.entity_category,
          location: locName,
          count: intent.requested_count,
          timeFilter: timeConstraintFict?.raw ?? null,
        },
        semantic_source: 'canonical',
      };
    }
  }

  if (intent.mission_type === 'monitor') {
    const timeConstraint = intent.constraints.find(c => c.type === 'time');
    console.log(`[CLARIFY_GATE] semantic_source=canonical route=agent_run mission_type=monitor (early exit)`);
    return {
      route: 'agent_run',
      reason: `Canonical intent mission_type=monitor — proceeding with agent execution.`,
      parsedFields: {
        businessType: intent.entity_category,
        location: intent.location_text,
        count: intent.requested_count,
        timeFilter: timeConstraint?.raw ?? null,
      },
      semantic_source: 'canonical',
    };
  }

  if (hasMonitoringIntent(msg)) {
    const timeConstraint = intent.constraints.find(c => c.type === 'time');
    console.log(`[CLARIFY_GATE] semantic_source=canonical route=agent_run — monitoring verb override (early exit, mission_type was ${intent.mission_type})`);
    return {
      route: 'agent_run',
      reason: `Monitoring verb detected in message — overriding mission_type=${intent.mission_type} — proceeding with agent execution.`,
      parsedFields: {
        businessType: intent.entity_category,
        location: intent.location_text,
        count: intent.requested_count,
        timeFilter: timeConstraint?.raw ?? null,
      },
      semantic_source: 'canonical',
    };
  }

  if (!msg || msg.length === 0) {
    return {
      route: 'clarify_before_run',
      reason: 'Clarification needed: input is empty.',
      triggerCategory: 'empty',
      questions: ['It looks like your message was empty. What would you like me to search for?'],
      missingFields: [],
      parsedFields: { businessType: null, location: null, count: null, timeFilter: null },
      semantic_source: 'canonical',
    };
  }

  if (isNonsenseInput(msg)) {
    return {
      route: 'clarify_before_run',
      reason: 'Clarification needed: input appears to be nonsense or unintelligible.',
      triggerCategory: 'malformed',
      questions: ['I couldn\'t understand that message. Could you rephrase what you\'re looking for? For example: "Find 10 pubs in Brighton"'],
      missingFields: [],
      parsedFields: { businessType: null, location: null, count: null, timeFilter: null },
      semantic_source: 'canonical',
    };
  }

  const malformed = isMalformedInput(msg);
  const mixed = hasMixedIntent(msg);
  if (malformed || mixed) {
    const questions: string[] = [];
    if (malformed) {
      questions.push('It looks like your message may contain multiple requests joined together. Could you separate them so I handle each one correctly?');
    }
    if (mixed && !malformed) {
      questions.push('Your message seems to contain more than one request. Could you tell me which one to tackle first?');
    }
    const timeConstraint = intent.constraints.find(c => c.type === 'time');
    return {
      route: 'clarify_before_run',
      reason: `Clarification needed: ${malformed ? 'input appears malformed or contains multiple concatenated requests' : 'message contains multiple searches'}.`,
      triggerCategory: 'multiple_requests',
      questions: questions.slice(0, 3),
      missingFields: [],
      parsedFields: {
        businessType: intent.entity_category,
        location: intent.location_text,
        count: intent.requested_count,
        timeFilter: timeConstraint?.raw ?? null,
      },
      semantic_source: 'canonical',
    };
  }

  if (intent.mission_type === 'explain' || intent.mission_type === 'meta_question') {
    console.log(`[CLARIFY_GATE] semantic_source=canonical route=direct_response mission_type=${intent.mission_type}`);
    return {
      route: 'direct_response',
      reason: `Canonical intent mission_type=${intent.mission_type} — no agent execution needed.`,
      semantic_source: 'canonical',
    };
  }

  if (intent.mission_type === 'unknown') {
    console.log(`[CLARIFY_GATE] semantic_source=canonical mission_type=unknown — falling back to regex`);
    const fallback = await evaluateClarifyGate(rawMsg);
    fallback.semantic_source = 'fallback_regex';
    return fallback;
  }

  if (
    (intent.mission_type === 'find_businesses' || intent.mission_type === 'deep_research') &&
    !intent.location_text?.trim() &&
    !isGlobalByDesign(msg)
  ) {
    const timeConstraint = intent.constraints.find(c => c.type === 'time');
    console.log(`[CLARIFY_GATE] semantic_source=canonical route=clarify_before_run — entity discovery missing location mission_type=${intent.mission_type}`);
    return {
      route: 'clarify_before_run',
      reason: 'Clarification needed: entity discovery query is missing a location constraint.',
      questions: ['Where should I search?'],
      missingFields: ['location'],
      parsedFields: {
        businessType: intent.entity_category,
        location: null,
        count: intent.requested_count,
        timeFilter: timeConstraint?.raw ?? null,
      },
      semantic_source: 'canonical',
    };
  }

  // CLARIFY_GATE_FIX: Check delegatedClarify + unrecognised location (fictional already caught above)
  if (intent.location_text?.trim() && options?.delegatedClarify) {
    const locValidity = await checkLocationValidity(intent.location_text, intent.entity_category);
    if (locValidity === 'unrecognised') {
      const locName = intent.location_text.trim();
      const timeConstraintLoc = intent.constraints.find(c => c.type === 'time');
      console.log(`[CLARIFY_GATE] semantic_source=canonical route=clarify_before_run — delegatedClarify + unrecognised location: "${locName}"`);
      return {
        route: 'clarify_before_run',
        reason: `Clarification needed: location "${locName}" is not recognised. ${options.delegatedClarifyReason || 'The router flagged this for clarification.'}`,
        triggerCategory: 'unrecognised_location',
        questions: [`I don't recognise "${locName}" as a location. Did you mean somewhere specific? Please provide a real place name.`],
        missingFields: ['location'],
        parsedFields: {
          businessType: intent.entity_category,
          location: locName,
          count: intent.requested_count,
          timeFilter: timeConstraintLoc?.raw ?? null,
        },
        semantic_source: 'canonical',
      };
    }
  }

  // CLARIFY_GATE_FIX: Honour delegatedClarify even without a location issue
  if (options?.delegatedClarify && !intent.location_text?.trim()) {
    const timeConstraintDel = intent.constraints.find(c => c.type === 'time');
    console.log(`[CLARIFY_GATE] semantic_source=canonical route=clarify_before_run — delegatedClarify honoured (no location)`);
    return {
      route: 'clarify_before_run',
      reason: `Clarification needed: ${options.delegatedClarifyReason || 'The router flagged this request for clarification.'}`,
      questions: ['Where should I search?'],
      missingFields: ['location'],
      parsedFields: {
        businessType: intent.entity_category,
        location: null,
        count: intent.requested_count,
        timeFilter: timeConstraintDel?.raw ?? null,
      },
      semantic_source: 'canonical',
    };
  }

  const timeConstraint = intent.constraints.find(c => c.type === 'time');
  console.log(`[CLARIFY_GATE] semantic_source=canonical route=agent_run mission_type=${intent.mission_type}`);
  return {
    route: 'agent_run',
    reason: `Canonical intent mission_type=${intent.mission_type} — proceeding with agent execution.`,
    parsedFields: {
      businessType: intent.entity_category,
      location: intent.location_text,
      count: intent.requested_count,
      timeFilter: timeConstraint?.raw ?? null,
    },
    semantic_source: 'canonical',
  };
}
