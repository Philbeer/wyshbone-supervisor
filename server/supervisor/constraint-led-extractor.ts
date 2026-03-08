export interface ConstraintContext {
  type: string;
  field: string;
  operator: string;
  value: string;
  hardness: string;
}

export interface EvidenceItem {
  quote: string;
  url: string;
  page_title: string;
  constraint_type: string;
  constraint_value: string;
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

function buildKeywordSet(constraint: ConstraintContext): string[] {
  const value = constraint.value.toLowerCase().trim();
  const keywords: string[] = [value];

  for (const [key, synonyms] of Object.entries(SYNONYM_MAP)) {
    if (value.includes(key) || key.includes(value)) {
      for (const syn of synonyms) {
        if (!keywords.includes(syn.toLowerCase())) {
          keywords.push(syn.toLowerCase());
        }
      }
    }
  }

  const words = value.split(/\s+/).filter(w => w.length >= 4);
  for (const word of words) {
    if (!keywords.includes(word)) {
      keywords.push(word);
    }
  }

  return keywords;
}

function getPageText(page: PageInput): string {
  return page.text_clean || page.text || page.content || '';
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

export function extractConstraintLedEvidence(
  pages: PageInput[],
  constraint: ConstraintContext,
  webSearchSnippets?: string[],
  maxItems: number = 3,
): ConstraintLedExtractionResult {
  const keywords = buildKeywordSet(constraint);
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
  }> = [];

  let pagesScanned = 0;

  for (const page of sortedPages) {
    const text = getPageText(page);
    if (!text || text.trim().length < 20) continue;
    pagesScanned++;

    const sentences = splitSentences(text);

    if (sentences.length > 0) {
      for (const sentence of sentences) {
        const { score, matchedKeyword } = scoreSentence(sentence, keywords);
        if (score > 0) {
          allCandidates.push({
            quote: sentence.substring(0, 250),
            url: page.url || '',
            page_title: page.title || '',
            score,
            matchedKeyword,
          });
        }
      }
    } else {
      for (let i = 0; i < text.length; i += 180) {
        const chunk = text.slice(i, i + 220).trim();
        if (chunk.length < 15) continue;
        const { score, matchedKeyword } = scoreSentence(chunk, keywords);
        if (score > 0) {
          allCandidates.push({
            quote: chunk.substring(0, 250),
            url: page.url || '',
            page_title: page.title || '',
            score,
            matchedKeyword,
          });
        }
      }
    }
  }

  if (webSearchSnippets && webSearchSnippets.length > 0) {
    for (const snippet of webSearchSnippets) {
      if (!snippet || snippet.trim().length < 10) continue;
      const { score, matchedKeyword } = scoreSentence(snippet, keywords);
      if (score > 0) {
        allCandidates.push({
          quote: snippet.substring(0, 250),
          url: 'web_search_snippet',
          page_title: 'Web Search Result',
          score: score - 1,
          matchedKeyword,
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

  const evidenceItems: EvidenceItem[] = topCandidates.map(c => ({
    quote: c.quote,
    url: c.url,
    page_title: c.page_title,
    constraint_type: constraint.type,
    constraint_value: constraintValue,
    match_reason: buildMatchReason(c.matchedKeyword, constraint.type),
    confidence: determineConfidence(c.score, c.matchedKeyword, constraintValue),
    keyword_matched: c.matchedKeyword,
  }));

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
  };
}
