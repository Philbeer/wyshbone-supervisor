import { storage } from '../storage';
import { createArtefact } from './artefacts';
import { computeQueryShapeKey, deriveQueryShapeFromGoal, type QueryShapeInput } from './query-shape-key';

export type VerificationLevel = 'minimal' | 'standard' | 'strict';
export type RadiusEscalation = 'off' | 'allowed' | 'aggressive';

export interface LearningKnobs {
  default_result_count: number;
  verification_level: VerificationLevel;
  search_budget_pages: number;
  radius_escalation: RadiusEscalation;
  stop_if_underfilled: boolean;
}

export interface FieldMetadataEntry {
  last_updated_run_id: string;
  updated_at: string;
}

export type FieldMetadata = Partial<Record<keyof LearningKnobs, FieldMetadataEntry>>;

export const BASELINE_DEFAULTS: LearningKnobs = {
  default_result_count: 20,
  verification_level: 'standard',
  search_budget_pages: 3,
  radius_escalation: 'allowed',
  stop_if_underfilled: false,
};

const ACTIVE_KNOBS: Set<keyof LearningKnobs> = new Set([
  'default_result_count',
  'search_budget_pages',
]);

export interface FinalPolicy {
  knobs: LearningKnobs;
  source_of_each_field: Record<keyof LearningKnobs, 'default' | 'user_override' | 'learned'>;
  active_fields: (keyof LearningKnobs)[];
  inactive_fields: (keyof LearningKnobs)[];
}

export interface PolicyAppliedArtefact {
  query_shape_key: string;
  final_policy: LearningKnobs;
  learned_used: boolean;
  learned_fields_used: string[];
  source_of_each_field: Record<string, 'default' | 'user_override' | 'learned'>;
  source_run_ids: Record<string, string>;
  active_fields: string[];
  inactive_fields: string[];
}

export interface UserOverrides {
  requested_count?: number;
  verification_level?: VerificationLevel;
}

export async function readLearningStore(queryShapeKey: string): Promise<{
  knobs: LearningKnobs;
  fieldMetadata: FieldMetadata;
  exists: boolean;
}> {
  const row = await storage.getLearningStoreEntry(queryShapeKey);
  if (!row) {
    return {
      knobs: { ...BASELINE_DEFAULTS },
      fieldMetadata: {},
      exists: false,
    };
  }

  return {
    knobs: {
      default_result_count: row.defaultResultCount,
      verification_level: row.verificationLevel as VerificationLevel,
      search_budget_pages: row.searchBudgetPages,
      radius_escalation: row.radiusEscalation as RadiusEscalation,
      stop_if_underfilled: row.stopIfUnderfilled === 1,
    },
    fieldMetadata: (row.fieldMetadata as FieldMetadata) || {},
    exists: true,
  };
}

export function mergePolicyKnobs(
  baseline: LearningKnobs,
  learned: LearningKnobs | null,
  learnedFieldMetadata: FieldMetadata,
  userOverrides?: UserOverrides,
): FinalPolicy {
  const knobs = { ...baseline };
  const source: Record<keyof LearningKnobs, 'default' | 'user_override' | 'learned'> = {
    default_result_count: 'default',
    verification_level: 'default',
    search_budget_pages: 'default',
    radius_escalation: 'default',
    stop_if_underfilled: 'default',
  };

  if (learned) {
    const knobKeys: (keyof LearningKnobs)[] = [
      'default_result_count',
      'verification_level',
      'search_budget_pages',
      'radius_escalation',
      'stop_if_underfilled',
    ];
    for (const key of knobKeys) {
      if (learnedFieldMetadata[key]) {
        (knobs as any)[key] = learned[key];
        source[key] = 'learned';
      }
    }
  }

  if (userOverrides?.requested_count !== undefined) {
    knobs.default_result_count = userOverrides.requested_count;
    source.default_result_count = 'user_override';
  }
  if (userOverrides?.verification_level !== undefined) {
    knobs.verification_level = userOverrides.verification_level;
    source.verification_level = 'user_override';
  }

  const activeFields: (keyof LearningKnobs)[] = [];
  const inactiveFields: (keyof LearningKnobs)[] = [];
  for (const key of Object.keys(knobs) as (keyof LearningKnobs)[]) {
    if (ACTIVE_KNOBS.has(key)) {
      activeFields.push(key);
    } else {
      inactiveFields.push(key);
    }
  }

  return { knobs, source_of_each_field: source, active_fields: activeFields, inactive_fields: inactiveFields };
}

export function buildPolicyAppliedPayload(
  queryShapeKey: string,
  finalPolicy: FinalPolicy,
  learnedFieldMetadata: FieldMetadata,
  learnedExists: boolean,
): PolicyAppliedArtefact {
  const learnedFieldsUsed: string[] = [];
  const sourceRunIds: Record<string, string> = {};

  for (const [field, src] of Object.entries(finalPolicy.source_of_each_field)) {
    if (src === 'learned') {
      learnedFieldsUsed.push(field);
      const meta = learnedFieldMetadata[field as keyof LearningKnobs];
      if (meta?.last_updated_run_id) {
        sourceRunIds[field] = meta.last_updated_run_id;
      }
    }
  }

  return {
    query_shape_key: queryShapeKey,
    final_policy: finalPolicy.knobs,
    learned_used: learnedExists && learnedFieldsUsed.length > 0,
    learned_fields_used: learnedFieldsUsed,
    source_of_each_field: finalPolicy.source_of_each_field,
    source_run_ids: sourceRunIds,
    active_fields: finalPolicy.active_fields,
    inactive_fields: finalPolicy.inactive_fields,
  };
}

export async function emitPolicyAppliedArtefact(params: {
  runId: string;
  userId: string;
  conversationId?: string;
  policyApplied: PolicyAppliedArtefact;
}): Promise<void> {
  const { runId, userId, conversationId, policyApplied } = params;
  try {
    await createArtefact({
      runId,
      type: 'policy_applied',
      title: `Policy Applied: ${policyApplied.query_shape_key}`,
      summary: `learned_used=${policyApplied.learned_used} learned_fields=[${policyApplied.learned_fields_used.join(',')}] active=[${policyApplied.active_fields.join(',')}]`,
      payload: policyApplied as unknown as Record<string, unknown>,
      userId,
      conversationId,
    });
    console.log(`[LEARNING_STORE] policy_applied artefact emitted for run_id=${runId} shape_key=${policyApplied.query_shape_key}`);
  } catch (err: any) {
    console.error(`[LEARNING_STORE] policy_applied artefact FAILED for run_id=${runId}: ${err.message}`);
  }
}

export interface LearningUpdatePayload {
  query_shape_key: string;
  run_id: string;
  updates: Partial<LearningKnobs>;
}

export async function handleLearningUpdate(payload: LearningUpdatePayload): Promise<void> {
  const { query_shape_key, run_id, updates } = payload;
  console.log(`[LEARNING_STORE] Processing learning_update for shape_key=${query_shape_key} from run_id=${run_id}`);

  const existing = await storage.getLearningStoreEntry(query_shape_key);

  const now = new Date().toISOString();
  const existingMeta = (existing?.fieldMetadata as FieldMetadata) || {};
  const newMeta: FieldMetadata = { ...existingMeta };

  for (const key of Object.keys(updates) as (keyof LearningKnobs)[]) {
    newMeta[key] = {
      last_updated_run_id: run_id,
      updated_at: now,
    };
  }

  if (existing) {
    const updateFields: Record<string, unknown> = {};
    if (updates.default_result_count !== undefined) updateFields.defaultResultCount = updates.default_result_count;
    if (updates.verification_level !== undefined) updateFields.verificationLevel = updates.verification_level;
    if (updates.search_budget_pages !== undefined) updateFields.searchBudgetPages = updates.search_budget_pages;
    if (updates.radius_escalation !== undefined) updateFields.radiusEscalation = updates.radius_escalation;
    if (updates.stop_if_underfilled !== undefined) updateFields.stopIfUnderfilled = updates.stop_if_underfilled ? 1 : 0;
    updateFields.fieldMetadata = newMeta;

    await storage.updateLearningStoreEntry(query_shape_key, updateFields);
    console.log(`[LEARNING_STORE] Updated existing entry for shape_key=${query_shape_key} fields=[${Object.keys(updates).join(',')}]`);
  } else {
    const baseline = { ...BASELINE_DEFAULTS };
    if (updates.default_result_count !== undefined) baseline.default_result_count = updates.default_result_count;
    if (updates.verification_level !== undefined) baseline.verification_level = updates.verification_level;
    if (updates.search_budget_pages !== undefined) baseline.search_budget_pages = updates.search_budget_pages;
    if (updates.radius_escalation !== undefined) baseline.radius_escalation = updates.radius_escalation;
    if (updates.stop_if_underfilled !== undefined) baseline.stop_if_underfilled = updates.stop_if_underfilled;

    await storage.createLearningStoreEntry({
      queryShapeKey: query_shape_key,
      defaultResultCount: baseline.default_result_count,
      verificationLevel: baseline.verification_level,
      searchBudgetPages: baseline.search_budget_pages,
      radiusEscalation: baseline.radius_escalation,
      stopIfUnderfilled: baseline.stop_if_underfilled ? 1 : 0,
      fieldMetadata: newMeta,
    });
    console.log(`[LEARNING_STORE] Created new entry for shape_key=${query_shape_key} fields=[${Object.keys(updates).join(',')}]`);
  }
}
