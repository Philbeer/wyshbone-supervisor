export const RELATIONSHIP_PREDICATES = [
  'works with',
  'work with',
  'working with',
  'supplies',
  'supply',
  'supplying',
  'serves',
  'serve',
  'serving',
  'partners with',
  'partner with',
  'partnering with',
  'supports',
  'support',
  'supporting',
  'clients of',
  'client of',
  'vendors to',
  'vendor to',
  'contracted by',
  'contracted to',
  'provides services to',
  'provide services to',
  'delivers to',
  'deliver to',
  'sells to',
  'sell to',
  'engaged by',
  'hired by',
  'retained by',
  'commissioned by',
  'appointed by',
  'owned by',
  'run by',
  'operated by',
  'managed by',
  'part of',
] as const;

export const RELATIONSHIP_ROLE_PATTERNS = [
  /\b(?:the\s+)?(?:landlord)(?:\s+(?:name|of|for))?\b/i,
  /\b(?:the\s+)?(?:owner)(?:\s+(?:name|of|for))?\b/i,
  /\b(?:the\s+)?(?:manager)(?:\s+(?:name|of|for))?\b/i,
  /\b(?:the\s+)?(?:operator)(?:\s+(?:name|of|for))?\b/i,
  /\b(?:the\s+)?(?:contact\s+person)(?:\s+(?:name|of|for))?\b/i,
  /\b(?:the\s+)?(?:decision\s+maker)(?:\s+(?:name|of|for))?\b/i,
  /\b(?:the\s+)?(?:gm|general\s+manager)(?:\s+(?:name|of|for))?\b/i,
  /\b(?:the\s+)?(?:head\s+brewer)(?:\s+(?:name|of|for))?\b/i,
  /\b(?:the\s+)?(?:practice\s+manager)(?:\s+(?:name|of|for))?\b/i,
  /\bfreehouse\b/i,
  /\bfree\s+house\b/i,
  /\btied\s+house\b/i,
  /\bgroup\b(?:\s+(?:that|which|who))?\b/i,
  /\bchain\b(?:\s+(?:that|which|who))?\b/i,
] as const;

export function detectRelationshipRole(userMessage: string): { detected: boolean; role: string | null } {
  const msgLower = userMessage.toLowerCase().trim();
  for (const pattern of RELATIONSHIP_ROLE_PATTERNS) {
    const match = msgLower.match(pattern);
    if (match) {
      return { detected: true, role: match[0].trim() };
    }
  }
  return { detected: false, role: null };
}

export interface RelationshipPredicateResult {
  requires_relationship_evidence: boolean;
  detected_predicate: string | null;
  relationship_target: string | null;
}

export function detectRelationshipPredicate(userMessage: string): RelationshipPredicateResult {
  const msgLower = userMessage.toLowerCase().trim();

  for (const predicate of RELATIONSHIP_PREDICATES) {
    const idx = msgLower.indexOf(predicate);
    if (idx === -1) continue;

    const afterPredicate = msgLower.slice(idx + predicate.length).trim();
    const target = afterPredicate
      .replace(/^(the|a|an)\s+/i, '')
      .split(/[,.;!?\n]/)[0]
      .trim() || null;

    return {
      requires_relationship_evidence: true,
      detected_predicate: predicate,
      relationship_target: target,
    };
  }

  return {
    requires_relationship_evidence: false,
    detected_predicate: null,
    relationship_target: null,
  };
}

export type RelationshipVerdict = 'yes' | 'no' | 'unknown';

export interface RelationshipEvidenceEntry {
  lead_place_id: string;
  lead_name: string;
  verdict: RelationshipVerdict;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  evidence_url: string | null;
  evidence_quote: string | null;
}

export interface RelationshipEvidenceSummary {
  requires_relationship_evidence: boolean;
  detected_predicate: string | null;
  relationship_target: string | null;
  verified_relationship_count: number;
  unverified_relationship_count: number;
  total_candidates: number;
  per_lead: RelationshipEvidenceEntry[];
}

export function buildRelationshipSummary(
  predicateResult: RelationshipPredicateResult,
  evidenceEntries: RelationshipEvidenceEntry[],
  totalCandidates: number,
): RelationshipEvidenceSummary {
  const verified = evidenceEntries.filter(e => e.verdict === 'yes').length;
  const unverified = totalCandidates - verified;

  return {
    requires_relationship_evidence: predicateResult.requires_relationship_evidence,
    detected_predicate: predicateResult.detected_predicate,
    relationship_target: predicateResult.relationship_target,
    verified_relationship_count: verified,
    unverified_relationship_count: unverified,
    total_candidates: totalCandidates,
    per_lead: evidenceEntries,
  };
}

export function buildRelationshipDeliveryLanguage(
  summary: RelationshipEvidenceSummary,
): { honest_label: string; stop_reason: string | null } {
  if (!summary.requires_relationship_evidence) {
    return { honest_label: 'results', stop_reason: null };
  }

  const target = summary.relationship_target || 'the specified entity';
  const predicate = summary.detected_predicate || 'works with';

  if (summary.verified_relationship_count === 0) {
    return {
      honest_label: `candidates associated with ${target}`,
      stop_reason: `Relationship "${predicate} ${target}" could not be verified for any result. All ${summary.total_candidates} results are candidates only — no evidence of the stated relationship was found.`,
    };
  }

  if (summary.verified_relationship_count < summary.total_candidates) {
    return {
      honest_label: `results (${summary.verified_relationship_count} verified, ${summary.unverified_relationship_count} unverified)`,
      stop_reason: `Only ${summary.verified_relationship_count} of ${summary.total_candidates} results have verified evidence of "${predicate} ${target}". Remaining results are candidates only.`,
    };
  }

  return { honest_label: 'verified results', stop_reason: null };
}

const DISHONEST_MATCH_PATTERNS = [
  /\b(?:found|delivered|discovered|located|identified)\b.*?\b(?:match(?:es|ing)?|meet(?:s|ing)?\s+(?:your\s+)?criteria)\b/i,
  /\b(?:these|the|all)\s+(?:organisations?|companies?|businesses?|results?)\s+(?:match|meet|satisfy|fulfil)/i,
  /\bmatching\s+(?:your\s+)?(?:criteria|requirements|request)/i,
];

export function sanitizeRelationshipMessage(
  msg: string,
  summary: RelationshipEvidenceSummary,
): string {
  if (!summary.requires_relationship_evidence) return msg;
  if (summary.verified_relationship_count > 0 && summary.verified_relationship_count >= summary.total_candidates) return msg;

  for (const pattern of DISHONEST_MATCH_PATTERNS) {
    if (pattern.test(msg)) {
      const target = summary.relationship_target || 'the specified entity';
      const predicate = summary.detected_predicate || 'works with';
      if (summary.verified_relationship_count === 0) {
        return `I found organisations associated with ${target}, but could not verify that they ${predicate} ${target}. No relationship evidence could be confirmed. All results are candidates only.`;
      }
      return `I found ${summary.total_candidates} candidates. ${summary.verified_relationship_count} have verified evidence of the "${predicate} ${target}" relationship; the rest are unverified candidates.`;
    }
  }

  return msg;
}
