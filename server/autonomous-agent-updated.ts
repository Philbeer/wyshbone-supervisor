// Patch for autonomous-agent.ts
// Updated storeAgentActivity function to match actual agent_activities schema

/**
 * Store agent activity to agent_activities table (matches actual schema from p2-t1)
 */
async function storeAgentActivity(params: {
  userId: string;
  activityType: string;
  inputData: any;
  outputData: any;
  metadata: any;
  status?: string;
}): Promise<void> {
  if (!supabase) {
    console.warn('[AUTONOMOUS_AGENT] Supabase not configured - skipping storage');
    return;
  }

  try {
    const id = `activity_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const timestamp = Date.now();

    const { error } = await supabase
      .from('agent_activities')
      .insert({
        id,
        user_id: params.userId,
        timestamp,
        task_generated: params.activityType === 'generate_tasks'
          ? `Generated ${params.outputData.tasks?.length || 0} tasks for today`
          : params.activityType,
        action_taken: 'goal_generation',
        action_params: params.inputData,
        results: params.outputData,
        interesting_flag: params.outputData.tasks?.length > 0 ? 1 : 0,
        status: params.status || 'success',
        duration_ms: null, // Will be filled in by task executor
        conversation_id: null,
        run_id: null,
        metadata: params.metadata,
        created_at: timestamp
      });

    if (error) {
      console.error('[AUTONOMOUS_AGENT] Error storing activity:', error);
    } else {
      console.log('[AUTONOMOUS_AGENT] Activity stored successfully');
    }

  } catch (error: any) {
    console.error('[AUTONOMOUS_AGENT] Error storing activity:', error.message);
  }
}
