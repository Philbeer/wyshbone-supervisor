import type { PlanStrategyId, VerificationMethod, ConstraintPlanMapping } from './mission-planner';
import type { MissionConstraintType } from './mission-schema';
import { createArtefact } from './artefacts';

export const VERIFICATION_POLICIES = [
  'DIRECTORY_VERIFIED',
  'WEBSITE_VERIFIED',
  'RELATIONSHIP_VERIFIED',
] as const;

export type VerificationPolicy = typeof VERIFICATION_POLICIES[number];

export interface VerificationPolicyResult {
  verification_policy: VerificationPolicy;
  reason: string;
}

const STRATEGY_TO_POLICY: Record<PlanStrategyId, VerificationPolicy> = {
  discovery_only: 'DIRECTORY_VERIFIED',
  discovery_then_direct_filter: 'DIRECTORY_VERIFIED',
  discovery_then_rank: 'DIRECTORY_VERIFIED',
  discovery_then_website_evidence: 'WEBSITE_VERIFIED',
  discovery_then_external_evidence: 'RELATIONSHIP_VERIFIED',
  composite: 'WEBSITE_VERIFIED',
};

const WEBSITE_EVIDENCE_CONSTRAINT_TYPES: Set<MissionConstraintType> = new Set([
  'attribute_check',
  'status_check',
  'website_evidence',
  'time_constraint',
]);

const RELATIONSHIP_CONSTRAINT_TYPES: Set<MissionConstraintType> = new Set([
  'relationship_check',
]);

export function deriveVerificationPolicy(
  input: Pick<{ constraint_mappings: ConstraintPlanMapping[] }, 'constraint_mappings'>,
): VerificationPolicyResult {
  const hasRelationship = input.constraint_mappings.some(
    m => RELATIONSHIP_CONSTRAINT_TYPES.has(m.constraint_type),
  );
  if (hasRelationship) {
    return {
      verification_policy: 'RELATIONSHIP_VERIFIED',
      reason: 'relationship predicate requires source-backed relationship evidence',
    };
  }

  const hasWebsiteEvidence = input.constraint_mappings.some(
    m => WEBSITE_EVIDENCE_CONSTRAINT_TYPES.has(m.constraint_type),
  );
  if (hasWebsiteEvidence) {
    const triggeringTypes = input.constraint_mappings
      .filter(m => WEBSITE_EVIDENCE_CONSTRAINT_TYPES.has(m.constraint_type))
      .map(m => m.constraint_type);
    const unique = [...new Set(triggeringTypes)];
    return {
      verification_policy: 'WEBSITE_VERIFIED',
      reason: `attribute requires page-level text evidence (${unique.join(', ')})`,
    };
  }

  return {
    verification_policy: 'DIRECTORY_VERIFIED',
    reason: 'entity discovery query with no website-content or relationship constraint',
  };
}

export function deriveVerificationPolicyFromConstraintTypes(
  constraintTypes: MissionConstraintType[],
): VerificationPolicyResult {
  const hasRelationship = constraintTypes.some(t => RELATIONSHIP_CONSTRAINT_TYPES.has(t));
  if (hasRelationship) {
    return {
      verification_policy: 'RELATIONSHIP_VERIFIED',
      reason: 'relationship predicate requires source-backed relationship evidence',
    };
  }

  const hasWebsiteEvidence = constraintTypes.some(t => WEBSITE_EVIDENCE_CONSTRAINT_TYPES.has(t));
  if (hasWebsiteEvidence) {
    const unique = [...new Set(constraintTypes.filter(t => WEBSITE_EVIDENCE_CONSTRAINT_TYPES.has(t)))];
    return {
      verification_policy: 'WEBSITE_VERIFIED',
      reason: `attribute requires page-level text evidence (${unique.join(', ')})`,
    };
  }

  return {
    verification_policy: 'DIRECTORY_VERIFIED',
    reason: 'entity discovery query with no website-content or relationship constraint',
  };
}

const LEGACY_TO_MISSION_CONSTRAINT_TYPE: Record<string, MissionConstraintType> = {
  'HAS_ATTRIBUTE': 'attribute_check',
  'RELATIONSHIP_CHECK': 'relationship_check',
  'STATUS_CHECK': 'status_check',
  'TIME_CONSTRAINT': 'time_constraint',
  'WEBSITE_EVIDENCE': 'website_evidence',
  'RANKING': 'ranking',
  'NAME_STARTS_WITH': 'text_compare',
  'NAME_CONTAINS': 'text_compare',
  'COUNT_MIN': 'entity_discovery',
  'LOCATION_EQUALS': 'location_constraint',
  'LOCATION_NEAR': 'location_constraint',
  'CATEGORY_EQUALS': 'entity_discovery',
  'MUST_USE_TOOL': 'entity_discovery',
};

export function deriveVerificationPolicyFromLegacyConstraints(
  legacyConstraintTypes: string[],
): VerificationPolicyResult {
  const missionTypes = legacyConstraintTypes
    .map(t => LEGACY_TO_MISSION_CONSTRAINT_TYPE[t])
    .filter((t): t is MissionConstraintType => t !== undefined);
  return deriveVerificationPolicyFromConstraintTypes(missionTypes);
}

export async function emitVerificationPolicyArtefact(params: {
  runId: string;
  userId: string;
  conversationId?: string;
  query: string;
  strategy: PlanStrategyId;
  policyResult: VerificationPolicyResult;
}): Promise<void> {
  const { runId, userId, conversationId, query, strategy, policyResult } = params;
  await createArtefact({
    runId,
    type: 'diagnostic',
    title: 'Verification Policy Selected',
    summary: `${policyResult.verification_policy}: ${policyResult.reason}`,
    payload: {
      query,
      strategy,
      verification_policy: policyResult.verification_policy,
      reason: policyResult.reason,
    },
    userId,
    conversationId,
  });
  console.log(`[VERIFICATION_POLICY] runId=${runId} policy=${policyResult.verification_policy} strategy=${strategy} reason="${policyResult.reason}"`);
}
