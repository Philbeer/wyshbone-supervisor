/**
 * Preference Learner Service
 *
 * Extracts patterns from user feedback to build a preference model.
 * Tracks: industries, regions, contact types user engages with.
 * Updates preference weights based on feedback.
 */

import { createPreferenceMemory, updateMemory } from './memory-writer';
import { getActiveMemories } from './memory-reader';

// ========================================
// TYPES
// ========================================

export interface UserPreferences {
  industries: PreferenceItem[];
  regions: PreferenceItem[];
  contactTypes: PreferenceItem[];
  keywords: PreferenceItem[];
}

export interface PreferenceItem {
  value: string;
  weight: number; // 0-1, higher = stronger preference
  engagementCount: number;
  lastEngaged: number;
  memoryId?: string;
}

export interface FeedbackEvent {
  userId: string;
  taskId?: string;
  result: any; // Task result data
  interesting: boolean;
  feedback?: 'helpful' | 'not_helpful';
}

// ========================================
// PREFERENCE EXTRACTION
// ========================================

/**
 * Learn preferences from a feedback event
 */
export async function learnFromFeedback(event: FeedbackEvent): Promise<void> {
  console.log('[PREFERENCE_LEARNER] Learning from feedback event...');

  // Extract signals from result data
  const signals = extractSignals(event.result);

  // Get current preferences
  const currentPrefs = await getUserPreferences(event.userId);

  // Update preferences based on feedback
  const updates: PreferenceUpdate[] = [];

  // Industries
  if (signals.industries.length > 0) {
    for (const industry of signals.industries) {
      const update = updatePreferenceWeight(
        currentPrefs.industries,
        industry,
        event.interesting || event.feedback === 'helpful'
      );
      if (update) {
        updates.push({ type: 'industry', ...update });
      }
    }
  }

  // Regions
  if (signals.regions.length > 0) {
    for (const region of signals.regions) {
      const update = updatePreferenceWeight(
        currentPrefs.regions,
        region,
        event.interesting || event.feedback === 'helpful'
      );
      if (update) {
        updates.push({ type: 'region', ...update });
      }
    }
  }

  // Contact types
  if (signals.contactTypes.length > 0) {
    for (const contactType of signals.contactTypes) {
      const update = updatePreferenceWeight(
        currentPrefs.contactTypes,
        contactType,
        event.interesting || event.feedback === 'helpful'
      );
      if (update) {
        updates.push({ type: 'contactType', ...update });
      }
    }
  }

  // Keywords
  if (signals.keywords.length > 0) {
    for (const keyword of signals.keywords) {
      const update = updatePreferenceWeight(
        currentPrefs.keywords,
        keyword,
        event.interesting || event.feedback === 'helpful'
      );
      if (update) {
        updates.push({ type: 'keyword', ...update });
      }
    }
  }

  // Store updated preferences
  await storePreferences(event.userId, updates);

  console.log(`[PREFERENCE_LEARNER] Updated ${updates.length} preferences`);
}

/**
 * Extract signals from task result data
 */
function extractSignals(result: any): {
  industries: string[];
  regions: string[];
  contactTypes: string[];
  keywords: string[];
} {
  const signals = {
    industries: [] as string[],
    regions: [] as string[],
    contactTypes: [] as string[],
    keywords: [] as string[]
  };

  if (!result) return signals;

  // Helper to extract from nested objects (brewery, pub, restaurant, etc.)
  const extractFromNested = (obj: any) => {
    if (!obj || typeof obj !== 'object') return;

    // Extract industries
    if (obj.industry) {
      signals.industries.push(normalizeValue(obj.industry));
    }
    if (obj.industries && Array.isArray(obj.industries)) {
      signals.industries.push(...obj.industries.map(normalizeValue));
    }
    if (obj.type) {
      signals.keywords.push(normalizeValue(obj.type));
    }

    // Extract regions/locations
    if (obj.location) {
      signals.regions.push(normalizeValue(obj.location));
    }
    if (obj.region) {
      signals.regions.push(normalizeValue(obj.region));
    }
    if (obj.city) {
      signals.regions.push(normalizeValue(obj.city));
    }
    if (obj.country) {
      signals.regions.push(normalizeValue(obj.country));
    }

    // Extract contact types
    if (obj.contactType) {
      signals.contactTypes.push(normalizeValue(obj.contactType));
    }
    if (obj.leadType) {
      signals.contactTypes.push(normalizeValue(obj.leadType));
    }

    // Extract keywords from description, query, or name
    if (obj.description) {
      signals.keywords.push(...extractKeywords(obj.description));
    }
    if (obj.query) {
      signals.keywords.push(...extractKeywords(obj.query));
    }
    if (obj.name) {
      signals.keywords.push(...extractKeywords(obj.name));
    }
  };

  // Extract from top level
  extractFromNested(result);

  // Extract from nested entities (brewery, pub, restaurant, etc.)
  const entityKeys = ['brewery', 'pub', 'restaurant', 'venue', 'company', 'contact', 'lead'];
  for (const key of entityKeys) {
    if (result[key]) {
      extractFromNested(result[key]);
      // Also add entity type as keyword
      signals.keywords.push(key);
    }
  }

  return signals;
}

/**
 * Extract keywords from text
 */
function extractKeywords(text: string): string[] {
  if (!text) return [];

  // Simple keyword extraction: lowercase, remove common words
  const commonWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'be', 'been', 'being']);

  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 3 && !commonWords.has(word))
    .map(word => word.replace(/[^a-z0-9]/g, ''))
    .filter(word => word.length > 0)
    .slice(0, 5); // Max 5 keywords
}

/**
 * Normalize value for consistency
 */
function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Update preference weight based on feedback
 */
function updatePreferenceWeight(
  currentPrefs: PreferenceItem[],
  value: string,
  isPositive: boolean
): PreferenceUpdate | null {
  const normalizedValue = normalizeValue(value);
  const existing = currentPrefs.find(p => p.value === normalizedValue);

  if (existing) {
    // Update existing preference
    const weightDelta = isPositive ? 0.1 : -0.1;
    const newWeight = Math.max(0, Math.min(1, existing.weight + weightDelta));

    return {
      value: normalizedValue,
      weight: newWeight,
      engagementCount: existing.engagementCount + 1,
      lastEngaged: Date.now(),
      memoryId: existing.memoryId,
      isNew: false
    };
  } else if (isPositive) {
    // Create new preference only if feedback is positive
    return {
      value: normalizedValue,
      weight: 0.5, // Start at neutral
      engagementCount: 1,
      lastEngaged: Date.now(),
      isNew: true
    };
  }

  return null;
}

// ========================================
// PREFERENCE STORAGE
// ========================================

interface PreferenceUpdate {
  type?: string;
  value: string;
  weight: number;
  engagementCount: number;
  lastEngaged: number;
  memoryId?: string;
  isNew: boolean;
}

/**
 * Store preference updates in memory system
 */
async function storePreferences(
  userId: string,
  updates: PreferenceUpdate[]
): Promise<void> {
  for (const update of updates) {
    const title = `Preference: ${update.value}`;
    const description = `User shows ${update.weight > 0.5 ? 'positive' : 'neutral'} preference for ${update.value} (${update.type || 'general'})`;
    const tags = [update.type || 'general', update.value, 'preference'];

    if (update.isNew) {
      // Create new preference memory
      const memoryId = await createPreferenceMemory(
        userId,
        title,
        description,
        tags
      );
      console.log(`[PREFERENCE_LEARNER] Created new preference: ${update.value}`);
    } else if (update.memoryId) {
      // Update existing preference memory
      await updateMemory({
        id: update.memoryId,
        tags,
        confidenceScore: update.weight
      });
      console.log(`[PREFERENCE_LEARNER] Updated preference: ${update.value} (weight: ${update.weight.toFixed(2)})`);
    }
  }
}

// ========================================
// PREFERENCE RETRIEVAL
// ========================================

/**
 * Get user's current preferences from memory
 */
export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const preferences: UserPreferences = {
    industries: [],
    regions: [],
    contactTypes: [],
    keywords: []
  };

  // Retrieve preference memories
  const memories = await getActiveMemories({
    userId,
    types: ['preference'],
    limit: 100
  });

  // Parse preferences from memories
  for (const memory of memories) {
    const prefItem: PreferenceItem = {
      value: memory.title.replace('Preference: ', ''),
      weight: memory.confidenceScore,
      engagementCount: memory.metadata?.engagementCount || memory.accessCount,
      lastEngaged: memory.lastAccessedAt || memory.createdAt,
      memoryId: memory.id
    };

    // Categorize by tags
    if (memory.tags.includes('industry')) {
      preferences.industries.push(prefItem);
    } else if (memory.tags.includes('region') || memory.tags.includes('location')) {
      preferences.regions.push(prefItem);
    } else if (memory.tags.includes('contactType') || memory.tags.includes('leadType')) {
      preferences.contactTypes.push(prefItem);
    } else if (memory.tags.includes('keyword')) {
      preferences.keywords.push(prefItem);
    } else {
      // Default to keywords
      preferences.keywords.push(prefItem);
    }
  }

  // Sort by weight (descending)
  preferences.industries.sort((a, b) => b.weight - a.weight);
  preferences.regions.sort((a, b) => b.weight - a.weight);
  preferences.contactTypes.sort((a, b) => b.weight - a.weight);
  preferences.keywords.sort((a, b) => b.weight - a.weight);

  return preferences;
}

/**
 * Get top preferences for use in planning
 */
export async function getTopPreferences(
  userId: string,
  count: number = 5
): Promise<string[]> {
  const prefs = await getUserPreferences(userId);

  const allPrefs = [
    ...prefs.industries,
    ...prefs.regions,
    ...prefs.contactTypes,
    ...prefs.keywords
  ];

  return allPrefs
    .sort((a, b) => b.weight - a.weight)
    .slice(0, count)
    .map(p => p.value);
}

// ========================================
// PREFERENCE-INFLUENCED PRIORITIZATION
// ========================================

/**
 * Score a task based on how well it matches user preferences
 */
export async function scoreTaskByPreferences(
  userId: string,
  task: any
): Promise<number> {
  const prefs = await getUserPreferences(userId);

  let score = 0;
  let matches = 0;

  // Check task description/title for preference matches
  const taskText = `${task.title || ''} ${task.description || ''}`.toLowerCase();

  // Match industries
  for (const pref of prefs.industries) {
    if (taskText.includes(pref.value)) {
      score += pref.weight;
      matches++;
    }
  }

  // Match regions
  for (const pref of prefs.regions) {
    if (taskText.includes(pref.value)) {
      score += pref.weight;
      matches++;
    }
  }

  // Match keywords
  for (const pref of prefs.keywords) {
    if (taskText.includes(pref.value)) {
      score += pref.weight * 0.5; // Keywords weighted less
      matches++;
    }
  }

  return matches > 0 ? score / matches : 0;
}

// ========================================
// EXPORTS
// ========================================

export default {
  learnFromFeedback,
  getUserPreferences,
  getTopPreferences,
  scoreTaskByPreferences
};
