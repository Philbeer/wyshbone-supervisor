/**
 * Feature Runner Service
 * 
 * Orchestrates feature execution and emits completion events.
 * SUP-6: Lead Finder Feature Pack
 * SUP-9: Feature Toggle Support
 */

import type { FeatureType, FeatureRunResult } from '../features/types';
import { runLeadFinder, type LeadFinderParams } from '../features/leadFinder/leadFinder';
import { createEventBus } from '../core/event-bus';
import type { BaseSupervisorEvent } from '../core/types';
import { isFeatureEnabled, type FeatureId, type FeatureContext } from '../config/features';

/**
 * Generate a unique ID (simple implementation without uuid dependency)
 */
function generateId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Feature completed event payload
 */
export interface FeatureCompletedPayload {
  featureType: FeatureType;
  requestId: string;
  timestamp: string;
  data: unknown;
}

/**
 * Feature completed event
 */
export interface FeatureCompletedEvent extends BaseSupervisorEvent {
  type: 'feature.completed';
  payload: FeatureCompletedPayload;
}

// Shared event bus instance for feature events
const eventBus = createEventBus();

/**
 * Get the shared event bus for subscribing to feature events
 */
export function getFeatureEventBus() {
  return eventBus;
}

// ============================================
// FEATURE TYPE TO TOGGLE ID MAPPING (SUP-9)
// ============================================

/**
 * Maps FeatureType (camelCase API values) to FeatureId (snake_case toggle IDs).
 * This ensures consistency between the API and the toggle system.
 */
const featureTypeToToggleId: Record<FeatureType, FeatureId> = {
  leadFinder: 'lead_finder',
};

/**
 * Run a feature by type with given parameters.
 * 
 * Checks feature toggle before execution (SUP-9).
 * If the feature is disabled, returns a feature_disabled status
 * without executing the feature logic or emitting events.
 * 
 * @param featureType - The type of feature to run
 * @param params - Parameters for the feature
 * @param context - Optional feature context for toggle evaluation
 * @returns Promise resolving to the feature result
 */
export async function runFeature(
  featureType: FeatureType,
  params: Record<string, unknown>,
  context?: FeatureContext
): Promise<FeatureRunResult> {
  const requestId = generateId();
  const timestamp = new Date().toISOString();
  
  // SUP-9: Check feature toggle before execution
  const toggleId = featureTypeToToggleId[featureType];
  if (!isFeatureEnabled(toggleId, context)) {
    console.log(`[FeatureRunner] Feature disabled: ${featureType} (toggle: ${toggleId}), requestId: ${requestId}`);
    return {
      status: "feature_disabled",
      error: `Feature '${featureType}' is currently disabled`,
      errorCode: "FEATURE_DISABLED"
    };
  }
  
  console.log(`[FeatureRunner] Running feature: ${featureType}, requestId: ${requestId}`);
  
  try {
    let data: unknown;
    
    switch (featureType) {
      case "leadFinder": {
        const leadFinderParams: LeadFinderParams = {
          query: (params.query as string) || "",
          location: (params.location as string) || ""
        };
        data = await runLeadFinder(leadFinderParams);
        break;
      }
      default: {
        // TypeScript exhaustive check
        const _exhaustive: never = featureType;
        throw new Error(`Unknown feature type: ${featureType}`);
      }
    }
    
    // Emit FeatureCompleted event (only when feature actually runs)
    const completedEvent: FeatureCompletedEvent = {
      id: generateId(),
      type: 'feature.completed',
      timestamp,
      source: 'feature-runner',
      payload: {
        featureType,
        requestId,
        timestamp,
        data
      }
    };
    
    await eventBus.publish(completedEvent);
    console.log(`[FeatureRunner] Feature completed: ${featureType}, requestId: ${requestId}`);
    
    return {
      status: "ok",
      data
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[FeatureRunner] Feature failed: ${featureType}, error: ${errorMessage}`);
    
    return {
      status: "error",
      error: errorMessage,
      errorCode: "EXECUTION_FAILED"
    };
  }
}

