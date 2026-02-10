/**
 * Native Google Places Text Search implementation for Supervisor
 * 
 * Minimal implementation - no pagination, no dedupe, no persistence.
 * Uses Google Places API Text Search endpoint directly.
 */

export interface PlaceResult {
  place_id: string;
  name: string;
  formatted_address: string;
  lat: number;
  lng: number;
  types?: string[];
}

export interface SearchPlacesResult {
  success: boolean;
  places: PlaceResult[];
  error?: string;
}

const GOOGLE_PLACES_TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';

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
