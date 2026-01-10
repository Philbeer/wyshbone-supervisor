/**
 * WABS Feedback Service (P3-T3)
 *
 * Stores user feedback on WABS scoring accuracy.
 * Calibrates scoring weights based on feedback history.
 */

import { supabase } from '../supabase';

export interface WABSFeedback {
  userId: string;
  taskId: string;
  resultData: any;
  wabsScore: number;
  wabsSignals: {
    relevance: number;
    novelty: number;
    actionability: number;
    urgency: number;
  };
  userFeedback: 'helpful' | 'not_helpful';
  feedbackReason?: string;
  timestamp: number;
}

/**
 * Store WABS feedback in agent_memory
 */
export async function storeWABSFeedback(feedback: WABSFeedback): Promise<string> {
  if (!supabase) {
    console.warn('[WABS_FEEDBACK] Supabase not configured');
    return '';
  }

  try {
    const memoryId = `wabs_feedback_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const { error } = await supabase
      .from('agent_memory')
      .insert({
        id: memoryId,
        user_id: feedback.userId,
        memory_type: 'wabs_feedback',
        content: `WABS scored this result ${feedback.wabsScore}/100 (${feedback.wabsSignals.relevance}R ${feedback.wabsSignals.novelty}N ${feedback.wabsSignals.actionability}A ${feedback.wabsSignals.urgency}U). User feedback: ${feedback.userFeedback}${feedback.feedbackReason ? ` - ${feedback.feedbackReason}` : ''}`,
        context: JSON.stringify({
          taskId: feedback.taskId,
          score: feedback.wabsScore,
          signals: feedback.wabsSignals,
          feedback: feedback.userFeedback,
          reason: feedback.feedbackReason
        }),
        metadata: {
          result_data: feedback.resultData,
          wabs_score: feedback.wabsScore,
          signals: feedback.wabsSignals
        },
        created_at: feedback.timestamp
      });

    if (error) {
      console.error('[WABS_FEEDBACK] Error storing feedback:', error);
      throw error;
    }

    console.log(`[WABS_FEEDBACK] Stored feedback for task ${feedback.taskId}: ${feedback.userFeedback}`);

    return memoryId;

  } catch (error: any) {
    console.error('[WABS_FEEDBACK] Exception storing feedback:', error.message);
    throw error;
  }
}

/**
 * Get WABS feedback history for a user
 */
export async function getWABSFeedbackHistory(
  userId: string,
  limit: number = 100
): Promise<WABSFeedback[]> {
  if (!supabase) {
    console.warn('[WABS_FEEDBACK] Supabase not configured');
    return [];
  }

  try {
    const { data, error } = await supabase
      .from('agent_memory')
      .select('*')
      .eq('user_id', userId)
      .eq('memory_type', 'wabs_feedback')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[WABS_FEEDBACK] Error fetching feedback history:', error);
      return [];
    }

    if (!data || data.length === 0) {
      return [];
    }

    // Parse feedback from memory records
    return data.map(record => {
      const context = typeof record.context === 'string'
        ? JSON.parse(record.context)
        : record.context;

      return {
        userId: record.user_id,
        taskId: context.taskId,
        resultData: record.metadata?.result_data,
        wabsScore: context.score,
        wabsSignals: context.signals,
        userFeedback: context.feedback,
        feedbackReason: context.reason,
        timestamp: record.created_at
      };
    });

  } catch (error: any) {
    console.error('[WABS_FEEDBACK] Exception fetching feedback:', error.message);
    return [];
  }
}

/**
 * Calibrate WABS scoring weights based on user feedback
 *
 * Uses feedback history to determine which signals best predict
 * user satisfaction. Returns optimized weights.
 */
export async function calibrateWeightsForUser(userId: string): Promise<{
  relevance: number;
  novelty: number;
  actionability: number;
  urgency: number;
} | null> {
  const feedbackHistory = await getWABSFeedbackHistory(userId);

  if (feedbackHistory.length < 10) {
    console.log(`[WABS_FEEDBACK] Not enough feedback for calibration (${feedbackHistory.length}/10)`);
    return null; // Use default weights
  }

  try {
    // Import WABS scorer calibration function
    const wabsScorerPath = '../../wyshbone-control-tower/lib/wabs-scorer.js';
    const { calibrateWeights } = await import(wabsScorerPath);

    // Format feedback for calibration
    const formattedFeedback = feedbackHistory.map(f => ({
      feedback: f.userFeedback,
      signals: f.wabsSignals
    }));

    const calibratedWeights = calibrateWeights(formattedFeedback);

    console.log(`[WABS_FEEDBACK] Calibrated weights for user ${userId}:`, calibratedWeights);

    return calibratedWeights;

  } catch (error: any) {
    console.error('[WABS_FEEDBACK] Error calibrating weights:', error.message);
    return null;
  }
}

/**
 * Get calibrated weights or default if insufficient feedback
 */
export async function getWeightsForUser(userId: string): Promise<{
  relevance: number;
  novelty: number;
  actionability: number;
  urgency: number;
}> {
  const calibrated = await calibrateWeightsForUser(userId);

  if (calibrated) {
    return calibrated;
  }

  // Return defaults
  return {
    relevance: 0.35,
    novelty: 0.25,
    actionability: 0.25,
    urgency: 0.15
  };
}

export default {
  storeWABSFeedback,
  getWABSFeedbackHistory,
  calibrateWeightsForUser,
  getWeightsForUser
};
