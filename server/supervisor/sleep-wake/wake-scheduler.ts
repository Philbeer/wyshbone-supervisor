import { supabase } from '../../supabase';
import { createArtefact } from '../artefacts';
import { logAFREvent } from '../afr-logger';
import type { SleepingGoal, WakeResult } from './types';
import { executeWake } from './wake-executor';

let isWaking = false;

const INTERVAL_MS: Record<string, number> = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
};

export async function checkAndWakeGoals(): Promise<void> {
  if (!supabase || process.env.SLEEP_WAKE_ENABLED !== 'true') return;
  if (isWaking) return;

  isWaking = true;
  try {
    const now = new Date().toISOString();
    const { data: dueMonitors, error } = await supabase
      .from('scheduled_monitors')
      .select('*')
      .eq('is_active', 1)
      .lte('next_wake_at', now)
      .order('next_wake_at', { ascending: true })
      .limit(5);

    if (error) {
      console.error(`[SLEEP_WAKE] Failed to query due monitors: ${error.message}`);
      return;
    }

    if (!dueMonitors || dueMonitors.length === 0) return;

    console.log(`[SLEEP_WAKE] ${dueMonitors.length} goal(s) due for wake`);

    for (const monitor of dueMonitors) {
      const goal: SleepingGoal = {
        id: monitor.id.toString(),
        userId: monitor.user_id,
        conversationId: monitor.conversation_id ?? null,
        label: monitor.label,
        description: monitor.description ?? '',
        scheduleType: monitor.schedule ?? 'daily',
        monitorType: monitor.monitor_type ?? 'lead_search',
        config: monitor.config ?? {},
        baselineEntityNames: monitor.baseline_entity_names ?? [],
        consecutiveEmptyWakes: monitor.consecutive_empty_wakes ?? 0,
        lastRunAt: monitor.last_run_at,
        lastRunId: monitor.last_run_id,
        nextWakeAt: monitor.next_wake_at,
        createdAt: monitor.created_at,
      };

      let wakeResult: WakeResult;
      try {
        wakeResult = await executeWake(goal);
      } catch (err: any) {
        console.error(`[SLEEP_WAKE] Uncaught error waking goal ${goal.id}: ${err.message}`);
        continue;
      }

      const intervalMs = INTERVAL_MS[goal.scheduleType] ?? INTERVAL_MS.daily;

      await supabase.from('scheduled_monitors').update({
        last_run_at: new Date().toISOString(),
        last_run_id: wakeResult.runId,
        next_wake_at: new Date(Date.now() + intervalMs).toISOString(),
        baseline_entity_names: JSON.stringify(wakeResult.entitiesFound),
        consecutive_empty_wakes: wakeResult.deltaCount > 0 ? 0 : (goal.consecutiveEmptyWakes + 1),
      }).eq('id', monitor.id);

      if (wakeResult.deltaCount > 0 && goal.conversationId) {
        const entityList = wakeResult.newEntities.slice(0, 5).join(', ');
        const moreCount = wakeResult.newEntities.length > 5 ? ` and ${wakeResult.newEntities.length - 5} more` : '';
        const nudgeContent = `I checked again for "${goal.label}" and found ${wakeResult.deltaCount} new result${wakeResult.deltaCount === 1 ? '' : 's'}: ${entityList}${moreCount}. Type "show details" to see the full results.`;

        const { randomUUID } = await import('crypto');
        const messageId = randomUUID();

        await supabase.from('messages').insert({
          id: messageId,
          conversation_id: goal.conversationId,
          role: 'assistant',
          content: nudgeContent,
          source: 'supervisor',
          metadata: {
            sleep_wake: true,
            goal_id: goal.id,
            run_id: wakeResult.runId,
            new_entity_count: wakeResult.deltaCount,
            new_entities: wakeResult.newEntities,
          },
          created_at: Date.now(),
        });

        console.log(`[SLEEP_WAKE] Nudged user ${goal.userId} in conversation ${goal.conversationId}: ${wakeResult.deltaCount} new entities`);
      } else if (wakeResult.deltaCount === 0 && goal.consecutiveEmptyWakes >= 4 && goal.conversationId) {
        // Notify user after 5 consecutive empty wakes
        const { randomUUID } = await import('crypto');
        const messageId = randomUUID();
        const emptyNudge = `I've checked "${goal.label}" ${goal.consecutiveEmptyWakes + 1} times now with no new results. Would you like me to keep monitoring, change the schedule, or stop checking?`;

        await supabase.from('messages').insert({
          id: messageId,
          conversation_id: goal.conversationId,
          role: 'assistant',
          content: emptyNudge,
          source: 'supervisor',
          metadata: {
            sleep_wake: true,
            goal_id: goal.id,
            empty_wake_nudge: true,
            consecutive_empty_wakes: goal.consecutiveEmptyWakes + 1,
          },
          created_at: Date.now(),
        });

        console.log(`[SLEEP_WAKE] Empty wake nudge sent for goal ${goal.id} after ${goal.consecutiveEmptyWakes + 1} empty checks`);
      }

      console.log(`[SLEEP_WAKE] Goal "${goal.label}" wake complete: ${wakeResult.entitiesFound.length} total, ${wakeResult.deltaCount} new`);
    }
  } finally {
    isWaking = false;
  }
}
