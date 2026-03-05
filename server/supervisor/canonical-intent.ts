import { z } from 'zod';

export const MISSION_TYPE_ENUM = [
  'find_businesses',
  'deep_research',
  'explain',
  'meta_question',
  'unknown',
] as const;

export const ENTITY_KIND_ENUM = [
  'venue',
  'company',
  'person',
  'unknown',
] as const;

export const GEO_MODE_ENUM = [
  'city',
  'region',
  'radius',
  'national',
  'unspecified',
] as const;

export const DEFAULT_COUNT_POLICY_ENUM = [
  'page_1',
  'explicit',
  'best_effort',
] as const;

export const CONSTRAINT_TYPE_ENUM = [
  'attribute',
  'rating',
  'reviews',
  'time',
  'name_filter',
  'category',
  'relationship',
  'unknown_constraint',
] as const;

export const HARDNESS_ENUM = ['hard', 'soft'] as const;

export const EVIDENCE_MODE_ENUM = [
  'google_places',
  'places_fields',
  'website_text',
  'web_search',
  'news',
  'registry',
  'review_text',
  'not_applicable',
  'unknown',
] as const;

export const PLAN_TEMPLATE_HINT_ENUM = [
  'simple_search',
  'search_and_verify',
  'search_verify_enrich',
  'deep_research',
  'unknown',
] as const;

export const CanonicalConstraintSchema = z.object({
  type: z.enum(CONSTRAINT_TYPE_ENUM),
  raw: z.string(),
  hardness: z.enum(HARDNESS_ENUM),
  evidence_mode: z.enum(EVIDENCE_MODE_ENUM),
  clarify_if_needed: z.boolean(),
  clarify_question: z.string().nullable(),
});

export type CanonicalConstraint = z.infer<typeof CanonicalConstraintSchema>;

export const CanonicalIntentSchema = z.object({
  mission_type: z.enum(MISSION_TYPE_ENUM),
  entity_kind: z.enum(ENTITY_KIND_ENUM),
  entity_category: z.string().nullable(),
  location_text: z.string().nullable(),
  geo_mode: z.enum(GEO_MODE_ENUM),
  radius_km: z.number().nullable(),
  requested_count: z.number().nullable(),
  default_count_policy: z.enum(DEFAULT_COUNT_POLICY_ENUM),
  constraints: z.array(CanonicalConstraintSchema),
  plan_template_hint: z.enum(PLAN_TEMPLATE_HINT_ENUM),
  preferred_evidence_order: z.array(z.enum(EVIDENCE_MODE_ENUM)),
});

export type CanonicalIntent = z.infer<typeof CanonicalIntentSchema>;

const OLD_SHAPE_FIELDS = ['action', 'business_type', 'country', 'location', 'count', 'delivery_requirements', 'confidence', 'raw_input'] as const;

export interface IntentValidationResult {
  ok: boolean;
  intent: CanonicalIntent | null;
  errors: string[];
}

export function validateCanonicalIntent(raw: unknown): IntentValidationResult {
  if (raw === null || raw === undefined) {
    return { ok: false, intent: null, errors: ['Input is null or undefined'] };
  }

  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const oldFieldsFound = OLD_SHAPE_FIELDS.filter(f => f in obj);
    if (oldFieldsFound.length > 0) {
      return {
        ok: false,
        intent: null,
        errors: [`Old schema fields detected: ${oldFieldsFound.join(', ')}. Extractor must use the v2 canonical shape.`],
      };
    }
  }

  const parseResult = CanonicalIntentSchema.safeParse(raw);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`
    );
    return { ok: false, intent: null, errors };
  }

  const intent = parseResult.data;
  const errors: string[] = [];

  for (let i = 0; i < intent.constraints.length; i++) {
    const c = intent.constraints[i];
    if (!c.type) errors.push(`constraints[${i}]: missing type`);
    if (!c.raw && c.raw !== '') errors.push(`constraints[${i}]: missing raw`);
    if (!c.hardness) errors.push(`constraints[${i}]: missing hardness`);
    if (!c.evidence_mode) errors.push(`constraints[${i}]: missing evidence_mode`);
    if (c.clarify_if_needed === undefined) errors.push(`constraints[${i}]: missing clarify_if_needed`);
  }

  if (errors.length > 0) {
    return { ok: false, intent: null, errors };
  }

  return { ok: true, intent, errors: [] };
}

export function parseAndValidateIntentJSON(jsonString: string): IntentValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e: any) {
    return { ok: false, intent: null, errors: [`JSON parse error: ${e.message}`] };
  }
  return validateCanonicalIntent(parsed);
}
