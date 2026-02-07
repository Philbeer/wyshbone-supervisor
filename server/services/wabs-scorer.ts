/**
 * WABS Scorer - Worth A Bloody Share
 * 4-Signal Judgement System for Result Interestingness
 *
 * Signals:
 * - RELEVANCE (35%): How well result matches query/goal
 * - NOVELTY (25%): How new/unique the result is
 * - ACTIONABILITY (25%): Can user take action on this?
 * - URGENCY (15%): Is this time-sensitive?
 */

import pg from 'pg';
const { Pool } = pg;

// Database connection
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

export interface WABSScore {
  score: number;           // 0-100 aggregate score
  signals: {
    relevance: number;     // 0-100
    novelty: number;       // 0-100
    actionability: number; // 0-100
    urgency: number;       // 0-100
  };
  explanation: string;     // Human-readable reason
  isInteresting: boolean;  // true if score >= 70
  weights: {               // Weights used (can be calibrated)
    relevance: number;
    novelty: number;
    actionability: number;
    urgency: number;
  };
}

export interface ScoreInput {
  result: any;             // The result to score
  query: string;           // User's query/goal
  userId: string;          // For personalization
  userPreferences?: Array<{ key: string; weight: number }>;
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
// SIGNAL 1: RELEVANCE (35%)
// ========================================

/**
 * Calculate relevance: How well does result match the query?
 *
 * Factors:
 * - Keyword overlap between query and result
 * - Presence of query terms in result
 * - Semantic similarity
 */
function calculateRelevance(result: any, query: string, userPreferences?: Array<{ key: string; weight: number }>): number {
  let score = 0;
  const maxScore = 100;

  // Normalize query
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2); // Filter short words

  // Convert result to searchable text
  const resultText = JSON.stringify(result).toLowerCase();

  // 1. Keyword matching (40 points)
  if (queryWords.length > 0) {
    const matchedWords = queryWords.filter(word => resultText.includes(word));
    const matchRatio = matchedWords.length / queryWords.length;
    score += matchRatio * 40;
  }

  // 2. Field-specific matching (30 points)
  // Check if query terms appear in key fields (name, title, description, etc.)
  const importantFields = ['name', 'title', 'description', 'summary', 'content', 'text'];
  let fieldMatches = 0;

  for (const field of importantFields) {
    if (result[field]) {
      const fieldText = String(result[field]).toLowerCase();
      const hasMatch = queryWords.some(word => fieldText.includes(word));
      if (hasMatch) fieldMatches++;
    }
  }

  if (fieldMatches > 0) {
    score += Math.min(30, fieldMatches * 10);
  }

  // 3. User preference alignment (30 points)
  if (userPreferences && userPreferences.length > 0) {
    let preferenceScore = 0;
    for (const pref of userPreferences) {
      if (resultText.includes(pref.key.toLowerCase())) {
        preferenceScore += pref.weight * 10;
      }
    }
    score += Math.min(30, preferenceScore);
  } else {
    // If no preferences, give partial credit for having data
    score += 15;
  }

  return Math.min(maxScore, Math.round(score));
}

// ========================================
// SIGNAL 2: NOVELTY (25%)
// ========================================

/**
 * Calculate novelty: Is this new/unique/fresh?
 *
 * Factors:
 * - Recency (newer = higher score)
 * - Uniqueness (not seen before)
 * - Freshness indicators
 */
function calculateNovelty(result: any, userId: string): number {
  let score = 0;
  const maxScore = 100;

  // 1. Recency scoring (50 points)
  const now = Date.now();
  let timestamp: number | null = null;

  // Try to extract timestamp from common fields
  if (result.created_at) timestamp = new Date(result.created_at).getTime();
  else if (result.updated_at) timestamp = new Date(result.updated_at).getTime();
  else if (result.timestamp) timestamp = new Date(result.timestamp).getTime();
  else if (result.date) timestamp = new Date(result.date).getTime();

  if (timestamp) {
    const ageMs = now - timestamp;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays < 1) score += 50;           // Less than 1 day old
    else if (ageDays < 7) score += 40;      // Less than 1 week old
    else if (ageDays < 30) score += 30;     // Less than 1 month old
    else if (ageDays < 90) score += 20;     // Less than 3 months old
    else if (ageDays < 365) score += 10;    // Less than 1 year old
    // Older than 1 year = 0 points
  } else {
    // No timestamp = assume moderate age
    score += 20;
  }

  // 2. Freshness indicators (30 points)
  const resultText = JSON.stringify(result).toLowerCase();
  const freshnessKeywords = ['new', 'just', 'recently', 'latest', 'fresh', 'updated', 'now', 'today'];
  const hasUrgencyKeywords = freshnessKeywords.some(kw => resultText.includes(kw));
  if (hasUrgencyKeywords) score += 30;

  // 3. Uniqueness (20 points)
  // Check if result has unique identifiers
  const hasId = result.id || result._id || result.uuid;
  const hasUniqueFields = result.email || result.phone || result.url || result.website;
  if (hasId) score += 10;
  if (hasUniqueFields) score += 10;

  return Math.min(maxScore, Math.round(score));
}

// ========================================
// SIGNAL 3: ACTIONABILITY (25%)
// ========================================

/**
 * Calculate actionability: Can user take action on this?
 *
 * Factors:
 * - Contact information (email, phone, website)
 * - Address/location
 * - Hours/availability
 * - Booking/purchase links
 */
function calculateActionability(result: any): number {
  let score = 0;
  const maxScore = 100;

  // 1. Contact information (40 points)
  const hasEmail = !!(result.email || result.contact_email || result.contact?.email);
  const hasPhone = !!(result.phone || result.telephone || result.contact_phone || result.contact?.phone);
  const hasWebsite = !!(result.url || result.website || result.link || result.homepage);

  if (hasEmail) score += 15;
  if (hasPhone) score += 15;
  if (hasWebsite) score += 10;

  // 2. Location information (25 points)
  const hasAddress = !!(result.address || result.location || result.street);
  const hasCity = !!(result.city || result.locality);
  const hasCoordinates = !!(result.lat && result.lng) || (result.latitude && result.longitude);

  if (hasAddress) score += 10;
  if (hasCity) score += 8;
  if (hasCoordinates) score += 7;

  // 3. Availability/hours (15 points)
  const hasHours = !!(result.hours || result.opening_hours || result.schedule || result.availability);
  if (hasHours) score += 15;

  // 4. Action links (20 points)
  const hasBookingLink = !!(result.booking_url || result.reserve_url || result.appointment_url);
  const hasPurchaseLink = !!(result.buy_url || result.purchase_url || result.shop_url);
  const hasSocialMedia = !!(result.facebook || result.twitter || result.instagram || result.social);

  if (hasBookingLink) score += 10;
  if (hasPurchaseLink) score += 5;
  if (hasSocialMedia) score += 5;

  return Math.min(maxScore, Math.round(score));
}

// ========================================
// SIGNAL 4: URGENCY (15%)
// ========================================

/**
 * Calculate urgency: Is this time-sensitive?
 *
 * Factors:
 * - Urgency keywords (hiring, closing, limited, urgent)
 * - Deadlines
 * - Recent posting
 */
function calculateUrgency(result: any): number {
  let score = 0;
  const maxScore = 100;

  const resultText = JSON.stringify(result).toLowerCase();

  // 1. Urgency keywords (50 points)
  const urgencyKeywords = {
    high: ['urgent', 'asap', 'immediately', 'now', 'today', 'deadline', 'expires', 'limited time', 'closing soon', 'last chance'],
    medium: ['hiring', 'recruiting', 'available now', 'limited', 'exclusive', 'special offer', 'ending soon'],
    low: ['soon', 'upcoming', 'new opportunity', 'recently posted']
  };

  let foundUrgency = false;
  for (const keyword of urgencyKeywords.high) {
    if (resultText.includes(keyword)) {
      score += 50;
      foundUrgency = true;
      break;
    }
  }

  if (!foundUrgency) {
    for (const keyword of urgencyKeywords.medium) {
      if (resultText.includes(keyword)) {
        score += 30;
        foundUrgency = true;
        break;
      }
    }
  }

  if (!foundUrgency) {
    for (const keyword of urgencyKeywords.low) {
      if (resultText.includes(keyword)) {
        score += 15;
        break;
      }
    }
  }

  // 2. Deadline presence (30 points)
  const hasDeadline = !!(result.deadline || result.expires_at || result.expiration || result.end_date);
  if (hasDeadline) {
    score += 30;

    // Check if deadline is soon
    try {
      const deadlineField = result.deadline || result.expires_at || result.expiration || result.end_date;
      const deadlineDate = new Date(deadlineField).getTime();
      const now = Date.now();
      const daysUntil = (deadlineDate - now) / (1000 * 60 * 60 * 24);

      if (daysUntil < 1) score += 20;      // Less than 1 day
      else if (daysUntil < 3) score += 10; // Less than 3 days
    } catch (e) {
      // Invalid date format, skip bonus
    }
  }

  // 3. Recent posting bonus (20 points)
  const now = Date.now();
  let timestamp: number | null = null;

  if (result.created_at) timestamp = new Date(result.created_at).getTime();
  else if (result.posted_at) timestamp = new Date(result.posted_at).getTime();

  if (timestamp) {
    const ageHours = (now - timestamp) / (1000 * 60 * 60);
    if (ageHours < 24) score += 20;       // Posted in last 24 hours
    else if (ageHours < 48) score += 10;  // Posted in last 48 hours
  }

  return Math.min(maxScore, Math.round(score));
}

// ========================================
// WEIGHT CALIBRATION
// ========================================

/**
 * Get calibrated weights for a user based on feedback history
 * Falls back to default weights if insufficient feedback
 */
async function getCalibratedWeights(userId: string): Promise<SignalWeights> {
  try {
    const result = await getPool().query(`
      SELECT metadata
      FROM agent_memory
      WHERE user_id = $1
        AND memory_type = 'wabs_feedback'
        AND is_deprecated = false
      ORDER BY created_at DESC
      LIMIT 20
    `, [userId]);

    const feedbacks = result.rows;

    // Need at least 10 feedbacks to calibrate
    if (feedbacks.length < 10) {
      console.log(`[WABS] Using default weights (only ${feedbacks.length} feedbacks)`);
      return DEFAULT_WEIGHTS;
    }

    // Separate helpful vs not helpful
    const helpful = feedbacks.filter(f => {
      const meta = typeof f.metadata === 'string' ? JSON.parse(f.metadata) : f.metadata;
      return meta.feedback === 'helpful';
    });

    const notHelpful = feedbacks.filter(f => {
      const meta = typeof f.metadata === 'string' ? JSON.parse(f.metadata) : f.metadata;
      return meta.feedback === 'not_helpful';
    });

    // Calculate average signal values for helpful vs not helpful
    const avgSignals = (list: any[]) => {
      if (list.length === 0) return { relevance: 50, novelty: 50, actionability: 50, urgency: 50 };

      const sum = list.reduce((acc, f) => {
        const meta = typeof f.metadata === 'string' ? JSON.parse(f.metadata) : f.metadata;
        const signals = meta.signals || {};
        return {
          relevance: acc.relevance + (signals.relevance || 50),
          novelty: acc.novelty + (signals.novelty || 50),
          actionability: acc.actionability + (signals.actionability || 50),
          urgency: acc.urgency + (signals.urgency || 50)
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
      return DEFAULT_WEIGHTS;
    }

    const calibratedWeights = {
      relevance: discrimination.relevance / totalDiscrimination,
      novelty: discrimination.novelty / totalDiscrimination,
      actionability: discrimination.actionability / totalDiscrimination,
      urgency: discrimination.urgency / totalDiscrimination
    };

    console.log(`[WABS] Calibrated weights from ${feedbacks.length} feedbacks:`, calibratedWeights);
    return calibratedWeights;

  } catch (error) {
    console.error('[WABS] Error calibrating weights:', error);
    return DEFAULT_WEIGHTS;
  }
}

// ========================================
// MAIN SCORING FUNCTION
// ========================================

/**
 * Score a result using the 4-signal WABS algorithm
 */
export async function scoreResult(input: ScoreInput): Promise<WABSScore> {
  const { result, query, userId, userPreferences } = input;

  // Get calibrated weights for this user
  const weights = await getCalibratedWeights(userId);

  // Calculate all 4 signals
  const signals = {
    relevance: calculateRelevance(result, query, userPreferences),
    novelty: calculateNovelty(result, userId),
    actionability: calculateActionability(result),
    urgency: calculateUrgency(result)
  };

  // Aggregate score using weights
  const score = Math.round(
    (signals.relevance * weights.relevance) +
    (signals.novelty * weights.novelty) +
    (signals.actionability * weights.actionability) +
    (signals.urgency * weights.urgency)
  );

  // Determine if interesting (>= 70)
  const isInteresting = score >= 70;

  // Generate explanation
  const explanation = generateExplanation(score, signals, isInteresting);

  return {
    score,
    signals,
    explanation,
    isInteresting,
    weights
  };
}

/**
 * Generate human-readable explanation of score
 */
function generateExplanation(score: number, signals: any, isInteresting: boolean): string {
  const parts: string[] = [];

  // Overall assessment
  if (isInteresting) {
    parts.push('⭐ This result is interesting and worth sharing!');
  } else if (score >= 50) {
    parts.push('📊 This result is moderately relevant.');
  } else {
    parts.push('📉 This result has low relevance.');
  }

  // Signal breakdown
  const sortedSignals = Object.entries(signals)
    .map(([name, value]) => ({ name, value: value as number }))
    .sort((a, b) => b.value - a.value);

  const topSignal = sortedSignals[0];
  parts.push(`Strongest: ${topSignal.name} (${topSignal.value}/100)`);

  // Highlight key factors
  if (signals.relevance >= 70) parts.push('✓ Highly relevant to query');
  if (signals.novelty >= 70) parts.push('✓ Fresh/unique result');
  if (signals.actionability >= 70) parts.push('✓ Clear action available');
  if (signals.urgency >= 70) parts.push('⚠️ Time-sensitive');

  return parts.join(' | ');
}

// ========================================
// WRAPPER FUNCTION FOR SMOKE TESTS
// ========================================

/**
 * Simplified wrapper for smoke tests and direct usage
 * Converts task result + task into ScoreInput format
 */
export async function calculateWABSScore(
  result: any,
  task: { description: string; context?: any },
  userId: string
): Promise<{ wabs_score: number; signals: any }> {
  const scoring = await scoreResult({
    result: result,
    query: task.description,
    userId: userId,
    userPreferences: []
  });

  return {
    wabs_score: scoring.score,
    signals: scoring.signals
  };
}

// ========================================
// EXPORTS
// ========================================

export { getCalibratedWeights, DEFAULT_WEIGHTS };
export type { SignalWeights };
