/**
 * Search Iteration Handler
 *
 * Deterministically rewrites a user's follow-up message into a modified
 * search query when they want to tweak a previous search — "now try Manchester",
 * "same but accountants", "find vets instead".
 *
 * No LLM required — pure regex pattern matching.
 */

import type { AccumulatedContext, LastDelivery } from './conversation-state';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface IterationResult {
  modifiedMessage: string;
  changeDescription: string;
  changeType: 'location' | 'entity' | 'constraint' | 'mixed';
}

// ─── Pattern arrays ───────────────────────────────────────────────────────────

const LOCATION_PATTERNS = [
  /\b(?:now |same |do |try )(?:in |near |around )?([A-Z][a-zA-Z\s,]+)/i,
  /\b(?:what about|how about) ([A-Z][a-zA-Z\s,]+)/i,
  /\b(?:try|find|search|do) (?:in |near )([A-Z][a-zA-Z\s,]+)/i,
];

const ENTITY_PATTERNS = [
  /\b(?:try|find|search for|look for) (.+?)(?:\s+instead|\s+in\b|\s*$)/i,
  /\b(?:same but) (.+?)(?:\s+in\b|\s*$)/i,
  /\b(.+?)\s+instead\b/i,
];

const COMBINED_PATTERN = /\b(?:find|search for|look for) (.+?) (?:in|near|around) ([A-Z][a-zA-Z\s,]+)/i;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripTrailingPunctuation(s: string): string {
  return s.replace(/[.,!?;:]+$/, '').trim();
}

// ─── Core export ──────────────────────────────────────────────────────────────

export function buildIteratedQuery(
  rawMessage: string,
  lastDelivery: LastDelivery,
  accumulatedContext: AccumulatedContext,
): IterationResult | null {
  const prevEntity = stripTrailingPunctuation(
    lastDelivery.entityType || accumulatedContext.entityType || '',
  );
  const prevLocation = stripTrailingPunctuation(
    lastDelivery.location || accumulatedContext.location || '',
  );

  // 1. Check COMBINED pattern first — it's already a complete query
  const combinedMatch = COMBINED_PATTERN.exec(rawMessage);
  if (combinedMatch) {
    const newEntity = stripTrailingPunctuation(combinedMatch[1]);
    const newLocation = stripTrailingPunctuation(combinedMatch[2]);
    const modifiedMessage = rawMessage.trim();
    console.log(`[SEARCH_ITERATION] mixed: "${rawMessage}" → "${modifiedMessage}"`);
    return {
      modifiedMessage,
      changeDescription: `Changed entity to "${newEntity}" and location to "${newLocation}"`,
      changeType: 'mixed',
    };
  }

  // 2. Check LOCATION CHANGE patterns
  for (const pattern of LOCATION_PATTERNS) {
    const match = pattern.exec(rawMessage);
    if (match) {
      const candidate = stripTrailingPunctuation(match[1]);

      // Guard: extracted value must not just be the same as the entity type
      if (prevEntity && candidate.toLowerCase() === prevEntity.toLowerCase()) {
        continue;
      }

      const newLocation = candidate;
      const modifiedMessage = prevEntity
        ? `find ${prevEntity} in ${newLocation}`
        : `search in ${newLocation}`;

      console.log(`[SEARCH_ITERATION] location: "${rawMessage}" → "${modifiedMessage}"`);
      return {
        modifiedMessage,
        changeDescription: `Changed location from "${prevLocation}" to "${newLocation}"`,
        changeType: 'location',
      };
    }
  }

  // 3. Check ENTITY CHANGE patterns
  for (const pattern of ENTITY_PATTERNS) {
    const match = pattern.exec(rawMessage);
    if (match) {
      const candidate = stripTrailingPunctuation(match[1]);

      // Must be 2–50 chars
      if (candidate.length < 2 || candidate.length > 50) {
        continue;
      }

      const newEntity = candidate;
      const modifiedMessage = prevLocation
        ? `find ${newEntity} in ${prevLocation}`
        : `find ${newEntity}`;

      console.log(`[SEARCH_ITERATION] entity: "${rawMessage}" → "${modifiedMessage}"`);
      return {
        modifiedMessage,
        changeDescription: `Changed entity from "${prevEntity}" to "${newEntity}"`,
        changeType: 'entity',
      };
    }
  }

  // 4. Nothing matched — caller falls through to normal pipeline
  return null;
}
