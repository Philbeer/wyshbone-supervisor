/**
 * Core Verticals - Barrel Export
 * 
 * Re-exports all vertical pack types and registry functions.
 * SUP-14: BreweryVerticalPack (pipeline, scripts, queries)
 */

// Types
export type {
  VerticalId,
  VerticalLeadPipelineStage,
  VerticalLeadFinderQueryRecipe,
  VerticalScriptTemplate,
  VerticalPack,
} from './types';

export { VerticalPackNotFoundError } from './types';

// Registry
export {
  getVerticalPack,
  listVerticalPacks,
  listVerticalIds,
  hasVerticalPack,
} from './VerticalPackRegistry';
