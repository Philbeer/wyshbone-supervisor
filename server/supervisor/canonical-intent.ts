import { z } from 'zod';

export const INTENT_ACTION_ENUM = [
  'find_businesses',
  'deep_research',
  'explain',
  'meta_question',
  'unknown',
] as const;

export const CONSTRAINT_TYPE_ENUM = [
  'location',
  'count',
  'attribute',
  'time',
  'name_filter',
  'category',
  'relationship',
  'unknown_constraint',
] as const;

export const HARDNESS_ENUM = ['hard', 'soft'] as const;

export const EVIDENCE_MODE_ENUM = [
  'google_places',
  'website_text',
  'web_search',
  'news',
  'registry',
  'review_text',
  'not_applicable',
  'unknown',
] as const;

export const CanonicalConstraintSchema = z.object({
  type: z.enum(CONSTRAINT_TYPE_ENUM),
  raw: z.string(),
  hardness: z.enum(HARDNESS_ENUM),
  evidence_mode: z.enum(EVIDENCE_MODE_ENUM),
  clarify_if_needed: z.boolean(),
  value: z.union([z.string(), z.number(), z.null()]).optional(),
});

export type CanonicalConstraint = z.infer<typeof CanonicalConstraintSchema>;

export const CanonicalIntentSchema = z.object({
  action: z.enum(INTENT_ACTION_ENUM),
  business_type: z.string().nullable(),
  location: z.string().nullable(),
  country: z.string().nullable(),
  count: z.number().nullable(),
  constraints: z.array(CanonicalConstraintSchema),
  delivery_requirements: z.object({
    email: z.boolean(),
    phone: z.boolean(),
    website: z.boolean(),
  }),
  confidence: z.number().min(0).max(1),
  raw_input: z.string(),
});

export type CanonicalIntent = z.infer<typeof CanonicalIntentSchema>;

export interface IntentValidationResult {
  ok: boolean;
  intent: CanonicalIntent | null;
  errors: string[];
}

export function validateCanonicalIntent(raw: unknown): IntentValidationResult {
  if (raw === null || raw === undefined) {
    return { ok: false, intent: null, errors: ['Input is null or undefined'] };
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
