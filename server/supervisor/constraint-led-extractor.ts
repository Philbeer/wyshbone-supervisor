export interface ConstraintContext {
  type: string;
  field: string;
  operator: string;
  value: string;
  hardness: string;
}

export type SourceType = 'website' | 'search_snippet' | 'gov_page' | 'social_media' | 'directory' | 'unknown';

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

const EVIDENCE_PAGE_BIAS: Record<string, RegExp[]> = {
  website_evidence: [
    /\/events?\b/i, /\/whats.?on\b/i, /\/live.?music\b/i, /\/entertainment\b/i,
    /\/menu\b/i, /\/food\b/i, /\/drinks?\b/i, /\/services?\b/i,
    /\/about\b/i, /\/facilities\b/i,
  ],
  relationship_check: [
    /\/about\b/i, /\/partners?\b/i, /\/projects?\b/i, /\/services?\b/i,
    /\/news\b/i, /\/clients?\b/i, /\/who.?we.?work.?with\b/i, /\/case.?stud/i,
  ],
  status_check: [
    /\/services?\b/i, /\/about\b/i, /\/contact\b/i, /\/book/i,
    /\/appointments?\b/i, /\/register\b/i, /\/patients?\b/i,
  ],
  attribute_check: [
    /\/about\b/i, /\/facilities\b/i, /\/amenities\b/i, /\/features?\b/i,
    /\/access/i, /\/info/i,
  ],
};

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

export function generatePhraseTargets(constraint: ConstraintContext): string[] {
  const value = constraint.value.toLowerCase().trim();
  const targets: string[] = [value];

  for (const [key, synonyms] of Object.entries(SYNONYM_MAP)) {
    if (value.includes(key) || key.includes(value)) {
      for (const syn of synonyms) {
        if (!targets.includes(syn.toLowerCase())) {
          targets.push(syn.toLowerCase());
        }
      }
    }
  }

  if (constraint.type === 'relationship_check') {
    for (const [entityKey, expansions] of Object.entries(ENTITY_EXPANSION_PATTERNS)) {
      if (value.includes(entityKey) || entityKey.includes(value)) {
        for (const expansion of expansions) {
          if (!targets.includes(expansion.toLowerCase())) {
            targets.push(expansion.toLowerCase());
          }
        }
      }
    }

    for (const [, predicates] of Object.entries(RELATIONSHIP_PREDICATES)) {
      for (const pred of predicates) {
        if (value.includes(pred.split(' ')[0])) {
          for (const variant of predicates) {
            if (!targets.includes(variant.toLowerCase())) {
              targets.push(variant.toLowerCase());
            }
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
          if (!targets.includes(expansion.toLowerCase())) {
            targets.push(expansion.toLowerCase());
          }
        }
      }
    }
  }

  const words = value.split(/\s+/).filter(w => w.length >= 4);
  for (const word of words) {
    if (!targets.includes(word)) {
      targets.push(word);
    }
  }

  const hyphenated = value.replace(/\s+/g, '-');
  if (hyphenated !== value && !targets.includes(hyphenated)) {
    targets.push(hyphenated);
  }
  const dehyphenated = value.replace(/-/g, ' ');
  if (dehyphenated !== value && !targets.includes(dehyphenated)) {
    targets.push(dehyphenated);
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

function scorePageRelevance(page: PageInput, constraintType: string): number {
  let score = 0;
  const url = (page.url || '').toLowerCase();
  const biases = EVIDENCE_PAGE_BIAS[constraintType] || [];

  for (const pattern of biases) {
    if (pattern.test(url)) {
      score += 5;
      break;
    }
  }

  if (page.page_type === 'home') score += 1;

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
  const contextRadius = 80;
  const start = Math.max(0, matchIndex - contextRadius);
  const end = Math.min(text.length, matchIndex + contextRadius);

  let snippet = text.slice(start, end).trim();

  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';

  return snippet;
}

function scoreSentence(sentence: string, keywords: string[]): { score: number; matchedKeyword: string | null } {
  const lower = sentence.toLowerCase();
  let score = 0;
  let bestMatch: string | null = null;

  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    if (lower.includes(kwLower)) {
      const kwWordCount = kwLower.split(/\s+/).length;
      score += kwWordCount >= 2 ? 5 : 3;

      const idx = lower.indexOf(kwLower);
      if (idx < lower.length * 0.4) score += 1;

      if (!bestMatch || kw.length > bestMatch.length) {
        bestMatch = kw;
      }
    }
  }

  const wordCount = sentence.split(/\s+/).length;
  if (wordCount >= 5 && wordCount <= 40) score += 1;
  if (wordCount < 5 || wordCount > 60) score -= 1;

  return { score, matchedKeyword: bestMatch };
}

function computeConfidenceScore(
  score: number,
  matchedKeyword: string | null,
  constraintValue: string,
  sourceType: SourceType,
): number {
  let base = Math.min(score / 10, 1.0);

  if (matchedKeyword && matchedKeyword.toLowerCase() === constraintValue.toLowerCase()) {
    base = Math.min(base + 0.2, 1.0);
  }

  if (sourceType === 'search_snippet') base *= 0.5;
  if (sourceType === 'gov_page') base = Math.min(base + 0.05, 1.0);

  return Math.round(base * 100) / 100;
}

function determineConfidence(
  score: number,
  matchedKeyword: string | null,
  constraintValue: string,
): 'high' | 'medium' | 'low' {
  if (matchedKeyword && matchedKeyword.toLowerCase() === constraintValue.toLowerCase() && score >= 5) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

function buildMatchReason(matchedKeyword: string | null, constraintType: string): string {
  if (!matchedKeyword) return `relevant to ${constraintType} constraint`;
  return `contains "${matchedKeyword}" phrase`;
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
): string {
  const phraseLC = matchedPhrase.toLowerCase();
  const valueLC = constraintValue.toLowerCase();
  const constraintLabel = CONSTRAINT_TYPE_LABELS[constraintType] || constraintType.replace(/_/g, ' ');

  if (phraseLC === valueLC) {
    return `Quote explicitly contains the phrase '${matchedPhrase}', satisfying the ${constraintLabel} constraint.`;
  }

  const entityTarget = constraintType === 'relationship_check'
    ? extractEntityFromConstraintValue(constraintValue)
    : constraintValue;
  const entityTargetLC = entityTarget.toLowerCase();

  for (const [entityKey, expansions] of Object.entries(ENTITY_EXPANSION_PATTERNS)) {
    if (entityTargetLC.includes(entityKey) || entityKey.includes(entityTargetLC)) {
      for (const expansion of expansions) {
        if (phraseLC.includes(expansion.toLowerCase())) {
          if (constraintType === 'relationship_check') {
            return `Quote mentions '${matchedPhrase}', an entity expansion of '${entityTarget}', supporting the relationship constraint '${constraintValue}'.`;
          }
          return `'${matchedPhrase}' is a type of ${entityTarget}, satisfying the ${constraintLabel} constraint.`;
        }
      }
    }
  }

  for (const [key] of Object.entries(SYNONYM_MAP)) {
    if (valueLC.includes(key) || key.includes(valueLC)) {
      const synonyms = SYNONYM_MAP[key];
      if (synonyms.some(s => phraseLC.includes(s.toLowerCase()))) {
        return `'${matchedPhrase}' is a synonym or variant of '${constraintValue}', satisfying the ${constraintLabel} constraint.`;
      }
    }
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

export function extractConstraintLedEvidence(
  pages: PageInput[],
  constraint: ConstraintContext,
  webSearchSnippets?: string[],
  maxItems: number = 3,
): ConstraintLedExtractionResult {
  const phraseTargets = generatePhraseTargets(constraint);
  const constraintValue = constraint.value;

  const sortedPages = [...pages].sort(
    (a, b) => scorePageRelevance(b, constraint.type) - scorePageRelevance(a, constraint.type),
  );

  const allCandidates: Array<{
    quote: string;
    url: string;
    page_title: string;
    score: number;
    matchedKeyword: string | null;
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
        const { score, matchedKeyword } = scoreSentence(sentence, phraseTargets);
        if (score > 0) {
          const matchIdx = matchedKeyword
            ? text.toLowerCase().indexOf(matchedKeyword.toLowerCase())
            : text.toLowerCase().indexOf(sentence.toLowerCase().substring(0, 30));
          const contextSnippet = extractContextSnippet(text, matchIdx >= 0 ? matchIdx : 0);

          allCandidates.push({
            quote: sentence.substring(0, 250),
            url: pageUrl,
            page_title: page.title || '',
            score,
            matchedKeyword,
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
        const { score, matchedKeyword } = scoreSentence(chunk, phraseTargets);
        if (score > 0) {
          allCandidates.push({
            quote: chunk.substring(0, 250),
            url: pageUrl,
            page_title: page.title || '',
            score,
            matchedKeyword,
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
      const { score, matchedKeyword } = scoreSentence(snippet, phraseTargets);
      if (score > 0) {
        allCandidates.push({
          quote: snippet.substring(0, 250),
          url: 'web_search_snippet',
          page_title: 'Web Search Result',
          score: score - 1,
          matchedKeyword,
          context_snippet: snippet.substring(0, 300),
          source_type: 'search_snippet' as SourceType,
          full_text: snippet,
        });
      }
    }
  }

  allCandidates.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const dedupedCandidates = allCandidates.filter(c => {
    const key = c.quote.toLowerCase().substring(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const topCandidates = dedupedCandidates.slice(0, maxItems);

  const evidenceItems: EvidenceItem[] = topCandidates.map(c => {
    const confidenceScore = computeConfidenceScore(c.score, c.matchedKeyword, constraintValue, c.source_type);

    const matchedPhrase = c.matchedKeyword || constraintValue;

    return {
      source_url: c.url,
      page_title: c.page_title,
      constraint_type: constraint.type,
      constraint_value: constraintValue,
      matched_phrase: matchedPhrase,
      direct_quote: c.quote,
      context_snippet: c.context_snippet,
      constraint_match_reason: buildConstraintMatchReason(constraint.type, constraintValue, matchedPhrase),
      source_type: c.source_type,
      confidence_score: confidenceScore,
      quote: c.quote,
      url: c.url,
      match_reason: buildMatchReason(c.matchedKeyword, constraint.type),
      confidence: determineConfidence(c.score, c.matchedKeyword, constraintValue),
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
