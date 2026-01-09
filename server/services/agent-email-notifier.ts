/**
 * Agent Email Notifier
 *
 * Sends email notifications when autonomous agent discovers interesting findings
 */

import { emailService, type AgentFindingsPayload } from '../notifications/email-service';
import type { AgentFinding } from '../notifications/templates/agent-findings-email';
import type { BatchExecutionResult, TaskExecutionResult } from './task-executor';
import { supabase } from '../supabase';

export interface UserInfo {
  userId: string;
  email: string;
  name?: string;
}

export interface EmailNotificationResult {
  sent: boolean;
  findingsCount: number;
  error?: string;
}

/**
 * Check if user has email notifications enabled
 */
async function isEmailNotificationsEnabled(userId: string): Promise<boolean> {
  if (!supabase) {
    console.warn('[AGENT_EMAIL] Supabase not configured - assuming notifications enabled');
    return true;
  }

  try {
    // Check user preferences (if you have a preferences table)
    // For now, assume enabled by default
    return true;
  } catch (error) {
    console.error('[AGENT_EMAIL] Error checking notification preferences:', error);
    return true; // Default to enabled if check fails
  }
}

/**
 * Convert task execution results to email-friendly format
 */
function convertToEmailFindings(results: TaskExecutionResult[]): AgentFinding[] {
  return results
    .filter(r => r.interesting && r.status === 'success')
    .map(r => ({
      taskTitle: r.task.title,
      taskDescription: r.task.description,
      priority: r.task.priority,
      result: r.toolResponse?.note || 'Task completed successfully',
      interestingReason: r.interestingReason || 'This task produced notable results',
      timestamp: Date.now() - (r.executionTime || 0) // Approximate start time
    }));
}

/**
 * Send email notification for interesting agent findings
 *
 * @param user - User information (ID, email, name)
 * @param executionResult - Results from task executor
 * @param dashboardUrl - URL to user's dashboard
 * @returns Email notification result
 */
export async function sendAgentFindingsNotification(
  user: UserInfo,
  executionResult: BatchExecutionResult,
  dashboardUrl?: string
): Promise<EmailNotificationResult> {
  console.log(`[AGENT_EMAIL] Checking if email notification needed for user ${user.userId}...`);

  // 1. Check if user has email notifications enabled
  const notificationsEnabled = await isEmailNotificationsEnabled(user.userId);
  if (!notificationsEnabled) {
    console.log(`[AGENT_EMAIL] Email notifications disabled for user ${user.userId}`);
    return { sent: false, findingsCount: 0 };
  }

  // 2. Filter for interesting findings only
  const interestingFindings = convertToEmailFindings(executionResult.results);

  if (interestingFindings.length === 0) {
    console.log(`[AGENT_EMAIL] No interesting findings for user ${user.userId} - skipping email`);
    return { sent: false, findingsCount: 0 };
  }

  console.log(`[AGENT_EMAIL] Found ${interestingFindings.length} interesting findings - sending email...`);

  // 3. Calculate success rate
  const successRate = executionResult.totalTasks > 0
    ? Math.round((executionResult.successful / executionResult.totalTasks) * 100)
    : 0;

  // 4. Prepare email payload
  const payload: AgentFindingsPayload = {
    userEmail: user.email,
    userName: user.name || 'there',
    findings: interestingFindings,
    totalTasksExecuted: executionResult.totalTasks,
    successRate,
    dashboardUrl: dashboardUrl || 'https://app.wyshbone.ai/dashboard',
    unsubscribeUrl: dashboardUrl
      ? `${dashboardUrl}/settings/notifications`
      : 'https://app.wyshbone.ai/settings/notifications'
  };

  // 5. Send email
  try {
    await emailService.sendAgentFindingsEmail(payload);

    console.log(`[AGENT_EMAIL] ✅ Email sent successfully to ${user.email}`);

    // 6. Log email sent activity (optional)
    await logEmailSentActivity(user.userId, interestingFindings.length);

    return {
      sent: true,
      findingsCount: interestingFindings.length
    };

  } catch (error: any) {
    console.error(`[AGENT_EMAIL] ❌ Failed to send email:`, error.message);

    return {
      sent: false,
      findingsCount: interestingFindings.length,
      error: error.message
    };
  }
}

/**
 * Log that an email was sent (for analytics)
 */
async function logEmailSentActivity(userId: string, findingsCount: number): Promise<void> {
  if (!supabase) {
    return;
  }

  try {
    const id = `activity_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const timestamp = Date.now();

    await supabase
      .from('agent_activities')
      .insert({
        id,
        user_id: userId,
        timestamp,
        task_generated: 'Email notification sent',
        action_taken: 'send_email',
        action_params: { findingsCount },
        results: { sent: true },
        interesting_flag: 0, // Not an interesting finding itself
        status: 'success',
        duration_ms: null,
        conversation_id: null,
        run_id: null,
        metadata: { type: 'email_notification' },
        created_at: timestamp
      });

    console.log('[AGENT_EMAIL] Email activity logged to database');
  } catch (error) {
    console.error('[AGENT_EMAIL] Error logging email activity:', error);
    // Don't throw - logging failure shouldn't stop the process
  }
}

/**
 * Batch send email notifications to multiple users
 *
 * @param userResults - Map of user ID to execution results
 * @param getUserInfo - Function to get user email/name from ID
 * @param dashboardUrl - Base dashboard URL
 */
export async function sendBatchAgentNotifications(
  userResults: Map<string, BatchExecutionResult>,
  getUserInfo: (userId: string) => Promise<UserInfo | null>,
  dashboardUrl?: string
): Promise<Map<string, EmailNotificationResult>> {
  console.log(`[AGENT_EMAIL] Sending batch notifications to ${userResults.size} users...`);

  const results = new Map<string, EmailNotificationResult>();

  for (const [userId, executionResult] of userResults.entries()) {
    try {
      const userInfo = await getUserInfo(userId);

      if (!userInfo) {
        console.warn(`[AGENT_EMAIL] User info not found for ${userId} - skipping`);
        results.set(userId, { sent: false, findingsCount: 0, error: 'User not found' });
        continue;
      }

      const result = await sendAgentFindingsNotification(
        userInfo,
        executionResult,
        dashboardUrl
      );

      results.set(userId, result);

      // Small delay between emails to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (error: any) {
      console.error(`[AGENT_EMAIL] Error sending notification to ${userId}:`, error.message);
      results.set(userId, {
        sent: false,
        findingsCount: 0,
        error: error.message
      });
    }
  }

  const sentCount = Array.from(results.values()).filter(r => r.sent).length;
  console.log(`[AGENT_EMAIL] Batch complete: ${sentCount}/${userResults.size} emails sent`);

  return results;
}

export default {
  sendAgentFindingsNotification,
  sendBatchAgentNotifications
};
