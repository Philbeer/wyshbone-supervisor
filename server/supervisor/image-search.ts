export interface ImageResult {
  url: string;
  alt: string;
  attribution: string;
  attribution_url: string;
}

const UNSPLASH_ENDPOINT = 'https://api.unsplash.com/search/photos';

export async function searchImages(
  query: string,
  opts: { count?: number; orientation?: 'landscape' | 'portrait' | 'squarish' } = {}
): Promise<ImageResult[]> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) {
    console.warn('[IMAGE_SEARCH] UNSPLASH_ACCESS_KEY not set — returning empty');
    return [];
  }

  const count = Math.min(Math.max(opts.count ?? 1, 1), 4);
  const orientation = opts.orientation ?? 'landscape';
  const params = new URLSearchParams({
    query,
    per_page: String(count),
    orientation,
    content_filter: 'high',
  });

  try {
    const res = await fetch(`${UNSPLASH_ENDPOINT}?${params.toString()}`, {
      headers: {
        Authorization: `Client-ID ${accessKey}`,
        'Accept-Version': 'v1',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      console.warn(`[IMAGE_SEARCH] Unsplash returned ${res.status} for "${query}"`);
      return [];
    }
    const data = await res.json() as { results?: any[] };
    if (!Array.isArray(data.results)) return [];
    return data.results.slice(0, count).map((r: any) => ({
      url: r.urls?.regular || r.urls?.small || '',
      alt: r.alt_description || r.description || query,
      attribution: `Photo by ${r.user?.name || 'Unknown'} on Unsplash`,
      attribution_url: r.user?.links?.html || 'https://unsplash.com',
    })).filter(img => img.url);
  } catch (err: any) {
    console.warn(`[IMAGE_SEARCH] Failed for "${query}": ${err.message}`);
    return [];
  }
}

export async function resolveImagePlaceholders(
  response: string,
): Promise<{ text: string; imageCount: number }> {
  const placeholderRegex = /\[IMAGE:\s*([^\]]+)\]/g;
  const matches = Array.from(response.matchAll(placeholderRegex));
  if (matches.length === 0) return { text: response, imageCount: 0 };

  const MAX_IMAGES = 3;
  const toFetch = matches.slice(0, MAX_IMAGES);

  const fetched = await Promise.all(
    toFetch.map(async (m) => {
      const desc = m[1].trim();
      const images = await searchImages(desc, { count: 1 });
      return { placeholder: m[0], desc, image: images[0] || null };
    })
  );

  let text = response;
  let imageCount = 0;
  for (const { placeholder, desc, image } of fetched) {
    if (image) {
      text = text.replace(placeholder, `![${image.alt || desc}](${image.url})`);
      imageCount++;
    } else {
      text = text.replace(placeholder, '');
    }
  }
  text = text.replace(placeholderRegex, '');
  return { text: text.trim(), imageCount };
}
