/**
 * Vertical Pack Types
 * 
 * Type definitions for vertical-specific configurations.
 * SUP-14: BreweryVerticalPack (pipeline, scripts, queries)
 * 
 * Vertical packs define industry-specific:
 * - Lead pipeline stages
 * - Lead Finder query recipes (search templates)
 * - Script templates (email / call scripts)
 */

// ============================================
// VERTICAL IDENTIFIERS
// ============================================

/**
 * Known vertical identifiers.
 * Add new verticals here as the system grows.
 */
export type VerticalId = 'brewery';

// ============================================
// LEAD PIPELINE TYPES
// ============================================

/**
 * A stage in a vertical-specific lead pipeline.
 * Pipelines define the journey from lead discovery to conversion.
 */
export interface VerticalLeadPipelineStage {
  /** Unique identifier for this stage (e.g. 'new', 'qualified', 'customer') */
  id: string;
  /** Human-readable label for display */
  label: string;
  /** Optional description explaining this stage */
  description?: string;
  /** Whether this is a terminal/end state (e.g. 'customer', 'lost') */
  isTerminal?: boolean;
  /** Sort order for display (lower = earlier in pipeline) */
  order: number;
}

// ============================================
// LEAD FINDER TYPES
// ============================================

/**
 * A recipe for Lead Finder searches.
 * Defines reusable search templates for finding leads in a specific vertical.
 */
export interface VerticalLeadFinderQueryRecipe {
  /** Unique identifier for this recipe */
  id: string;
  /** Human-readable label for display */
  label: string;
  /** Optional description of what this search finds */
  description?: string;
  /** Search template with {PLACEHOLDERS} for variable substitution */
  searchTemplate: string;
  /** Optional tags for filtering/categorization */
  tags?: string[];
  /** Default country code for location-based searches (e.g. 'GB') */
  defaultCountryCode?: string;
}

// ============================================
// SCRIPT TEMPLATE TYPES
// ============================================

/**
 * A script template for outreach or follow-up.
 * Uses {{placeholders}} for dynamic content substitution.
 */
export interface VerticalScriptTemplate {
  /** Unique identifier for this template */
  id: string;
  /** Human-readable label for display */
  label: string;
  /** Optional description of when to use this template */
  description?: string;
  /** Template body with {{placeholders}} for variable substitution */
  bodyTemplate: string;
  /** Optional tags for filtering/categorization */
  tags?: string[];
  /** Channel this template is designed for */
  channel?: 'email' | 'call' | 'note';
}

// ============================================
// VERTICAL PACK INTERFACE
// ============================================

/**
 * A complete vertical pack containing all configurations
 * for a specific industry vertical.
 * 
 * @example
 * ```ts
 * const breweryPack: VerticalPack = {
 *   verticalId: 'brewery',
 *   name: 'Brewery',
 *   description: 'Tools for breweries selling to pubs and venues',
 *   leadPipeline: [...],
 *   leadFinderRecipes: [...],
 *   scriptTemplates: [...]
 * };
 * ```
 */
export interface VerticalPack {
  /** Unique identifier for this vertical */
  verticalId: VerticalId;
  /** Human-readable name */
  name: string;
  /** Optional description of this vertical */
  description?: string;
  /** Pipeline stages for lead management */
  leadPipeline: VerticalLeadPipelineStage[];
  /** Lead Finder query recipes */
  leadFinderRecipes: VerticalLeadFinderQueryRecipe[];
  /** Script templates for outreach */
  scriptTemplates: VerticalScriptTemplate[];
}

// ============================================
// ERROR TYPES
// ============================================

/**
 * Error thrown when a vertical pack is not found in the registry.
 */
export class VerticalPackNotFoundError extends Error {
  constructor(verticalId: string) {
    super(`Vertical pack not found: ${verticalId}`);
    this.name = 'VerticalPackNotFoundError';
  }
}
