import { z } from 'zod';

export const MISSION_CONSTRAINT_TYPES = [
  'entity_discovery',
  'location_constraint',
  'text_compare',
  'attribute_check',
  'relationship_check',
  'numeric_range',
  'time_constraint',
  'status_check',
  'website_evidence',
  'contact_extraction',
  'ranking',
] as const;

export type MissionConstraintType = typeof MISSION_CONSTRAINT_TYPES[number];

export const MISSION_MODES = [
  'research_now',
  'monitor',
  'alert_on_change',
  'recurring_check',
] as const;

export type MissionMode = typeof MISSION_MODES[number];

export const TEXT_COMPARE_OPERATORS = [
  'contains',
  'starts_with',
  'ends_with',
  'equals',
  'not_contains',
] as const;

export const NUMERIC_OPERATORS = [
  'gte',
  'lte',
  'gt',
  'lt',
  'eq',
  'between',
] as const;

export const ATTRIBUTE_CHECK_OPERATORS = ['has', 'equals', 'not_has'] as const;
export const RELATIONSHIP_CHECK_OPERATORS = ['has', 'serves', 'owned_by', 'managed_by', 'partners_with'] as const;
export const TIME_CONSTRAINT_OPERATORS = ['within_last', 'after', 'before'] as const;
export const STATUS_CHECK_OPERATORS = ['equals', 'has', 'not_equals'] as const;
export const WEBSITE_EVIDENCE_OPERATORS = ['contains', 'mentions'] as const;
export const CONTACT_EXTRACTION_OPERATORS = ['extract'] as const;
export const RANKING_OPERATORS = ['top', 'best', 'bottom'] as const;
export const ENTITY_DISCOVERY_OPERATORS = ['equals', 'includes'] as const;
export const LOCATION_CONSTRAINT_OPERATORS = ['within', 'near', 'equals'] as const;

export const VALID_OPERATORS_BY_TYPE: Record<MissionConstraintType, readonly string[]> = {
  text_compare: TEXT_COMPARE_OPERATORS,
  numeric_range: NUMERIC_OPERATORS,
  attribute_check: ATTRIBUTE_CHECK_OPERATORS,
  relationship_check: RELATIONSHIP_CHECK_OPERATORS,
  time_constraint: TIME_CONSTRAINT_OPERATORS,
  status_check: STATUS_CHECK_OPERATORS,
  website_evidence: WEBSITE_EVIDENCE_OPERATORS,
  contact_extraction: CONTACT_EXTRACTION_OPERATORS,
  ranking: RANKING_OPERATORS,
  entity_discovery: ENTITY_DISCOVERY_OPERATORS,
  location_constraint: LOCATION_CONSTRAINT_OPERATORS,
};

export const HARDNESS_VALUES = ['hard', 'soft'] as const;

// PHASE_2: Evidence requirement tiers — declares what kind of proof a constraint needs
export const EVIDENCE_REQUIREMENT_VALUES = [
  'none',
  'lead_field',
  'directory_data',
  'search_snippet',
  'website_text',
  'external_source',
] as const;

export type EvidenceRequirement = typeof EVIDENCE_REQUIREMENT_VALUES[number];

// PHASE_2: Mapping from constraint type to default evidence requirement
export function defaultEvidenceRequirement(type: MissionConstraintType, operator?: string): EvidenceRequirement {
  switch (type) {
    case 'text_compare':
      return 'none';
    case 'entity_discovery':
      return 'none';
    case 'contact_extraction':
      return 'none';
    case 'numeric_range':
      return 'none';
    case 'ranking':
      return 'none';
    case 'location_constraint':
      return 'directory_data';
    case 'website_evidence':
      return 'website_text';
    case 'attribute_check':
      return 'website_text';
    case 'status_check':
      return 'website_text';
    case 'relationship_check':
      return 'external_source';
    case 'time_constraint':
      return 'external_source';
    default:
      return 'external_source';
  }
}

export const MissionConstraintSchema = z.object({
  type: z.enum(MISSION_CONSTRAINT_TYPES),
  field: z.string().min(1),
  operator: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  value_secondary: z.union([z.string(), z.number(), z.null()]).optional(),
  hardness: z.enum(HARDNESS_VALUES),
  evidence_requirement: z.enum(EVIDENCE_REQUIREMENT_VALUES).optional(), // PHASE_2
  synonyms: z.array(z.string()).nullable().optional(), // LLM-generated synonyms for website_evidence matching
  reasoning_mode: z.enum(['direct', 'inferential']).nullable().optional(), // how evidence should be judged
});

export type MissionConstraint = z.infer<typeof MissionConstraintSchema>;

export const StructuredMissionSchema = z.object({
  entity_category: z.string().min(1),
  location_text: z.string().nullable(),
  requested_count: z.number().nullable(),
  constraints: z.array(MissionConstraintSchema),
  mission_mode: z.enum(MISSION_MODES),
});

export type StructuredMission = z.infer<typeof StructuredMissionSchema>;

export interface MissionValidationResult {
  ok: boolean;
  mission: StructuredMission | null;
  errors: string[];
}

export type MissionFailureStage =
  | 'none'
  | 'no_api_key'
  | 'pass1_llm_call'
  | 'pass2_llm_call'
  | 'pass2_json_parse'
  | 'pass2_schema_validation'
  | 'extractor_exception';

export function validateStructuredMission(raw: unknown): MissionValidationResult {
  if (raw === null || raw === undefined) {
    return { ok: false, mission: null, errors: ['Input is null or undefined'] };
  }

  const parseResult = StructuredMissionSchema.safeParse(raw);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`
    );
    return { ok: false, mission: null, errors };
  }

  const mission = parseResult.data;
  const errors: string[] = [];

  for (let i = 0; i < mission.constraints.length; i++) {
    const c = mission.constraints[i];

    const validOps = VALID_OPERATORS_BY_TYPE[c.type as MissionConstraintType];
    if (validOps && !validOps.includes(c.operator)) {
      errors.push(`constraints[${i}].operator: "${c.operator}" is not valid for type "${c.type}". Allowed: [${validOps.join(', ')}]`);
    }

    if (c.type === 'numeric_range') {
      if (typeof c.value !== 'number') {
        errors.push(`constraints[${i}].value: numeric_range requires a number value, got ${typeof c.value}`);
      }
      if (c.operator === 'between' && (c.value_secondary === null || c.value_secondary === undefined)) {
        errors.push(`constraints[${i}]: "between" operator requires value_secondary`);
      }
    }

    if (c.type === 'contact_extraction') {
      if (c.operator !== 'extract') {
        errors.push(`constraints[${i}].operator: contact_extraction must use "extract" operator`);
      }
    }

    if (c.type === 'text_compare' && (typeof c.value !== 'string' || c.value.trim().length === 0)) {
      errors.push(`constraints[${i}].value: text_compare requires a non-empty string value`);
    }

    if (c.type === 'website_evidence' && (typeof c.value !== 'string' || c.value.trim().length === 0)) {
      errors.push(`constraints[${i}].value: website_evidence requires a non-empty string value`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, mission: null, errors };
  }

  for (const c of mission.constraints) {
    if (!c.evidence_requirement) {
      c.evidence_requirement = defaultEvidenceRequirement(c.type as MissionConstraintType, c.operator);
    }
  }

  return { ok: true, mission, errors: [] };
}

export function parseAndValidateMissionJSON(jsonString: string): MissionValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e: any) {
    return { ok: false, mission: null, errors: [`JSON parse error: ${e.message}`] };
  }
  return validateStructuredMission(parsed);
}

export interface ConstraintChecklist {
  has_entity: boolean;
  has_location: boolean;
  has_text_compare: boolean;
  has_attribute_check: boolean;
  has_relationship_check: boolean;
  has_numeric_range: boolean;
  has_time_constraint: boolean;
  has_status_check: boolean;
  has_website_evidence: boolean;
  has_contact_extraction: boolean;
  has_ranking: boolean;
  has_requested_count: boolean;
  has_monitoring_intent: boolean;
}

export interface ImplicitExpansionTrace {
  explicit_constraints: string[];
  inferred_constraints: Array<{
    type: string;
    field: string;
    operator: string;
    value: string | number | null;
    hardness: string;
    source: string;
  }>;
  inference_notes: string[];
  had_addendum: boolean;
}

export interface IntentNarrative {
  entity_description: string;
  entity_exclusions: string[];
  commercial_context: string;
  key_discriminator: string;
  findability: 'easy' | 'moderate' | 'hard' | 'very_hard';
  findability_reason: string;
  suggested_approaches: string[];
  fallback_intent: string;
  scarcity_expectation: 'abundant' | 'moderate' | 'scarce' | 'unknown';
  clarification_needed: boolean;
  clarification_question: string | null;
  ambiguity_flags: string[];
}

export interface MissionExtractionTrace {
  raw_user_input: string;
  pass1_semantic_interpretation: string;
  pass1_constraint_checklist: ConstraintChecklist | null;
  implicit_expansion: ImplicitExpansionTrace | null;
  pass2_structured_mission: StructuredMission | null;
  pass2_raw_json: string;
  validation_result: MissionValidationResult;
  pass3_intent_narrative: IntentNarrative | null;
  pass3_raw_json: string;
  pass3_duration_ms: number;
  model: string;
  pass1_duration_ms: number;
  pass2_duration_ms: number;
  total_duration_ms: number;
  timestamp: string;
  failure_stage: MissionFailureStage;
}
