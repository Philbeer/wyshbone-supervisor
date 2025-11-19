/**
 * SUP-011: Fallback Data Sources
 * 
 * Implements automatic fallback between multiple lead data sources
 * when the primary source fails or returns insufficient results.
 */

import type { LeadDataSourceId, LeadSearchResultMeta, SupervisorUserContext } from "./types/lead-gen-plan";

// ========================================
// CONFIGURATION
// ========================================

/**
 * Minimum number of leads considered "successful" for a search
 * If a source returns fewer leads, we'll try the next fallback
 */
const MIN_LEADS_THRESHOLD = 3;

/**
 * Maximum number of fallback attempts before giving up
 */
const MAX_FALLBACK_ATTEMPTS = 3;

// ========================================
// TYPES
// ========================================

export interface LeadSearchOptions {
  primary: LeadDataSourceId;
  fallbacks: LeadDataSourceId[];
}

export interface LeadSearchParams {
  query: string;
  region: string;
  country?: string;
  maxResults?: number;
}

export interface LeadSearchWithFallbackResult {
  sourceUsed: LeadDataSourceId;
  leads: any[];
  meta: LeadSearchResultMeta;
}

// ========================================
// DATA SOURCE IMPLEMENTATIONS
// ========================================

/**
 * Search using Google Places API
 */
async function searchGooglePlaces(params: LeadSearchParams): Promise<{ leads: any[]; error?: string }> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  
  if (!apiKey) {
    return {
      leads: [],
      error: "GOOGLE_PLACES_API_KEY not configured"
    };
  }

  try {
    const url = 'https://places.googleapis.com/v1/places:searchText';
    const requestBody = {
      textQuery: `${params.query} in ${params.region} ${params.country || ''}`.trim(),
      maxResultCount: params.maxResults || 10
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.internationalPhoneNumber'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        leads: [],
        error: `Google Places API error: ${response.status} ${errorText}`
      };
    }

    const data = await response.json();
    const places = data.places || [];
    
    // Transform to our lead format
    const leads = places.map((place: any) => ({
      place_id: place.id,
      name: place.displayName?.text || 'Unknown',
      address: place.formattedAddress || '',
      website: place.websiteUri || '',
      phone: place.nationalPhoneNumber || place.internationalPhoneNumber || ''
    }));

    return { leads };
  } catch (error) {
    return {
      leads: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Search using internal pubs database (stub - would query Supabase)
 */
async function searchInternalPubs(params: LeadSearchParams): Promise<{ leads: any[]; error?: string }> {
  // TODO: Implement Supabase query for internal pubs database
  console.log(`🗄️  INTERNAL_PUBS: Searching for "${params.query}" in ${params.region}`);
  
  // For now, return empty results with a note
  return {
    leads: [],
    error: "internal_pubs source not yet implemented"
  };
}

/**
 * Search using DataLedger (stub - would call DataLedger API)
 */
async function searchDataLedger(params: LeadSearchParams): Promise<{ leads: any[]; error?: string }> {
  // TODO: Implement DataLedger API integration
  console.log(`📊 DATALEDGER: Searching for "${params.query}" in ${params.region}`);
  
  // For now, return empty results with a note
  return {
    leads: [],
    error: "dataledger source not yet implemented"
  };
}

/**
 * Fallback mock source for testing (always returns some results)
 */
async function searchFallbackMock(params: LeadSearchParams): Promise<{ leads: any[]; error?: string }> {
  console.log(`🎭 FALLBACK_MOCK: Providing mock results for "${params.query}"`);
  
  // Generate 5 mock leads
  const leads = Array.from({ length: 5 }, (_, i) => ({
    place_id: `mock_${Date.now()}_${i}`,
    name: `${params.query} Business ${i + 1}`,
    address: `${params.region}, ${params.country || 'Unknown'}`,
    website: `https://example-mock${i}.com`,
    phone: `+1 555 ${String(i).padStart(3, '0')} ${String(Date.now() % 10000).padStart(4, '0')}`
  }));

  return { leads };
}

// ========================================
// FALLBACK SEARCH LOGIC
// ========================================

/**
 * Execute search using a specific data source
 */
async function executeSearchForSource(
  source: LeadDataSourceId,
  params: LeadSearchParams
): Promise<{ leads: any[]; error?: string }> {
  switch (source) {
    case "google_places":
      return await searchGooglePlaces(params);
    case "internal_pubs":
      return await searchInternalPubs(params);
    case "dataledger":
      return await searchDataLedger(params);
    case "fallback_mock":
      return await searchFallbackMock(params);
    default:
      return {
        leads: [],
        error: `Unknown data source: ${source}`
      };
  }
}

/**
 * Search for leads with automatic fallback to alternative sources
 * 
 * SUP-011 Core Function:
 * 1. Tries primary source first
 * 2. If it fails or returns too few leads, tries fallback sources in order
 * 3. Returns first successful result with sufficient leads
 * 4. Tracks full fallback chain for observability
 */
export async function searchLeadsWithFallback(
  options: LeadSearchOptions,
  params: LeadSearchParams
): Promise<LeadSearchWithFallbackResult> {
  const fallbackChain: Array<{
    source: LeadDataSourceId;
    success: boolean;
    errorMessage?: string;
    leadsFound?: number;
  }> = [];

  // Build ordered list of sources to try
  const sourcesToTry = [options.primary, ...options.fallbacks].slice(0, MAX_FALLBACK_ATTEMPTS + 1);

  console.log(`🔍 SUP-011: Starting fallback search with primary=${options.primary}, fallbacks=[${options.fallbacks.join(', ')}]`);

  // Try each source in order
  for (const source of sourcesToTry) {
    console.log(`   Trying source: ${source}`);
    
    const result = await executeSearchForSource(source, params);
    const leadsFound = result.leads.length;
    const hasError = !!result.error;
    const hasSufficientLeads = leadsFound >= MIN_LEADS_THRESHOLD;

    // Record this attempt in the chain
    fallbackChain.push({
      source,
      success: !hasError && hasSufficientLeads,
      errorMessage: result.error,
      leadsFound
    });

    // Check if this source succeeded
    if (!hasError && hasSufficientLeads) {
      console.log(`   ✅ ${source} succeeded with ${leadsFound} leads`);
      
      const meta: LeadSearchResultMeta = {
        source,
        leadsFound,
        success: true,
        fallbackUsed: source !== options.primary,
        fallbackChain
      };

      return {
        sourceUsed: source,
        leads: result.leads,
        meta
      };
    }

    // Log why this source didn't work
    if (hasError) {
      console.log(`   ❌ ${source} failed: ${result.error}`);
    } else {
      console.log(`   ⚠️  ${source} returned only ${leadsFound} leads (< ${MIN_LEADS_THRESHOLD} threshold)`);
    }
  }

  // All sources failed
  console.log(`   ❌ All ${sourcesToTry.length} sources failed or returned insufficient leads`);

  const meta: LeadSearchResultMeta = {
    source: options.primary,
    leadsFound: 0,
    success: false,
    errorCode: "ALL_SOURCES_FAILED",
    errorMessage: `All data sources failed or returned < ${MIN_LEADS_THRESHOLD} leads`,
    fallbackUsed: fallbackChain.length > 1,
    fallbackChain
  };

  return {
    sourceUsed: options.primary,
    leads: [],
    meta
  };
}
