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

  if (evidenceItems.length === 0) return false;

  let hasVerified = false;
  for (const ev of evidenceItems) {
    const status = ev?.verification_status;
    if (status === 'no_evidence' || status === 'insufficient_evidence' || status === 'no_relevant_evidence') {
      return false;
    }
    if (status === 'verified') {
      hasVerified = true;
    }
  }

  return hasVerified;
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
