/**
 * Feature Runner Service
 * 
 * Orchestrates feature execution and emits completion events.
 * SUP-6: Lead Finder Feature Pack
 */

import type { FeatureType, FeatureRunResult } from '../features/types';
import { runLeadFinder, type LeadFinderParams } from '../features/leadFinder/leadFinder';
import { createEventBus } from '../core/event-bus';
import type { BaseSupervisorEvent } from '../core/types';

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

/**
 * Run a feature by type with given parameters.
 * 
 * @param featureType - The type of feature to run
 * @param params - Parameters for the feature
 * @returns Promise resolving to the feature result
 */
export async function runFeature(
  featureType: FeatureType,
  params: Record<string, unknown>
): Promise<FeatureRunResult> {
  const requestId = generateId();
  const timestamp = new Date().toISOString();
  
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
    
    // Emit FeatureCompleted event
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
      error: errorMessage
    };
  }
}

