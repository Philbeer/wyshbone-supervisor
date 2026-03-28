/**
 * Native Google Places Text Search implementation for Supervisor
 *
 * Uses Places API v1 (places:searchText) for discovery.
 * websiteUri is returned directly in the search response — no separate
 * Place Details calls are needed or made.
 *
 * Supports two query modes:
 *   TEXT_ONLY      — query phrasing only, no location bias params
 *   BIASED_STABLE  — adds locationBias circle (lat/lng + radius) and regionCode
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

const GOOGLE_PLACES_V1_URL = 'https://places.googleapis.com/v1/places:searchText';
const GOOGLE_GEOCODING_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

const PLACES_V1_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
  'places.websiteUri',
].join(',');

// ---------------------------------------------------------------------------
// In-memory place cache — keyed by place_id, stores resolved website/phone.
// TODO: add TTL before production
// ---------------------------------------------------------------------------
const placeCache = new Map<string, {
  website: string | null;
  phone: string | null;
  cachedAt: string;
  cacheVersion: '1.0';
}>();

// ---------------------------------------------------------------------------
// In-memory geocode cache — keyed by "location::country"
// ---------------------------------------------------------------------------
const geocodeCache = new Map<string, { lat: number; lng: number } | null>();

// ---------------------------------------------------------------------------
// In-memory search results cache — keyed by query+location+country+mode
// Prevents identical searches from hitting Google repeatedly (24h TTL)
// ---------------------------------------------------------------------------
interface SearchCacheEntry {
  data: SearchPlacesResult;
  expiresAt: number;
  createdAt: number;
}
const searchResultsCache = new Map<string, SearchCacheEntry>();
let cacheStats = { hits: 0, misses: 0 };

// Periodic cleanup and stats logging
setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [key, entry] of searchResultsCache) {
    if (now > entry.expiresAt) { searchResultsCache.delete(key); evicted++; } // No-op in dev mode (Infinity TTL)
  }
  const total = cacheStats.hits + cacheStats.misses;
  const hitRate = total > 0 ? Math.round((cacheStats.hits / total) * 100) : 0;
  console.log(`📊 [GP CACHE] Hits: ${cacheStats.hits} | Misses: ${cacheStats.misses} | Rate: ${hitRate}% | Entries: ${searchResultsCache.size}${evicted ? ` | Evicted: ${evicted}` : ''}`);
}, 10 * 60 * 1000); // Every 10 minutes

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

export async function searchPlaces(
  query: string,
  location: string,
  country: string,
  maxResults: number = 20,
  mode: GoogleQueryMode = 'TEXT_ONLY',
): Promise<SearchPlacesResult> {
  // ─── SEARCH CACHE CHECK ───────────────────────────────────────
  const cacheKey = `search:${query.toLowerCase().trim()}||${location.toLowerCase().trim()}||${country.toLowerCase().trim()}||${maxResults}||${mode}`;
  const cachedSearch = searchResultsCache.get(cacheKey);
  if (cachedSearch && Date.now() < cachedSearch.expiresAt) {
    cacheStats.hits++;
    const ageMin = Math.round((Date.now() - cachedSearch.createdAt) / 60000);
    console.log(`⚡ [GP CACHE HIT] "${query}" in "${location}" (age: ${ageMin}m) — saved 1+ API call`);
    return cachedSearch.data;
  }
  cacheStats.misses++;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    console.error('[GOOGLE_PLACES] GOOGLE_MAPS_API_KEY not set');
    return {
      success: false,
      places: [],
      error: 'GOOGLE_MAPS_API_KEY not configured',
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
    // Places API v1 returns up to 20 results per call — no pagination tokens.
    const requestedCount = Math.min(maxResults, 20);

    const requestBody: Record<string, unknown> = {
      textQuery: searchQuery,
      maxResultCount: requestedCount,
    };

    if (biasApplied && locationBias) {
      requestBody['locationBias'] = {
        circle: {
          center: { latitude: locationBias.lat, longitude: locationBias.lng },
          radius: radiusUsed,
        },
      };
    }

    if (regionUsed) {
      requestBody['regionCode'] = regionUsed;
    }

    console.log(`[GOOGLE_PLACES] v1 Request: textQuery="${searchQuery}" maxResultCount=${requestedCount} bias=${biasApplied}`);

    const response = await fetch(GOOGLE_PLACES_V1_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': PLACES_V1_FIELD_MASK,
      },
      body: JSON.stringify(requestBody),
    });

    const pagesFetched = 1;

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[GOOGLE_PLACES] v1 API error:', response.status, errorText);
      return {
        success: false,
        places: [],
        error: `Google Places API error: ${response.status}`,
        debug: buildDebug(requestedMode, usedMode, searchQuery, regionUsed, biasApplied, biasLocation, radiusUsed, pagesFetched, 0, biasFallback),
      };
    }

    const data = await response.json() as {
      places?: Array<{
        id: string;
        displayName?: { text: string };
        formattedAddress?: string;
        location?: { latitude: number; longitude: number };
        types?: string[];
        websiteUri?: string;
      }>;
      error?: { message: string };
    };

    if (data.error) {
      console.error('[GOOGLE_PLACES] v1 API error body:', data.error.message);
      return {
        success: false,
        places: [],
        error: data.error.message,
        debug: buildDebug(requestedMode, usedMode, searchQuery, regionUsed, biasApplied, biasLocation, radiusUsed, pagesFetched, 0, biasFallback),
      };
    }

    const rawPlaces = data.places || [];
    console.log(`[GOOGLE_PLACES] v1 Response: ${rawPlaces.length} places returned`);

    let websitesFound = 0;

    const places: PlaceResult[] = rawPlaces.slice(0, maxResults).map(raw => {
      const placeId = raw.id;

      if (placeCache.has(placeId)) {
        const cached = placeCache.get(placeId)!;
        console.log(`[PLACES CACHE HIT] ${placeId} cached at ${cached.cachedAt}`);
        return {
          place_id: placeId,
          name: raw.displayName?.text || 'Unknown',
          formatted_address: raw.formattedAddress || '',
          lat: raw.location?.latitude ?? 0,
          lng: raw.location?.longitude ?? 0,
          types: raw.types,
          website: cached.website ?? undefined,
          phone: cached.phone ?? undefined,
        };
      }

      console.log(`[PLACES CACHE MISS] ${placeId} — fetching from API`);

      const website = raw.websiteUri ?? null;
      const phone: string | null = null;

      placeCache.set(placeId, {
        website,
        phone,
        cachedAt: new Date().toISOString(),
        cacheVersion: '1.0',
      });

      if (website) websitesFound++;

      return {
        place_id: placeId,
        name: raw.displayName?.text || 'Unknown',
        formatted_address: raw.formattedAddress || '',
        lat: raw.location?.latitude ?? 0,
        lng: raw.location?.longitude ?? 0,
        types: raw.types,
        website: website ?? undefined,
        phone: phone ?? undefined,
      };
    });

    console.log(`[GOOGLE_PLACES] places_websites_found=${websitesFound}/${places.length}`);
    console.log(`[GOOGLE_PLACES] Found ${places.length} places (requested up to ${maxResults})`);

    // ─── CACHE THE RESULT ─────────────────────────────────────────
    const resultToCache: SearchPlacesResult = {
      success: true,
      places,
      debug: buildDebug(requestedMode, usedMode, searchQuery, regionUsed, biasApplied, biasLocation, radiusUsed, pagesFetched, places.length, biasFallback),
    };
    searchResultsCache.set(cacheKey, {
      data: resultToCache,
      expiresAt: Infinity, // Never expires (dev mode)
      createdAt: Date.now(),
    });
    console.log(`💾 [GP CACHE] Stored: "${query}" in "${location}" (${places.length} results, cached permanently (dev mode))`);

    return resultToCache;

  } catch (error: any) {
    console.error('[GOOGLE_PLACES] Exception:', error.message);
    return {
      success: false,
      places: [],
      error: error.message,
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
