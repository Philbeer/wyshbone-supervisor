/**
 * Native Google Places Text Search implementation for Supervisor
 * 
 * Uses Google Places API Text Search for discovery, then Place Details
 * for each result to fetch website and phone.
 *
 * Supports two query modes:
 *   TEXT_ONLY      — query phrasing only, no location bias params
 *   BIASED_STABLE  — adds region + location bias (lat/lng + radius)
 */

export type GoogleQueryMode = 'TEXT_ONLY' | 'BIASED_STABLE';

export interface PlaceResult {
  place_id: string;
  name: string;
  formatted_address: string;
  lat: number;
  lng: number;
  types?: string[];
  website?: string;
  phone?: string;
}

export interface SearchPlacesDebug {
  google_query_mode_requested: GoogleQueryMode;
  google_query_mode_used: GoogleQueryMode;
  google_query_string: string;
  region_used: string | null;
  bias_applied: boolean;
  bias_location: string | null;
  radius_used: number | null;
  pages_fetched: number;
  results_returned: number;
  bias_unavailable_fallback: boolean;
}

export interface SearchPlacesResult {
  success: boolean;
  places: PlaceResult[];
  error?: string;
  debug?: SearchPlacesDebug;
}

const GOOGLE_PLACES_TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const GOOGLE_PLACES_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const GOOGLE_GEOCODING_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

const geocodeCache = new Map<string, { lat: number; lng: number } | null>();

const UK_COUNTRY_VARIANTS = new Set([
  'uk', 'united kingdom', 'gb', 'great britain', 'england', 'scotland', 'wales',
]);

function isUkCountry(country: string): boolean {
  return UK_COUNTRY_VARIANTS.has(country.toLowerCase().trim());
}

const DEFAULT_BIAS_RADIUS = 50000;

async function geocodeLocation(location: string, country: string, apiKey: string): Promise<{ lat: number; lng: number } | null> {
  const cacheKey = `${location.toLowerCase().trim()}::${country.toLowerCase().trim()}`;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey)!;

  try {
    const { resolveRegionKeys, getRegion } = await import('./geo-regions');
    const regionKeys = resolveRegionKeys(location);
    if (regionKeys.length > 0) {
      let totalLat = 0, totalLng = 0, count = 0;
      for (const key of regionKeys) {
        const region = getRegion(key);
        if (region) {
          totalLat += (region.bbox.north + region.bbox.south) / 2;
          totalLng += (region.bbox.east + region.bbox.west) / 2;
          count++;
        }
      }
      if (count > 0) {
        const result = { lat: totalLat / count, lng: totalLng / count };
        console.log(`[GOOGLE_PLACES] Geocoded "${location}" via geo-regions → ${result.lat.toFixed(4)},${result.lng.toFixed(4)}`);
        geocodeCache.set(cacheKey, result);
        return result;
      }
    }

    const url = new URL(GOOGLE_GEOCODING_URL);
    url.searchParams.set('address', `${location}, ${country}`);
    url.searchParams.set('key', apiKey);

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      console.warn(`[GOOGLE_PLACES] Geocoding HTTP error ${resp.status} for "${location}"`);
      geocodeCache.set(cacheKey, null);
      return null;
    }

    const data = await resp.json() as {
      status: string;
      results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
    };

    if (data.status === 'OK' && data.results.length > 0) {
      const loc = data.results[0].geometry.location;
      const result = { lat: loc.lat, lng: loc.lng };
      console.log(`[GOOGLE_PLACES] Geocoded "${location}" via Geocoding API → ${result.lat.toFixed(4)},${result.lng.toFixed(4)}`);
      geocodeCache.set(cacheKey, result);
      return result;
    }

    console.warn(`[GOOGLE_PLACES] Geocoding returned ${data.status} for "${location}"`);
    geocodeCache.set(cacheKey, null);
    return null;
  } catch (err: any) {
    console.warn(`[GOOGLE_PLACES] Geocoding exception for "${location}": ${err.message}`);
    geocodeCache.set(cacheKey, null);
    return null;
  }
}

async function fetchPlaceDetails(placeId: string, apiKey: string): Promise<{ website?: string; phone?: string }> {
  try {
    const url = new URL(GOOGLE_PLACES_DETAILS_URL);
    url.searchParams.set('place_id', placeId);
    url.searchParams.set('fields', 'website,formatted_phone_number,international_phone_number');
    url.searchParams.set('key', apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) return {};

    const data = await response.json() as {
      status: string;
      result?: {
        website?: string;
        formatted_phone_number?: string;
        international_phone_number?: string;
      };
    };

    if (data.status !== 'OK' || !data.result) return {};

    return {
      website: data.result.website || undefined,
      phone: data.result.formatted_phone_number || data.result.international_phone_number || undefined,
    };
  } catch {
    return {};
  }
}

export async function searchPlaces(
  query: string,
  location: string,
  country: string,
  maxResults: number = 20,
  mode: GoogleQueryMode = 'TEXT_ONLY',
): Promise<SearchPlacesResult> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  
  if (!apiKey) {
    console.error('[GOOGLE_PLACES] GOOGLE_MAPS_API_KEY not set');
    return {
      success: false,
      places: [],
      error: 'GOOGLE_MAPS_API_KEY not configured'
    };
  }

  const requestedMode = mode;
  let usedMode = mode;
  let biasApplied = false;
  let biasLocation: string | null = null;
  let radiusUsed: number | null = null;
  let regionUsed: string | null = null;
  let biasFallback = false;

  let searchQuery: string;
  let locationBias: { lat: number; lng: number } | null = null;

  if (usedMode === 'BIASED_STABLE') {
    locationBias = await geocodeLocation(location, country, apiKey);
    if (!locationBias) {
      console.log(`[GOOGLE_PLACES] Bias unavailable for "${location}" — falling back to TEXT_ONLY`);
      usedMode = 'TEXT_ONLY';
      biasFallback = true;
    }
  }

  if (usedMode === 'TEXT_ONLY') {
    searchQuery = `${query} ${location} ${country}`.trim();
  } else {
    searchQuery = `${query} ${country}`.trim();
    biasApplied = true;
    biasLocation = `${locationBias!.lat.toFixed(6)},${locationBias!.lng.toFixed(6)}`;
    radiusUsed = DEFAULT_BIAS_RADIUS;
    if (isUkCountry(country)) {
      regionUsed = 'uk';
    }
  }

  console.log(`[GOOGLE_PLACES] mode_requested=${requestedMode} mode_used=${usedMode} query="${searchQuery}" bias=${biasApplied} bias_location=${biasLocation} radius=${radiusUsed} region=${regionUsed} fallback=${biasFallback}`);
  
  try {
    let allPlaces: PlaceResult[] = [];
    let nextPageToken: string | undefined;
    const maxPages = Math.min(Math.ceil(maxResults / 20), 3);
    let pagesFetched = 0;

    for (let page = 0; page < maxPages; page++) {
      if (page > 0 && nextPageToken) {
        await new Promise(r => setTimeout(r, 2000));
      }

      const url = new URL(GOOGLE_PLACES_TEXT_SEARCH_URL);
      url.searchParams.set('query', searchQuery);
      url.searchParams.set('key', apiKey);

      if (biasApplied && locationBias) {
        url.searchParams.set('location', biasLocation!);
        url.searchParams.set('radius', String(radiusUsed));
      }

      if (regionUsed) {
        url.searchParams.set('region', regionUsed);
      }

      if (nextPageToken && page > 0) {
        url.searchParams.set('pagetoken', nextPageToken);
      }

      const redactedUrl = url.toString().replace(apiKey, 'REDACTED');
      console.log(`[GOOGLE_PLACES] Request page=${page + 1}: ${redactedUrl}`);

      const response = await fetch(url.toString());
      pagesFetched++;

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[GOOGLE_PLACES] API error:', response.status, errorText);
        if (allPlaces.length > 0) break;
        return {
          success: false,
          places: [],
          error: `Google Places API error: ${response.status}`,
          debug: buildDebug(requestedMode, usedMode, searchQuery, regionUsed, biasApplied, biasLocation, radiusUsed, pagesFetched, 0, biasFallback),
        };
      }

      const data = await response.json() as {
        status: string;
        results: Array<{
          place_id: string;
          name: string;
          formatted_address: string;
          geometry: { location: { lat: number; lng: number } };
          types?: string[];
        }>;
        next_page_token?: string;
        error_message?: string;
      };

      console.log(`[GOOGLE_PLACES] Response page=${page + 1}: status=${data.status} results=${(data.results || []).length} next_page_token=${data.next_page_token ? 'yes' : 'no'}`);

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        console.error('[GOOGLE_PLACES] API status:', data.status, data.error_message);
        if (allPlaces.length > 0) break;
        return {
          success: false,
          places: [],
          error: data.error_message || `Google Places status: ${data.status}`,
          debug: buildDebug(requestedMode, usedMode, searchQuery, regionUsed, biasApplied, biasLocation, radiusUsed, pagesFetched, 0, biasFallback),
        };
      }

      const pagePlaces: PlaceResult[] = (data.results || []).map(result => ({
        place_id: result.place_id,
        name: result.name,
        formatted_address: result.formatted_address,
        lat: result.geometry.location.lat,
        lng: result.geometry.location.lng,
        types: result.types
      }));

      allPlaces.push(...pagePlaces);
      console.log(`[GOOGLE_PLACES] Page ${page + 1}: ${pagePlaces.length} places (total: ${allPlaces.length})`);

      nextPageToken = data.next_page_token;
      if (!nextPageToken || allPlaces.length >= maxResults) break;
    }

    const places = allPlaces.slice(0, maxResults);

    const DETAILS_CONCURRENCY = 5;
    let websitesFound = 0;
    for (let i = 0; i < places.length; i += DETAILS_CONCURRENCY) {
      const batch = places.slice(i, i + DETAILS_CONCURRENCY);
      const details = await Promise.all(
        batch.map(p => fetchPlaceDetails(p.place_id, apiKey))
      );
      for (let j = 0; j < batch.length; j++) {
        if (details[j].website) {
          batch[j].website = details[j].website;
          websitesFound++;
        }
        if (details[j].phone) {
          batch[j].phone = details[j].phone;
        }
      }
    }

    console.log(`[GOOGLE_PLACES] places_details_websites_found=${websitesFound}/${places.length}`);
    console.log(`[GOOGLE_PLACES] Found ${places.length} places (requested up to ${maxResults})`);

    return {
      success: true,
      places,
      debug: buildDebug(requestedMode, usedMode, searchQuery, regionUsed, biasApplied, biasLocation, radiusUsed, pagesFetched, places.length, biasFallback),
    };
    
  } catch (error: any) {
    console.error('[GOOGLE_PLACES] Exception:', error.message);
    return {
      success: false,
      places: [],
      error: error.message
    };
  }
}

function buildDebug(
  requested: GoogleQueryMode,
  used: GoogleQueryMode,
  queryString: string,
  region: string | null,
  biasApplied: boolean,
  biasLoc: string | null,
  radius: number | null,
  pages: number,
  results: number,
  fallback: boolean,
): SearchPlacesDebug {
  return {
    google_query_mode_requested: requested,
    google_query_mode_used: used,
    google_query_string: queryString,
    region_used: region,
    bias_applied: biasApplied,
    bias_location: biasLoc,
    radius_used: radius,
    pages_fetched: pages,
    results_returned: results,
    bias_unavailable_fallback: fallback,
  };
}
