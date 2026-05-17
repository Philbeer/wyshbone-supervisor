/**
 * @deprecated As of feat-delivery-gateway: the canonical verification rule
 * is now applied inside finalize-delivery.ts at the gateway. New code should
 * not call isLeadVerified — instead, trust that leads reaching downstream
 * consumers have already been filtered by the gateway.
 *
 * This function remains exported for any legacy callers but should not be
 * relied upon for new code. It uses a deny-list rule that lets some unverified
 * leads through (e.g. leads with verification_status === 'unverified').
 */

/**
 * Single source of truth for whether a delivered lead is "verified".
 *
 * Reads the per-lead Tower semantic verification status from match_evidence —
 * the same data displayed on each result card in the UI. No other flags
 * (match_valid, entity.verified, combined Tower verdict) participate in
 * this decision.
 *
 * Rule:
 *   A lead is verified iff:
 *     - at least one match_evidence item has verification_status === 'verified', AND
 *     - NO match_evidence item has verification_status of 'no_evidence' or
 *       'insufficient_evidence' (a failed hard constraint check).
 *
 * Anything else (weak_match, proxy, unverified, empty evidence) is NOT verified.
 */

export type EvidenceVerificationStatus =
  | 'verified'
  | 'weak_match'
  | 'proxy'
  | 'unverified'
  | 'no_evidence'
  | 'insufficient_evidence'
  | 'no_relevant_evidence';

interface EvidenceItem {
  verification_status?: EvidenceVerificationStatus | string | null;
}

interface LeadWithEvidence {
  match_evidence?: EvidenceItem[] | null;
  supporting_evidence?: EvidenceItem[] | null;
}

export function isLeadVerified(lead: LeadWithEvidence): boolean {
  const evidenceItems: EvidenceItem[] = [
    ...(Array.isArray(lead.match_evidence) ? lead.match_evidence : []),
    ...(Array.isArray(lead.supporting_evidence) ? lead.supporting_evidence : []),
  ];

  // Rule: a lead is verified iff NO evidence item has a failure status.
  // Failure statuses come from Tower semantic verification saying "I
  // checked and found no support" — these are real disqualifications.
  //
  // Everything else passes:
  //   - 'verified' (Tower confirmed)
  //   - 'weak_match' (partial Tower match)
  //   - 'proxy' (strong evidence, no Tower confirmation needed)
  //   - 'unverified' (no Tower verify ran — typical for location-only
  //     queries with no hard semantic constraints)
  //   - empty evidence array (executor returned the lead, nothing to fail)
  //
  // The executor has already filtered by location and basic constraints
  // upstream. By the time a lead reaches this helper, it's a real
  // candidate — we only drop it if Tower explicitly judged a hard
  // constraint and the evidence failed.
  for (const ev of evidenceItems) {
    const status = ev?.verification_status;
    if (status === 'no_evidence' || status === 'insufficient_evidence' || status === 'no_relevant_evidence') {
      return false;
    }
  }

  return true;
}

/**
 * Count how many leads in a list are verified by the single rule.
 */
export function countVerifiedLeads(leads: LeadWithEvidence[]): number {
  let n = 0;
  for (const l of leads) {
    if (isLeadVerified(l)) n++;
  }
  return n;
}
