import { createArtefact } from './artefacts';

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

export interface DeliveredEntity {
  entity_id: string;
  name: string;
  address: string;
  match_level: 'exact' | 'closest';
  soft_violations: string[];
}

export interface DeliverySummaryPayload {
  requested_count: number;
  hard_constraints: string[];
  soft_constraints: string[];
  plan_versions: PlanVersionEntry[];
  soft_relaxations: SoftRelaxation[];
  delivered_exact: DeliveredEntity[];
  delivered_closest: DeliveredEntity[];
  delivered_exact_count: number;
  delivered_total_count: number;
  shortfall: number;
  stop_reason: string | null;
  suggested_next_question: string | null;
  cvl_verified_exact_count: number | null;
  cvl_unverifiable_count: number | null;
}

export interface DeliverySummaryLeadInput {
  entity_id?: string;
  place_id?: string;
  placeId?: string;
  name: string;
  address: string;
  found_in_plan_version?: number;
}

export interface DeliverySummaryInput {
  runId: string;
  userId: string;
  conversationId?: string;
  originalUserGoal: string;
  requestedCount: number;
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

function classifyLead(
  lead: DeliverySummaryLeadInput,
  hardConstraints: string[],
  softRelaxations: SoftRelaxation[],
): DeliveredEntity {
  const entityId = lead.entity_id || lead.place_id || lead.placeId || `lead:${lead.name}`;

  const hardViolations: string[] = [];
  for (const hc of hardConstraints) {
    if (!leadSatisfiesHardConstraint(lead, hc)) {
      hardViolations.push(hc);
    }
  }

  if (hardViolations.length > 0) {
    return {
      entity_id: entityId,
      name: lead.name,
      address: lead.address,
      match_level: 'closest',
      soft_violations: hardViolations,
    };
  }

  if (softRelaxations.length === 0) {
    return {
      entity_id: entityId,
      name: lead.name,
      address: lead.address,
      match_level: 'exact',
      soft_violations: [],
    };
  }

  const softViolations: string[] = [];
  for (const relaxation of softRelaxations) {
    if (!leadSatisfiesOriginalSoftConstraint(lead, relaxation)) {
      softViolations.push(relaxation.constraint);
    }
  }

  if (softViolations.length === 0) {
    return {
      entity_id: entityId,
      name: lead.name,
      address: lead.address,
      match_level: 'exact',
      soft_violations: [],
    };
  }

  return {
    entity_id: entityId,
    name: lead.name,
    address: lead.address,
    match_level: 'closest',
    soft_violations: softViolations,
  };
}

function deriveSuggestedNextQuestion(
  softRelaxations: SoftRelaxation[],
  exactCount: number,
  requestedCount: number,
): string | null {
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

export function buildDeliverySummaryPayload(input: DeliverySummaryInput): DeliverySummaryPayload {
  const exact: DeliveredEntity[] = [];
  const closest: DeliveredEntity[] = [];

  for (const lead of input.leads) {
    const classified = classifyLead(lead, input.hardConstraints, input.softRelaxations);
    if (classified.match_level === 'exact') {
      exact.push(classified);
    } else {
      closest.push(classified);
    }
  }

  const hasCvl = input.cvlVerifiedExactCount !== undefined && input.cvlVerifiedExactCount !== null;

  const rawExactCount = exact.length;
  const rawTotalCount = exact.length + closest.length;

  const exactCount = hasCvl ? input.cvlVerifiedExactCount! : rawExactCount;
  const requestedCount = hasCvl
    ? (input.cvlRequestedCountUser ?? 0)
    : input.requestedCount;
  const shortfall = Math.max(0, requestedCount - exactCount);

  const verdictIsFailure = input.finalVerdict !== 'pass' && input.finalVerdict !== 'ACCEPT';

  let isStop: boolean;
  let stopReason: string | null;

  if (hasCvl) {
    const hasHardUnverifiable = (input.cvlHardUnverifiable ?? []).length > 0;
    isStop = verdictIsFailure || exactCount < requestedCount || hasHardUnverifiable;
    if (isStop) {
      if (input.stopReason) {
        stopReason = input.stopReason;
      } else if (hasHardUnverifiable) {
        stopReason = `Unverifiable hard constraint: ${(input.cvlHardUnverifiable ?? []).join(', ')}`;
      } else if (exactCount < requestedCount) {
        stopReason = `CVL verified ${exactCount} of ${requestedCount} requested`;
      } else {
        stopReason = `Run ended with verdict: ${input.finalVerdict}`;
      }
    } else {
      stopReason = null;
    }
  } else {
    const hasShortfall = rawTotalCount < input.requestedCount;
    isStop = hasShortfall || verdictIsFailure;
    stopReason = isStop
      ? (input.stopReason || (hasShortfall ? `Delivered ${rawTotalCount} of ${input.requestedCount} requested` : `Run ended with verdict: ${input.finalVerdict}`))
      : null;
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
    delivered_total_count: hasCvl ? rawTotalCount : rawTotalCount,
    shortfall,
    stop_reason: stopReason,
    suggested_next_question: suggestedNextQuestion,
    cvl_verified_exact_count: hasCvl ? exactCount : null,
    cvl_unverifiable_count: input.cvlUnverifiableCount ?? null,
  };
}

export async function emitDeliverySummary(input: DeliverySummaryInput): Promise<void> {
  const payload = buildDeliverySummaryPayload(input);

  const finalVerdictLower = (input.finalVerdict || '').toLowerCase();
  let verdictLabel: string;
  if (payload.stop_reason) {
    verdictLabel = finalVerdictLower === 'change_plan' ? 'NEEDS_VERIFICATION' : 'STOP';
  } else {
    verdictLabel = 'PASS';
  }
  const title = `Delivery Summary: ${verdictLabel} — ${payload.delivered_exact_count} of ${payload.requested_count} delivered`;
  const cvlLabel = payload.cvl_verified_exact_count !== null ? ` cvl_verified=${payload.cvl_verified_exact_count}` : '';
  const summary = `exact=${payload.delivered_exact_count} closest=${payload.delivered_closest.length} shortfall=${payload.shortfall}${cvlLabel}${payload.stop_reason ? ` stop_reason="${payload.stop_reason}"` : ''}`;

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
    console.log(`[DELIVERY_SUMMARY] runId=${input.runId} exact=${payload.delivered_exact_count} closest=${payload.delivered_closest.length} total=${payload.delivered_total_count} requested=${payload.requested_count} shortfall=${payload.shortfall} verdict=${verdictLabel}`);
  } catch (err: any) {
    console.error(`[DELIVERY_SUMMARY] Failed to emit delivery_summary artefact: ${err.message}`);
  }
}
