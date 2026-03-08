import type { StructuredMission, MissionConstraint, MissionExtractionTrace, MissionFailureStage } from './mission-schema';
import type { ParsedGoal, StructuredConstraint, SuccessCriteria } from './goal-to-constraints';
import { inferCountryFromLocation, isAttributeLikeConstraint } from './goal-to-constraints';
import type { CanonicalIntent, CanonicalConstraint } from './canonical-intent';

export type DowngradeReason =
  | 'relationship_to_has_attribute'
  | 'status_to_has_attribute'
  | 'time_to_has_attribute'
  | 'website_evidence_to_has_attribute'
  | 'ranking_to_count_min';

export interface ConstraintDowngrade {
  constraint_index: number;
  canonical_type: string;
  mapped_type: string;
  reason: DowngradeReason;
  detail: string;
}

export interface HandoffDiagnostic {
  canonical_constraints: Array<{
    index: number;
    type: string;
    field: string;
    operator: string;
    value: unknown;
    hardness: string;
  }>;
  mapped_constraints: Array<{
    id: string;
    type: string;
    field: string;
    operator: string;
    value: unknown;
    hard: boolean;
    has_canonical: boolean;
  }>;
  downgrades: ConstraintDowngrade[];
  downgrade_count: number;
  mapping_fidelity: 'exact' | 'degraded' | 'unknown';
}

export interface MissionShadowComparison {
  mission: StructuredMission;
  legacy_entity_category: string | null;
  legacy_location: string | null;
  legacy_constraints_count: number;
  mission_entity_category: string;
  mission_location: string | null;
  mission_constraints_count: number;
  differences: string[];
}

export interface MissionDiagnosticPayload {
  pipeline_ok: boolean;
  failure_stage: MissionFailureStage;
  model: string;
  timing: {
    pass1_ms: number;
    pass2_ms: number;
    total_ms: number;
  };
  layers: {
    raw_user_input: string;
    pass1_semantic_interpretation: string;
    pass2_structured_mission: {
      entity_category: string;
      location_text: string | null;
      mission_mode: string;
      constraints_count: number;
      constraint_types: string[];
    } | null;
  };
  validation: {
    ok: boolean;
    error_count: number;
    errors: string[];
  };
  legacy_comparison: {
    has_legacy: boolean;
    differences: string[];
  } | null;
  fallback_reason: string | null;
}

export function buildMissionDiagnosticPayload(
  trace: MissionExtractionTrace,
  legacyIntent: CanonicalIntent | null,
  legacyParsedGoal: ParsedGoal | null,
  fallbackReason: string | null,
): MissionDiagnosticPayload {
  const mission = trace.pass2_structured_mission;

  let legacyComparison: MissionDiagnosticPayload['legacy_comparison'] = null;
  if (mission && (legacyIntent || legacyParsedGoal)) {
    const comp = compareMissionWithLegacy(mission, legacyIntent, legacyParsedGoal);
    legacyComparison = {
      has_legacy: true,
      differences: comp.differences,
    };
  } else if (legacyIntent || legacyParsedGoal) {
    legacyComparison = {
      has_legacy: true,
      differences: ['mission extraction failed — cannot compare'],
    };
  }

  return {
    pipeline_ok: trace.validation_result.ok,
    failure_stage: trace.failure_stage,
    model: trace.model,
    timing: {
      pass1_ms: trace.pass1_duration_ms,
      pass2_ms: trace.pass2_duration_ms,
      total_ms: trace.total_duration_ms,
    },
    layers: {
      raw_user_input: trace.raw_user_input.substring(0, 500),
      pass1_semantic_interpretation: trace.pass1_semantic_interpretation.substring(0, 500),
      pass2_structured_mission: mission ? {
        entity_category: mission.entity_category,
        location_text: mission.location_text,
        mission_mode: mission.mission_mode,
        constraints_count: mission.constraints.length,
        constraint_types: mission.constraints.map(c => c.type),
      } : null,
    },
    validation: {
      ok: trace.validation_result.ok,
      error_count: trace.validation_result.errors.length,
      errors: trace.validation_result.errors.slice(0, 5),
    },
    legacy_comparison: legacyComparison,
    fallback_reason: fallbackReason,
  };
}

export function compareMissionWithLegacy(
  mission: StructuredMission,
  legacyIntent: CanonicalIntent | null,
  legacyParsedGoal: ParsedGoal | null,
): MissionShadowComparison {
  const legacyEntity = legacyIntent?.entity_category ?? legacyParsedGoal?.business_type ?? null;
  const legacyLocation = legacyIntent?.location_text ?? legacyParsedGoal?.location ?? null;
  const legacyConstraintsCount = legacyIntent?.constraints?.length ?? legacyParsedGoal?.constraints?.length ?? 0;

  const differences: string[] = [];

  if (legacyEntity && mission.entity_category.toLowerCase() !== legacyEntity.toLowerCase()) {
    differences.push(`entity_category: mission="${mission.entity_category}" vs legacy="${legacyEntity}"`);
  }

  const missionLoc = mission.location_text?.toLowerCase() ?? '';
  const legacyLoc = legacyLocation?.toLowerCase() ?? '';
  if (missionLoc !== legacyLoc) {
    differences.push(`location: mission="${mission.location_text}" vs legacy="${legacyLocation}"`);
  }

  if (mission.constraints.length !== legacyConstraintsCount) {
    differences.push(`constraints_count: mission=${mission.constraints.length} vs legacy=${legacyConstraintsCount}`);
  }

  return {
    mission,
    legacy_entity_category: legacyEntity,
    legacy_location: legacyLocation,
    legacy_constraints_count: legacyConstraintsCount,
    mission_entity_category: mission.entity_category,
    mission_location: mission.location_text,
    mission_constraints_count: mission.constraints.length,
    differences,
  };
}

function buildCanonical(c: MissionConstraint) {
  return {
    type: c.type,
    field: c.field,
    operator: c.operator,
    value: c.value,
    hardness: c.hardness,
    ...(c.value_secondary !== undefined && c.value_secondary !== null ? { value_secondary: c.value_secondary } : {}),
  };
}

function mapMissionConstraintToStructured(c: MissionConstraint, index: number): StructuredConstraint | null {
  const canonical = buildCanonical(c);

  switch (c.type) {
    case 'text_compare': {
      if (c.operator === 'starts_with') {
        return {
          id: `c_name_prefix_m${index}`,
          type: 'NAME_STARTS_WITH',
          field: 'name',
          operator: 'starts_with',
          value: typeof c.value === 'string' ? c.value : '',
          hard: c.hardness === 'hard',
          rationale: `Name starts with "${c.value}"`,
          canonical,
        };
      }
      if (c.field === 'name') {
        return {
          id: `c_name_contains_m${index}`,
          type: 'NAME_CONTAINS',
          field: 'name',
          operator: 'contains_word',
          value: typeof c.value === 'string' ? c.value : '',
          hard: c.hardness === 'hard',
          rationale: `Name contains "${c.value}"`,
          canonical,
        };
      }
      return null;
    }

    case 'attribute_check': {
      const val = typeof c.value === 'string' ? c.value : String(c.value ?? '');
      const shortName = val.replace(/\s+/g, '_').toLowerCase().substring(0, 20);
      return {
        id: `c_attr_${shortName}_m${index}`,
        type: 'HAS_ATTRIBUTE',
        field: 'attribute',
        operator: 'has',
        value: val,
        hard: c.hardness === 'hard',
        rationale: `Has attribute "${val}"`,
        canonical,
      };
    }

    case 'numeric_range': {
      if (c.field === 'rating' || c.field === 'review_count') {
        const op = c.operator === 'gte' ? '>=' : c.operator === 'lte' ? '<=' : c.operator === 'gt' ? '>' : c.operator === 'lt' ? '<' : '>=';
        return {
          id: `c_${c.field}_m${index}`,
          type: 'COUNT_MIN',
          field: c.field,
          operator: op,
          value: typeof c.value === 'number' ? c.value : 0,
          hard: c.hardness === 'hard',
          rationale: `${c.field} ${op} ${c.value}`,
          canonical,
        };
      }
      return null;
    }

    case 'website_evidence': {
      const val = typeof c.value === 'string' ? c.value : String(c.value ?? '');
      const shortName = val.replace(/\s+/g, '_').toLowerCase().substring(0, 20);
      return {
        id: `c_webev_${shortName}_m${index}`,
        type: 'WEBSITE_EVIDENCE',
        field: 'website_text',
        operator: c.operator,
        value: val,
        hard: c.hardness === 'hard',
        rationale: `Website must contain evidence of "${val}"`,
        canonical,
      };
    }

    case 'time_constraint': {
      const val = typeof c.value === 'string' ? c.value : String(c.value ?? '');
      return {
        id: `c_time_m${index}`,
        type: 'TIME_CONSTRAINT',
        field: c.field,
        operator: c.operator,
        value: val,
        hard: c.hardness === 'hard',
        rationale: `Time constraint: ${c.field} ${c.operator} ${val}`,
        canonical,
      };
    }

    case 'status_check': {
      const val = typeof c.value === 'string' ? c.value : String(c.value ?? '');
      const shortName = val.replace(/\s+/g, '_').toLowerCase().substring(0, 20);
      return {
        id: `c_status_${shortName}_m${index}`,
        type: 'STATUS_CHECK',
        field: c.field,
        operator: c.operator,
        value: val,
        hard: c.hardness === 'hard',
        rationale: `Status: ${c.field} ${c.operator} "${val}"`,
        canonical,
      };
    }

    case 'relationship_check': {
      const val = typeof c.value === 'string' ? c.value : String(c.value ?? '');
      const shortName = val.replace(/\s+/g, '_').toLowerCase().substring(0, 20);
      return {
        id: `c_rel_${shortName}_m${index}`,
        type: 'RELATIONSHIP_CHECK',
        field: c.field,
        operator: c.operator,
        value: val,
        hard: c.hardness === 'hard',
        rationale: `Relationship: ${c.field} ${c.operator} "${val}"`,
        canonical,
      };
    }

    case 'ranking': {
      const val = typeof c.value === 'number' ? c.value : null;
      return {
        id: `c_ranking_m${index}`,
        type: 'RANKING',
        field: c.field || 'rating',
        operator: c.operator,
        value: val ?? 0,
        hard: c.hardness === 'hard',
        rationale: `Ranking: ${c.operator} ${val ?? 'unspecified'} by ${c.field || 'rating'}`,
        canonical,
      };
    }

    case 'contact_extraction':
      return null;

    case 'entity_discovery':
      return null;

    case 'location_constraint': {
      const val = typeof c.value === 'string' ? c.value : String(c.value ?? '');
      if (c.operator === 'near' || c.operator === 'within') {
        return {
          id: `c_loc_near_m${index}`,
          type: 'LOCATION_NEAR',
          field: 'location',
          operator: 'within_km',
          value: { center: val, km: 10 },
          hard: c.hardness === 'hard',
          rationale: `${c.operator === 'within' ? 'Within' : 'Near'} ${val}`,
          canonical,
        };
      }
      return {
        id: `c_loc_m${index}`,
        type: 'LOCATION_EQUALS',
        field: 'location',
        operator: '=',
        value: val,
        hard: c.hardness === 'hard',
        rationale: `Location constraint: ${val}`,
        canonical,
      };
    }

    default:
      return null;
  }
}

export function buildHandoffDiagnostic(
  mission: StructuredMission,
  mappedConstraints: StructuredConstraint[],
): HandoffDiagnostic {
  const canonicalConstraints = mission.constraints.map((c, i) => ({
    index: i,
    type: c.type,
    field: c.field,
    operator: c.operator,
    value: c.value,
    hardness: c.hardness,
  }));

  const mapped = mappedConstraints
    .filter(c => c.canonical)
    .map(c => ({
      id: c.id,
      type: c.type,
      field: c.field,
      operator: c.operator,
      value: c.value,
      hard: c.hard,
      has_canonical: !!c.canonical,
    }));

  const downgrades: ConstraintDowngrade[] = [];

  for (const c of mappedConstraints) {
    if (!c.canonical) continue;
    const ct = c.canonical.type;
    const mt = c.type;

    if (ct === 'relationship_check' && mt === 'HAS_ATTRIBUTE') {
      downgrades.push({ constraint_index: mappedConstraints.indexOf(c), canonical_type: ct, mapped_type: mt, reason: 'relationship_to_has_attribute', detail: `Relationship "${c.canonical.operator} ${c.canonical.value}" downgraded to generic attribute` });
    }
    if (ct === 'status_check' && mt === 'HAS_ATTRIBUTE') {
      downgrades.push({ constraint_index: mappedConstraints.indexOf(c), canonical_type: ct, mapped_type: mt, reason: 'status_to_has_attribute', detail: `Status "${c.canonical.field} ${c.canonical.operator} ${c.canonical.value}" downgraded to generic attribute` });
    }
    if (ct === 'time_constraint' && mt === 'HAS_ATTRIBUTE') {
      downgrades.push({ constraint_index: mappedConstraints.indexOf(c), canonical_type: ct, mapped_type: mt, reason: 'time_to_has_attribute', detail: `Time constraint "${c.canonical.field} ${c.canonical.operator} ${c.canonical.value}" downgraded to generic attribute` });
    }
    if (ct === 'website_evidence' && mt === 'HAS_ATTRIBUTE') {
      downgrades.push({ constraint_index: mappedConstraints.indexOf(c), canonical_type: ct, mapped_type: mt, reason: 'website_evidence_to_has_attribute', detail: `Website evidence "${c.canonical.value}" downgraded to generic attribute` });
    }
    if (ct === 'ranking' && mt === 'COUNT_MIN') {
      downgrades.push({ constraint_index: mappedConstraints.indexOf(c), canonical_type: ct, mapped_type: mt, reason: 'ranking_to_count_min', detail: `Ranking "${c.canonical.operator} by ${c.canonical.field}" downgraded to numeric minimum` });
    }
  }

  return {
    canonical_constraints: canonicalConstraints,
    mapped_constraints: mapped,
    downgrades,
    downgrade_count: downgrades.length,
    mapping_fidelity: downgrades.length === 0 ? 'exact' : 'degraded',
  };
}

export function missionToParsedGoal(
  mission: StructuredMission,
  originalGoal: string,
): ParsedGoal {
  const businessType = mission.entity_category;
  const location = mission.location_text ?? '';
  const country = location ? inferCountryFromLocation(location) : 'UK';
  const requestedCountUser = mission.requested_count ?? null;
  const searchBudgetCount = requestedCountUser
    ? Math.min(Math.max(30, requestedCountUser * 3), 50)
    : 30;

  const constraints: StructuredConstraint[] = [];

  if (requestedCountUser !== null && requestedCountUser > 0) {
    constraints.push({
      id: 'c_count',
      type: 'COUNT_MIN',
      field: 'count',
      operator: '>=',
      value: requestedCountUser,
      hard: true,
      rationale: `User requested ${requestedCountUser} results`,
    });
  }

  if (location) {
    constraints.push({
      id: 'c_location',
      type: 'LOCATION_EQUALS',
      field: 'location',
      operator: '=',
      value: location,
      hard: false,
      rationale: `Location: ${location}`,
    });
  }

  let nameFilter: string | null = null;
  let prefixFilter: string | null = null;
  let attributeFilter: string | null = null;
  let includeEmail = false;
  let includePhone = false;
  let includeWebsite = false;

  for (let i = 0; i < mission.constraints.length; i++) {
    const mc = mission.constraints[i];

    if (mc.type === 'contact_extraction') {
      const field = mc.field?.toLowerCase() ?? '';
      if (field === 'email') includeEmail = true;
      else if (field === 'phone') includePhone = true;
      else if (field === 'website') includeWebsite = true;
      else {
        includeEmail = true;
        includePhone = true;
        includeWebsite = true;
      }
      continue;
    }

    const mapped = mapMissionConstraintToStructured(mc, i);
    if (mapped) {
      constraints.push(mapped);
      if (mapped.type === 'NAME_CONTAINS' && !nameFilter) {
        nameFilter = typeof mapped.value === 'string' ? mapped.value : null;
      }
      if (mapped.type === 'NAME_STARTS_WITH' && !prefixFilter) {
        prefixFilter = typeof mapped.value === 'string' ? mapped.value : null;
      }
      if (isAttributeLikeConstraint(mapped.type) && !attributeFilter) {
        attributeFilter = typeof mapped.value === 'string' ? mapped.value : null;
      }
    }
  }

  const requiredConstraintIds = constraints.filter(c => c.hard).map(c => c.id);
  const optionalConstraintIds = constraints.filter(c => !c.hard).map(c => c.id);

  const successCriteria: SuccessCriteria = {
    required_constraints: requiredConstraintIds,
    optional_constraints: optionalConstraintIds,
    target_count: requestedCountUser,
  };

  return {
    original_goal: originalGoal,
    requested_count_user: requestedCountUser,
    search_budget_count: searchBudgetCount,
    business_type: businessType,
    location,
    country,
    prefix_filter: prefixFilter,
    name_filter: nameFilter,
    attribute_filter: attributeFilter,
    tool_preference: null,
    include_email: includeEmail,
    include_phone: includePhone,
    include_website: includeWebsite,
    constraints,
    success_criteria: successCriteria,
  };
}

export function logMissionShadow(
  trace: MissionExtractionTrace,
  legacyIntent: CanonicalIntent | null,
  legacyParsedGoal: ParsedGoal | null,
): void {
  const mission = trace.pass2_structured_mission;

  console.log(`[MISSION_SHADOW] ======= Mission Extraction Trace =======`);
  console.log(`[MISSION_SHADOW] Raw input: "${trace.raw_user_input.substring(0, 200)}"`);
  console.log(`[MISSION_SHADOW] Pass 1 interpretation: "${trace.pass1_semantic_interpretation.substring(0, 300)}"`);
  console.log(`[MISSION_SHADOW] failure_stage=${trace.failure_stage}`);

  if (mission) {
    console.log(`[MISSION_SHADOW] Pass 2 mission: entity="${mission.entity_category}" location="${mission.location_text}" mode="${mission.mission_mode}" constraints=${mission.constraints.length}`);
    for (const c of mission.constraints) {
      console.log(`[MISSION_SHADOW]   constraint: type=${c.type} field=${c.field} op=${c.operator} value="${c.value}" hardness=${c.hardness}`);
    }

    const comparison = compareMissionWithLegacy(mission, legacyIntent, legacyParsedGoal);
    if (comparison.differences.length > 0) {
      console.log(`[MISSION_SHADOW] Differences from legacy:`);
      for (const diff of comparison.differences) {
        console.log(`[MISSION_SHADOW]   ${diff}`);
      }
    } else {
      console.log(`[MISSION_SHADOW] No differences from legacy detected`);
    }
  } else {
    console.log(`[MISSION_SHADOW] Pass 2 failed: ${trace.validation_result.errors.join('; ')}`);
  }

  console.log(`[MISSION_SHADOW] Model: ${trace.model} | Pass1: ${trace.pass1_duration_ms}ms | Pass2: ${trace.pass2_duration_ms}ms | Total: ${trace.total_duration_ms}ms`);
  console.log(`[MISSION_SHADOW] ====================================`);
}
