/**
 * Preferences API Endpoint
 *
 * GET /api/preferences - Get user's learned preferences
 */

import { Request, Response } from 'express';
import { getUserPreferences } from '../services/preference-learner';

/**
 * Get user preferences
 */
export async function getPreferences(req: Request, res: Response): Promise<void> {
  try {
    // Get user ID from session
    const sessionId = req.headers['x-session-id'] as string;
    if (!sessionId) {
      res.status(401).json({ error: 'Unauthorized - no session ID' });
      return;
    }

    // For now, use session ID as user ID (in production, you'd map session to user)
    const userId = sessionId;

    // Retrieve preferences
    const preferences = await getUserPreferences(userId);

    res.status(200).json({
      success: true,
      preferences,
      updatedAt: Date.now()
    });

  } catch (error: any) {
    console.error('[PREFERENCES_API] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to retrieve preferences'
    });
  }
}

export default {
  getPreferences
};
