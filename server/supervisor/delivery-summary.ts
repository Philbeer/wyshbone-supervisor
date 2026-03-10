import { createArtefact } from './artefacts';
import type { VerificationPolicy } from './verification-policy';

export interface PlanVersionEntry {
  version: number;
  changes_made: string[];
}

export interface SoftRelaxation {
  constraint: string;
  from: string;
  to: string;
  reason: string;
  plan_version: number;
}

export interface MatchEvidenceItem {
  constraint_type: string;
  source_url: string | null;
  source_type: string | null;
  quote: string | null;
  matched_phrase: string | null;
  context_snippet: string | null;
  confidence: number;
  verification_status: 'verified' | 'weak_match' | 'proxy' | 'unverified';
}

export interface MatchBasisItem {
  constraint_type: string;
  constraint_value: string;
  valid: boolean;
  reason: string;
}

export interface SupportingEvidenceItem {
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
}

export interface DeliveredEntity {
  entity_id: string;
  name: string;
  address: string;
  match_level: 'exact' | 'closest';
  soft_violations: string[];
  match_valid?: boolean;
  match_summary?: string;
  match_basis?: MatchBasisItem[];
  supporting_evidence?: SupportingEvidenceItem[];
  match_evidence?: MatchEvidenceItem[];
}

export type CanonicalVerdict = 'PASS' | 'PARTIAL' | 'STOP' | 'ERROR' | 'COMPLETED';

export interface CvlLocationBreakdown {
  verified_geo_count: number;
  search_bounded_count: number;
  out_of_area_count: number;
  unknown_count: number;
}

export interface CvlSummary {
  verified_exact_count: number;
  unverifiable_count: number;
  hard_unverifiable: string[];
  location_breakdown: CvlLocationBreakdown | null;
}

export type TrustStatus = 'TRUSTED' | 'UNTRUSTED';

export interface DeliverySummaryPayload {
  requested_count: number | null;
  hard_constraints: string[];
  soft_constraints: string[];
  plan_versions: PlanVersionEntry[];
  soft_relaxations: SoftRelaxation[];
  delivered_exact: DeliveredEntity[];
  delivered_closest: DeliveredEntity[];
  delivered_exact_count: number;
  delivered_total_count: number;
  shortfall: number;
  status: CanonicalVerdict;
  trust_status: TrustStatus;
  tower_verdict: string | null;
  cvl_summary: CvlSummary | null;
  stop_reason: string | null;
  suggested_next_question: string | null;
  cvl_verified_exact_count: number | null;
  cvl_unverifiable_count: number | null;
  relationship_context: RelationshipContext | null;
  verification_policy?: VerificationPolicy;
  verification_policy_reason?: string;
}

export interface DeliverySummaryLeadInput {
  entity_id?: string;
  place_id?: string;
  placeId?: string;
  name: string;
  address: string;
  found_in_plan_version?: number;
  match_valid?: boolean;
  match_summary?: string;
  match_basis?: MatchBasisItem[];
  supporting_evidence?: SupportingEvidenceItem[];
  match_evidence?: MatchEvidenceItem[];
}

export type CvlLocationStatus = 'verified_geo' | 'search_bounded' | 'out_of_area' | 'unknown' | 'not_applicable';

export interface CvlLeadVerification {
  lead_place_id: string;
  lead_name: string;
  verified_exact: boolean;
  all_hard_satisfied: boolean;
  location_confidence: CvlLocationStatus;
}

export interface RelationshipContext {
  requires_relationship_evidence: boolean;
  detected_predicate: string | null;
  relationship_target: string | null;
  verified_relationship_count: number;
}

export interface DeliverySummaryInput {
  runId: string;
  userId: string;
  conversationId?: string;
  originalUserGoal: string;
  requestedCount: number | null;
  hardConstraints: string[];
  softConstraints: string[];
  planVersions: PlanVersionEntry[];
  softRelaxations: SoftRelaxation[];
  leads: DeliverySummaryLeadInput[];
  finalVerdict: string;
  stopReason?: string | null;
  cvlVerifiedExactCount?: number | null;
  cvlUnverifiableCount?: number | null;
  cvlRequestedCountUser?: number | null;
  cvlHardUnverifiable?: string[];
  cvlLocationBreakdown?: CvlLocationBreakdown | null;
  cvlLeadVerifications?: CvlLeadVerification[];
  relationshipContext?: RelationshipContext;
  verificationPolicy?: VerificationPolicy;
  verificationPolicyReason?: string;
}

export function determineLeadExactness(
  lead: DeliverySummaryLeadInput,
  hardConstraints: string[],
  softRelaxations: SoftRelaxation[],
  cvlVerification: CvlLeadVerification | null,
): { match_level: 'exact' | 'closest'; soft_violations: string[] } {
  if (cvlVerification) {
    if (!cvlVerification.verified_exact) {
      const violations = cvlVerification.all_hard_satisfied
        ? softRelaxations.map(r => r.constraint)
        : hardConstraints.length > 0
          ? hardConstraints
          : ['CVL verification failed'];
      return { match_level: 'closest', soft_violations: violations };
    }
    return { match_level: 'exact', soft_violations: [] };
  }

  return classifyLeadByHeuristic(lead, hardConstraints, softRelaxations);
}

function isNonTextualConstraint(constraintName: string): boolean {
  const lower = constraintName.toLowerCase();
  return lower.includes('radius') || lower.includes('distance') || lower.includes('count') || lower.includes('limit');
}

function leadSatisfiesHardConstraint(
  lead: DeliverySummaryLeadInput,
  constraint: string,
): boolean {
  const lower = constraint.toLowerCase();
  const eqIdx = lower.indexOf('=');
  if (eqIdx === -1) return true;

  const key = lower.substring(0, eqIdx).trim();
  const value = lower.substring(eqIdx + 1).trim();
  if (!value) return true;

  if (key === 'query' || key === 'keyword' || key === 'type' || key === 'category') {
    const name = (lead.name || '').toLowerCase();
    const addr = (lead.address || '').toLowerCase();
    return name.includes(value) || addr.includes(value);
  }

  return true;
}

function leadSatisfiesOriginalSoftConstraint(
  lead: DeliverySummaryLeadInput,
  relaxation: SoftRelaxation,
): boolean {
  const originalValue = relaxation.from.toLowerCase().trim();
  if (!originalValue) return true;

  const constraintName = relaxation.constraint.toLowerCase();

  if (isNonTextualConstraint(constraintName)) {
    const planVersion = lead.found_in_plan_version ?? 1;
    return relaxation.plan_version > planVersion;
  }

  if (constraintName.includes('location') || constraintName.includes('area') || constraintName.includes('geo')) {
    const addr = (lead.address || '').toLowerCase();
    return addr.includes(originalValue);
  }

  if (constraintName.includes('prefix')) {
    const name = (lead.name || '').toLowerCase();
    return name.startsWith(originalValue);
  }

  if (constraintName.includes('name') || constraintName.includes('category') || constraintName.includes('type') || constraintName.includes('business')) {
    const name = (lead.name || '').toLowerCase();
    const addr = (lead.address || '').toLowerCase();
    return name.includes(originalValue) || addr.includes(originalValue);
  }

  const planVersion = lead.found_in_plan_version ?? 1;
  return relaxation.plan_version > planVersion;
}

function classifyLeadByHeuristic(
  lead: DeliverySummaryLeadInput,
  hardConstraints: string[],
  softRelaxations: SoftRelaxation[],
): { match_level: 'exact' | 'closest'; soft_violations: string[] } {
  const hardViolations: string[] = [];
  for (const hc of hardConstraints) {
    if (!leadSatisfiesHardConstraint(lead, hc)) {
      hardViolations.push(hc);
    }
  }

  if (hardViolations.length > 0) {
    return { match_level: 'closest', soft_violations: hardViolations };
  }

  if (softRelaxations.length === 0) {
    return { match_level: 'exact', soft_violations: [] };
  }

  const softViolations: string[] = [];
  for (const relaxation of softRelaxations) {
    if (!leadSatisfiesOriginalSoftConstraint(lead, relaxation)) {
      softViolations.push(relaxation.constraint);
    }
  }

  if (softViolations.length === 0) {
    return { match_level: 'exact', soft_violations: [] };
  }

  return { match_level: 'closest', soft_violations: softViolations };
}

function deriveSuggestedNextQuestion(
  softRelaxations: SoftRelaxation[],
  exactCount: number,
  requestedCount: number | null,
): string | null {
  if (requestedCount === null) return null;
  if (exactCount >= requestedCount) return null;

  if (softRelaxations.length === 0) return null;

  if (softRelaxations.length > 1) {
    return 'Do you want me to broaden the criteria?';
  }

  const constraint = softRelaxations[0].constraint.toLowerCase();
  if (constraint.includes('location') || constraint.includes('radius') || constraint.includes('area') || constraint.includes('geo')) {
    return 'Do you want me to include nearby results?';
  }

  return 'Do you want me to include similar matches?';
}

function normalizeTowerVerdict(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  if (lower === 'error') return 'ERROR';
  const stopVerdicts = ['stop', 'change_plan', 'reject', 'fail', 'blocked'];
  if (stopVerdicts.includes(lower)) return 'STOP';
  const passVerdicts = ['pass', 'accept', 'approved', 'good'];
  if (passVerdicts.includes(lower)) return 'PASS';
  return raw.toUpperCase();
}

function deriveCanonicalStatus(
  verifiedExact: number,
  requested: number | null,
  towerVerdict: string | null,
  hasHardUnverifiable: boolean,
  deliveredTotal?: number,
): CanonicalVerdict {
  const totalDelivered = deliveredTotal ?? 0;
  if (towerVerdict === 'ERROR' && totalDelivered === 0) return 'ERROR';
  if (totalDelivered > 0) return 'COMPLETED';
  if (hasHardUnverifiable) return 'STOP';
  return 'STOP';
}

export function buildDeliverySummaryPayload(input: DeliverySummaryInput): DeliverySummaryPayload {
  const hasCvlLeadData = !!(input.cvlLeadVerifications && input.cvlLeadVerifications.length > 0);

  const cvlMap = new Map<string, CvlLeadVerification>();
  if (hasCvlLeadData) {
    for (const lv of input.cvlLeadVerifications!) {
      cvlMap.set(lv.lead_place_id, lv);
      cvlMap.set(lv.lead_name, lv);
    }
  }

  const exact: DeliveredEntity[] = [];
  const closest: DeliveredEntity[] = [];

  for (const lead of input.leads) {
    const entityId = lead.entity_id || lead.place_id || lead.placeId || `lead:${lead.name}`;
    const leadId = lead.entity_id || lead.place_id || lead.placeId || '';
    const cvlMatch = hasCvlLeadData
      ? (cvlMap.get(leadId) || cvlMap.get(lead.name) || null)
      : null;

    const { match_level, soft_violations } = determineLeadExactness(
      lead,
      input.hardConstraints,
      input.softRelaxations,
      cvlMatch,
    );

    const entity: DeliveredEntity = {
      entity_id: entityId,
      name: lead.name,
      address: lead.address,
      match_level,
      soft_violations,
      ...(lead.match_valid !== undefined ? { match_valid: lead.match_valid } : {}),
      ...(lead.match_summary ? { match_summary: lead.match_summary } : {}),
      ...(lead.match_basis && lead.match_basis.length > 0 ? { match_basis: lead.match_basis } : {}),
      ...(lead.supporting_evidence && lead.supporting_evidence.length > 0 ? { supporting_evidence: lead.supporting_evidence } : {}),
      ...(lead.match_evidence && lead.match_evidence.length > 0 ? { match_evidence: lead.match_evidence } : {}),
    };

    if (match_level === 'exact') {
      exact.push(entity);
    } else {
      closest.push(entity);
    }
  }

  const hasCvl = input.cvlVerifiedExactCount !== undefined && input.cvlVerifiedExactCount !== null;

  const exactCount = exact.length;
  const closestCount = closest.length;
  const rawTotalCount = exactCount + closestCount;

  const requestedCount: number | null = input.requestedCount === null
    ? null
    : (hasCvl ? (input.cvlRequestedCountUser ?? input.requestedCount) : input.requestedCount);
  const shortfall = requestedCount === null ? 0 : Math.max(0, requestedCount - exactCount);

  const towerVerdict = normalizeTowerVerdict(input.finalVerdict);
  const hardUnverifiable = input.cvlHardUnverifiable ?? [];
  const hasHardUnverifiable = hardUnverifiable.length > 0;

  const relCtx = input.relationshipContext ?? null;
  const relationshipUnverified = relCtx?.requires_relationship_evidence && relCtx.verified_relationship_count === 0;

  let effectiveExactCount = exactCount;
  if (relationshipUnverified) {
    for (const e of exact) {
      e.match_level = 'closest';
      if (!e.soft_violations.includes('relationship_not_verified')) {
        e.soft_violations.push('relationship_not_verified');
      }
    }
    closest.push(...exact.splice(0));
    effectiveExactCount = 0;
  }

  const deliveredTotalForStatus = relationshipUnverified ? 0 : (exact.length + closest.length);
  const status = deriveCanonicalStatus(effectiveExactCount, requestedCount, towerVerdict, hasHardUnverifiable, deliveredTotalForStatus);
  const trustStatus: TrustStatus = (status === 'PASS' || status === 'PARTIAL' || status === 'COMPLETED') ? 'TRUSTED' : 'UNTRUSTED';

  const cvlSummary: CvlSummary | null = hasCvl ? {
    verified_exact_count: input.cvlVerifiedExactCount!,
    unverifiable_count: input.cvlUnverifiableCount ?? 0,
    hard_unverifiable: hardUnverifiable,
    location_breakdown: input.cvlLocationBreakdown ?? null,
  } : null;

  let stopReason: string | null = null;
  if (relationshipUnverified) {
    const target = relCtx!.relationship_target || 'the specified entity';
    const predicate = relCtx!.detected_predicate || 'works with';
    stopReason = `Relationship "${predicate} ${target}" could not be verified for any result. All ${rawTotalCount} results are candidates only.`;
  } else if (status === 'STOP') {
    if (input.stopReason) {
      stopReason = input.stopReason;
    } else if (hasHardUnverifiable) {
      stopReason = `Unverifiable hard constraint: ${hardUnverifiable.join(', ')}`;
    } else if (towerVerdict === 'STOP') {
      stopReason = `Tower verdict: ${input.finalVerdict}`;
    } else if (requestedCount !== null) {
      stopReason = `Delivered 0 of ${requestedCount} requested`;
    } else {
      stopReason = `No results found`;
    }
  } else if (status === 'PARTIAL') {
    stopReason = input.stopReason || (requestedCount !== null ? `Verified ${exactCount} of ${requestedCount} requested` : null);
  }

  const suggestedNextQuestion = deriveSuggestedNextQuestion(
    input.softRelaxations,
    exactCount,
    requestedCount,
  );

  return {
    requested_count: requestedCount,
    hard_constraints: input.hardConstraints,
    soft_constraints: input.softConstraints,
    plan_versions: input.planVersions,
    soft_relaxations: input.softRelaxations,
    delivered_exact: exact,
    delivered_closest: closest,
    delivered_exact_count: exactCount,
    delivered_total_count: rawTotalCount,
    shortfall,
    status,
    trust_status: trustStatus,
    tower_verdict: towerVerdict,
    cvl_summary: cvlSummary,
    stop_reason: stopReason,
    suggested_next_question: suggestedNextQuestion,
    cvl_verified_exact_count: hasCvl ? input.cvlVerifiedExactCount! : null,
    cvl_unverifiable_count: input.cvlUnverifiableCount ?? null,
    relationship_context: relCtx,
    ...(input.verificationPolicy ? {
      verification_policy: input.verificationPolicy,
      verification_policy_reason: input.verificationPolicyReason,
    } : {}),
  };
}

export async function emitDeliverySummary(input: DeliverySummaryInput): Promise<DeliverySummaryPayload> {
  const payload = buildDeliverySummaryPayload(input);

  const countLabel = payload.requested_count !== null
    ? `${payload.delivered_exact_count} of ${payload.requested_count} delivered`
    : `${payload.delivered_exact_count} delivered`;
  const title = `Delivery Summary: ${payload.status} — ${countLabel}`;
  const cvlLabel = payload.cvl_summary ? ` cvl_verified=${payload.cvl_summary.verified_exact_count}` : '';
  const towerLabel = payload.tower_verdict ? ` tower=${payload.tower_verdict}` : '';
  const requestedLabel = payload.requested_count !== null ? ` requested=${payload.requested_count}` : '';
  const shortfallLabel = payload.requested_count !== null ? ` shortfall=${payload.shortfall}` : '';
  const summary = `status=${payload.status} exact=${payload.delivered_exact_count} closest=${payload.delivered_closest.length}${shortfallLabel}${requestedLabel}${cvlLabel}${towerLabel}${payload.stop_reason ? ` stop_reason="${payload.stop_reason}"` : ''}`;

  try {
    await createArtefact({
      runId: input.runId,
      type: 'delivery_summary',
      title,
      summary,
      payload: payload as unknown as Record<string, unknown>,
      userId: input.userId,
      conversationId: input.conversationId,
    });
    const locLabel = payload.cvl_summary?.location_breakdown
      ? ` location=[geo=${payload.cvl_summary.location_breakdown.verified_geo_count} bounded=${payload.cvl_summary.location_breakdown.search_bounded_count} out=${payload.cvl_summary.location_breakdown.out_of_area_count} unk=${payload.cvl_summary.location_breakdown.unknown_count}]`
      : '';
    console.log(`[DELIVERY_SUMMARY] runId=${input.runId} status=${payload.status} exact=${payload.delivered_exact_count} closest=${payload.delivered_closest.length} total=${payload.delivered_total_count}${payload.requested_count !== null ? ` requested=${payload.requested_count} shortfall=${payload.shortfall}` : ''} tower=${payload.tower_verdict || 'none'}${locLabel}`);
  } catch (err: any) {
    console.error(`[DELIVERY_SUMMARY] Failed to emit delivery_summary artefact: ${err.message}`);
  }

  return payload;
}
