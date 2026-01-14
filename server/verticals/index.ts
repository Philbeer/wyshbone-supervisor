/**
 * Verticals - Barrel Export
 * 
 * Re-exports all vertical packs.
 * SUP-14: BreweryVerticalPack (pipeline, scripts, queries)
 */

// Brewery Vertical
export { BreweryVerticalPack, getBreweryVerticalPack } from './brewery';

// Core types and registry (convenience re-export)
export type {
  VerticalId,
  VerticalLeadPipelineStage,
  VerticalLeadFinderQueryRecipe,
  VerticalScriptTemplate,
  VerticalPack,
} from '../core/verticals';

export {
  getVerticalPack,
  listVerticalPacks,
  listVerticalIds,
  hasVerticalPack,
  VerticalPackNotFoundError,
} from '../core/verticals';
