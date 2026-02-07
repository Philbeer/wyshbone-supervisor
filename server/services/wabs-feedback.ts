/**
 * WABS Feedback Service (P3-T3)
 *
 * Stores user feedback on WABS scoring accuracy.
 * Calibrates scoring weights based on feedback history.
 *
 * Refactored to use direct PostgreSQL connection (no Supabase client dependency)
 */

import pg from 'pg';
const { Pool } = pg;

// Database connection (lazy initialization)
let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    // Supabase-only: no DATABASE_URL fallback permitted
    const connStr = process.env.SUPABASE_DATABASE_URL;
    if (!connStr) {
      throw new Error('SUPABASE_DATABASE_URL not configured');
    }
    pool = new Pool({ connectionString: connStr });
  }
  return pool;
}

// ========================================
// TYPES
// ========================================

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

export interface SignalWeights {
  relevance: number;
  novelty: number;
  actionability: number;
  urgency: number;
}

// Default weights
const DEFAULT_WEIGHTS: SignalWeights = {
  relevance: 0.35,
  novelty: 0.25,
  actionability: 0.25,
  urgency: 0.15
};

// ========================================
// FEEDBACK STORAGE
// ========================================

/**
 * Store WABS feedback in agent_memory
 */
export async function storeWABSFeedback(feedback: WABSFeedback): Promise<string> {
  const memoryId = `wabs_feedback_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const now = Date.now();

  try {
    await getPool().query(`
      INSERT INTO agent_memory (
        id, user_id, memory_type, title, description,
        tags, metadata, created_at, source, is_deprecated
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      )
    `, [
      memoryId,
      feedback.userId,
      'wabs_feedback',
      `WABS Feedback: ${feedback.userFeedback}`,
      `WABS scored this result ${feedback.wabsScore}/100 (${feedback.wabsSignals.relevance}R ${feedback.wabsSignals.novelty}N ${feedback.wabsSignals.actionability}A ${feedback.wabsSignals.urgency}U). User feedback: ${feedback.userFeedback}${feedback.feedbackReason ? ` - ${feedback.feedbackReason}` : ''}`,
      ['wabs', 'feedback', feedback.userFeedback],
      JSON.stringify({
        taskId: feedback.taskId,
        score: feedback.wabsScore,
        signals: feedback.wabsSignals,
        feedback: feedback.userFeedback,
        reason: feedback.feedbackReason,
        result_data: feedback.resultData
      }),
      now,
      'user_feedback',
      false
    ]);

    console.log(`[WABS_FEEDBACK] Stored feedback for task ${feedback.taskId}: ${feedback.userFeedback}`);

    return memoryId;

  } catch (error: any) {
    console.error('[WABS_FEEDBACK] Exception storing feedback:', error.message);
    throw error;
  }
}

// ========================================
// FEEDBACK RETRIEVAL
// ========================================

/**
 * Get WABS feedback history for a user
 */
export async function getWABSFeedbackHistory(
  userId: string,
  limit: number = 100
): Promise<WABSFeedback[]> {
  try {
    const result = await getPool().query(`
      SELECT id, user_id, metadata, created_at
      FROM agent_memory
      WHERE user_id = $1
        AND memory_type = 'wabs_feedback'
        AND is_deprecated = false
      ORDER BY created_at DESC
      LIMIT $2
    `, [userId, limit]);

    if (result.rows.length === 0) {
      return [];
    }

    // Parse feedback from memory records
    return result.rows.map(record => {
      const metadata = typeof record.metadata === 'string'
        ? JSON.parse(record.metadata)
        : record.metadata;

      return {
        userId: record.user_id,
        taskId: metadata.taskId,
        resultData: metadata.result_data,
        wabsScore: metadata.score,
        wabsSignals: metadata.signals,
        userFeedback: metadata.feedback,
        feedbackReason: metadata.reason,
        timestamp: record.created_at
      };
    });

  } catch (error: any) {
    console.error('[WABS_FEEDBACK] Exception fetching feedback:', error.message);
    return [];
  }
}

// ========================================
// WEIGHT CALIBRATION
// ========================================

/**
 * Calibrate WABS scoring weights based on user feedback
 *
 * Uses feedback history to determine which signals best predict
 * user satisfaction. Returns optimized weights.
 */
export async function calibrateWeightsForUser(userId: string): Promise<SignalWeights | null> {
  const feedbackHistory = await getWABSFeedbackHistory(userId, 20);

  if (feedbackHistory.length < 10) {
    console.log(`[WABS_FEEDBACK] Not enough feedback for calibration (${feedbackHistory.length}/10)`);
    return null; // Use default weights
  }

  try {
    // Separate helpful vs not helpful
    const helpful = feedbackHistory.filter(f => f.userFeedback === 'helpful');
    const notHelpful = feedbackHistory.filter(f => f.userFeedback === 'not_helpful');

    if (helpful.length === 0 || notHelpful.length === 0) {
      console.log('[WABS_FEEDBACK] Need both helpful and not_helpful feedback to calibrate');
      return null;
    }

    // Calculate average signal values for helpful vs not helpful
    const avgSignals = (list: WABSFeedback[]) => {
      if (list.length === 0) return { relevance: 50, novelty: 50, actionability: 50, urgency: 50 };

      const sum = list.reduce((acc, f) => {
        const signals = f.wabsSignals;
        return {
          relevance: acc.relevance + signals.relevance,
          novelty: acc.novelty + signals.novelty,
          actionability: acc.actionability + signals.actionability,
          urgency: acc.urgency + signals.urgency
        };
      }, { relevance: 0, novelty: 0, actionability: 0, urgency: 0 });

      return {
        relevance: sum.relevance / list.length,
        novelty: sum.novelty / list.length,
        actionability: sum.actionability / list.length,
        urgency: sum.urgency / list.length
      };
    };

    const helpfulAvg = avgSignals(helpful);
    const notHelpfulAvg = avgSignals(notHelpful);

    // Calculate discrimination: how much each signal differs between helpful and not helpful
    const discrimination = {
      relevance: Math.abs(helpfulAvg.relevance - notHelpfulAvg.relevance),
      novelty: Math.abs(helpfulAvg.novelty - notHelpfulAvg.novelty),
      actionability: Math.abs(helpfulAvg.actionability - notHelpfulAvg.actionability),
      urgency: Math.abs(helpfulAvg.urgency - notHelpfulAvg.urgency)
    };

    // Signals with higher discrimination get higher weight
    const totalDiscrimination = discrimination.relevance + discrimination.novelty +
                                discrimination.actionability + discrimination.urgency;

    if (totalDiscrimination === 0) {
      console.log('[WABS_FEEDBACK] No discrimination between signals, using defaults');
      return null;
    }

    const calibratedWeights: SignalWeights = {
      relevance: discrimination.relevance / totalDiscrimination,
      novelty: discrimination.novelty / totalDiscrimination,
      actionability: discrimination.actionability / totalDiscrimination,
      urgency: discrimination.urgency / totalDiscrimination
    };

    console.log(`[WABS_FEEDBACK] Calibrated weights from ${feedbackHistory.length} feedbacks:`, calibratedWeights);

    return calibratedWeights;

  } catch (error: any) {
    console.error('[WABS_FEEDBACK] Error calibrating weights:', error.message);
    return null;
  }
}

/**
 * Get calibrated weights or default if insufficient feedback
 */
export async function getWeightsForUser(userId: string): Promise<SignalWeights> {
  const calibrated = await calibrateWeightsForUser(userId);

  if (calibrated) {
    return calibrated;
  }

  // Return defaults
  return DEFAULT_WEIGHTS;
}

// ========================================
// EXPORTS
// ========================================

export default {
  storeWABSFeedback,
  getWABSFeedbackHistory,
  calibrateWeightsForUser,
  getWeightsForUser
};
