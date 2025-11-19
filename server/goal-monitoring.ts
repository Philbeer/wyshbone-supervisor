import { supabase } from './supabase';
import { storage } from './storage';

// ========================================
// TYPES
// ========================================

export type GoalMonitorStatus =
  | "ok"
  | "no_plan"
  | "stalled"
  | "repeated_failures";

export interface GoalMonitorEvent {
  userId: string;
  sessionId?: string;
  goalId?: string;
  goalText?: string;
  status: GoalMonitorStatus;
  reason: string;
  lastActivityAt?: string; // ISO timestamp
  failureCount?: number;
  createdAt: string; // ISO timestamp
  monitorType?: string;
  monitorLabel?: string;
}

// ========================================
// CONFIGURATION
// ========================================

// How long before a goal is considered stalled (hours)
const STALE_HOURS = 48;

// Minimum number of leads expected for active goals
const MIN_LEADS_THRESHOLD = 1;

// ========================================
// MONITORING LOGIC
// ========================================

/**
 * Check all active goals/monitors for users and detect problem states.
 * Returns only non-OK events that need attention.
 */
export async function monitorGoalsOnce(): Promise<GoalMonitorEvent[]> {
  const events: GoalMonitorEvent[] = [];

  if (!supabase) {
    console.warn('[GOAL_MONITOR] Supabase not configured, skipping monitoring');
    return events;
  }

  try {
    // Fetch all active scheduled monitors
    const { data: monitors, error: monitorsError } = await supabase
      .from('scheduled_monitors')
      .select('id, user_id, label, description, monitor_type, created_at')
      .eq('is_active', 1);

    if (monitorsError) {
      console.error('[GOAL_MONITOR] Error fetching monitors:', monitorsError);
      return events;
    }

    if (!monitors || monitors.length === 0) {
      console.log('[GOAL_MONITOR] No active monitors found');
      return events;
    }

    console.log(`[GOAL_MONITOR] Checking ${monitors.length} active monitor(s)...`);

    // Check each monitor
    for (const monitor of monitors) {
      const event = await checkMonitorStatus(monitor);
      if (event && event.status !== 'ok') {
        events.push(event);
      }
    }

    // Also check users with objectives but no monitors
    await checkUsersWithoutMonitors(events);

    console.log(`[GOAL_MONITOR] Found ${events.length} issue(s) requiring attention`);
    
  } catch (error) {
    console.error('[GOAL_MONITOR] Error during monitoring:', error);
  }

  return events;
}

/**
 * Check status of a single monitor
 */
async function checkMonitorStatus(monitor: any): Promise<GoalMonitorEvent | null> {
  const userId = monitor.user_id;
  const goalText = monitor.label || monitor.description;
  const monitorCreatedAt = new Date(monitor.created_at);
  const now = new Date();
  const hoursSinceCreation = (now.getTime() - monitorCreatedAt.getTime()) / (1000 * 60 * 60);

  // Only check monitors that have been active for at least 1 hour
  if (hoursSinceCreation < 1) {
    return null;
  }

  if (!supabase) {
    return null;
  }

  try {
    // Check for recent leads (activity indicator)
    const staleThresholdDate = new Date(now.getTime() - STALE_HOURS * 60 * 60 * 1000);
    const oldThresholdDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24h ago
    
    const leads = await storage.getSuggestedLeads(userId);
    const recentLeads = leads.filter(lead => 
      new Date(lead.createdAt) > staleThresholdDate
    );
    const last24hLeads = leads.filter(lead =>
      new Date(lead.createdAt) > oldThresholdDate
    );

    // Check for recent user activity (signals, messages) to detect execution attempts
    const { data: recentSignals } = await supabase
      .from('user_signals')
      .select('id, type, created_at')
      .eq('user_id', userId)
      .gte('created_at', staleThresholdDate.toISOString())
      .order('created_at', { ascending: false })
      .limit(10);

    const { data: supervisorTasks } = await supabase
      .from('supervisor_tasks')
      .select('id, task_type, status, created_at')
      .eq('user_id', userId)
      .gte('created_at', oldThresholdDate.toISOString())
      .order('created_at', { ascending: false })
      .limit(20);

    const hasRecentActivity = (recentSignals && recentSignals.length > 0) || 
                              (supervisorTasks && supervisorTasks.length > 0);
    const failedTasks = supervisorTasks?.filter(t => t.status === 'failed') || [];
    
    // Determine status based on activity patterns
    let status: GoalMonitorStatus = 'ok';
    let reason = '';

    // REPEATED FAILURES: Active execution attempts but no successful leads
    if (hoursSinceCreation >= 24 && hasRecentActivity && last24hLeads.length === 0 && failedTasks.length >= 3) {
      status = 'repeated_failures';
      reason = `Monitor "${monitor.label}" has ${failedTasks.length} failed execution attempts in the past 24h with no successful leads generated. This suggests systematic failures in lead generation.`;
      
      return {
        userId,
        goalId: monitor.id.toString(),
        goalText,
        status,
        reason,
        failureCount: failedTasks.length,
        lastActivityAt: failedTasks[0]?.created_at,
        createdAt: new Date().toISOString(),
        monitorType: monitor.monitor_type,
        monitorLabel: monitor.label
      };
    }

    // NO PLAN: Monitor exists but no execution attempts (no signals, no tasks)
    if (!hasRecentActivity && leads.length === 0 && hoursSinceCreation >= 2) {
      status = 'no_plan';
      reason = `Monitor "${monitor.label}" has been active for ${hoursSinceCreation.toFixed(1)}h but shows no execution attempts or activity. No plan appears to be running.`;
      
      return {
        userId,
        goalId: monitor.id.toString(),
        goalText,
        status,
        reason,
        createdAt: new Date().toISOString(),
        monitorType: monitor.monitor_type,
        monitorLabel: monitor.label
      };
    }

    // STALLED: Had previous success but no recent leads despite having activity
    if (leads.length > 0 && recentLeads.length === 0 && hoursSinceCreation >= 48) {
      status = 'stalled';
      const lastActivity = leads[0] ? new Date(leads[0].createdAt).toISOString() : undefined;
      reason = `Monitor "${monitor.label}" previously generated ${leads.length} leads but has not produced any in the past ${STALE_HOURS}h. Last successful lead: ${lastActivity ? new Date(lastActivity).toLocaleString() : 'unknown'}.`;
      
      return {
        userId,
        goalId: monitor.id.toString(),
        goalText,
        status,
        reason,
        lastActivityAt: lastActivity,
        createdAt: new Date().toISOString(),
        monitorType: monitor.monitor_type,
        monitorLabel: monitor.label
      };
    }

    // OK: Has recent activity and leads, or monitor is too new to judge
    return null;

  } catch (error) {
    console.error(`[GOAL_MONITOR] Error checking monitor ${monitor.id}:`, error);
    return null;
  }
}

/**
 * Check users who have objectives but no active monitors
 */
async function checkUsersWithoutMonitors(events: GoalMonitorEvent[]): Promise<void> {
  if (!supabase) return;

  try {
    // Fetch users with objectives
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, email, primary_objective, secondary_objectives')
      .not('primary_objective', 'is', null);

    if (usersError || !users || users.length === 0) {
      return;
    }

    for (const user of users) {
      // Check if user has any active monitors
      const { data: userMonitors } = await supabase
        .from('scheduled_monitors')
        .select('id')
        .eq('user_id', user.id)
        .eq('is_active', 1)
        .limit(1);

      if (!userMonitors || userMonitors.length === 0) {
        // User has objectives but no active monitors
        const objective = user.primary_objective;
        
        events.push({
          userId: user.id,
          goalText: objective,
          status: 'no_plan',
          reason: `User has goal "${objective}" but no active monitoring plan has been set up.`,
          createdAt: new Date().toISOString()
        });
      }
    }
  } catch (error) {
    console.error('[GOAL_MONITOR] Error checking users without monitors:', error);
  }
}

/**
 * Emit a goal monitor event to structured logs.
 * Can be extended to persist to database or send to external monitoring system.
 */
export function emitGoalMonitorEvent(event: GoalMonitorEvent): void {
  const logEntry = {
    timestamp: event.createdAt,
    type: 'GOAL_MONITOR',
    userId: event.userId,
    goalId: event.goalId,
    goalText: event.goalText,
    status: event.status,
    reason: event.reason,
    lastActivityAt: event.lastActivityAt,
    failureCount: event.failureCount,
    monitorType: event.monitorType,
    monitorLabel: event.monitorLabel
  };

  // Structured logging - can be extended to persist to DB or event bus
  console.log(`[GOAL_MONITOR] ${JSON.stringify(logEntry)}`);
}

/**
 * Publish goal monitor events to Tower (and local logs).
 * In a real system, this would send events to an external monitoring/alerting system.
 */
export async function publishGoalMonitorEvents(events: GoalMonitorEvent[]): Promise<void> {
  if (events.length === 0) {
    return;
  }

  console.log(`[GOAL_MONITOR] Publishing ${events.length} event(s)...`);

  for (const event of events) {
    // Emit to structured logs
    emitGoalMonitorEvent(event);

    // In a production system, we would also:
    // - Send to Tower/Control monitoring API
    // - Create alerts for stalled goals
    // - Notify users via email/Slack
    // - Store in a monitoring events table
    
    // For now, log a summary
    const statusEmoji = 
      event.status === 'no_plan' ? '❌' :
      event.status === 'stalled' ? '⏸️' :
      event.status === 'repeated_failures' ? '🔴' : '✅';
    
    console.log(`  ${statusEmoji} ${event.status.toUpperCase()}: ${event.goalText || 'Unnamed goal'} (user: ${event.userId})`);
    console.log(`     ${event.reason}`);
  }

  console.log(`[GOAL_MONITOR] All events published`);
}
