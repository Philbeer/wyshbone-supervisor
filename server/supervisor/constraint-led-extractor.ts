export interface ConstraintContext {
  type: string;
  field: string;
  operator: string;
  value: string;
  hardness: string;
  synonyms?: string[] | null;
}

export type SourceType = 'website' | 'search_snippet' | 'gov_page' | 'social_media' | 'directory' | 'unknown';

// PHASE_2: Canonical source trust tier — surfaces provenance for Tower
export type SourceTier = 'first_party_website' | 'search_snippet' | 'directory_field' | 'lead_field' | 'external_source';

// PHASE_2: Map existing source_type to canonical source_tier
export function mapSourceTypeToTier(sourceType: SourceType): SourceTier {
  switch (sourceType) {
    case 'website':
      return 'first_party_website';
    case 'search_snippet':
      return 'search_snippet';
    case 'directory':
      return 'directory_field';
    case 'gov_page':
      return 'external_source';
    case 'social_media':
      return 'external_source';
    case 'unknown':
    default:
      return 'external_source';
  }
}

export interface EvidenceItem {
  source_url: string;
  page_title: string;
  constraint_type: string;
  constraint_value: string;
  matched_phrase: string;
  direct_quote: string;
  context_snippet: string;
  constraint_match_reason: string;
  source_type: SourceType;
  source_tier: SourceTier; // PHASE_2
  confidence_score: number;
  quote: string;
  url: string;
  match_reason: string;
  confidence: 'high' | 'medium' | 'low';
  keyword_matched: string | null;
}

export interface ConstraintLedExtractionResult {
  evidence_items: EvidenceItem[];
  pages_scanned: number;
  constraint: ConstraintContext;
  no_evidence: boolean;
  extraction_method: 'keyword_sentence' | 'keyword_chunk' | 'no_match';
  phrase_targets: string[];
}

interface PageInput {
  url?: string;
  title?: string;
  text_clean?: string;
  text?: string;
  content?: string;
  page_type?: string;
}

export type PageHintSlug = string;

const EVIDENCE_PAGE_BIAS: Record<string, RegExp[]> = {
  website_evidence: [
    /\/events?\b/i, /\/whats.?on\b/i, /\/live.?music\b/i, /\/entertainment\b/i,
    /\/menu\b/i, /\/food\b/i, /\/drinks?\b/i, /\/services?\b/i,
    /\/about\b/i, /\/facilities\b/i, /\/spa\b/i, /\/wellness\b/i,
    /\/dining\b/i, /\/restaurant\b/i, /\/bar\b/i, /\/pool\b/i,
    /\/gym\b/i, /\/fitness\b/i, /\/personal.?train/i,
    /\/rooms?\b/i, /\/accommodation\b/i, /\/amenities\b/i,
    /\/craft.?beer\b/i, /\/brew/i, /\/garden\b/i, /\/terrace\b/i,
    /\/rooftop\b/i, /\/theatre\b/i, /\/cinema\b/i,
  ],
  relationship_check: [
    /\/about\b/i, /\/partners?\b/i, /\/projects?\b/i, /\/services?\b/i,
    /\/news\b/i, /\/clients?\b/i, /\/who.?we.?work.?with\b/i, /\/case.?stud/i,
    /\/frameworks?\b/i, /\/contracts?\b/i, /\/tender/i, /\/suppliers?\b/i,
    /\/accreditations?\b/i, /\/portfolio\b/i, /\/testimonials?\b/i,
    /\/sectors?\b/i, /\/industries\b/i, /\/public.?sector\b/i,
  ],
  status_check: [
    /\/services?\b/i, /\/about\b/i, /\/contact\b/i, /\/book/i,
    /\/appointments?\b/i, /\/register\b/i, /\/patients?\b/i,
    /\/referrals?\b/i, /\/opening/i, /\/hours\b/i,
  ],
  attribute_check: [
    /\/about\b/i, /\/facilities\b/i, /\/amenities\b/i, /\/features?\b/i,
    /\/access/i, /\/info/i, /\/services?\b/i,
    /\/spa\b/i, /\/wellness\b/i, /\/gym\b/i, /\/pool\b/i,
    /\/menu\b/i, /\/dining\b/i, /\/events?\b/i,
  ],
};

const CONSTRAINT_VALUE_PAGE_HINTS: Record<string, RegExp[]> = {
  'live music': [/\/events?\b/i, /\/whats.?on\b/i, /\/live.?music\b/i, /\/entertainment\b/i, /\/gigs?\b/i],
  'music': [/\/events?\b/i, /\/whats.?on\b/i, /\/entertainment\b/i],
  'vegan': [/\/menu\b/i, /\/food\b/i, /\/dining\b/i, /\/restaurant\b/i, /\/allergen/i],
  'vegetarian': [/\/menu\b/i, /\/food\b/i, /\/dining\b/i, /\/restaurant\b/i, /\/allergen/i],
  'gluten': [/\/menu\b/i, /\/food\b/i, /\/allergen/i, /\/dietary\b/i],
  'spa': [/\/spa\b/i, /\/wellness\b/i, /\/treatments?\b/i, /\/relax/i, /\/facilities\b/i],
  'pool': [/\/pool\b/i, /\/swim/i, /\/leisure\b/i, /\/facilities\b/i],
  'gym': [/\/gym\b/i, /\/fitness\b/i, /\/facilities\b/i],
  'personal train': [/\/personal.?train/i, /\/pt\b/i, /\/fitness\b/i, /\/services?\b/i, /\/team\b/i],
  'rooftop': [/\/rooftop\b/i, /\/bar\b/i, /\/terrace\b/i, /\/dining\b/i],
  'beer garden': [/\/garden\b/i, /\/terrace\b/i, /\/outdoor/i, /\/facilities\b/i],
  'craft beer': [/\/beer\b/i, /\/brew/i, /\/drinks?\b/i, /\/tap.?list/i],
  'brew': [/\/brew/i, /\/beer\b/i, /\/drinks?\b/i, /\/tap.?list/i],
  'dog': [/\/dog/i, /\/pet/i, /\/facilities\b/i, /\/info/i, /\/about\b/i],
  'wheelchair': [/\/access/i, /\/facilities\b/i, /\/info/i, /\/about\b/i],
  'parking': [/\/parking\b/i, /\/directions?\b/i, /\/visit/i, /\/info/i],
  'wifi': [/\/facilities\b/i, /\/amenities\b/i, /\/info/i],
  'family': [/\/famil/i, /\/kids?\b/i, /\/children\b/i, /\/facilities\b/i, /\/info/i],
  'booking': [/\/book/i, /\/reserv/i, /\/contact\b/i],
  'nhs': [/\/nhs\b/i, /\/patients?\b/i, /\/services?\b/i, /\/referr/i],
  'accepting': [/\/patients?\b/i, /\/register\b/i, /\/new.?patient/i, /\/services?\b/i],
  'relationship': [/\/partners?\b/i, /\/clients?\b/i, /\/case.?stud/i, /\/frameworks?\b/i, /\/about\b/i, /\/sectors?\b/i],
};

const PAGE_HINT_SLUGS: Record<string, string[]> = {
  'live music': ['events', 'whats-on', 'live-music', 'entertainment', 'gigs'],
  'music': ['events', 'whats-on', 'entertainment'],
  'vegan': ['menu', 'food', 'dining', 'restaurant', 'allergens'],
  'vegetarian': ['menu', 'food', 'dining', 'restaurant', 'allergens'],
  'gluten': ['menu', 'food', 'allergens', 'dietary'],
  'spa': ['spa', 'wellness', 'treatments', 'relax', 'facilities'],
  'pool': ['pool', 'swimming', 'leisure', 'facilities'],
  'gym': ['gym', 'fitness', 'facilities'],
  'personal train': ['personal-training', 'pt', 'fitness', 'services', 'team'],
  'rooftop': ['rooftop', 'bar', 'terrace', 'dining'],
  'beer garden': ['garden', 'terrace', 'outdoor', 'facilities'],
  'craft beer': ['beer', 'brewery', 'drinks', 'tap-list'],
  'brew': ['brewery', 'beer', 'drinks', 'tap-list'],
  'cask ale': ['beers', 'ales', 'our-beers', 'real-ale', 'drinks', 'cellar', 'tap-list', 'bar', 'what-we-serve'],
  'real ale': ['beers', 'ales', 'our-beers', 'real-ale', 'drinks', 'cellar', 'tap-list', 'bar', 'what-we-serve'],
  'dog': ['dog-friendly', 'pets', 'facilities', 'info', 'about'],
  'wheelchair': ['accessibility', 'facilities', 'info', 'about'],
  'parking': ['parking', 'directions', 'visit', 'info'],
  'wifi': ['facilities', 'amenities', 'info'],
  'family': ['families', 'kids', 'children', 'facilities', 'info'],
  'booking': ['book', 'reservations', 'contact'],
  'nhs': ['nhs', 'patients', 'services', 'referrals'],
  'accepting': ['patients', 'register', 'new-patients', 'services'],
  'relationship': ['partners', 'clients', 'case-studies', 'frameworks', 'about', 'sectors'],
};

export function getPageHintsForConstraint(constraint: ConstraintContext): string[] {
  const value = constraint.value.toLowerCase();
  const hints: string[] = [];

  if (constraint.type === 'relationship_check') {
    hints.push('partners', 'clients', 'case-studies', 'frameworks', 'about', 'sectors', 'public-sector', 'testimonials');
  }

  for (const [key, slugs] of Object.entries(PAGE_HINT_SLUGS)) {
    if (value.includes(key) || key.includes(value)) {
      for (const s of slugs) {
        if (!hints.includes(s)) hints.push(s);
      }
    }
  }

  return hints;
}

const _synonymCache = new Map<string, string[]>();

const SYNONYM_MAP: Record<string, string[]> = {
  'live music': ['live music', 'live band', 'acoustic', 'live entertainment', 'live gig', 'live performance', 'music night', 'open mic'],
  'dog friendly': ['dog friendly', 'dogs welcome', 'dog-friendly', 'pet friendly', 'pets welcome', 'four-legged', 'canine'],
  'wheelchair accessible': ['wheelchair', 'accessible', 'disability', 'disabled access', 'step-free', 'ramp', 'mobility'],
  'beer garden': ['beer garden', 'garden', 'outdoor seating', 'patio', 'terrace', 'alfresco'],
  'vegan': ['vegan', 'plant-based', 'plant based', 'dairy-free', 'dairy free'],
  'vegetarian': ['vegetarian', 'veggie', 'meat-free', 'meat free'],
  'gluten free': ['gluten free', 'gluten-free', 'coeliac', 'celiac'],
  'parking': ['parking', 'car park', 'free parking', 'on-site parking'],
  'wifi': ['wifi', 'wi-fi', 'free wifi', 'wireless', 'internet'],
  'family': ['family friendly', 'family-friendly', 'children welcome', 'kids welcome', 'child friendly'],
  'nhs': ['nhs', 'national health service', 'nhs funded', 'nhs patients'],
  'private': ['private', 'privately funded', 'private patients', 'self-pay'],
  'accepting': ['accepting', 'taking on', 'now accepting', 'registering', 'open to new', 'currently accepting'],
  'bookings': ['booking', 'bookings', 'reservations', 'reserve', 'book online', 'book now', 'book a table'],
  'rooftop': ['rooftop', 'roof terrace', 'rooftop bar', 'sky bar', 'skyline'],
  'spa': ['spa', 'wellness', 'treatments', 'massage', 'sauna', 'steam room', 'jacuzzi', 'hot tub'],
  'craft beer': ['craft beer', 'craft ale', 'microbrewery', 'home brewed', 'own brew', 'brewed on site', 'in-house brew'],
  'brew': ['brew', 'brewery', 'microbrewery', 'brewpub', 'brew pub', 'on-site brewery', 'brewed', 'home-brewed'],
  'cask ale': ['cask ale', 'real ale', 'hand-pulled', 'hand pump', 'cask conditioned', 'cask beer', 'cask marque', 'traditional ale', 'real ales', 'guest ales', 'live ale'],
  'real ale': ['real ale', 'cask ale', 'hand-pulled', 'hand pump', 'cask conditioned', 'cask beer', 'cask marque', 'traditional ale', 'real ales', 'guest ales', 'live ale'],
  'personal training': ['personal training', 'personal trainer', 'pt sessions', 'one to one training', '1-2-1 training', 'pt'],
  'swimming pool': ['swimming pool', 'pool', 'indoor pool', 'outdoor pool', 'heated pool', 'lap pool'],
  'gym': ['gym', 'fitness centre', 'fitness center', 'workout', 'exercise'],
  'conference': ['conference', 'conference room', 'meeting room', 'event space', 'function room'],
  'wedding': ['wedding', 'weddings', 'wedding venue', 'ceremony', 'reception'],
  'sustainability': ['sustainability', 'sustainable', 'eco-friendly', 'green', 'carbon neutral', 'environmentally friendly'],
};

const ENTITY_EXPANSION_PATTERNS: Record<string, string[]> = {
  'local authority': ['council', 'borough council', 'district council', 'city council', 'county council', 'metropolitan borough'],
  'nhs': ['nhs trust', 'hospital trust', 'clinical commissioning group', 'ccg', 'integrated care board', 'icb'],
  'university': ['university', 'uni', 'college', 'academic institution', 'faculty'],
  'school': ['school', 'academy', 'primary school', 'secondary school', 'high school', 'grammar school'],
  'hospital': ['hospital', 'medical centre', 'medical center', 'clinic', 'infirmary', 'health centre'],
  'charity': ['charity', 'charitable', 'not-for-profit', 'nonprofit', 'non-profit', 'voluntary organisation'],
  'government': ['government', 'gov', 'public sector', 'state', 'central government', 'department'],
  'police': ['police', 'constabulary', 'law enforcement', 'police force', 'police service'],
  'fire service': ['fire service', 'fire brigade', 'fire and rescue', 'fire department'],
  'housing association': ['housing association', 'registered social landlord', 'social housing', 'housing provider'],
};

const RELATIONSHIP_PREDICATES: Record<string, string[]> = {
  'works with': ['works with', 'working with', 'work with', 'collaborated with', 'in partnership with', 'partnered with'],
  'supplies': ['supplies', 'supplier', 'supplying', 'provides', 'provider', 'delivering', 'contracted by'],
  'funded by': ['funded by', 'funding from', 'grant from', 'supported by', 'financed by', 'investment from'],
  'serves': ['serves', 'serving', 'service provider for', 'contracted to', 'commissioned by'],
  'affiliated with': ['affiliated with', 'affiliated to', 'associated with', 'member of', 'part of'],
};

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'that', 'this', 'these',
  'those', 'it', 'its', 'they', 'them', 'their', 'we', 'our', 'us',
  'you', 'your', 'he', 'she', 'him', 'her', 'his', 'who', 'whom',
  'which', 'what', 'where', 'when', 'how', 'not', 'no', 'nor', 'so',
  'if', 'then', 'than', 'too', 'very', 'just', 'also', 'more', 'most',
]);

function basicStem(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('ing') && w.length > 5) {
    const stem = w.slice(0, -3);
    if (stem.endsWith('e')) return stem;
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) return stem.slice(0, -1);
    return stem;
  }
  if (w.endsWith('ment') && w.length > 6) return w.slice(0, -4);
  if (w.endsWith('ness') && w.length > 6) return w.slice(0, -4);
  if (w.endsWith('able') && w.length > 6) return w.slice(0, -4);
  if (w.endsWith('tion') && w.length > 5) return w.slice(0, -4);
  if (w.endsWith('sion') && w.length > 5) return w.slice(0, -4);
  if (w.endsWith('ous') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ive') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) {
    const stem = w.slice(0, -2);
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) return stem.slice(0, -1);
    return stem;
  }
  if (w.endsWith('ly') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('er') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1);
  return w;
}

function normaliseText(text: string): string {
  return text.toLowerCase().replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
}

interface PhraseTarget {
  phrase: string;
  wordCount: number;
  isSynonym: boolean;
  isEntityExpansion: boolean;
  isExactValue: boolean;
  isRelationshipPredicate: boolean;
  isSingleWordFragment: boolean;
}

export function generatePhraseTargets(constraint: ConstraintContext): string[] {
  const targets = generateClassifiedPhraseTargets(constraint);
  return targets.map(t => t.phrase);
}

function generateClassifiedPhraseTargets(constraint: ConstraintContext): PhraseTarget[] {
  const value = constraint.value.toLowerCase().trim();
  const targets: PhraseTarget[] = [{
    phrase: value,
    wordCount: value.split(/\s+/).length,
    isSynonym: false,
    isEntityExpansion: false,
    isExactValue: true,
    isRelationshipPredicate: false,
    isSingleWordFragment: false,
  }];

  const seen = new Set<string>([value]);

  const addTarget = (phrase: string, flags: Partial<PhraseTarget>) => {
    const p = phrase.toLowerCase().trim();
    if (seen.has(p)) return;
    seen.add(p);
    targets.push({
      phrase: p,
      wordCount: p.split(/\s+/).length,
      isSynonym: false,
      isEntityExpansion: false,
      isExactValue: false,
      isRelationshipPredicate: false,
      isSingleWordFragment: false,
      ...flags,
    });
  };

  for (const [key, synonyms] of Object.entries(SYNONYM_MAP)) {
    if (value.includes(key) || key.includes(value)) {
      for (const syn of synonyms) {
        addTarget(syn, { isSynonym: true, wordCount: syn.split(/\s+/).length });
      }
    }
  }

  if (constraint.synonyms && constraint.synonyms.length > 0) {
    for (const syn of constraint.synonyms) {
      addTarget(syn.toLowerCase().trim(), { isSynonym: true, wordCount: syn.trim().split(/\s+/).length });
    }
  }

  if (constraint.type === 'relationship_check') {
    for (const [entityKey, expansions] of Object.entries(ENTITY_EXPANSION_PATTERNS)) {
      if (value.includes(entityKey) || entityKey.includes(value)) {
        for (const expansion of expansions) {
          addTarget(expansion, { isEntityExpansion: true, wordCount: expansion.split(/\s+/).length });
        }
      }
    }

    for (const [, predicates] of Object.entries(RELATIONSHIP_PREDICATES)) {
      for (const pred of predicates) {
        if (value.includes(pred.split(' ')[0])) {
          for (const variant of predicates) {
            addTarget(variant, { isRelationshipPredicate: true, wordCount: variant.split(/\s+/).length });
          }
          break;
        }
      }
    }
  }

  if (constraint.type === 'status_check' || constraint.type === 'attribute_check') {
    for (const [entityKey, expansions] of Object.entries(ENTITY_EXPANSION_PATTERNS)) {
      if (value.includes(entityKey)) {
        for (const expansion of expansions) {
          addTarget(expansion, { isEntityExpansion: true, wordCount: expansion.split(/\s+/).length });
        }
      }
    }
  }

  const words = value.split(/\s+/).filter(w => w.length >= 4 && !STOP_WORDS.has(w));
  for (const word of words) {
    if (value.split(/\s+/).length > 1) {
      addTarget(word, { isSingleWordFragment: true, wordCount: 1 });
    }
  }

  const hyphenated = value.replace(/\s+/g, '-');
  if (hyphenated !== value) {
    addTarget(hyphenated, { isSynonym: true, wordCount: value.split(/\s+/).length });
  }
  const dehyphenated = value.replace(/-/g, ' ');
  if (dehyphenated !== value) {
    addTarget(dehyphenated, { isSynonym: true, wordCount: dehyphenated.split(/\s+/).length });
  }

  return targets;
}

function getPageText(page: PageInput): string {
  return page.text_clean || page.text || page.content || '';
}

function classifySourceType(url: string): SourceType {
  if (!url || url === 'web_search_snippet') return 'search_snippet';
  const lower = url.toLowerCase();
  if (lower.includes('.gov.') || lower.includes('.gov/') || lower.includes('government')) return 'gov_page';
  if (lower.includes('facebook.com') || lower.includes('twitter.com') || lower.includes('x.com') ||
      lower.includes('linkedin.com') || lower.includes('instagram.com')) return 'social_media';
  if (lower.includes('yell.com') || lower.includes('yelp.com') || lower.includes('tripadvisor') ||
      lower.includes('google.com/maps') || lower.includes('192.com') || lower.includes('thomsonlocal')) return 'directory';
  return 'website';
}

function classifyPageType(url: string, constraintType: string, constraintValue: string): 'evidence_rich' | 'neutral' | 'noise' {
  const lower = (url || '').toLowerCase();
  const valueLower = constraintValue.toLowerCase();

  for (const [key, patterns] of Object.entries(CONSTRAINT_VALUE_PAGE_HINTS)) {
    if (valueLower.includes(key) || key.includes(valueLower)) {
      for (const pat of patterns) {
        if (pat.test(lower)) return 'evidence_rich';
      }
    }
  }

  const biases = EVIDENCE_PAGE_BIAS[constraintType] || [];
  for (const pat of biases) {
    if (pat.test(lower)) return 'evidence_rich';
  }

  if (/\/(privacy|cookie|legal|terms|sitemap|login|cart|checkout|404)\b/i.test(lower)) return 'noise';

  return 'neutral';
}

function scorePageRelevance(page: PageInput, constraintType: string, constraintValue: string): number {
  let score = 0;
  const url = (page.url || '').toLowerCase();
  const pageClass = classifyPageType(url, constraintType, constraintValue);

  if (pageClass === 'evidence_rich') score += 10;
  if (pageClass === 'noise') score -= 5;

  if (page.page_type === 'home') score += 2;

  const title = (page.title || '').toLowerCase();
  const valueLower = constraintValue.toLowerCase();
  if (title.includes(valueLower)) score += 8;

  const valueWords = valueLower.split(/\s+/).filter(w => w.length >= 4 && !STOP_WORDS.has(w));
  for (const w of valueWords) {
    if (title.includes(w)) score += 3;
  }

  return score;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/([.!?])\s+/g, '$1\n')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length >= 10 && s.length <= 500);
}

function extractContextSnippet(text: string, matchIndex: number): string {
  const contextRadius = 120;
  const start = Math.max(0, matchIndex - contextRadius);
  const end = Math.min(text.length, matchIndex + contextRadius);

  let snippet = text.slice(start, end).trim();

  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';

  return snippet;
}

interface SentenceScore {
  score: number;
  matchedKeyword: string | null;
  matchTier: 'exact_value' | 'full_phrase' | 'synonym' | 'entity_expansion' | 'single_word' | 'stem_only' | 'none';
}

function scoreSentence(
  sentence: string,
  classifiedTargets: PhraseTarget[],
  constraintValue: string,
  constraintType: string,
): SentenceScore {
  const normalised = normaliseText(sentence);
  let score = 0;
  let bestMatch: string | null = null;
  let bestTier: SentenceScore['matchTier'] = 'none';

  const exactValueLC = constraintValue.toLowerCase();
  const exactValueNorm = normaliseText(constraintValue);

  if (normalised.includes(exactValueNorm)) {
    score += 12;
    bestMatch = constraintValue;
    bestTier = 'exact_value';
  }

  for (const target of classifiedTargets) {
    const targetNorm = normaliseText(target.phrase);
    if (targetNorm === exactValueNorm && bestTier === 'exact_value') continue;

    if (normalised.includes(targetNorm)) {
      let matchScore: number;
      let tier: SentenceScore['matchTier'];

      if (target.isExactValue) {
        matchScore = 12;
        tier = 'exact_value';
      } else if (target.isSingleWordFragment) {
        matchScore = 1;
        tier = 'single_word';
      } else if (target.isRelationshipPredicate) {
        matchScore = 3;
        tier = 'synonym';
      } else if (target.isSynonym && target.wordCount >= 2) {
        matchScore = 8;
        tier = 'synonym';
      } else if (target.isSynonym) {
        matchScore = 5;
        tier = 'synonym';
      } else if (target.isEntityExpansion && target.wordCount >= 2) {
        matchScore = 7;
        tier = 'entity_expansion';
      } else if (target.isEntityExpansion) {
        matchScore = 4;
        tier = 'entity_expansion';
      } else if (target.wordCount >= 2) {
        matchScore = 8;
        tier = 'full_phrase';
      } else {
        matchScore = 2;
        tier = 'single_word';
      }

      if (matchScore > score || (matchScore === score && target.phrase.length > (bestMatch?.length || 0))) {
        score = matchScore;
        bestMatch = target.phrase;
        bestTier = tier;
      }
    }
  }

  if (bestTier === 'none' || bestTier === 'single_word') {
    const sentenceWords = normalised.split(/\s+/).map(w => basicStem(w));
    const valueWords = exactValueLC.split(/\s+/).filter(w => w.length >= 4 && !STOP_WORDS.has(w));
    const valueStems = valueWords.map(w => basicStem(w));

    let stemMatches = 0;
    for (const vs of valueStems) {
      if (sentenceWords.some(sw => sw === vs)) stemMatches++;
    }

    if (stemMatches > 0 && valueStems.length > 0) {
      const stemScore = stemMatches >= valueStems.length ? 4 : stemMatches >= 2 ? 3 : 2;
      if (stemScore > score) {
        score = stemScore;
        bestMatch = bestMatch || constraintValue;
        bestTier = 'stem_only';
      }
    }
  }

  if (bestTier === 'single_word' && score <= 1) {
    const sentenceNormWords = normalised.split(/\s+/);
    const fragmentWord = bestMatch?.toLowerCase() || '';
    const wordIdx = sentenceNormWords.indexOf(fragmentWord);
    if (wordIdx >= 0) {
      const windowStart = Math.max(0, wordIdx - 4);
      const windowEnd = Math.min(sentenceNormWords.length, wordIdx + 5);
      const localWindow = sentenceNormWords.slice(windowStart, windowEnd).join(' ');

      const valueWords = exactValueLC.split(/\s+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w));
      let localSupport = 0;
      for (const vw of valueWords) {
        if (vw !== fragmentWord && localWindow.includes(vw)) localSupport++;
      }

      for (const target of classifiedTargets) {
        if (!target.isSingleWordFragment && target.wordCount >= 2) {
          const targetNorm = normaliseText(target.phrase);
          if (localWindow.includes(targetNorm)) localSupport += 2;
        }
      }

      if (localSupport > 0) {
        score += localSupport;
        bestTier = 'synonym';
      }
    }
  }

  const wordCount = sentence.split(/\s+/).length;
  if (wordCount >= 8 && wordCount <= 35) score += 1;
  if (wordCount < 5 || wordCount > 60) score -= 1;

  if (bestMatch) {
    const idx = normalised.indexOf(normaliseText(bestMatch));
    if (idx >= 0 && idx < normalised.length * 0.4) score += 1;
  }

  return { score, matchedKeyword: bestMatch, matchTier: bestTier };
}

function scoreRelationshipSentence(
  sentence: string,
  constraintValue: string,
  classifiedTargets: PhraseTarget[],
): SentenceScore {
  const normalised = normaliseText(sentence);
  const entityTarget = extractEntityFromConstraintValue(constraintValue);
  const entityTargetLC = normaliseText(entityTarget);

  let hasEntityMention = false;
  let hasPredicateMention = false;
  let bestEntityMatch: string | null = null;
  let bestPredicateMatch: string | null = null;

  if (normalised.includes(entityTargetLC)) {
    hasEntityMention = true;
    bestEntityMatch = entityTarget;
  }

  if (!hasEntityMention) {
    for (const [entityKey, expansions] of Object.entries(ENTITY_EXPANSION_PATTERNS)) {
      if (entityTargetLC.includes(entityKey) || entityKey.includes(entityTargetLC)) {
        for (const expansion of expansions) {
          if (normalised.includes(normaliseText(expansion))) {
            hasEntityMention = true;
            bestEntityMatch = expansion;
            break;
          }
        }
        if (hasEntityMention) break;
      }
    }
  }

  for (const [, predicates] of Object.entries(RELATIONSHIP_PREDICATES)) {
    for (const pred of predicates) {
      if (normalised.includes(normaliseText(pred))) {
        hasPredicateMention = true;
        bestPredicateMatch = pred;
        break;
      }
    }
    if (hasPredicateMention) break;
  }

  let score = 0;
  let matchTier: SentenceScore['matchTier'] = 'none';
  let bestMatch: string | null = null;

  if (hasEntityMention && hasPredicateMention) {
    const entityIdx = normalised.indexOf(normaliseText(bestEntityMatch!));
    const predIdx = normalised.indexOf(normaliseText(bestPredicateMatch!));
    const distance = Math.abs(entityIdx - predIdx);

    if (distance < 100) {
      score = 14;
      matchTier = 'exact_value';
    } else {
      score = 10;
      matchTier = 'full_phrase';
    }
    bestMatch = `${bestPredicateMatch} ${bestEntityMatch}`;
  } else if (hasEntityMention) {
    const namedEntityPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:council|trust|nhs|university|hospital|authority|police|service)\b/i;
    if (namedEntityPattern.test(sentence)) {
      score = 4;
      matchTier = 'entity_expansion';
    } else {
      score = 2;
      matchTier = 'single_word';
    }
    bestMatch = bestEntityMatch;
  } else if (hasPredicateMention) {
    score = 1;
    matchTier = 'single_word';
    bestMatch = bestPredicateMatch;
  } else {
    const genericResult = scoreSentence(sentence, classifiedTargets, constraintValue, 'relationship_check');
    if (genericResult.score >= 4) {
      return genericResult;
    }
    return { score: 0, matchedKeyword: null, matchTier: 'none' };
  }

  const wordCount = sentence.split(/\s+/).length;
  if (wordCount >= 8 && wordCount <= 35) score += 1;
  if (wordCount < 5 || wordCount > 60) score -= 1;

  return { score, matchedKeyword: bestMatch, matchTier };
}

const SOURCE_CONFIDENCE_MULTIPLIERS: Record<SourceType, number> = {
  website: 1.0,
  gov_page: 1.15,
  search_snippet: 0.35,
  social_media: 0.5,
  directory: 0.45,
  unknown: 0.4,
};

const PAGE_CLASS_MULTIPLIERS: Record<string, number> = {
  evidence_rich: 1.2,
  neutral: 1.0,
  noise: 0.5,
};

function computeConfidenceScore(
  score: number,
  matchedKeyword: string | null,
  constraintValue: string,
  sourceType: SourceType,
  matchTier: SentenceScore['matchTier'],
  pageUrl: string,
  constraintType: string,
): number {
  let base: number;

  switch (matchTier) {
    case 'exact_value':
      base = Math.min(0.6 + score / 25, 1.0);
      break;
    case 'full_phrase':
    case 'synonym':
      base = Math.min(0.4 + score / 25, 0.9);
      break;
    case 'entity_expansion':
      base = Math.min(0.3 + score / 30, 0.8);
      break;
    case 'stem_only':
      base = Math.min(0.2 + score / 30, 0.6);
      break;
    case 'single_word':
      base = Math.min(0.1 + score / 40, 0.4);
      break;
    default:
      base = Math.min(score / 20, 0.3);
  }

  const sourceMultiplier = SOURCE_CONFIDENCE_MULTIPLIERS[sourceType] ?? 0.5;
  base *= sourceMultiplier;

  const pageClass = classifyPageType(pageUrl, constraintType, constraintValue);
  const pageMultiplier = PAGE_CLASS_MULTIPLIERS[pageClass] ?? 1.0;
  base *= pageMultiplier;

  return Math.round(Math.min(base, 1.0) * 100) / 100;
}

function determineConfidence(
  score: number,
  matchTier: SentenceScore['matchTier'],
  constraintValue: string,
): 'high' | 'medium' | 'low' {
  if ((matchTier === 'exact_value' || matchTier === 'full_phrase') && score >= 8) return 'high';
  if (matchTier === 'synonym' && score >= 6) return 'medium';
  if ((matchTier === 'exact_value' || matchTier === 'full_phrase' || matchTier === 'synonym') && score >= 4) return 'medium';
  if (matchTier === 'entity_expansion' && score >= 5) return 'medium';
  return 'low';
}

function buildMatchReason(matchedKeyword: string | null, constraintType: string, matchTier: SentenceScore['matchTier']): string {
  if (!matchedKeyword) return `relevant to ${constraintType} constraint`;
  const tierLabel = matchTier === 'exact_value' ? 'exact match' :
    matchTier === 'full_phrase' ? 'phrase match' :
    matchTier === 'synonym' ? 'synonym match' :
    matchTier === 'entity_expansion' ? 'entity expansion' :
    matchTier === 'stem_only' ? 'stem match' :
    matchTier === 'single_word' ? 'weak word match' : 'match';
  return `${tierLabel}: "${matchedKeyword}"`;
}

const CONSTRAINT_TYPE_LABELS: Record<string, string> = {
  website_evidence: 'website evidence',
  relationship_check: 'relationship',
  attribute_check: 'attribute',
  status_check: 'status',
  text_compare: 'text',
};

function extractEntityFromConstraintValue(constraintValue: string): string {
  const valueLC = constraintValue.toLowerCase();
  for (const predicates of Object.values(RELATIONSHIP_PREDICATES)) {
    for (const pred of predicates) {
      if (valueLC.startsWith(pred.toLowerCase() + ' ')) {
        return constraintValue.substring(pred.length).trim();
      }
      if (valueLC.endsWith(' ' + pred.toLowerCase())) {
        return constraintValue.substring(0, constraintValue.length - pred.length).trim();
      }
    }
  }
  return constraintValue;
}

function buildConstraintMatchReason(
  constraintType: string,
  constraintValue: string,
  matchedPhrase: string,
  matchTier: SentenceScore['matchTier'],
): string {
  const phraseLC = matchedPhrase.toLowerCase();
  const valueLC = constraintValue.toLowerCase();
  const constraintLabel = CONSTRAINT_TYPE_LABELS[constraintType] || constraintType.replace(/_/g, ' ');

  if (matchTier === 'exact_value' || phraseLC === valueLC) {
    return `Quote explicitly contains the phrase '${matchedPhrase}', satisfying the ${constraintLabel} constraint.`;
  }

  const entityTarget = constraintType === 'relationship_check'
    ? extractEntityFromConstraintValue(constraintValue)
    : constraintValue;
  const entityTargetLC = entityTarget.toLowerCase();

  if (matchTier === 'entity_expansion') {
    if (constraintType === 'relationship_check') {
      return `Quote mentions '${matchedPhrase}', an entity expansion of '${entityTarget}', supporting the relationship constraint '${constraintValue}'.`;
    }
    return `'${matchedPhrase}' is a type of ${entityTarget}, satisfying the ${constraintLabel} constraint.`;
  }

  if (matchTier === 'synonym' || matchTier === 'full_phrase') {
    for (const [key] of Object.entries(SYNONYM_MAP)) {
      if (valueLC.includes(key) || key.includes(valueLC)) {
        const synonyms = SYNONYM_MAP[key];
        if (synonyms.some(s => phraseLC.includes(s.toLowerCase()))) {
          return `'${matchedPhrase}' is a synonym or variant of '${constraintValue}', satisfying the ${constraintLabel} constraint.`;
        }
      }
    }
    return `'${matchedPhrase}' is a related phrase for '${constraintValue}', satisfying the ${constraintLabel} constraint.`;
  }

  if (matchTier === 'stem_only') {
    return `Quote contains stemmed match for '${constraintValue}' via '${matchedPhrase}', weak ${constraintLabel} evidence.`;
  }

  if (matchTier === 'single_word') {
    if (constraintType === 'relationship_check') {
      return `Quote mentions '${matchedPhrase}' which is weakly relevant to the relationship constraint '${constraintValue}'. Stronger evidence would name both parties.`;
    }
    return `Quote contains '${matchedPhrase}', a weak single-word overlap with '${constraintValue}'. Stronger full-phrase evidence preferred.`;
  }

  if (constraintType === 'relationship_check') {
    if (phraseLC.includes(entityTargetLC) || entityTargetLC.includes(phraseLC)) {
      return `Quote mentions '${matchedPhrase}' which relates to '${entityTarget}', supporting the relationship constraint '${constraintValue}'.`;
    }
    return `Quote mentions '${matchedPhrase}' which is relevant to the relationship constraint '${constraintValue}'.`;
  }

  if (phraseLC.includes(valueLC) || valueLC.includes(phraseLC)) {
    return `Quote contains '${matchedPhrase}' which relates to '${constraintValue}', satisfying the ${constraintLabel} constraint.`;
  }

  return `Quote contains '${matchedPhrase}' which is relevant to the ${constraintLabel} constraint for '${constraintValue}'.`;
}

export async function extractConstraintLedEvidence(
  pages: PageInput[],
  constraint: ConstraintContext,
  webSearchSnippets?: string[],
  maxItems: number = 3,
  leadName?: string,
): Promise<ConstraintLedExtractionResult> {
  const classifiedTargets = generateClassifiedPhraseTargets(constraint);
  const phraseTargets = classifiedTargets.map(t => t.phrase);
  const constraintValue = constraint.value;
  const isRelationship = constraint.type === 'relationship_check';

  console.log(`[EVIDENCE_EXTRACT] fired for "${leadName ?? 'undefined'}" + "${constraintValue}"`);

  const sortedPages = [...pages].sort(
    (a, b) => scorePageRelevance(b, constraint.type, constraintValue) - scorePageRelevance(a, constraint.type, constraintValue),
  );

  // === Two-layer evidence extraction ===
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && leadName) {
    try {
      // LAYER 1 — Semantic phrase scanning with LLM-expanded synonyms
      // The hardcoded SYNONYM_MAP is removed. Instead, we use a quick LLM call
      // to generate relevant search terms for ANY constraint value.

      let l1Phrases: string[] = [constraintValue.toLowerCase()];

      try {
        const cacheKey = constraintValue.toLowerCase();
        if (_synonymCache.has(cacheKey)) {
          l1Phrases = _synonymCache.get(cacheKey)!;
          console.log(`[EVIDENCE_SYNONYM] Cache hit for "${constraintValue}" — ${l1Phrases.length} phrases`);
        } else {
          const synonymModel = process.env.SYNONYM_EXPANSION_MODEL || 'claude-3-haiku-20240307';
          const anthropicKey = process.env.ANTHROPIC_API_KEY;

          if (anthropicKey) {
            const synResp = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': anthropicKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: synonymModel,
                max_tokens: 200,
                temperature: 0,
                system: 'You generate search terms for finding evidence on business websites. Given a concept, return a JSON array of 8-15 alternative phrases, synonyms, related terms, and well-known brand names that indicate the same thing. Include both formal and informal terms. Return JSON only, no markdown.',
                messages: [{
                  role: 'user',
                  content: `Generate search phrases for: "${constraintValue}"
          
Example: "beer garden" → ["beer garden", "garden", "outdoor seating", "patio", "terrace", "alfresco", "outside area", "garden area"]

Example: "cask ale" → ["cask ale", "real ale", "traditional ale", "hand-pulled", "hand pump", "cask-conditioned", "cask beer", "real ales", "Harvey's", "Timothy Taylor", "London Pride", "cask marque"]

Now do: "${constraintValue}"
Return JSON array only: ["term1", "term2", ...]`,
                }],
              }),
            });

            if (!synResp.ok) {
              const errBody = await synResp.text().catch(() => '');
              const { detectBillingError } = await import('./api-error-detector');
              detectBillingError('anthropic', synResp.status, errBody);
            } else {
              const synData = await synResp.json() as any;
              const synText = synData.content?.[0]?.text || '';
              const synCleaned = synText.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
              const synParsed = JSON.parse(synCleaned);
              if (Array.isArray(synParsed) && synParsed.length > 0) {
                l1Phrases = synParsed.map((s: string) => s.toLowerCase());
                // Ensure the original value is always included
                if (!l1Phrases.includes(constraintValue.toLowerCase())) {
                  l1Phrases.unshift(constraintValue.toLowerCase());
                }
                console.log(`[EVIDENCE_SYNONYM] "${constraintValue}" expanded to ${l1Phrases.length} phrases: ${l1Phrases.slice(0, 6).join(', ')}...`);
              }
            }
          }
          _synonymCache.set(cacheKey, l1Phrases);
        }
      } catch (synErr: any) {
        console.warn(`[EVIDENCE_SYNONYM] Synonym expansion failed (using original value): ${synErr.message}`);
        // Falls back to just [constraintValue] — no worse than before
      }

      type WindowEntry = { text: string; url: string; source_type: SourceType; pageIdx: number; matchPos: number };
      const windows: WindowEntry[] = [];
      let pagesWithText = 0;

      outer: for (let pageIdx = 0; pageIdx < sortedPages.length; pageIdx++) {
        const page = sortedPages[pageIdx];
        const rawText = getPageText(page);
        if (!rawText || rawText.trim().length < 20) continue;
        pagesWithText++;
        const textLower = rawText.toLowerCase();
        const pageUrl = page.url || '';
        const sourceType = classifySourceType(pageUrl);

        for (const phrase of l1Phrases) {
          let searchPos = 0;
          while (windows.length < 5) {
            const idx = textLower.indexOf(phrase, searchPos);
            if (idx === -1) break;
            const overlaps = windows.some(w => w.pageIdx === pageIdx && Math.abs(w.matchPos - idx) < 300);
            if (!overlaps) {
              const start = Math.max(0, idx - 150);
              const end = Math.min(rawText.length, idx + 150);
              windows.push({ text: rawText.substring(start, end).trim(), url: pageUrl, source_type: sourceType, pageIdx, matchPos: idx });
            }
            searchPos = idx + phrase.length;
          }
          if (windows.length >= 5) break outer;
        }
      }

      console.log(`[EVIDENCE_EXTRACT_L1] "${leadName}" + "${constraintValue}" → phrases=${JSON.stringify(l1Phrases)} windows=${windows.length}/${pagesWithText} pages`);

      if (windows.length === 0) {
        console.log(`[EVIDENCE_EXTRACT_L1] "${leadName}" + "${constraintValue}" → 0 keyword hits — trying LLM with full page content`);

        // Instead of returning no_evidence, send the first 2-3 pages to the LLM
        // and let it judge semantically whether the business offers this
        const fallbackPages = sortedPages.slice(0, 3);
        const fallbackTexts: string[] = [];

        for (const page of fallbackPages) {
          const text = getPageText(page);
          if (text && text.trim().length >= 50) {
            // Take first 1500 chars of each page to keep token cost low
            fallbackTexts.push(text.substring(0, 1500));
          }
        }

        if (fallbackTexts.length > 0 && openaiKey && leadName) {
          try {
            const { default: OpenAI } = await import('openai');
            const client = new OpenAI({ apiKey: openaiKey });

            const fallbackResponse = await Promise.race([
              client.chat.completions.create({
                model: process.env.EVIDENCE_JUDGE_MODEL ?? 'gpt-4o-mini',
                temperature: 0.1,
                max_tokens: 300,
                response_format: { type: 'json_object' },
                messages: [
                  {
                    role: 'system',
                    content: `You are judging whether a business offers or provides "${constraintValue}". You will receive text from their website. Look for ANY evidence — direct mentions, synonyms, related terms, brand names, menu items, or descriptions that indicate they offer this.\n\nBe reasonably inclusive — if a pub lists specific ale brands or says "real ales" and the constraint is "cask ale", that counts. But don't force a match from nothing.\n\nRespond with JSON: {"match": true/false, "evidence_sentence": "one sentence summary of evidence found or null", "confidence": "high"/"medium"/"low"}`,
                  },
                  {
                    role: 'user',
                    content: JSON.stringify({
                      business_name: leadName,
                      constraint: constraintValue,
                      website_content: fallbackTexts,
                    }),
                  },
                ],
              }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Fallback LLM timeout')), 8000)),
            ]);

            const fbRaw = fallbackResponse.choices[0]?.message?.content?.trim() || '';
            const fbCleaned = fbRaw.replace(/```json\n?|\n?```/g, '').trim();
            const fbParsed = JSON.parse(fbCleaned);

            if (fbParsed.match && fbParsed.evidence_sentence) {
              console.log(`[EVIDENCE_EXTRACT_FALLBACK_LLM] "${leadName}" + "${constraintValue}" → MATCH via full-page LLM: ${fbParsed.evidence_sentence.substring(0, 100)}`);

              const fbUrl = fallbackPages[0]?.url || '';
              const fbSourceType = classifySourceType(fbUrl);

              return {
                evidence_items: [{
                  source_url: fbUrl,
                  page_title: fallbackPages[0]?.title || '',
                  constraint_type: constraint.type,
                  constraint_value: constraintValue,
                  matched_phrase: constraintValue,
                  direct_quote: fbParsed.evidence_sentence.substring(0, 250),
                  context_snippet: fbParsed.evidence_sentence.substring(0, 300),
                  constraint_match_reason: `LLM semantic judge found evidence of "${constraintValue}" on website content (no keyword match).`,
                  source_type: fbSourceType,
                  source_tier: mapSourceTypeToTier(fbSourceType),
                  confidence_score: fbParsed.confidence === 'high' ? 0.80 : fbParsed.confidence === 'medium' ? 0.60 : 0.40,
                  quote: fbParsed.evidence_sentence.substring(0, 250),
                  url: fbUrl,
                  match_reason: `LLM semantic: "${constraintValue}"`,
                  confidence: fbParsed.confidence || 'medium',
                  keyword_matched: null,
                }],
                pages_scanned: pagesWithText,
                constraint,
                no_evidence: false,
                extraction_method: 'keyword_sentence',
                phrase_targets: phraseTargets,
              };
            } else {
              console.log(`[EVIDENCE_EXTRACT_FALLBACK_LLM] "${leadName}" + "${constraintValue}" → NO MATCH via full-page LLM`);
            }
          } catch (fbErr: any) {
            console.warn(`[EVIDENCE_EXTRACT_FALLBACK_LLM] Failed for "${leadName}": ${fbErr.message}`);
          }
        }

        // If we get here, both keyword scan AND LLM fallback found nothing
        return {
          evidence_items: [],
          pages_scanned: pagesWithText,
          constraint,
          no_evidence: true,
          extraction_method: 'no_match',
          phrase_targets: phraseTargets,
        };
      }

      // LAYER 2 — gpt-4o judges the windows
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: openaiKey });

      const extracts = windows.map(w => w.text);

      console.log(`[EVIDENCE_EXTRACT_LLM] sending ${extracts.length} windows to gpt-4o for "${leadName}"`);

      const llmCallPromise = client.chat.completions.create({
        model: process.env.EVIDENCE_JUDGE_MODEL ?? 'gpt-4o-mini',
        temperature: 0.1,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are a strict evidence judge for a business lead finder. You will receive short extracts from a business website where a phrase was found. Decide if any extract genuinely proves this business offers or provides "${constraintValue}".\nRules:\n- A word in a brand name, product name, or unrelated context does not count\n- A phrase appearing in an unrelated context does not count\n- Generic lists do not count unless "${constraintValue}" is explicitly named within them\n- Only return sentences where a reasonable person would say this proves the business offers "${constraintValue}"\n- Do not force a match\nRespond with JSON only: {"evidence_sentences": ["..."]}. Return {"evidence_sentences": []} if nothing qualifies.`,
          },
          {
            role: 'user',
            content: JSON.stringify({ business_name: leadName, constraint: constraintValue, extracts }),
          },
        ],
      });

      const llmTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('LLM judge timeout after 6s')), 6000),
      );

      const response = await Promise.race([llmCallPromise, llmTimeoutPromise]);

      const raw = response.choices[0]?.message?.content?.trim() || '';
      const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const sentences: string[] = Array.isArray(parsed.evidence_sentences)
        ? parsed.evidence_sentences.filter((s: any) => typeof s === 'string' && s.length > 0).slice(0, maxItems)
        : [];

      if (sentences.length > 0) {
        console.log(`[EVIDENCE_EXTRACT_L2] "${leadName}" + "${constraintValue}" → ${sentences.length} sentence(s) approved by judge`);

        const llmItems: EvidenceItem[] = sentences.map(sentence => {
          const matchingWindow = windows.find(w =>
            w.text.toLowerCase().includes(sentence.toLowerCase().substring(0, 50)),
          );
          const url = matchingWindow?.url || windows[0]?.url || '';
          const sourceType = matchingWindow?.source_type || 'website';

          return {
            source_url: url,
            page_title: '',
            constraint_type: constraint.type,
            constraint_value: constraintValue,
            matched_phrase: constraintValue,
            direct_quote: sentence.substring(0, 250),
            context_snippet: sentence.substring(0, 300),
            constraint_match_reason: `LLM judge approved sentence as direct evidence of "${constraintValue}".`,
            source_type: sourceType,
            source_tier: mapSourceTypeToTier(sourceType),
            confidence_score: 0.85,
            quote: sentence.substring(0, 250),
            url,
            match_reason: `LLM judge: "${constraintValue}"`,
            confidence: 'high' as const,
            keyword_matched: constraintValue,
          };
        });

        return {
          evidence_items: llmItems,
          pages_scanned: pagesWithText,
          constraint,
          no_evidence: false,
          extraction_method: 'keyword_sentence',
          phrase_targets: phraseTargets,
        };
      } else {
        console.log(`[EVIDENCE_EXTRACT_L2] "${leadName}" + "${constraintValue}" → judge approved 0 sentences — no_evidence`);
        return {
          evidence_items: [],
          pages_scanned: pagesWithText,
          constraint,
          no_evidence: true,
          extraction_method: 'keyword_sentence',
          phrase_targets: phraseTargets,
        };
      }
    } catch (llmErr: any) {
      console.warn(`[EVIDENCE_EXTRACT_L2] LLM judge failed for "${leadName}" + "${constraintValue}" (falling back to keyword scoring): ${(llmErr as Error).message}`);
    }
  }
  console.log(`[EVIDENCE_EXTRACT_FALLBACK] "${leadName || 'unknown'}" + "${constraintValue}" → using keyword scoring (LLM unavailable)`);
  // === end two-layer extraction ===

  const allCandidates: Array<{
    quote: string;
    url: string;
    page_title: string;
    score: number;
    matchedKeyword: string | null;
    matchTier: SentenceScore['matchTier'];
    context_snippet: string;
    source_type: SourceType;
    full_text: string;
  }> = [];

  let pagesScanned = 0;

  for (const page of sortedPages) {
    const text = getPageText(page);
    if (!text || text.trim().length < 20) continue;
    pagesScanned++;

    const pageUrl = page.url || '';
    const sourceType = classifySourceType(pageUrl);

    const sentences = splitSentences(text);

    if (sentences.length > 0) {
      for (const sentence of sentences) {
        const result = isRelationship
          ? scoreRelationshipSentence(sentence, constraintValue, classifiedTargets)
          : scoreSentence(sentence, classifiedTargets, constraintValue, constraint.type);

        const minScore = isRelationship ? 3 : 2;
        if (result.score >= minScore) {
          const matchIdx = result.matchedKeyword
            ? text.toLowerCase().indexOf(result.matchedKeyword.toLowerCase())
            : text.toLowerCase().indexOf(sentence.toLowerCase().substring(0, 30));
          const contextSnippet = extractContextSnippet(text, matchIdx >= 0 ? matchIdx : 0);

          allCandidates.push({
            quote: sentence.substring(0, 250),
            url: pageUrl,
            page_title: page.title || '',
            score: result.score,
            matchedKeyword: result.matchedKeyword,
            matchTier: result.matchTier,
            context_snippet: contextSnippet,
            source_type: sourceType,
            full_text: text,
          });
        }
      }
    } else {
      for (let i = 0; i < text.length; i += 180) {
        const chunk = text.slice(i, i + 220).trim();
        if (chunk.length < 15) continue;
        const result = isRelationship
          ? scoreRelationshipSentence(chunk, constraintValue, classifiedTargets)
          : scoreSentence(chunk, classifiedTargets, constraintValue, constraint.type);

        const minScore = isRelationship ? 3 : 2;
        if (result.score >= minScore) {
          allCandidates.push({
            quote: chunk.substring(0, 250),
            url: pageUrl,
            page_title: page.title || '',
            score: result.score,
            matchedKeyword: result.matchedKeyword,
            matchTier: result.matchTier,
            context_snippet: chunk.substring(0, 300),
            source_type: sourceType,
            full_text: text,
          });
        }
      }
    }
  }

  if (webSearchSnippets && webSearchSnippets.length > 0) {
    for (const snippet of webSearchSnippets) {
      if (!snippet || snippet.trim().length < 10) continue;
      const result = isRelationship
        ? scoreRelationshipSentence(snippet, constraintValue, classifiedTargets)
        : scoreSentence(snippet, classifiedTargets, constraintValue, constraint.type);

      const minScore = isRelationship ? 3 : 2;
      if (result.score >= minScore) {
        allCandidates.push({
          quote: snippet.substring(0, 250),
          url: 'web_search_snippet',
          page_title: 'Web Search Result',
          score: result.score - 2,
          matchedKeyword: result.matchedKeyword,
          matchTier: result.matchTier,
          context_snippet: snippet.substring(0, 300),
          source_type: 'search_snippet' as SourceType,
          full_text: snippet,
        });
      }
    }
  }

  allCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const tierRank: Record<string, number> = { exact_value: 6, full_phrase: 5, synonym: 4, entity_expansion: 3, stem_only: 2, single_word: 1, none: 0 };
    return (tierRank[b.matchTier] || 0) - (tierRank[a.matchTier] || 0);
  });

  const seen = new Set<string>();
  const dedupedCandidates = allCandidates.filter(c => {
    const key = c.quote.toLowerCase().substring(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const topCandidates = dedupedCandidates.slice(0, maxItems);

  const evidenceItems: EvidenceItem[] = topCandidates.map(c => {
    const confidenceScore = computeConfidenceScore(
      c.score, c.matchedKeyword, constraintValue, c.source_type, c.matchTier, c.url, constraint.type,
    );

    const matchedPhrase = c.matchedKeyword || constraintValue;

    return {
      source_url: c.url,
      page_title: c.page_title,
      constraint_type: constraint.type,
      constraint_value: constraintValue,
      matched_phrase: matchedPhrase,
      direct_quote: c.quote,
      context_snippet: c.context_snippet,
      constraint_match_reason: buildConstraintMatchReason(constraint.type, constraintValue, matchedPhrase, c.matchTier),
      source_type: c.source_type,
      source_tier: mapSourceTypeToTier(c.source_type),
      confidence_score: confidenceScore,
      quote: c.quote,
      url: c.url,
      match_reason: buildMatchReason(c.matchedKeyword, constraint.type, c.matchTier),
      confidence: determineConfidence(c.score, c.matchTier, constraintValue),
      keyword_matched: c.matchedKeyword,
    };
  });

  const usedChunkFallback = allCandidates.length > 0 && sortedPages.every(page => {
    const text = getPageText(page);
    return splitSentences(text).length === 0;
  });

  const method: ConstraintLedExtractionResult['extraction_method'] =
    evidenceItems.length === 0 ? 'no_match' :
    usedChunkFallback ? 'keyword_chunk' :
    'keyword_sentence';

  return {
    evidence_items: evidenceItems,
    pages_scanned: pagesScanned,
    constraint,
    no_evidence: evidenceItems.length === 0,
    extraction_method: method,
    phrase_targets: phraseTargets,
  };
}
