/**
 * Feature Toggle Configuration
 * 
 * Simple feature flag system for enabling/disabling features.
 * SUP-9: Lead Finder on/off toggle
 * 
 * Usage:
 *   import { isFeatureEnabled, getFeatureConfig } from './config/features';
 *   
 *   if (isFeatureEnabled('lead_finder')) {
 *     // run lead finder
 *   }
 * 
 * To enable/disable Lead Finder:
 *   - Set FEATURE_LEAD_FINDER_ENABLED=true/false in environment
 *   - OR modify defaultFeatureToggles below
 */

// ============================================
// FEATURE IDENTIFIERS
// ============================================

/**
 * Known feature identifiers that can be toggled.
 * Add new feature IDs here as the system grows.
 */
export type FeatureId = 'lead_finder';

// ============================================
// FEATURE TOGGLE TYPES
// ============================================

/**
 * Configuration for a single feature toggle
 */
export interface FeatureToggle {
  /** Whether the feature is enabled */
  enabled: boolean;
  /** Optional: specific account IDs this toggle applies to (future use) */
  accountIds?: string[];
  /** Optional: specific environments this toggle applies to (future use) */
  environments?: string[];
}

/**
 * Context for evaluating feature toggles
 */
export interface FeatureContext {
  /** Current environment (e.g., 'development', 'production') */
  environment?: string;
  /** Account ID for account-specific overrides (future use) */
  accountId?: string;
  /** User ID for user-specific overrides (future use) */
  userId?: string;
}

/**
 * Full feature configuration including toggle and metadata
 */
export interface FeatureConfig extends FeatureToggle {
  /** Feature identifier */
  featureId: FeatureId;
  /** Human-readable name */
  name: string;
  /** Description of what the feature does */
  description: string;
}

// ============================================
// DEFAULT FEATURE TOGGLES
// ============================================

/**
 * Default feature toggle configuration.
 * 
 * This is the single source of truth for feature flags.
 * Environment variables can override these defaults.
 * 
 * To disable Lead Finder: set enabled: false below
 * OR set FEATURE_LEAD_FINDER_ENABLED=false in environment
 */
export const defaultFeatureToggles: Record<FeatureId, FeatureToggle> = {
  lead_finder: {
    enabled: true, // Change to false to disable Lead Finder globally
  },
};

/**
 * Feature metadata (names, descriptions)
 */
const featureMetadata: Record<FeatureId, { name: string; description: string }> = {
  lead_finder: {
    name: 'Lead Finder',
    description: 'Search and discover business leads based on query and location',
  },
};

// ============================================
// ENVIRONMENT VARIABLE OVERRIDES
// ============================================

/**
 * Maps feature IDs to their environment variable names.
 * Environment variables take precedence over defaultFeatureToggles.
 */
const envVarMapping: Record<FeatureId, string> = {
  lead_finder: 'FEATURE_LEAD_FINDER_ENABLED',
};

/**
 * Get the toggle value from environment variable if set.
 * Returns undefined if not set, allowing fallback to defaults.
 */
function getEnvToggle(featureId: FeatureId): boolean | undefined {
  const envVar = envVarMapping[featureId];
  const value = process.env[envVar];
  
  if (value === undefined || value === '') {
    return undefined;
  }
  
  // Parse boolean-like values
  const normalized = value.toLowerCase().trim();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  
  // Log warning for unexpected values
  console.warn(`[FeatureToggle] Invalid value for ${envVar}: "${value}". Expected true/false.`);
  return undefined;
}

// ============================================
// FEATURE TOGGLE API
// ============================================

/**
 * Check if a feature is enabled.
 * 
 * Resolution order:
 *   1. Environment variable override (if set)
 *   2. Default toggle configuration
 * 
 * @param featureId - The feature to check
 * @param context - Optional context for future account/env overrides
 * @returns true if the feature is enabled, false otherwise
 * 
 * @example
 * ```ts
 * if (isFeatureEnabled('lead_finder')) {
 *   // run lead finder logic
 * }
 * ```
 */
export function isFeatureEnabled(featureId: FeatureId, context?: FeatureContext): boolean {
  // 1. Check environment variable override first
  const envOverride = getEnvToggle(featureId);
  if (envOverride !== undefined) {
    return envOverride;
  }
  
  // 2. Fall back to default configuration
  const toggle = defaultFeatureToggles[featureId];
  if (!toggle) {
    // Unknown feature - default to disabled for safety
    console.warn(`[FeatureToggle] Unknown feature ID: ${featureId}. Defaulting to disabled.`);
    return false;
  }
  
  // Future: Add account-specific or environment-specific override logic here
  // using the context parameter
  
  return toggle.enabled;
}

/**
 * Get the full configuration for a feature.
 * 
 * @param featureId - The feature to get config for
 * @param context - Optional context (for future use)
 * @returns Full feature configuration including metadata
 * 
 * @example
 * ```ts
 * const config = getFeatureConfig('lead_finder');
 * console.log(config.name, config.enabled);
 * ```
 */
export function getFeatureConfig(featureId: FeatureId, context?: FeatureContext): FeatureConfig {
  const toggle = defaultFeatureToggles[featureId];
  const metadata = featureMetadata[featureId];
  
  if (!toggle || !metadata) {
    // Return a disabled config for unknown features
    return {
      featureId,
      name: featureId,
      description: 'Unknown feature',
      enabled: false,
    };
  }
  
  // Apply environment override
  const envOverride = getEnvToggle(featureId);
  const enabled = envOverride !== undefined ? envOverride : toggle.enabled;
  
  return {
    featureId,
    ...metadata,
    ...toggle,
    enabled,
  };
}

/**
 * Get all feature configurations.
 * Useful for debugging or admin dashboards.
 * 
 * @returns Array of all feature configurations
 */
export function getAllFeatureConfigs(): FeatureConfig[] {
  const featureIds = Object.keys(defaultFeatureToggles) as FeatureId[];
  return featureIds.map(id => getFeatureConfig(id));
}

