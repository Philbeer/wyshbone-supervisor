import { randomUUID } from 'crypto';
import type { SleepingGoal, WakeResult } from './types';
import { detectDelta } from './delta-detector';
import { supabase } from '../../supabase';
import { createArtefact } from '../artefacts';
import { logRunEvent } from '../run-logger';
import { logAFREvent } from '../afr-logger';
import type { StructuredMission, MissionConstraint } from '../mission-schema';
import { buildMissionPlan } from '../mission-planner';
import { runReloop } from '../reloop/index';

export async function executeWake(goal: SleepingGoal): Promise<WakeResult> {
  const runId = randomUUID();

  try {
    console.log(`[SLEEP_WAKE] Waking goal ${goal.id}: "${goal.label}" (schedule=${goal.scheduleType})`);

    const mission: StructuredMission = {
      entity_category: goal.config.business_type,
      location_text: goal.config.location,
      requested_count: null,
      mission_mode: 'research_now',
      constraints: goal.config.constraints.map(c => ({
        type: c.type as MissionConstraint['type'],
        field: c.field,
        operator: c.operator,
        value: c.value as MissionConstraint['value'],
        hardness: 'hard' as const,
      })),
    };

    const missionPlan = buildMissionPlan(mission);

    const missionTrace = {
      raw_user_input: goal.config.original_goal,
      pass1_semantic_interpretation: `Wake scan for: ${goal.config.original_goal}`,
      pass1_constraint_checklist: null,
      implicit_expansion: null,
      pass2_structured_mission: mission,
      pass2_raw_json: '',
      validation_result: { ok: true, mission, errors: [] },
      pass3_intent_narrative: null,
      pass3_raw_json: '',
      pass3_duration_ms: 0,
      model: 'wake_scan',
      pass1_duration_ms: 0,
      pass2_duration_ms: 0,
      total_duration_ms: 0,
      timestamp: new Date().toISOString(),
      failure_stage: 'none' as const,
    };

    const result = await runReloop({
      runId,
      userId: goal.userId,
      conversationId: goal.conversationId ?? undefined,
      rawUserInput: goal.config.original_goal,
      mission,
      plan: missionPlan,
      missionTrace,
      intentNarrative: null,
      queryId: null,
      executionPath: 'gp_cascade',
    });

    const entityNames = result.leads.map(l => l.name);
    const delta = detectDelta(goal.baselineEntityNames, entityNames);

    await createArtefact({
      runId,
      type: 'sleep_wake_result',
      title: `Wake scan: ${goal.label} — ${delta.newEntities.length} new entities`,
      summary: `Found ${entityNames.length} total, ${delta.newEntities.length} new, ${delta.removedEntities.length} removed`,
      payload: {
        goal_id: goal.id,
        schedule_type: goal.scheduleType,
        baseline_count: delta.baselineCount,
        current_count: delta.currentCount,
        new_entities: delta.newEntities,
        removed_entities: delta.removedEntities,
        unchanged_count: delta.unchangedCount,
      },
      userId: goal.userId,
      conversationId: goal.conversationId ?? undefined,
    }).catch(e => console.warn(`[SLEEP_WAKE] artefact failed: ${e.message}`));

    return {
      goalId: goal.id,
      runId,
      entitiesFound: entityNames,
      newEntities: delta.newEntities,
      removedEntities: delta.removedEntities,
      deltaCount: delta.newEntities.length,
      succeeded: true,
    };
  } catch (err: any) {
    console.error(`[SLEEP_WAKE] Wake failed for goal ${goal.id}: ${err.message}`);
    return {
      goalId: goal.id,
      runId,
      entitiesFound: [],
      newEntities: [],
      removedEntities: [],
      deltaCount: 0,
      succeeded: false,
      error: err.message,
    };
  }
}
