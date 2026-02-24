/**
 * Native Google Places Text Search implementation for Supervisor
 * 
 * Uses Google Places API Text Search for discovery, then Place Details
 * for each result to fetch website and phone.
 */

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

export interface SearchPlacesResult {
  success: boolean;
  places: PlaceResult[];
  error?: string;
}

const GOOGLE_PLACES_TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const GOOGLE_PLACES_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';

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
  maxResults: number = 20
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

  const searchQuery = `${query} in ${location} ${country}`;
  console.log(`[GOOGLE_PLACES] Searching for: "${searchQuery}"`);
  
  try {
    let allPlaces: PlaceResult[] = [];
    let nextPageToken: string | undefined;
    const maxPages = Math.min(Math.ceil(maxResults / 20), 3);

    for (let page = 0; page < maxPages; page++) {
      if (page > 0 && nextPageToken) {
        await new Promise(r => setTimeout(r, 2000));
      }

      const url = new URL(GOOGLE_PLACES_TEXT_SEARCH_URL);
      url.searchParams.set('query', searchQuery);
      url.searchParams.set('key', apiKey);
      if (nextPageToken && page > 0) {
        url.searchParams.set('pagetoken', nextPageToken);
      }

      const response = await fetch(url.toString());

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[GOOGLE_PLACES] API error:', response.status, errorText);
        if (allPlaces.length > 0) break;
        return {
          success: false,
          places: [],
          error: `Google Places API error: ${response.status}`
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

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        console.error('[GOOGLE_PLACES] API status:', data.status, data.error_message);
        if (allPlaces.length > 0) break;
        return {
          success: false,
          places: [],
          error: data.error_message || `Google Places status: ${data.status}`
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
      places
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
