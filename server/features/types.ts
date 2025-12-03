/**
 * Feature Types
 * 
 * Type definitions for the feature runner system.
 * SUP-6: Lead Finder Feature Pack
 * SUP-9: Feature Toggle Support
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
 * Error codes for feature execution
 */
export type FeatureErrorCode = 
  | "FEATURE_DISABLED"
  | "UNKNOWN_FEATURE"
  | "EXECUTION_FAILED";

/**
 * Result wrapper for feature execution
 * 
 * Status values:
 *   - "ok": Feature executed successfully
 *   - "error": Feature execution failed
 *   - "feature_disabled": Feature is disabled via toggle
 */
export interface FeatureRunResult<T = unknown> {
  status: "ok" | "error" | "feature_disabled";
  data?: T;
  error?: string;
  /** Error code for programmatic handling by callers */
  errorCode?: FeatureErrorCode;
}

