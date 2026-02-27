import { describe, it, expect } from 'vitest';
import {
  pointInBBox,
  resolveRegionKeys,
  verifyLocationGeo,
  getRegion,
  type BBox,
} from './geo-regions';

describe('pointInBBox', () => {
  const westSussexBBox: BBox = { north: 51.18, south: 50.72, east: -0.09, west: -0.96 };

  it('returns true for point inside bbox', () => {
    expect(pointInBBox(50.95, -0.33, westSussexBBox)).toBe(true);
  });

  it('returns true for point on boundary', () => {
    expect(pointInBBox(51.18, -0.50, westSussexBBox)).toBe(true);
    expect(pointInBBox(50.72, -0.96, westSussexBBox)).toBe(true);
  });

  it('returns false for point outside bbox', () => {
    expect(pointInBBox(52.0, -0.50, westSussexBBox)).toBe(false);
    expect(pointInBBox(50.95, 1.0, westSussexBBox)).toBe(false);
  });
});

describe('resolveRegionKeys', () => {
  it('resolves "sussex" to East Sussex + West Sussex', () => {
    const keys = resolveRegionKeys('sussex');
    expect(keys).toContain('GB-ESX');
    expect(keys).toContain('GB-WSX');
    expect(keys).toHaveLength(2);
  });

  it('resolves "Sussex" case-insensitively', () => {
    const keys = resolveRegionKeys('Sussex');
    expect(keys).toContain('GB-ESX');
    expect(keys).toContain('GB-WSX');
  });

  it('resolves "east sussex" to single region', () => {
    const keys = resolveRegionKeys('east sussex');
    expect(keys).toEqual(['GB-ESX']);
  });

  it('resolves "west sussex" to single region', () => {
    const keys = resolveRegionKeys('west sussex');
    expect(keys).toEqual(['GB-WSX']);
  });

  it('resolves "kent" to single region', () => {
    const keys = resolveRegionKeys('kent');
    expect(keys).toEqual(['GB-KEN']);
  });

  it('resolves "london" to Greater London', () => {
    const keys = resolveRegionKeys('london');
    expect(keys).toEqual(['GB-LDN']);
  });

  it('returns empty array for unknown location', () => {
    const keys = resolveRegionKeys('mars');
    expect(keys).toEqual([]);
  });
});

describe('verifyLocationGeo', () => {
  it('verifies Crawley (West Sussex) as inside Sussex', () => {
    const result = verifyLocationGeo(51.1092, -0.1872, 'sussex', false);
    expect(result.status).toBe('VERIFIED_GEO');
    expect(result.method).toBe('geo_bbox');
    expect(result.regionKey).toBe('GB-WSX');
    expect(result.confidence).toBe('high');
  });

  it('verifies Burgess Hill (West Sussex) as inside Sussex', () => {
    const result = verifyLocationGeo(50.9535, -0.1283, 'sussex', false);
    expect(result.status).toBe('VERIFIED_GEO');
    expect(result.method).toBe('geo_bbox');
  });

  it('verifies Haywards Heath (West Sussex) as inside Sussex', () => {
    const result = verifyLocationGeo(51.0048, -0.1035, 'sussex', false);
    expect(result.status).toBe('VERIFIED_GEO');
  });

  it('verifies Eastbourne (East Sussex) as inside Sussex', () => {
    const result = verifyLocationGeo(50.7684, 0.2905, 'sussex', false);
    expect(result.status).toBe('VERIFIED_GEO');
    expect(result.regionKey).toBe('GB-ESX');
  });

  it('verifies Brighton (East Sussex boundary area) as inside Sussex', () => {
    const result = verifyLocationGeo(50.8225, -0.1372, 'sussex', false);
    expect(result.status).toBe('VERIFIED_GEO');
  });

  it('marks Manchester as OUT_OF_AREA for Sussex', () => {
    const result = verifyLocationGeo(53.4808, -2.2426, 'sussex', false);
    expect(result.status).toBe('OUT_OF_AREA');
    expect(result.method).toBe('geo_bbox');
    expect(result.confidence).toBe('high');
  });

  it('returns UNKNOWN for missing lat/lng with hard constraint', () => {
    const result = verifyLocationGeo(null, null, 'sussex', true);
    expect(result.status).toBe('UNKNOWN');
    expect(result.method).toBe('unknown');
  });

  it('returns SEARCH_BOUNDED for missing lat/lng with soft constraint', () => {
    const result = verifyLocationGeo(null, null, 'sussex', false);
    expect(result.status).toBe('SEARCH_BOUNDED');
    expect(result.method).toBe('search_bounded');
  });

  it('returns SEARCH_BOUNDED for unknown region with soft constraint and lat/lng', () => {
    const result = verifyLocationGeo(51.0, -0.5, 'atlantis', false);
    expect(result.status).toBe('SEARCH_BOUNDED');
  });

  it('returns UNKNOWN for unknown region with hard constraint', () => {
    const result = verifyLocationGeo(51.0, -0.5, 'atlantis', true);
    expect(result.status).toBe('UNKNOWN');
  });

  it('verifies Maidstone (Kent) as inside Kent', () => {
    const result = verifyLocationGeo(51.2721, 0.5290, 'kent', false);
    expect(result.status).toBe('VERIFIED_GEO');
    expect(result.regionKey).toBe('GB-KEN');
  });

  it('marks Maidstone (Kent) as OUT_OF_AREA for Sussex', () => {
    const result = verifyLocationGeo(51.2721, 0.5290, 'sussex', false);
    expect(result.status).toBe('OUT_OF_AREA');
  });

  it('includes lat/lng in evidence', () => {
    const result = verifyLocationGeo(51.1092, -0.1872, 'sussex', false);
    expect(result.lat).toBe(51.1092);
    expect(result.lng).toBe(-0.1872);
  });
});

describe('region data integrity', () => {
  it('East Sussex and West Sussex have non-overlapping major bboxes', () => {
    const esx = getRegion('GB-ESX');
    const wsx = getRegion('GB-WSX');
    expect(esx).toBeDefined();
    expect(wsx).toBeDefined();
    expect(esx!.bbox.west).toBeGreaterThanOrEqual(wsx!.bbox.east);
  });

  it('Sussex composite covers both sub-regions', () => {
    const keys = resolveRegionKeys('sussex');
    expect(keys).toEqual(expect.arrayContaining(['GB-ESX', 'GB-WSX']));
  });
});
