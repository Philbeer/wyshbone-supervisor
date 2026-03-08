export type RelationshipDirection = 'forward' | 'reverse';

export interface RelationshipEntity {
  label: string;
  raw: string;
  institutional_score: number;
}

export interface RelationshipDirectionResult {
  relationship_query: boolean;
  left_entity: RelationshipEntity | null;
  right_entity: RelationshipEntity | null;
  chosen_direction: RelationshipDirection;
  reason: string;
  reverse_search_queries: string[];
}

const AUTHORITY_PATTERNS: Array<{ pattern: RegExp; label: string; score: number }> = [
  { pattern: /\b(?:council|local\s+authority|borough|county\s+council|city\s+council|district\s+council|town\s+council|parish\s+council)\b/i, label: 'local_authority', score: 3 },
  { pattern: /\b(?:government|gov\.uk|central\s+government|ministry|department\s+of|cabinet\s+office|hmrc|home\s+office)\b/i, label: 'government', score: 3 },
  { pattern: /\b(?:nhs|national\s+health\s+service|nhs\s+trust|clinical\s+commissioning|icb|health\s+board)\b/i, label: 'nhs', score: 3 },
  { pattern: /\b(?:university|universities|polytechnic|college|academic\s+institution)\b/i, label: 'university', score: 3 },
  { pattern: /\b(?:regulator|regulatory\s+body|ofsted|ofcom|ofgem|fca|cqc|hse|environment\s+agency)\b/i, label: 'regulator', score: 3 },
  { pattern: /\b(?:public\s+body|quango|arms?\s+length\s+body|executive\s+agency|ndpb)\b/i, label: 'public_body', score: 3 },
  { pattern: /\b(?:police|fire\s+service|ambulance\s+service|emergency\s+services?)\b/i, label: 'emergency_services', score: 3 },
  { pattern: /\b(?:school|academy|trust|multi-?academy\s+trust|mat)\b/i, label: 'education_trust', score: 3 },
  { pattern: /\b(?:housing\s+association|social\s+housing|registered\s+provider)\b/i, label: 'housing_association', score: 3 },
  { pattern: /\b(?:major\s+retailer|supermarket|tesco|sainsbury|asda|morrisons|waitrose|marks\s+and\s+spencer|m&s)\b/i, label: 'major_retailer', score: 2 },
  { pattern: /\b(?:large\s+corporate|multinational|plc|ftse|fortune\s+500)\b/i, label: 'large_corporate', score: 2 },
  { pattern: /\b(?:national\s+charity|major\s+charity|oxfam|red\s+cross|cancer\s+research|british\s+heart)\b/i, label: 'national_charity', score: 2 },
  { pattern: /\b(?:major\s+brand|global\s+brand|national\s+brand)\b/i, label: 'major_brand', score: 2 },
  { pattern: /\b(?:network\s+rail|transport\s+for|tfl|national\s+trust|english\s+heritage|historic\s+england)\b/i, label: 'national_body', score: 2 },
  { pattern: /\b(?:developer|property\s+developer|construction\s+company|building\s+contractor)\b/i, label: 'developer', score: 2 },
];

const DEFAULT_ENTITY_SCORE = 1;

const DIRECTIONAL_PREDICATES: Record<string, 'toward_right' | 'toward_left' | 'neutral'> = {
  'works with': 'neutral',
  'work with': 'neutral',
  'working with': 'neutral',
  'partners with': 'neutral',
  'partner with': 'neutral',
  'partnering with': 'neutral',
  'supplies': 'toward_right',
  'supply': 'toward_right',
  'supplying': 'toward_right',
  'sells to': 'toward_right',
  'sell to': 'toward_right',
  'delivers to': 'toward_right',
  'deliver to': 'toward_right',
  'provides services to': 'toward_right',
  'provide services to': 'toward_right',
  'serves': 'toward_right',
  'serve': 'toward_right',
  'serving': 'toward_right',
  'vendors to': 'toward_right',
  'vendor to': 'toward_right',
  'contracted by': 'toward_left',
  'contracted to': 'toward_right',
  'commissioned by': 'toward_left',
  'funded by': 'toward_left',
  'supported by': 'toward_left',
  'engaged by': 'toward_left',
  'hired by': 'toward_left',
  'retained by': 'toward_left',
  'appointed by': 'toward_left',
  'owned by': 'toward_left',
  'run by': 'toward_left',
  'operated by': 'toward_left',
  'managed by': 'toward_left',
  'part of': 'toward_left',
  'clients of': 'toward_left',
  'client of': 'toward_left',
  'member of': 'toward_left',
  'supports': 'toward_right',
  'support': 'toward_right',
  'supporting': 'toward_right',
  'collaborates with': 'neutral',
  'collaborates_with': 'neutral',
  'contractor to': 'toward_right',
};

function scoreEntity(raw: string): RelationshipEntity {
  const text = raw.trim();
  let bestScore = DEFAULT_ENTITY_SCORE;
  let bestLabel = 'general';

  for (const entry of AUTHORITY_PATTERNS) {
    if (entry.pattern.test(text)) {
      if (entry.score > bestScore) {
        bestScore = entry.score;
        bestLabel = entry.label;
      }
    }
  }

  return {
    label: bestLabel,
    raw: text,
    institutional_score: bestScore,
  };
}

function buildReverseSearchQueries(
  rightEntity: RelationshipEntity,
  leftEntityCategory: string,
  predicate: string,
): string[] {
  const target = rightEntity.raw;
  const queries: string[] = [];

  queries.push(`"${target}" partners ${leftEntityCategory}`);
  queries.push(`"${target}" "work with" ${leftEntityCategory}`);
  queries.push(`"${target}" ${leftEntityCategory}`);
  queries.push(`"${target}" "in partnership with" ${leftEntityCategory}`);

  if (/\b(?:council|authority|government|nhs|university|public\s+body)\b/i.test(target)) {
    queries.push(`site:gov.uk "${target}" ${leftEntityCategory}`);
    queries.push(`"${target}" community ${leftEntityCategory}`);
  }

  return queries.slice(0, 5);
}

export function analyseRelationshipDirection(
  entityCategory: string,
  relationshipTarget: string | null,
  detectedPredicate: string | null,
): RelationshipDirectionResult {
  if (!relationshipTarget || !detectedPredicate) {
    return {
      relationship_query: false,
      left_entity: null,
      right_entity: null,
      chosen_direction: 'forward',
      reason: 'No relationship target or predicate detected — using default forward direction.',
      reverse_search_queries: [],
    };
  }

  const leftEntity = scoreEntity(entityCategory);
  const rightEntity = scoreEntity(relationshipTarget);

  const predicateDirection = DIRECTIONAL_PREDICATES[detectedPredicate.toLowerCase()] ?? 'neutral';

  let directionScore = rightEntity.institutional_score - leftEntity.institutional_score;

  if (predicateDirection === 'toward_right') {
    directionScore += 1;
  } else if (predicateDirection === 'toward_left') {
    directionScore -= 1;
  }

  const DIRECTION_THRESHOLD = 1;

  let chosenDirection: RelationshipDirection;
  let reason: string;
  let reverseQueries: string[] = [];

  if (directionScore >= DIRECTION_THRESHOLD) {
    chosenDirection = 'reverse';
    reason = `"${rightEntity.raw}" (${rightEntity.label}, score=${rightEntity.institutional_score}) is more likely to publish evidence of the relationship than "${leftEntity.raw}" (${leftEntity.label}, score=${leftEntity.institutional_score}). Predicate "${detectedPredicate}" direction: ${predicateDirection}. Searching from the right entity first.`;
    reverseQueries = buildReverseSearchQueries(rightEntity, entityCategory, detectedPredicate);
  } else if (directionScore <= -DIRECTION_THRESHOLD) {
    chosenDirection = 'forward';
    reason = `"${leftEntity.raw}" (${leftEntity.label}, score=${leftEntity.institutional_score}) is equally or more likely to publish evidence. Predicate "${detectedPredicate}" direction: ${predicateDirection}. Using standard forward search.`;
  } else {
    chosenDirection = 'forward';
    reason = `Both entities have similar institutional scores (left=${leftEntity.institutional_score}, right=${rightEntity.institutional_score}). Predicate "${detectedPredicate}" direction: ${predicateDirection}. Falling back to standard forward search.`;
  }

  return {
    relationship_query: true,
    left_entity: leftEntity,
    right_entity: rightEntity,
    chosen_direction: chosenDirection,
    reason,
    reverse_search_queries: reverseQueries,
  };
}
