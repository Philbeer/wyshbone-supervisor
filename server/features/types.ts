/**
 * Feature Types
 * 
 * Type definitions for the feature runner system.
 * SUP-6: Lead Finder Feature Pack
 */

/**
 * Available feature types that can be executed
 */
export type FeatureType = "leadFinder";

/**
 * Base interface for feature run requests
 */
export interface FeatureRunRequest {
  feature: FeatureType;
  params: Record<string, unknown>;
}

/**
 * Result wrapper for feature execution
 */
export interface FeatureRunResult<T = unknown> {
  status: "ok" | "error";
  data?: T;
  error?: string;
}

