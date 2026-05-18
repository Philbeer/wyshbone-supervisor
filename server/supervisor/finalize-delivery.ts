/**
 * SINGLE SOURCE OF TRUTH for verified lead delivery.
 *
 * Every executor that produces leads MUST call finalizeDelivery() to produce
 * the canonical delivered set. The returned FinalizedDelivery object is the
 * ONLY thing downstream consumers (delivery-summary, response-builder, UI,
 * behaviour judge, AFR) should read from for count, list, and verification.
 *
 * Rule: a lead appears in finalizedDelivery.verifiedLeads if and only if its
 * per-constraint Tower verification rollup is exactly 'verified'. Anything
 * else (weak_match, no_evidence, insufficient_evidence) is dropped.
 *
 * For queries with no Tower-judged constraints (pure location/category), the
 * executor has already filtered upstream — the lead defaults to verified.
 */

import type { StructuredConstraintPayload } from './mission-executor';

export type RollupStatus = 'verified' | 'weak_match' | 'no_evidence';

export type EvidenceVerificationStatus =
  | 'verified'
  | 'weak_match'
  | 'no_evidence'
  | 'insufficient_evidence'
  | 'proxy';

// Constraint types that Tower judges per-lead. Other types (text_compare,
// numeric_range, location_constraint, ranking) are handled structurally
// upstream and do not contribute to the rollup.
export const TOWER_JUDGED_CONSTRAINT_TYPES = new Set([
  'attribute_check',
  'website_evidence',
  'relationship_check',
  'time_constraint',
  'time_predicate',
  'status_check',
]);

export interface PerConstraintVerification {
  constraint_type: string;
  constraint_value: string;
  tower_status: EvidenceVerificationStatus | null;
  tower_confidence: number | null;
  tower_reasoning: string | null;
  source_url: string | null;
  quote: string | null;
}

export interface RawLeadInput {
  name: string;
  address: string;
  phone?: string | null;
  website?: string | null;
  placeId: string;
  source: string;
  executor_confidence?: 'high' | 'medium' | 'low' | null;
  verifications: PerConstraintVerification[];
}

export interface FinalizedLead {
  entity_id: string;
  name: string;
  address: string;
  phone: string | null;
  website: string | null;
  placeId: string;
  source: string;
  status: 'verified';
  match_evidence: Array<{
    constraint_type: string;
    constraint_value: string;
    source_url: string | null;
    quote: string | null;
    matched_phrase: string | null;
    context_snippet: string | null;
    confidence: number;
    verification_status: 'verified' | 'weak_match' | 'proxy';
  }>;
  supporting_evidence: Array<{
    entity_name: string;
    constraint_type: string;
    constraint_value: string;
    source_url: string | null;
    source_type: string | null;
    quote: string | null;
    matched_phrase: string | null;
    context_snippet: string | null;
    verification_status: 'verified' | 'weak_match' | 'proxy' | 'no_relevant_evidence';
    confidence: number;
  }>;
  match_summary: string;
  match_valid: true;
}

export interface DroppedLead {
  name: string;
  placeId: string;
  rollup_status: 'weak_match' | 'no_evidence';
  failed_constraints: string[];
  reasoning: string;
  negation_exclusion?: boolean;
}

export interface FinalizedDelivery {
  verifiedLeads: FinalizedLead[];
  dropped: DroppedLead[];
  count: number;
  totalCandidates: number;
  requestedCount: number | null;
  hasTowerJudgedConstraints: boolean;
}

export interface FinalizeDeliveryInput {
  leads: RawLeadInput[];
  structuredConstraints: StructuredConstraintPayload[];
  requestedCount: number | null;
}

/**
 * Compute the rollup status for a single lead based on its per-constraint
 * Tower verifications.
 *
 * Rules:
 *  - If lead has zero tower-judged constraints AND no verifications:
 *    fall back to executor_confidence (high=verified, medium=weak_match, low=no_evidence)
 *  - If any constraint returned 'no_evidence' or 'insufficient_evidence': no_evidence
 *  - If ALL applicable constraints returned 'verified': verified
 *  - Otherwise (mix of verified + weak_match, or any weak_match): weak_match
 */
export function computeRollup(
  lead: RawLeadInput,
  towerJudgedConstraintCount: number,
): RollupStatus {
  const towerJudgedVerifications = lead.verifications.filter(v =>
    TOWER_JUDGED_CONSTRAINT_TYPES.has(v.constraint_type)
  );

  // Case 1: no tower-judged constraints exist for this query at all.
  // Executor has filtered upstream; trust the executor.
  if (towerJudgedConstraintCount === 0) {
    if (!lead.executor_confidence) return 'verified';
    if (lead.executor_confidence === 'high') return 'verified';
    if (lead.executor_confidence === 'medium') return 'weak_match';
    return 'no_evidence';
  }

  // Case 2: tower-judged constraints exist but this lead has no verifications
  // for them (executor didn't run them). Treat as no_evidence — we can't claim verified.
  if (towerJudgedVerifications.length === 0) {
    return 'no_evidence';
  }

  // Case 3: any explicit failure → no_evidence
  const hasFailure = towerJudgedVerifications.some(
    v => v.tower_status === 'no_evidence' || v.tower_status === 'insufficient_evidence'
  );
  if (hasFailure) return 'no_evidence';

  // Case 4: any constraint missing a verdict → conservative no_evidence
  const hasUnverdicted = towerJudgedVerifications.some(v => v.tower_status === null);
  if (hasUnverdicted) return 'no_evidence';

  // Case 5: all constraints fully verified → verified
  const allVerified = towerJudgedVerifications.every(v => v.tower_status === 'verified');
  if (allVerified) return 'verified';

  // Case 6: mix of verified and weak_match (no failures) → weak_match
  return 'weak_match';
}

/**
 * Returns true if a constraint operator is a negation (not_*) operator.
 * These constraints require STRICT inverse semantics: Tower `verified` or
 * `weak_match` means the forbidden thing was found → lead is excluded.
 * Only Tower `no_evidence` or `insufficient_evidence` lets the lead through.
 */
function isNegationOperator(operator: string): boolean {
  return operator.startsWith('not_');
}

/**
 * Build a lookup keyed by (constraint_type + ':' + constraint_value) for
 * every hard, Tower-judged constraint so we can resolve operator during flip.
 * When multiple constraints share the same type+value pair, the last one wins
 * (edge case — in practice they should be unique).
 */
function buildNegationOperatorMap(
  structuredConstraints: StructuredConstraintPayload[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of structuredConstraints) {
    if (c.hardness === 'hard' && TOWER_JUDGED_CONSTRAINT_TYPES.has(c.type)) {
      const key = `${c.type}:${String(c.value ?? '')}`;
      map.set(key, c.operator);
    }
  }
  return map;
}

/**
 * Apply the negation flip to a single verification's tower_status.
 *
 * STRICT negation semantics (operator starts with "not_"):
 *   Tower verified          → FAILED  (forbidden thing was found)
 *   Tower weak_match        → FAILED  (strict mode — any evidence of it fails)
 *   Tower no_evidence       → PASSED  (nothing found — lead is clean)
 *   Tower insufficient_evidence → PASSED (benefit of the doubt)
 *
 * Positive semantics are unchanged (returns status as-is).
 */
function applyNegationFlip(
  status: EvidenceVerificationStatus | null,
  operator: string,
): EvidenceVerificationStatus | null {
  if (!isNegationOperator(operator)) return status;
  switch (status) {
    case 'verified':
    case 'weak_match':
      return 'no_evidence';
    case 'no_evidence':
    case 'insufficient_evidence':
      return 'verified';
    default:
      return status;
  }
}

export function finalizeDelivery(input: FinalizeDeliveryInput): FinalizedDelivery {
  const towerJudgedConstraints = input.structuredConstraints.filter(
    c => c.hardness === 'hard' && TOWER_JUDGED_CONSTRAINT_TYPES.has(c.type)
  );
  const towerJudgedConstraintCount = towerJudgedConstraints.length;
  const hasTowerJudgedConstraints = towerJudgedConstraintCount > 0;

  const negationOperatorMap = buildNegationOperatorMap(input.structuredConstraints);

  const verifiedLeads: FinalizedLead[] = [];
  const dropped: DroppedLead[] = [];

  for (const lead of input.leads) {
    // Apply negation flip: rewrite tower_status for verifications whose
    // matching constraint uses a not_* operator before computing rollup.
    const flippedLead: RawLeadInput = {
      ...lead,
      verifications: lead.verifications.map(v => {
        const key = `${v.constraint_type}:${v.constraint_value}`;
        const operator = negationOperatorMap.get(key);
        if (!operator || !isNegationOperator(operator)) return v;
        const flipped = applyNegationFlip(v.tower_status, operator);
        return flipped === v.tower_status ? v : { ...v, tower_status: flipped };
      }),
    };

    const rollup = computeRollup(flippedLead, towerJudgedConstraintCount);

    if (rollup !== 'verified') {
      // Identify which constraints caused the drop, noting negation exclusions.
      const failedVerifications = flippedLead.verifications.filter(v =>
        TOWER_JUDGED_CONSTRAINT_TYPES.has(v.constraint_type) &&
        (v.tower_status === 'no_evidence' ||
          v.tower_status === 'insufficient_evidence' ||
          v.tower_status === 'weak_match' ||
          v.tower_status === null)
      );

      const failedConstraints = failedVerifications.map(v => v.constraint_value);

      // Check if any failing constraint was a negation (original status was
      // verified/weak_match but got flipped to no_evidence).
      const negationFailures = failedVerifications.filter(v => {
        const key = `${v.constraint_type}:${v.constraint_value}`;
        const operator = negationOperatorMap.get(key);
        return operator && isNegationOperator(operator);
      });

      const isNegationExclusion = negationFailures.length > 0;

      let reasoning: string;
      if (isNegationExclusion) {
        const details = negationFailures
          .map(v => {
            const key = `${v.constraint_type}:${v.constraint_value}`;
            const operator = negationOperatorMap.get(key) ?? 'not_*';
            return `excluded by negation constraint: ${operator} ${v.constraint_value}`;
          })
          .join('; ');
        reasoning = details;
      } else {
        const firstReasoning = lead.verifications.find(v => v.tower_reasoning)?.tower_reasoning;
        reasoning = firstReasoning || `Lead rollup was ${rollup}, not verified`;
      }

      dropped.push({
        name: lead.name,
        placeId: lead.placeId,
        rollup_status: rollup,
        failed_constraints: failedConstraints,
        reasoning,
        ...(isNegationExclusion ? { negation_exclusion: true } : {}),
      });
      continue;
    }

    // Lead is verified — build canonical FinalizedLead using flipped verifications
    // so negation constraints that passed (no_evidence → verified) appear correctly.
    const matchEvidence = flippedLead.verifications
      .filter(v =>
        TOWER_JUDGED_CONSTRAINT_TYPES.has(v.constraint_type) &&
        v.tower_status === 'verified'
      )
      .map(v => ({
        constraint_type: v.constraint_type,
        constraint_value: v.constraint_value,
        source_url: v.source_url,
        quote: v.quote,
        matched_phrase: v.constraint_value,
        context_snippet: v.quote,
        confidence: v.tower_confidence ?? 0.85,
        verification_status: 'verified' as const,
      }));

    const supportingEvidence = matchEvidence.map(me => ({
      entity_name: lead.name,
      constraint_type: me.constraint_type,
      constraint_value: me.constraint_value,
      source_url: me.source_url,
      source_type: lead.source,
      quote: me.quote,
      matched_phrase: me.matched_phrase,
      context_snippet: me.context_snippet,
      verification_status: 'verified' as const,
      confidence: me.confidence,
    }));

    const summary = matchEvidence.length > 0
      ? `Verified via ${lead.source}: ${matchEvidence.length} constraint${matchEvidence.length === 1 ? '' : 's'} confirmed`
      : `Found via ${lead.source} (no Tower-judged constraints applicable)`;

    verifiedLeads.push({
      entity_id: lead.placeId,
      name: lead.name,
      address: lead.address,
      phone: lead.phone ?? null,
      website: lead.website ?? null,
      placeId: lead.placeId,
      source: lead.source,
      status: 'verified',
      match_evidence: matchEvidence,
      supporting_evidence: supportingEvidence,
      match_summary: summary,
      match_valid: true,
    });
  }

  // Apply requestedCount cap AFTER verification filter
  const capped = input.requestedCount !== null
    ? verifiedLeads.slice(0, input.requestedCount)
    : verifiedLeads;
  const overcapDropped = verifiedLeads.length - capped.length;

  if (overcapDropped > 0) {
    console.log(`[FINALIZE_DELIVERY] Dropped ${overcapDropped} verified leads over requestedCount=${input.requestedCount}`);
  }

  console.log(
    `[FINALIZE_DELIVERY] ${input.leads.length} candidates → ${capped.length} verified delivered, ` +
    `${dropped.length} unverified dropped (hasTowerJudgedConstraints=${hasTowerJudgedConstraints})`
  );

  return {
    verifiedLeads: capped,
    dropped,
    count: capped.length,
    totalCandidates: input.leads.length,
    requestedCount: input.requestedCount,
    hasTowerJudgedConstraints,
  };
}
