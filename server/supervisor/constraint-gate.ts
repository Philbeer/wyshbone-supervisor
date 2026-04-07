// Pre-Execution Constraint Gate
// Runs BEFORE any tool execution, Google search, or SEARCH_PLACES call.
// Supervisor is the sole authority for constraint interpretation and verifiability.
// If any HARD constraint is unresolved, can_execute MUST be false.

import {
  type TimePredicateContract,
  type Hardness,
  buildTimePredicateContract,
  resolveProxyChoice,
  detectTimePredicate,
  inferHardness,
} from './time-predicate';

import {
  detectRelationshipPredicate,
  detectRelationshipRole,
} from './relationship-predicate';

import type { CanonicalIntent, CanonicalConstraint } from './canonical-intent';

export type LiveMusicVerification = 'website_verify' | 'best_effort' | null;
export type TimePredicateResolution = 'news_mention' | 'recent_reviews' | 'best_effort' | null;

export type AttributeClassification = 'TOOL_CHECKABLE' | 'SUBJECTIVE_UNDEFINED' | 'MISSING_NUMERIC_THRESHOLD' | 'BLOCKING';

export interface AttributeConstraint {
  type: 'attribute';
  attribute: string;
  classification: AttributeClassification;
  verifiability: 'verifiable' | 'proxy' | 'unverifiable';
  requires_clarification: boolean;
  chosen_verification: LiveMusicVerification;
  hardness: Hardness;
  must_be_certain?: boolean;
  keyword_variants?: string[];
}

export interface SubjectivePredicateConstraint {
  type: 'subjective_predicate';
  label: string;
  verifiability: 'unverifiable';
  hardness: 'soft';
  required_inputs_missing: string[];
  can_execute: boolean;
  why_blocked: string;
  suggested_rephrase: string | null;
  clarification_options: string[];
}

export type NumericAmbiguityCategory = 'fuzzy_quantity' | 'ranking' | 'numeric_adjective';

export interface NumericAmbiguityConstraint {
  type: 'numeric_ambiguity';
  label: string;
  category: NumericAmbiguityCategory;
  verifiability: 'unverifiable';
  hardness: 'soft';
  can_execute: boolean;
  why_blocked: string;
  clarification_question: string;
  must_be_certain?: boolean;
}

export type RelationshipStrategy = 'official_only' | 'best_effort_web' | 'two_plus_sources' | 'skip_if_uncertain' | null;

export interface RelationshipPredicateConstraint {
  type: 'relationship_predicate';
  label: string;
  detected_role: string | null;
  detected_predicate: string | null;
  verifiability: 'proxy';
  hardness: 'soft';
  can_execute: boolean;
  why_blocked: string;
  clarify_question: string;
  chosen_relationship_strategy: RelationshipStrategy;
  must_be_certain?: boolean;
}

export type Constraint = TimePredicateContract | AttributeConstraint | SubjectivePredicateConstraint | NumericAmbiguityConstraint | RelationshipPredicateConstraint;

export type SemanticSource = 'canonical' | 'fallback_regex';

export interface ConstraintContract {
  constraints: Constraint[];
  can_execute: boolean;
  why_blocked: string | null;
  clarify_questions: string[];
  stop_recommended: boolean;
  semantic_source?: SemanticSource;
}

export interface PendingConstraintState {
  conversationId: string;
  originalMessage: string;
  contract: ConstraintContract;
  originRunId: string | null;
  createdAt: number;
}

const pendingContracts = new Map<string, PendingConstraintState>();
const PENDING_TTL_MS = 15 * 60 * 1000;

const SUBJECTIVE_TERMS_PATTERN = /\b(?:best\s+rated|best\s+places|coolest|nicest|nicer|most\s+fun|most\s+popular|most\s+interesting|greatest|finest|ultimate|amazing|awesome|incredible|fantastic|perfect|ideal|favourite|favorite|chillest|trendiest|hippest|dopest|sickest|vibes?|vibe-?y|vibey|nice|good\s+atmosphere|great\s+atmosphere|great(?!\s+(?:for|at|with))|cool(?!est)|lovely|decent|chill(?!est)|good(?!\s+(?:for\s+studying|guinness|beer))|popular|fancy|high[- ]?end|recommended|quality|trendy|better)\b/gi;

const MEASURABLE_CRITERIA_PATTERN = /\b(?:live\s*music|craft\s*beer|real\s*ale|cask\s*ale|dog\s*friendly|family\s*friendly|late[- ]?\s*night|open\s*late|cheap|budget|expensive|premium|cosy|cozy|quiet|outdoor\s*seating|beer\s*garden|rooftop|waterfront|riverside|seafront|free\s*wifi|wheelchair|accessible|parking|vegan|vegetarian|gluten\s*free|halal|kosher|organic|independent|chain|gastropub|wine\s*bar|cocktail\s*bar|sports?\s*bar|micro\s*pub|tap\s*room|free\s*house|food\s*served|nightlife|lively|romantic|walkable|events|student|views|scenic|good\s+for\s+studying|good\s+guinness|good\s+beer|has\s+food|near\s+\w|within\s+\d+\s*(?:miles?|km|minutes?)|4\.\d\s*stars?|\d+\s*stars?)\b/i;

const SUBJECTIVE_CLARIFICATION_OPTIONS = [
  'Lively', 'Quiet', 'Cosy', 'Late-night', 'Live music',
  'Good for food', 'Beer garden', 'Dog friendly',
];

const MEASURABLE_FOLLOW_UP_PATTERN = /\b(?:lively|quiet|cosy|cozy|late[- ]?\s*night|open\s*late|live\s*music|good\s+for\s+food|food\s+served|beer\s*garden|dog\s*friendly|family\s*friendly|craft\s*beer|real\s*ale|rooftop|outdoor\s*seating|cocktail|cheap|budget|romantic|student|walkable|scenic|views|events|nightlife|sports?\s*bar|wheelchair|accessible)\b/i;

const FUZZY_QUANTITY_PATTERN = /\b(?:a\s+few|few|many|most|several|loads\s+of|lots\s+of|bunch\s+of|handful\s+of|plenty\s+of|numerous|some(?!\s+(?:of\s+the|kind|type|sort)))\b/i;

const RANKING_WITHOUT_COUNT_PATTERN = /\b(top|best)(?!\s+\d)\b/i;

const RANKING_WITH_COUNT_PATTERN = /\b(?:top|best)\s+\d+\b/i;

const RANKING_EXCLUSION_PATTERN = /\b(?:best\s+rated|best\s+places)\b/i;

const NUMERIC_ADJECTIVE_PATTERN = /\b(?:cheap|expensive|large|big|small|tiny|huge)\b/i;

const NUMERIC_ADJECTIVE_WITH_THRESHOLD_PATTERN = /\b(?:under|over|less\s+than|more\s+than|at\s+least|at\s+most|max(?:imum)?|min(?:imum)?)\s*[£$€]?\s*\d/i;

const HAS_COUNT_PATTERN = /\b\d+\b/;
const HAS_THRESHOLD_PATTERN = /(?:[£$€]\s*\d|\b\d+\s*(?:pound|£|quid|dollar|\$|euro|€)|under\s+[£$€]?\s*\d|over\s+[£$€]?\s*\d|less\s+than\s+[£$€]?\s*\d|more\s+than\s+[£$€]?\s*\d|at\s+least\s+[£$€]?\s*\d|at\s+most\s+[£$€]?\s*\d|\b\d+\s*(?:sq\s*ft|sqm|m²|seats?|capacity|people|covers|square))/i;

function followUpResolvesNumericCategory(followUpMsg: string, category: NumericAmbiguityCategory): boolean {
  const hasCount = HAS_COUNT_PATTERN.test(followUpMsg);
  switch (category) {
    case 'fuzzy_quantity':
      return hasCount;
    case 'ranking':
      return hasCount;
    case 'numeric_adjective':
      return HAS_THRESHOLD_PATTERN.test(followUpMsg);
    default:
      return false;
  }
}

function buildNumericAmbiguityQuestion(label: string, category: NumericAmbiguityCategory): string {
  if (category === 'fuzzy_quantity') {
    return `You said '${label}' — how many exactly? Give me a specific number (e.g. 5, 10, 20).`;
  }
  if (category === 'ranking') {
    return `'${label}' by what measure, and how many? (e.g. top 5 by rating, best 10 by reviews)`;
  }
  return `What does '${label}' mean to you? Give me a specific threshold (e.g. under £10 per meal, under £5 per pint).`;
}

function extractNumericAmbiguity(msg: string): NumericAmbiguityConstraint | null {
  const hasThreshold = NUMERIC_ADJECTIVE_WITH_THRESHOLD_PATTERN.test(msg);

  const fuzzyMatch = msg.match(FUZZY_QUANTITY_PATTERN);
  if (fuzzyMatch) {
    const label = fuzzyMatch[0].trim().toLowerCase();
    return {
      type: 'numeric_ambiguity',
      label,
      category: 'fuzzy_quantity',
      verifiability: 'unverifiable',
      hardness: 'soft',
      can_execute: false,
      why_blocked: 'This request uses an undefined quantity or ranking',
      clarification_question: buildNumericAmbiguityQuestion(label, 'fuzzy_quantity'),
    };
  }

  if (RANKING_WITHOUT_COUNT_PATTERN.test(msg) && !RANKING_WITH_COUNT_PATTERN.test(msg) && !RANKING_EXCLUSION_PATTERN.test(msg)) {
    const rankMatch = msg.match(RANKING_WITHOUT_COUNT_PATTERN);
    const label = rankMatch![0].trim().toLowerCase();
    return {
      type: 'numeric_ambiguity',
      label,
      category: 'ranking',
      verifiability: 'unverifiable',
      hardness: 'soft',
      can_execute: false,
      why_blocked: 'This request uses an undefined quantity or ranking',
      clarification_question: buildNumericAmbiguityQuestion(label, 'ranking'),
    };
  }

  const adjMatch = msg.match(NUMERIC_ADJECTIVE_PATTERN);
  if (adjMatch && !hasThreshold) {
    const label = adjMatch[0].trim().toLowerCase();
    return {
      type: 'numeric_ambiguity',
      label,
      category: 'numeric_adjective',
      verifiability: 'unverifiable',
      hardness: 'soft',
      can_execute: false,
      why_blocked: 'This request uses an undefined quantity or ranking',
      clarification_question: buildNumericAmbiguityQuestion(label, 'numeric_adjective'),
    };
  }

  return null;
}

const RELATIONSHIP_CLARIFY_QUESTION = `Relationship information (e.g. owner, landlord, manager) is not reliably available from public business listings. Which approach would you like?\n\nA) Official sources only — highest certainty, fewer results\nB) Best-effort public web — more results, lower certainty\nC) Require 2+ independent sources per relationship claim\nD) Skip relationship fields if uncertain — return venues only`;

function extractRelationshipPredicate(msg: string): RelationshipPredicateConstraint | null {
  const predResult = detectRelationshipPredicate(msg);
  const roleResult = detectRelationshipRole(msg);

  if (!predResult.requires_relationship_evidence && !roleResult.detected) return null;

  const label = predResult.detected_predicate || roleResult.role || 'relationship';

  return {
    type: 'relationship_predicate',
    label,
    detected_role: roleResult.role,
    detected_predicate: predResult.detected_predicate,
    verifiability: 'proxy',
    hardness: 'soft',
    can_execute: false,
    why_blocked: 'Relationship information (owner, landlord, manager, etc.) is not reliably available from public business listings.',
    clarify_question: RELATIONSHIP_CLARIFY_QUESTION,
    chosen_relationship_strategy: null,
  };
}

const RELATIONSHIP_STRATEGY_PATTERNS: { pattern: RegExp; strategy: RelationshipStrategy }[] = [
  { pattern: /\boption\s*[Aa]\b/i, strategy: 'official_only' },
  { pattern: /\bofficial\s+(?:sources?\s+)?only\b/i, strategy: 'official_only' },
  { pattern: /\bresearch\s+each\s+(?:result|lead)\s+individually\b/i, strategy: 'official_only' },
  { pattern: /\boption\s*[Bb]\b/i, strategy: 'best_effort_web' },
  { pattern: /\bbest[- ]?effort\s+(?:public\s+)?web\b/i, strategy: 'best_effort_web' },
  { pattern: /\bkeyword[- ]?based\s+filter/i, strategy: 'best_effort_web' },
  { pattern: /\boption\s*[Cc]\b/i, strategy: 'two_plus_sources' },
  { pattern: /\b2\+?\s*(?:independent\s+)?sources?\b/i, strategy: 'two_plus_sources' },
  { pattern: /\btwo\s+(?:independent\s+)?sources?\b/i, strategy: 'two_plus_sources' },
  { pattern: /\boption\s*[Dd]\b/i, strategy: 'skip_if_uncertain' },
  { pattern: /\bskip\s+(?:relationship\s+)?(?:fields?\s+)?if\s+uncertain\b/i, strategy: 'skip_if_uncertain' },
  { pattern: /\bskip\s+(?:if\s+)?uncertain\b/i, strategy: 'skip_if_uncertain' },
  { pattern: /\bskip\s+this\s+filter\b/i, strategy: 'skip_if_uncertain' },
  { pattern: /\breturn\s+all\s+results?\b/i, strategy: 'skip_if_uncertain' },
  { pattern: /\breturn\s+venues?\s+only\b/i, strategy: 'skip_if_uncertain' },
  { pattern: /\bvenues?\s+only\b/i, strategy: 'skip_if_uncertain' },
  { pattern: /\breturn\s+all\b/i, strategy: 'skip_if_uncertain' },
  { pattern: /\bdon'?t\s+filter\b/i, strategy: 'skip_if_uncertain' },
  { pattern: /\bno\s+filter/i, strategy: 'skip_if_uncertain' },
  { pattern: /\bremove\s+(?:this\s+)?(?:filter|constraint)\b/i, strategy: 'skip_if_uncertain' },
  { pattern: /^[Aa]\s*\)\s*/i, strategy: 'official_only' },
  { pattern: /^[Bb]\s*\)\s*/i, strategy: 'best_effort_web' },
  { pattern: /^[Cc]\s*\)\s*/i, strategy: 'two_plus_sources' },
  { pattern: /^[Dd]\s*\)\s*/i, strategy: 'skip_if_uncertain' },
  { pattern: /^\s*skip\s*$/i, strategy: 'skip_if_uncertain' },
];

export function detectRelationshipStrategyChoice(msg: string): RelationshipStrategy {
  for (const entry of RELATIONSHIP_STRATEGY_PATTERNS) {
    if (entry.pattern.test(msg)) return entry.strategy;
  }
  return null;
}

export function detectSubjectiveTerms(text: string): string[] {
  const matches = text.match(SUBJECTIVE_TERMS_PATTERN);
  if (!matches) return [];
  const unique = [...new Set(matches.map(m => m.trim().toLowerCase()))];
  return unique;
}

export function hasMeasurableCriteria(text: string): boolean {
  return MEASURABLE_CRITERIA_PATTERN.test(text);
}

function extractLocationFromMsg(msg: string): string | null {
  const locMatch = msg.match(/\bin\s+([A-Za-z][a-zA-Z.\s]+?)(?:\s+(?:that|which|with|and)\b|$)/i);
  return locMatch ? locMatch[1].trim() : null;
}

function buildSuggestedRephrases(labels: string[], msg: string): string[] {
  const location = extractLocationFromMsg(msg);
  const locSuffix = location ? ` in ${location}` : '';
  const entityMatch = msg.match(/\b(bars?|pubs?|cafes?|restaurants?|shops?|venues?)\b/i);
  const entity = entityMatch ? entityMatch[1].toLowerCase() : 'bars';
  return [
    `Find lively ${entity}${locSuffix}`,
    `Find cosy ${entity}${locSuffix} with live music`,
  ];
}

function extractSubjectivePredicate(msg: string): SubjectivePredicateConstraint | null {
  const terms = detectSubjectiveTerms(msg);
  if (terms.length === 0) return null;
  const label = terms.join(', ');
  const required_inputs_missing = terms.map(t => `definition_of_${t.replace(/\s+/g, '_')}`);
  const rephrases = buildSuggestedRephrases(terms, msg);
  return {
    type: 'subjective_predicate',
    label,
    verifiability: 'unverifiable',
    hardness: 'soft',
    required_inputs_missing,
    can_execute: false,
    why_blocked: `This request uses a subjective term that needs clarification`,
    suggested_rephrase: rephrases.join(' | '),
    clarification_options: SUBJECTIVE_CLARIFICATION_OPTIONS,
  };
}

const BLOCKING_ATTRIBUTES = new Set(['live_music']);

const ATTRIBUTE_PATTERNS: { pattern: RegExp; attribute: string }[] = [
  { pattern: /\b(?:have|has|with|offer(?:s|ing)?|featuring?)\s+live\s*music\b/i, attribute: 'live_music' },
  { pattern: /\blive\s*music\b/i, attribute: 'live_music' },
  { pattern: /\b(?:have|has|with|offer(?:s|ing)?|featuring?)\s+craft\s*beer\b/i, attribute: 'craft_beer' },
  { pattern: /\bcraft\s*beer\b/i, attribute: 'craft_beer' },
  { pattern: /\b(?:have|has|with|offer(?:s|ing)?|featuring?)\s+real\s*ale\b/i, attribute: 'real_ale' },
  { pattern: /\breal\s*ale\b/i, attribute: 'real_ale' },
  { pattern: /\b(?:have|has|with|offer(?:s|ing)?|featuring?)\s+(?:a\s+)?beer\s*garden\b/i, attribute: 'beer_garden' },
  { pattern: /\bbeer\s*garden\b/i, attribute: 'beer_garden' },
  { pattern: /\b(?:have|has|with|offer(?:s|ing)?|featuring?)\s+outdoor\s*seating\b/i, attribute: 'outdoor_seating' },
  { pattern: /\boutdoor\s*seating\b/i, attribute: 'outdoor_seating' },
  { pattern: /\b(?:have|has|with|offer(?:s|ing)?|featuring?)\s+(?:a\s+)?rooftop\b/i, attribute: 'rooftop' },
  { pattern: /\brooftop\b/i, attribute: 'rooftop' },
  { pattern: /\bdog\s*friendly\b/i, attribute: 'dog_friendly' },
  { pattern: /\bfamily\s*friendly\b/i, attribute: 'family_friendly' },
  { pattern: /\bfree\s*wifi\b/i, attribute: 'free_wifi' },
  { pattern: /\bwheelchair\s*accessible\b/i, attribute: 'wheelchair_accessible' },
  { pattern: /\bparking\b/i, attribute: 'parking' },
  { pattern: /\bvegan\b/i, attribute: 'vegan' },
  { pattern: /\bvegetarian\b/i, attribute: 'vegetarian' },
  { pattern: /\bfood\s*served\b/i, attribute: 'food_served' },
  { pattern: /\blate[- ]?\s*night\b/i, attribute: 'late_night' },
];

const NO_PROXY_PATTERNS = /\b(?:no\s+prox(?:y|ies)|no\s+approximation|don'?t\s+use\s+(?:any\s+)?prox(?:y|ies)|without\s+prox(?:y|ies)|don'?t\s+guess)\b/i;

const PROXY_SELECTION_PATTERNS: { pattern: RegExp; proxyId: string }[] = [
  { pattern: /\b(?:use|accept|try|go\s+with|pick|choose|select)\s+(?:the\s+)?(?:first\s+)?(?:recent\s*)?reviews?\s*(?:proxy)?\b/i, proxyId: 'recent_reviews' },
  { pattern: /\b(?:use|accept|try|go\s+with|pick|choose|select)\s+(?:the\s+)?(?:first\s+)?news\s*(?:mention)?\s*(?:proxy)?\b/i, proxyId: 'news_mention' },
  { pattern: /\brecent\s*reviews?\s*(?:proxy|option|method)?\b/i, proxyId: 'recent_reviews' },
  { pattern: /\bnews\s*mentions?\s*(?:proxy|option|method)?\b/i, proxyId: 'news_mention' },
  { pattern: /\boption\s*[Aa]\b/i, proxyId: 'news_mention' },
  { pattern: /\boption\s*[Bb]\b/i, proxyId: 'recent_reviews' },
  { pattern: /\bfirst\s+(?:option|one|proxy)\b/i, proxyId: 'news_mention' },
  { pattern: /\bsecond\s+(?:option|one|proxy)\b/i, proxyId: 'recent_reviews' },
  { pattern: /\b[Aa]\b\)?.*news/i, proxyId: 'news_mention' },
  { pattern: /\b[Bb]\b\)?.*reviews?/i, proxyId: 'recent_reviews' },
  { pattern: /^[Aa]\s*\)\s*$/i, proxyId: 'news_mention' },
  { pattern: /^[Bb]\s*\)\s*$/i, proxyId: 'recent_reviews' },
];

const BEST_EFFORT_PATTERNS = /\b(?:best[- ]?effort|unverified\s+(?:is\s+)?(?:ok|fine|acceptable|good)|don'?t\s+(?:need\s+to\s+)?verify|skip\s+verif|proceed\s+(?:unverified|without\s+verif)|that'?s?\s+(?:ok|fine)|option\s*(?:3|three|[Cc])\b|[Cc]\))/i;

const LIVE_MUSIC_VERIFY_PATTERNS = /(?:\bverify\s+(?:[\w\s]*?)(?:via|through|using)\s+(?:website|listings?|web)\b|\bverify\s+via\s+(?:website|listings?|web)\b|\bcheck\s+(?:website|listings?)\b|\bwebsite\s+verif|\boption\s*(?:1|one)\b|\b[Aa]\b\s*\)|\b[Aa]\b\s*(?:for\s+live)|\bon\s+(?:their|the)\s+website\b|\bsay\s+(?:they\s+)?(?:have|offer|do)\b.*\bon\s+(?:their|the)\s+website\b|\bfrom\s+(?:their|the)\s+website\b|\baccording\s+to\s+(?:their|the)\s+website\b|\bwebsite\s+(?:says?|mentions?|lists?|shows?)\b)/i;
const LIVE_MUSIC_BEST_EFFORT_PATTERNS = /(?:\bbest[- ]?effort\b|\bunverified\s+(?:is\s+)?(?:ok|fine|acceptable|good)\b|\bdon'?t\s+(?:need\s+to\s+)?verify\b|\bskip\s+verif|\boption\s*(?:2|two)\b|\b[Bb]\b\s*\)|\b[Bb]\b\s*(?:for\s+live))/i;

const GENERIC_ATTRIBUTE_PATTERNS = [
  /\b(?:that|which)\s+(?:serve|serves|offer|offers|have|has|provide|provides|feature|features|include|includes)\s+(.+?)(?:\s+(?:in|near|around|across|throughout|within)\b|$)/i,
  /\b(?:with|offering|serving|featuring|providing|including)\s+(.+?)(?:\s+(?:in|near|around|across|throughout|within)\b|$)/i,
  /\b(?:that|which)\s+(?:are|is)\s+(.+?)(?:\s+(?:in|near|around|across|throughout|within)\b|$)/i,
];

const COMMON_ATTRIBUTE_SYNONYMS: Record<string, string[]> = {
  'air conditioning': ['air con', 'a/c', 'ac', 'climate control', 'air conditioned', 'air-conditioned', 'air-conditioning'],
  'serve food': ['food served', 'food available', 'serves food', 'food menu', 'kitchen', 'dining', 'meals', 'lunch', 'dinner'],
  'food': ['food served', 'food available', 'serves food', 'food menu', 'kitchen', 'dining', 'meals', 'lunch', 'dinner', 'gastropub', 'restaurant'],
  'parking': ['car park', 'car parking', 'free parking', 'on-site parking', 'parking available', 'parking lot'],
  'wifi': ['wi-fi', 'free wifi', 'free wi-fi', 'wireless internet', 'internet access'],
  'free wifi': ['wi-fi', 'free wi-fi', 'wireless internet', 'internet access', 'complimentary wifi'],
  'wheelchair accessible': ['wheelchair access', 'disabled access', 'step-free', 'accessibility', 'accessible entrance'],
  'dog friendly': ['dogs welcome', 'dog-friendly', 'well-behaved dogs', 'four-legged friends', 'pets welcome'],
  'family friendly': ['family-friendly', 'child friendly', 'children welcome', 'kids welcome', 'family pub', 'family restaurant'],
  'beer garden': ['outdoor seating area', 'garden terrace', 'patio', 'beer patio', 'outside seating'],
  'outdoor seating': ['outdoor area', 'outside seating', 'terrace', 'patio', 'al fresco', 'garden seating'],
  'live music': ['live band', 'live bands', 'open mic', 'gigs', 'gig', 'music night', 'music nights', 'live entertainment', 'live acoustic'],
  'craft beer': ['craft ales', 'craft brewery', 'microbrewery', 'artisan beer', 'indie beer'],
  'real ale': ['cask ale', 'cask beer', 'real ales', 'hand-pulled', 'traditional ale'],
  'rooftop': ['rooftop bar', 'rooftop terrace', 'sky bar', 'rooftop seating'],
  'vegan': ['vegan options', 'vegan menu', 'plant-based', 'vegan food', 'vegan friendly'],
  'vegetarian': ['vegetarian options', 'vegetarian menu', 'veggie options', 'veggie menu'],
  'gluten free': ['gluten-free', 'coeliac friendly', 'celiac friendly', 'gluten free options'],
  'late night': ['late-night', 'open late', 'late opening', 'late bar', 'late licence', 'late license'],
  'pool table': ['pool tables', 'billiards', 'snooker'],
  'function room': ['function rooms', 'private room', 'private dining', 'event space', 'hire'],
  'karaoke': ['karaoke night', 'karaoke nights', 'sing-along'],
};

const PURE_SUBJECTIVE_PATTERN = /^(?:best|top|nicest|coolest|greatest|finest|most\s+\w+|favourite|favorite|ideal|perfect|amazing|awesome|incredible|fantastic|ultimate|chillest|trendiest|hippest|recommended|quality|nice|good|great|lovely|decent|popular|trendy|fancy|better|chill|cool|vibes?|vibey|vibe-?y)$/i;

export function classifyAttribute(raw: string): AttributeClassification {
  const trimmed = raw.trim().toLowerCase();
  if (PURE_SUBJECTIVE_PATTERN.test(trimmed)) return 'SUBJECTIVE_UNDEFINED';
  if (/^(?:cheap|expensive|budget|premium|high[- ]?end)$/i.test(trimmed) && !/[£$€\d]/.test(trimmed)) return 'MISSING_NUMERIC_THRESHOLD';
  return 'TOOL_CHECKABLE';
}

export function generateKeywordVariants(attrRaw: string): string[] {
  const base = attrRaw.toLowerCase().trim().replace(/[''""]/g, '');
  const variants = new Set<string>();
  variants.add(base);

  const stripped = base.replace(/[^a-z0-9\s&/-]/g, '').trim();
  if (stripped && stripped !== base) variants.add(stripped);

  const hyphenToSpace = base.replace(/-/g, ' ');
  if (hyphenToSpace !== base) variants.add(hyphenToSpace);

  const spaceToHyphen = base.replace(/\s+/g, '-');
  if (spaceToHyphen !== base) variants.add(spaceToHyphen);

  const withAnd = base.replace(/\s*&\s*/g, ' and ');
  if (withAnd !== base) variants.add(withAnd);

  const withAmpersand = base.replace(/\s+and\s+/gi, ' & ');
  if (withAmpersand !== base) variants.add(withAmpersand);

  const noSpaces = base.replace(/\s+/g, '');
  if (noSpaces !== base && noSpaces.length > 3) variants.add(noSpaces);

  const words = base.split(/\s+/);
  if (words.length > 0) {
    const lastWord = words[words.length - 1];
    const prefix = words.slice(0, -1).join(' ');
    const prefixStr = prefix ? prefix + ' ' : '';
    if (lastWord.endsWith('s') && lastWord.length > 2) {
      const singular = lastWord.slice(0, -1);
      variants.add(prefixStr + singular);
      if (lastWord.endsWith('ies')) {
        variants.add(prefixStr + lastWord.slice(0, -3) + 'y');
      }
    } else if (lastWord.length > 1) {
      variants.add(prefixStr + lastWord + 's');
      if (lastWord.endsWith('y')) {
        variants.add(prefixStr + lastWord.slice(0, -1) + 'ies');
      }
    }
  }

  const synonyms = COMMON_ATTRIBUTE_SYNONYMS[base] || COMMON_ATTRIBUTE_SYNONYMS[base.replace(/_/g, ' ')] || [];
  for (const syn of synonyms) variants.add(syn);

  return Array.from(variants);
}

function extractGenericAttributes(msg: string, alreadyFound: Set<string>): { attribute: string; raw: string }[] {
  const results: { attribute: string; raw: string }[] = [];

  for (const pattern of GENERIC_ATTRIBUTE_PATTERNS) {
    const match = msg.match(pattern);
    if (!match || !match[1]) continue;

    let raw = match[1].trim();
    raw = raw.replace(/\b(?:please|thanks|thank you|for me)\b/gi, '').trim();
    raw = raw.replace(/\s+(?:that|which|who)\s+.*$/i, '').trim();
    raw = raw.replace(/,\s+(?:and\s+)?(?:also|too)\b.*$/i, '').trim();

    if (!raw || raw.length < 2 || raw.length > 60) continue;

    const normalized = raw.toLowerCase().replace(/\s+/g, '_');
    if (alreadyFound.has(normalized)) continue;

    if (SUBJECTIVE_TERMS_PATTERN.test(raw) && !MEASURABLE_CRITERIA_PATTERN.test(raw)) continue;

    alreadyFound.add(normalized);
    results.push({ attribute: normalized, raw });
  }

  return results;
}

export function extractAttributes(msg: string): AttributeConstraint[] {
  const found = new Set<string>();
  const result: AttributeConstraint[] = [];

  for (const entry of ATTRIBUTE_PATTERNS) {
    if (entry.pattern.test(msg) && !found.has(entry.attribute)) {
      found.add(entry.attribute);
      const isBlocking = BLOCKING_ATTRIBUTES.has(entry.attribute);
      const classification: AttributeClassification = isBlocking ? 'TOOL_CHECKABLE' : 'TOOL_CHECKABLE';
      result.push({
        type: 'attribute',
        attribute: entry.attribute,
        classification,
        verifiability: isBlocking ? 'proxy' : 'verifiable',
        requires_clarification: isBlocking,
        chosen_verification: null,
        hardness: inferHardness(msg),
        keyword_variants: generateKeywordVariants(entry.attribute.replace(/_/g, ' ')),
      });
    }
  }

  const genericAttrs = extractGenericAttributes(msg, found);
  for (const ga of genericAttrs) {
    const classification = classifyAttribute(ga.raw);
    if (classification === 'SUBJECTIVE_UNDEFINED' || classification === 'MISSING_NUMERIC_THRESHOLD') continue;
    result.push({
      type: 'attribute',
      attribute: ga.attribute,
      classification,
      verifiability: 'verifiable',
      requires_clarification: false,
      chosen_verification: null,
      hardness: inferHardness(msg),
      keyword_variants: generateKeywordVariants(ga.raw),
    });
  }

  return result;
}

export function extractAllConstraints(msg: string): Constraint[] {
  const constraints: Constraint[] = [];

  const subjectivePredicate = extractSubjectivePredicate(msg);
  if (subjectivePredicate) {
    constraints.push(subjectivePredicate);
  }

  const numericAmbiguity = extractNumericAmbiguity(msg);
  if (numericAmbiguity) {
    constraints.push(numericAmbiguity);
  }

  const relationshipPred = extractRelationshipPredicate(msg);
  if (relationshipPred) {
    constraints.push(relationshipPred);
  }

  const timePredicate = buildTimePredicateContract(msg);
  if (timePredicate) {
    constraints.push(timePredicate);
  }

  const attributes = extractAttributes(msg);
  for (const attr of attributes) {
    constraints.push(attr);
  }

  return constraints;
}

export function detectNoProxySignal(msg: string): boolean {
  return NO_PROXY_PATTERNS.test(msg);
}

const MUST_BE_CERTAIN_PATTERNS = /\b(?:must\s+be\s+certain|must\s+be\s+(?:guaranteed|verified|exact|accurate|sure)|need\s+(?:to\s+be\s+)?certain|require\s+certainty|has\s+to\s+be\s+certain|i\s+need\s+certainty|certain(?:ty)?\s+(?:is\s+)?required|only\s+if\s+(?:you'?re|it'?s)\s+certain)\b/i;

export function detectMustBeCertain(msg: string): boolean {
  return MUST_BE_CERTAIN_PATTERNS.test(msg);
}

export function isCertainVerifiable(constraint: Constraint): boolean {
  if (constraint.type === 'time_predicate') {
    return false;
  }
  if (constraint.type === 'attribute' && constraint.attribute === 'live_music') {
    return false;
  }
  if (constraint.verifiability === 'verifiable') {
    return true;
  }
  return false;
}

export function applyCertaintyGate(contract: ConstraintContract): ConstraintContract {
  const hasUnresolvedSubjective = contract.constraints.some(c => isSubjectivePredicateUnresolved(c));
  if (hasUnresolvedSubjective) return contract;
  const hasUnresolvedNumeric = contract.constraints.some(c => isNumericAmbiguityUnresolved(c));
  if (hasUnresolvedNumeric) return contract;

  const blocked = contract.constraints.filter(c => c.must_be_certain && !isCertainVerifiable(c));
  if (blocked.length === 0) return contract;

  const reasons = blocked.map(c => {
    if (c.type === 'time_predicate') {
      return `"${c.predicate}" — opening dates cannot be verified with certainty from any available data source`;
    }
    if (c.type === 'attribute') {
      return `"${c.attribute}" — this attribute cannot be strictly verified from public listings data`;
    }
    return `unknown constraint cannot be verified`;
  });

  for (const c of contract.constraints) {
    if (c.must_be_certain && !isCertainVerifiable(c)) {
      c.can_execute = false;
      c.hardness = 'hard';
      c.verifiability = 'unverifiable';
      if (c.type === 'time_predicate') {
        c.why_blocked = 'User requires certainty but opening dates cannot be verified.';
        c.suggested_rephrase = null;
      }
    }
  }

  return {
    ...contract,
    can_execute: false,
    stop_recommended: true,
    why_blocked: `You asked for certainty, but I can't guarantee the following with public data:\n• ${reasons.join('\n• ')}\n\nAlternatives: accept a proxy (news mentions or recent reviews as evidence), use best-effort (unverified), or remove the constraint.`,
    clarify_questions: [],
  };
}

export function detectProxySelection(msg: string): string | null {
  if (BEST_EFFORT_PATTERNS.test(msg)) return null;

  for (const entry of PROXY_SELECTION_PATTERNS) {
    if (entry.pattern.test(msg)) {
      return entry.proxyId;
    }
  }
  return null;
}

export function detectBestEffort(msg: string): boolean {
  return BEST_EFFORT_PATTERNS.test(msg);
}

export function detectLiveMusicChoice(msg: string): LiveMusicVerification {
  if (LIVE_MUSIC_VERIFY_PATTERNS.test(msg)) return 'website_verify';
  if (LIVE_MUSIC_BEST_EFFORT_PATTERNS.test(msg)) return 'best_effort';
  return null;
}

function detectWindowFromFollowUp(msg: string): { window: string; window_days: number } | null {
  const windowPattern = /\b(?:last|past)\s+(\d+)\s+(months?|years?|weeks?|days?)\b/i;
  const match = msg.match(windowPattern);
  if (match) {
    const n = parseInt(match[1], 10);
    const unit = match[2].toLowerCase().replace(/s$/, '');
    let days = n * 30;
    if (unit === 'day') days = n;
    else if (unit === 'week') days = n * 7;
    else if (unit === 'year') days = n * 365;
    return { window: `${n} ${match[2].toLowerCase()}`, window_days: days };
  }

  if (/\bthis\s+year\b/i.test(msg)) {
    return { window: 'this year', window_days: 365 };
  }

  return null;
}

const TIME_PREDICATE_QUESTION = `I can't guarantee opening dates from listings. Do you want me to use a proxy or treat this as best-effort unverified?\n\nA) Use news mentions proxy\nB) Use first reviews proxy\nC) Best-effort, unverified is OK`;

const LIVE_MUSIC_QUESTION = `Live music isn't reliably verified from Places data. Do you want me to verify via website / listings (slower) or treat as best-effort unverified?\n\nA) Verify via website / listings\nB) Best-effort, unverified is OK`;

function isTimePredicateUnresolved(c: Constraint): boolean {
  if (c.type !== 'time_predicate') return false;
  return !c.can_execute;
}

function isLiveMusicUnresolved(c: Constraint): boolean {
  if (c.type !== 'attribute') return false;
  if (c.attribute !== 'live_music') return false;
  return c.requires_clarification && c.chosen_verification === null;
}

function isSubjectivePredicateUnresolved(c: Constraint): boolean {
  return c.type === 'subjective_predicate' && !c.can_execute;
}

function isNumericAmbiguityUnresolved(c: Constraint): boolean {
  return c.type === 'numeric_ambiguity' && !c.can_execute;
}

function isRelationshipPredicateUnresolved(c: Constraint): boolean {
  return c.type === 'relationship_predicate' && !c.can_execute;
}

function buildGateState(constraints: Constraint[], isNoProxy: boolean): ConstraintContract {
  const clarify_questions: string[] = [];
  const blockReasons: string[] = [];
  let stop_recommended = false;
  let activeBlockFound = false;

  const hasUnresolvedSubjective = constraints.some(c => isSubjectivePredicateUnresolved(c));
  const hasUnresolvedNumeric = constraints.some(c => isNumericAmbiguityUnresolved(c));
  const hasUnresolvedRelationship = constraints.some(c => isRelationshipPredicateUnresolved(c));
  const hasUnresolvedTime = constraints.some(c => isTimePredicateUnresolved(c));

  for (const c of constraints) {
    if (c.type === 'subjective_predicate' && !c.can_execute) {
      if (!activeBlockFound) {
        blockReasons.push(c.why_blocked);
        const termsDisplay = c.label.split(', ').map(t => `'${t}'`).join(' and ');
        const optionsList = c.clarification_options.join(', ');
        clarify_questions.push(`When you say ${termsDisplay}, what do you mean? Pick one or more: ${optionsList} — or tell me your own criteria.`);
        activeBlockFound = true;
      }
    } else if (hasUnresolvedSubjective) {
      continue;
    } else if (c.type === 'numeric_ambiguity' && !c.can_execute) {
      if (!activeBlockFound) {
        blockReasons.push(c.why_blocked);
        clarify_questions.push(c.clarification_question);
        activeBlockFound = true;
      }
    } else if (hasUnresolvedNumeric) {
      continue;
    } else if (c.type === 'relationship_predicate' && !c.can_execute) {
      if (!activeBlockFound) {
        blockReasons.push(c.why_blocked);
        clarify_questions.push(c.clarify_question);
        activeBlockFound = true;
      }
    } else if (hasUnresolvedRelationship) {
      continue;
    } else if (c.type === 'time_predicate') {
      if (isNoProxy || (c.verifiability === 'unverifiable' && c.hardness === 'hard')) {
        if (!activeBlockFound) {
          stop_recommended = true;
          blockReasons.push(c.why_blocked || 'Opening dates cannot be verified from any available data source. This constraint cannot be satisfied.');
          activeBlockFound = true;
        }
      } else if (!c.can_execute) {
        if (!activeBlockFound) {
          clarify_questions.push(TIME_PREDICATE_QUESTION);
          blockReasons.push(c.why_blocked || 'Time predicate requires proxy selection or best-effort acceptance.');
          activeBlockFound = true;
        }
      }
    } else if (hasUnresolvedTime) {
      continue;
    } else if (c.type === 'attribute' && c.attribute === 'live_music') {
      if (c.requires_clarification && c.chosen_verification === null) {
        if (!activeBlockFound) {
          clarify_questions.push(LIVE_MUSIC_QUESTION);
          blockReasons.push('Live music cannot be reliably verified from Places data alone.');
          activeBlockFound = true;
        }
      }
    }
  }

  const anyBlocked =
    constraints.some(c => isSubjectivePredicateUnresolved(c)) ||
    constraints.some(c => isNumericAmbiguityUnresolved(c)) ||
    constraints.some(c => isRelationshipPredicateUnresolved(c)) ||
    constraints.some(c => isTimePredicateUnresolved(c)) ||
    constraints.some(c => isLiveMusicUnresolved(c));

  const can_execute = !anyBlocked && !stop_recommended;

  return {
    constraints,
    can_execute,
    why_blocked: blockReasons.length > 0 ? blockReasons.join(' ') : null,
    clarify_questions,
    stop_recommended,
  };
}

export function preExecutionConstraintGate(msg: string): ConstraintContract {
  const constraints = extractAllConstraints(msg);

  if (constraints.length === 0) {
    return {
      constraints: [],
      can_execute: true,
      why_blocked: null,
      clarify_questions: [],
      stop_recommended: false,
    };
  }

  const hasSubjective = constraints.some(c => c.type === 'subjective_predicate');
  if (hasSubjective) {
    console.log(`[CONSTRAINT_GATE] constraint_gate_triggered: subjective`);
  }

  const initialLiveMusicChoice = detectLiveMusicChoice(msg);
  if (initialLiveMusicChoice) {
    for (const c of constraints) {
      if (c.type === 'attribute' && c.attribute === 'live_music' && c.requires_clarification) {
        c.chosen_verification = initialLiveMusicChoice;
        c.requires_clarification = false;
        c.can_execute = true;
        c.why_blocked = '';
        console.log(`[CONSTRAINT_GATE] Auto-resolved live_music from initial message: chosen_verification=${initialLiveMusicChoice}`);
      }
    }
  }

  const isNoProxy = detectNoProxySignal(msg);
  const isMustBeCertain = detectMustBeCertain(msg);

  if (isNoProxy || isMustBeCertain) {
    for (const c of constraints) {
      c.must_be_certain = true;
      if (c.type === 'time_predicate') {
        c.hardness = 'hard';
        c.verifiability = 'unverifiable';
        c.can_execute = false;
        c.why_blocked = 'User requires certainty but opening dates cannot be verified from any available data source. This constraint cannot be satisfied.';
        c.suggested_rephrase = null;
      }
    }
  }

  const gate = buildGateState(constraints, isNoProxy || isMustBeCertain);
  if (isMustBeCertain) {
    return applyCertaintyGate(gate);
  }
  return gate;
}

export function resolveFollowUp(
  existingContract: ConstraintContract,
  followUpMsg: string,
): ConstraintContract {
  const noProxy = detectNoProxySignal(followUpMsg);
  const mustBeCertain = detectMustBeCertain(followUpMsg);
  const proxyChoice = detectProxySelection(followUpMsg);
  const bestEffort = detectBestEffort(followUpMsg);
  const windowInfo = detectWindowFromFollowUp(followUpMsg);
  const liveMusicChoice = detectLiveMusicChoice(followUpMsg);
  const followUpHasMeasurable = MEASURABLE_FOLLOW_UP_PATTERN.test(followUpMsg);

  const hadUnresolvedSubjective = existingContract.constraints.some(c => isSubjectivePredicateUnresolved(c));
  const hadUnresolvedNumeric = existingContract.constraints.some(c => isNumericAmbiguityUnresolved(c));

  const updatedConstraints = existingContract.constraints.map(c => {
    if (c.type === 'subjective_predicate' && !c.can_execute) {
      if (followUpHasMeasurable) {
        return {
          ...c,
          can_execute: true,
          why_blocked: '',
          required_inputs_missing: [],
        } as SubjectivePredicateConstraint;
      }
      return c;
    }

    if (hadUnresolvedSubjective) {
      return c;
    }

    if (c.type === 'numeric_ambiguity' && !c.can_execute) {
      if (followUpResolvesNumericCategory(followUpMsg, c.category)) {
        return {
          ...c,
          can_execute: true,
          why_blocked: '',
        } as NumericAmbiguityConstraint;
      }
      return c;
    }

    if (hadUnresolvedNumeric) {
      return c;
    }

    const hadUnresolvedRelationship = existingContract.constraints.some(c => isRelationshipPredicateUnresolved(c));

    if (c.type === 'relationship_predicate' && !c.can_execute) {
      const strategyChoice = detectRelationshipStrategyChoice(followUpMsg);
      if (strategyChoice) {
        return {
          ...c,
          can_execute: true,
          why_blocked: '',
          chosen_relationship_strategy: strategyChoice,
        } as RelationshipPredicateConstraint;
      }
      return c;
    }

    if (hadUnresolvedRelationship) {
      return c;
    }

    const hadUnresolvedTime = existingContract.constraints.some(c => isTimePredicateUnresolved(c));

    if (c.type === 'time_predicate') {
      if (c.can_execute && c.chosen_proxy) {
        return c;
      }

      let updated = { ...c };

      if (mustBeCertain) {
        updated = { ...updated, must_be_certain: true };
      }

      if (windowInfo && updated.required_inputs_missing.includes('time_window')) {
        updated = {
          ...updated,
          window: windowInfo.window,
          window_days: windowInfo.window_days,
          required_inputs_missing: updated.required_inputs_missing.filter(f => f !== 'time_window'),
        };
      }

      if (mustBeCertain) {
        updated = {
          ...updated,
          hardness: 'hard',
          verifiability: 'unverifiable',
          can_execute: false,
          why_blocked: 'You asked for certainty, but I can\'t guarantee opening dates with public data.',
          suggested_rephrase: null,
          chosen_proxy: null,
          must_be_certain: true,
        };
      } else if (noProxy) {
        updated = {
          ...updated,
          hardness: 'hard',
          verifiability: 'unverifiable',
          can_execute: false,
          why_blocked: 'User rejected all proxy options. Opening dates cannot be verified, so this constraint cannot be satisfied.',
          suggested_rephrase: null,
          chosen_proxy: null,
        };
      } else if (bestEffort) {
        updated = {
          ...updated,
          hardness: 'soft',
          verifiability: 'unverifiable',
          can_execute: true,
          why_blocked: null,
          suggested_rephrase: null,
          chosen_proxy: 'best_effort',
        };
      } else if (proxyChoice) {
        updated = resolveProxyChoice(updated, proxyChoice);
      }

      return updated;
    }

    if (hadUnresolvedTime) {
      return c;
    }

    if (c.type === 'attribute' && c.attribute === 'live_music' && c.requires_clarification && c.chosen_verification === null) {
      if (mustBeCertain) {
        return { ...c, must_be_certain: true, hardness: 'hard', verifiability: 'unverifiable', can_execute: false };
      }
      if (liveMusicChoice) {
        return { ...c, chosen_verification: liveMusicChoice, requires_clarification: false };
      }
      if (bestEffort) {
        return { ...c, chosen_verification: 'best_effort' as LiveMusicVerification, requires_clarification: false };
      }
    }

    if (mustBeCertain && c.type === 'attribute') {
      return { ...c, must_be_certain: true };
    }

    return c;
  });

  const gateResult = buildGateState(updatedConstraints, noProxy || mustBeCertain);

  // If smart clarification inferred product context, enrich the entity description
  const inferredCtx = (existingContract as any)._inferred_context;
  if (inferredCtx?.product_description) {
    const entityConstraint = gateResult.constraints.find((c: any) =>
      c.type === 'entity_type' || c.type === 'entity_description' || c.type === 'ENTITY_TYPE'
    ) as any;
    if (entityConstraint && entityConstraint.value) {
      entityConstraint.value = `${entityConstraint.value} (specifically: businesses interested in ${inferredCtx.product_description})`;
      console.log(`[SMART_CLARIFY] Enriched entity constraint with product context: "${entityConstraint.value.slice(0, 100)}"`);
    }
    // Carry inferred context forward so downstream resolution can use it
    (gateResult as any)._inferred_context = inferredCtx;
  }

  if (mustBeCertain) {
    return applyCertaintyGate(gateResult);
  }
  return gateResult;
}

export function storePendingContract(conversationId: string, originalMessage: string, contract: ConstraintContract, originRunId?: string | null): void {
  pendingContracts.set(conversationId, {
    conversationId,
    originalMessage,
    contract,
    originRunId: originRunId ?? null,
    createdAt: Date.now(),
  });
}

export function getPendingContract(conversationId: string): PendingConstraintState | null {
  const state = pendingContracts.get(conversationId);
  if (!state) return null;
  if (Date.now() - state.createdAt > PENDING_TTL_MS) {
    pendingContracts.delete(conversationId);
    return null;
  }
  return state;
}

export function clearPendingContract(conversationId: string): void {
  pendingContracts.delete(conversationId);
}

export function preExecutionConstraintGateFromIntent(intent: CanonicalIntent, rawMsg: string): ConstraintContract {
  const constraints: Constraint[] = [];
  let coveredTypes = new Set<string>();

  for (const cc of intent.constraints) {
    switch (cc.type) {
      case 'attribute': {
        const attrKey = cc.raw.toLowerCase().trim().replace(/\s+/g, '_');
        const classification = classifyAttribute(cc.raw);
        if (classification === 'SUBJECTIVE_UNDEFINED' || classification === 'MISSING_NUMERIC_THRESHOLD') break;
        const isBlocking = BLOCKING_ATTRIBUTES.has(attrKey);
        constraints.push({
          type: 'attribute',
          attribute: attrKey,
          classification: 'TOOL_CHECKABLE',
          verifiability: isBlocking ? 'proxy' : 'verifiable',
          requires_clarification: isBlocking,
          chosen_verification: null,
          hardness: cc.hardness as Hardness,
          keyword_variants: generateKeywordVariants(cc.raw),
        });
        coveredTypes.add('attribute');
        break;
      }
      case 'time': {
        const timePred = buildTimePredicateContract(cc.raw);
        if (timePred) {
          if (cc.hardness === 'hard') {
            timePred.hardness = 'hard';
          }
          constraints.push(timePred);
        }
        coveredTypes.add('time');
        break;
      }
      case 'relationship': {
        const relRole = detectRelationshipRole(cc.raw);
        constraints.push({
          type: 'relationship_predicate',
          predicate: cc.raw,
          relationship_target: relRole?.relationship_target ?? cc.raw,
          relationship_direction: relRole?.relationship_direction ?? 'unknown',
          verifiability: 'unverifiable',
          hardness: cc.hardness as Hardness,
          can_execute: false,
          why_blocked: `Relationship constraint "${cc.raw}" requires strategy selection before search can proceed.`,
          clarify_question: `Your request involves a relationship filter ("${cc.raw}"). Do you want me to:\n\nA) Research each result individually (slower, more thorough)\nB) Use keyword-based filtering (faster, less precise)\nC) Skip this filter and return all results`,
        });
        coveredTypes.add('relationship');
        break;
      }
      case 'unknown_constraint': {
        if (cc.clarify_if_needed) {
          const terms = cc.raw.trim();
          constraints.push({
            type: 'subjective_predicate',
            label: terms,
            terms: [terms],
            verifiability: 'unverifiable',
            hardness: 'soft',
            can_execute: false,
            why_blocked: `Subjective term "${terms}" is too vague to verify from listings data.`,
            clarification_options: SUBJECTIVE_CLARIFICATION_OPTIONS,
            required_inputs_missing: [],
          });
          coveredTypes.add('subjective');
        }
        break;
      }
      case 'rating':
      case 'reviews':
      case 'name_filter':
      case 'category':
        break;
    }
  }

  if (constraints.length === 0 && coveredTypes.size === 0) {
    return {
      constraints: [],
      can_execute: true,
      why_blocked: null,
      clarify_questions: [],
      stop_recommended: false,
      semantic_source: 'canonical',
    };
  }

  const allHard = intent.constraints.every(c => c.hardness === 'hard');
  const hasMustBeCertainInCanonical = allHard && intent.constraints.some(c => c.type === 'time' && c.hardness === 'hard');
  const isNoProxy = hasMustBeCertainInCanonical || detectNoProxySignal(rawMsg);
  const isMustBeCertain = hasMustBeCertainInCanonical || detectMustBeCertain(rawMsg);

  if (isNoProxy || isMustBeCertain) {
    for (const c of constraints) {
      c.must_be_certain = true;
      if (c.type === 'time_predicate') {
        c.hardness = 'hard';
        c.verifiability = 'unverifiable';
        c.can_execute = false;
        c.why_blocked = 'User requires certainty but opening dates cannot be verified from any available data source. This constraint cannot be satisfied.';
        c.suggested_rephrase = null;
      }
    }
  }

  const canonicalHasVerifyChoice = intent.constraints.some(c => c.type === 'attribute' && c.evidence_mode === 'website_text' && !c.clarify_if_needed);
  if (canonicalHasVerifyChoice) {
    for (const c of constraints) {
      if (c.type === 'attribute' && c.attribute === 'live_music' && c.requires_clarification) {
        c.chosen_verification = 'website_verify';
        c.requires_clarification = false;
        c.can_execute = true;
        c.why_blocked = '';
        console.log(`[CONSTRAINT_GATE] canonical evidence_mode=website_text auto-resolved live_music clarification`);
      }
    }
  } else {
    const initialLiveMusicChoice = detectLiveMusicChoice(rawMsg);
    if (initialLiveMusicChoice) {
      for (const c of constraints) {
        if (c.type === 'attribute' && c.attribute === 'live_music' && c.requires_clarification) {
          c.chosen_verification = initialLiveMusicChoice;
          c.requires_clarification = false;
          c.can_execute = true;
          c.why_blocked = '';
        }
      }
    }
  }

  const gate = buildGateState(constraints, isNoProxy || isMustBeCertain);
  const result = isMustBeCertain ? applyCertaintyGate(gate) : gate;
  result.semantic_source = 'canonical';
  console.log(`[CONSTRAINT_GATE] semantic_source=canonical constraints=${result.constraints.length} can_execute=${result.can_execute}`);
  return result;
}

const buildStamp = process.env.GIT_SHA?.substring(0, 7) || '5c9c5a8';
const isDev = process.env.NODE_ENV !== 'production';

export function buildConstraintGateMessage(contract: ConstraintContract): string {
  if (contract.stop_recommended) {
    const reason = contract.why_blocked || 'One or more constraints cannot be verified from available data sources.';
    const stamp = isDev ? `\n\n[build: ${buildStamp}]` : '';
    return `I need to stop here. ${reason}\n\nIf you'd like, you can rephrase your request without the unverifiable requirement, and I'll try again.${stamp}`;
  }

  if (contract.clarify_questions.length > 0) {
    if (contract.clarify_questions.length === 1) {
      return `Before I search, I need to check one thing:\n\n${contract.clarify_questions[0]}`;
    }
    const bullets = contract.clarify_questions.map((q, i) => `${i + 1}. ${q}`).join('\n\n');
    return `Before I search, I need to check a couple of things:\n\n${bullets}`;
  }

  return contract.why_blocked || 'Some constraints need clarification before I can proceed.';
}
