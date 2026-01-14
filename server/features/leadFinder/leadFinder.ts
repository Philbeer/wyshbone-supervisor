/**
 * Lead Finder Feature Module
 * 
 * Provides lead search functionality with mock data for now.
 * SUP-6: Lead Finder Feature Pack
 * SUP-15: Lead Finder uses brewery search recipes
 */

import {
  getVerticalPack,
  VerticalPackNotFoundError,
  type VerticalId,
  type VerticalLeadFinderQueryRecipe,
} from '../../core/verticals';

/**
 * A mock lead returned by the lead finder
 */
export interface MockLead {
  businessName: string;
  address: string;
  score: number;
}

/**
 * Parameters for running the lead finder
 * 
 * SUP-15: Extended with optional recipeId and verticalId for pack-based searches.
 * - If recipeId is provided, looks up recipe from the vertical pack.
 * - If verticalId is omitted, defaults to 'brewery'.
 * - For backwards compatibility, requests without recipeId use legacy search.
 */
export interface LeadFinderParams {
  query: string;
  location: string;
  /** Optional: Recipe ID for vertical pack-based search (e.g. 'micropubs_uk') */
  recipeId?: string;
  /** Optional: Vertical ID to look up recipes from (defaults to 'brewery') */
  verticalId?: VerticalId;
}

/**
 * Result from the lead finder
 */
export interface LeadFinderResult {
  leads: MockLead[];
  count: number;
}

/**
 * Hardcoded mock leads for development/testing
 */
const MOCK_LEADS: MockLead[] = [
  {
    businessName: "Bristol Dental Practice",
    address: "45 Queen Square, Bristol BS1 4LH",
    score: 92
  },
  {
    businessName: "Manchester Smiles Clinic",
    address: "12 Piccadilly Gardens, Manchester M1 1RG",
    score: 87
  },
  {
    businessName: "London Dental Hub",
    address: "78 Harley Street, London W1G 7HJ",
    score: 95
  },
  {
    businessName: "Birmingham Family Dentistry",
    address: "23 Colmore Row, Birmingham B3 2BJ",
    score: 78
  },
  {
    businessName: "Leeds Dental Centre",
    address: "56 The Headrow, Leeds LS1 8EQ",
    score: 84
  }
];

// ============================================
// SEARCH QUERY BUILDERS (SUP-15)
// ============================================

/**
 * Build a search query from a vertical pack recipe.
 * Replaces placeholders in the recipe's searchTemplate with values from params.
 * 
 * Supported placeholders:
 * - {REGION_OR_TOWN} - replaced with params.location
 * - {CITY} - replaced with params.location
 * 
 * @param recipe - The Lead Finder query recipe from the vertical pack
 * @param params - The Lead Finder params containing location/query info
 * @returns The final search query string
 */
export function buildSearchQueryFromRecipe(
  recipe: VerticalLeadFinderQueryRecipe,
  params: LeadFinderParams
): string {
  let query = recipe.searchTemplate;
  
  if (params.location) {
    const location = params.location.trim();
    query = query
      .replace('{REGION_OR_TOWN}', location)
      .replace('{CITY}', location);
  } else {
    // Strip placeholders if no location provided
    query = query
      .replace('{REGION_OR_TOWN}', '')
      .replace('{CITY}', '')
      .trim();
  }
  
  return query;
}

/**
 * Build a search query using legacy behaviour (pre-SUP-15).
 * Simply combines query and location into a single search string.
 * 
 * @param params - The Lead Finder params
 * @returns The final search query string
 */
export function buildLegacySearchQuery(params: LeadFinderParams): string {
  const parts: string[] = [];
  
  if (params.query && params.query.trim()) {
    parts.push(params.query.trim());
  }
  
  if (params.location && params.location.trim()) {
    parts.push(params.location.trim());
  }
  
  return parts.join(' ');
}

/**
 * Run the lead finder with given parameters.
 * 
 * SUP-15: Now supports vertical pack recipes.
 * - If params.recipeId is provided, looks up recipe from vertical pack.
 * - If params.verticalId is omitted, defaults to 'brewery'.
 * - For backwards compatibility, requests without recipeId use legacy search.
 * 
 * Currently returns mock data. In the future, this will
 * integrate with real data sources.
 * 
 * @param params - Search parameters (query, location, optional recipeId/verticalId)
 * @returns Promise resolving to leads and count
 */
export async function runLeadFinder(params: LeadFinderParams): Promise<LeadFinderResult> {
  console.log(`[LeadFinder] Starting lead search...`);
  
  // SUP-15: Build search query from recipe or legacy params
  let searchQuery: string;
  let usedRecipeId: string | undefined;
  let usedVerticalId: VerticalId | undefined;
  
  if (params.recipeId) {
    // Use vertical pack recipe
    const verticalId: VerticalId = params.verticalId ?? 'brewery';
    usedVerticalId = verticalId;
    usedRecipeId = params.recipeId;
    
    const pack = getVerticalPack(verticalId);
    if (!pack) {
      throw new VerticalPackNotFoundError(verticalId);
    }
    
    const recipe = pack.leadFinderRecipes.find(r => r.id === params.recipeId);
    if (!recipe) {
      throw new Error(`Lead Finder: recipe "${params.recipeId}" not found for vertical "${verticalId}"`);
    }
    
    searchQuery = buildSearchQueryFromRecipe(recipe, params);
    console.log(`[LeadFinder] Using recipe "${params.recipeId}" from vertical "${verticalId}"`);
  } else {
    // Fallback to legacy behaviour
    searchQuery = buildLegacySearchQuery(params);
    console.log(`[LeadFinder] Using legacy search (no recipe)`);
  }
  
  console.log(`[LeadFinder] Search Query: "${searchQuery}", Location: "${params.location}"`);
  if (usedVerticalId) {
    console.log(`[LeadFinder] Vertical: ${usedVerticalId}, Recipe: ${usedRecipeId}`);
  }
  
  // Simulate async operation (pretend to fetch leads)
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Filter leads based on location if provided (simple mock filtering)
  const filteredLeads = params.location 
    ? MOCK_LEADS.filter(lead => 
        lead.address.toLowerCase().includes(params.location.toLowerCase())
      )
    : MOCK_LEADS;
  
  // If no leads match the location filter, return all leads (for demo purposes)
  const leads = filteredLeads.length > 0 ? filteredLeads : MOCK_LEADS;
  
  console.log(`[LeadFinder] Found ${leads.length} leads`);
  
  return {
    leads,
    count: leads.length,
  };
}

