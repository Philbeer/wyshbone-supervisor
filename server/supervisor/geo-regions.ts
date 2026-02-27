export interface BBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface RegionDefinition {
  key: string;
  name: string;
  bbox: BBox;
  aliases: string[];
}

export interface CompositeRegion {
  key: string;
  name: string;
  children: string[];
  aliases: string[];
}

const REGIONS: Record<string, RegionDefinition> = {
  'GB-ESX': {
    key: 'GB-ESX',
    name: 'East Sussex',
    bbox: { north: 51.20, south: 50.73, east: 0.35, west: -0.09 },
    aliases: ['east sussex'],
  },
  'GB-WSX': {
    key: 'GB-WSX',
    name: 'West Sussex',
    bbox: { north: 51.18, south: 50.72, east: -0.09, west: -0.96 },
    aliases: ['west sussex'],
  },
  'GB-KEN': {
    key: 'GB-KEN',
    name: 'Kent',
    bbox: { north: 51.50, south: 50.90, east: 1.45, west: 0.00 },
    aliases: ['kent'],
  },
  'GB-SRY': {
    key: 'GB-SRY',
    name: 'Surrey',
    bbox: { north: 51.45, south: 51.10, east: 0.10, west: -0.85 },
    aliases: ['surrey'],
  },
  'GB-HAM': {
    key: 'GB-HAM',
    name: 'Hampshire',
    bbox: { north: 51.40, south: 50.72, east: -0.72, west: -1.95 },
    aliases: ['hampshire', 'hants'],
  },
  'GB-LDN': {
    key: 'GB-LDN',
    name: 'Greater London',
    bbox: { north: 51.69, south: 51.28, east: 0.34, west: -0.51 },
    aliases: ['london', 'greater london'],
  },
  'GB-DOR': {
    key: 'GB-DOR',
    name: 'Dorset',
    bbox: { north: 51.08, south: 50.51, east: -1.69, west: -2.96 },
    aliases: ['dorset'],
  },
  'GB-DEV': {
    key: 'GB-DEV',
    name: 'Devon',
    bbox: { north: 51.25, south: 50.20, east: -2.90, west: -4.68 },
    aliases: ['devon'],
  },
  'GB-SOM': {
    key: 'GB-SOM',
    name: 'Somerset',
    bbox: { north: 51.30, south: 50.88, east: -2.34, west: -3.84 },
    aliases: ['somerset'],
  },
  'GB-WIL': {
    key: 'GB-WIL',
    name: 'Wiltshire',
    bbox: { north: 51.68, south: 51.05, east: -1.50, west: -2.37 },
    aliases: ['wiltshire', 'wilts'],
  },
  'GB-OXF': {
    key: 'GB-OXF',
    name: 'Oxfordshire',
    bbox: { north: 52.11, south: 51.45, east: -0.87, west: -1.69 },
    aliases: ['oxfordshire', 'oxon'],
  },
  'GB-BKM': {
    key: 'GB-BKM',
    name: 'Buckinghamshire',
    bbox: { north: 52.07, south: 51.49, east: -0.47, west: -1.17 },
    aliases: ['buckinghamshire', 'bucks'],
  },
  'GB-BRK': {
    key: 'GB-BRK',
    name: 'Berkshire',
    bbox: { north: 51.62, south: 51.32, east: -0.55, west: -1.63 },
    aliases: ['berkshire', 'berks'],
  },
  'GB-ESS': {
    key: 'GB-ESS',
    name: 'Essex',
    bbox: { north: 52.08, south: 51.40, east: 1.11, west: 0.00 },
    aliases: ['essex'],
  },
  'GB-HRT': {
    key: 'GB-HRT',
    name: 'Hertfordshire',
    bbox: { north: 52.08, south: 51.60, east: 0.20, west: -0.65 },
    aliases: ['hertfordshire', 'herts'],
  },
  'GB-NFK': {
    key: 'GB-NFK',
    name: 'Norfolk',
    bbox: { north: 52.97, south: 52.33, east: 1.77, west: 0.30 },
    aliases: ['norfolk'],
  },
  'GB-SFK': {
    key: 'GB-SFK',
    name: 'Suffolk',
    bbox: { north: 52.50, south: 51.93, east: 1.77, west: 0.35 },
    aliases: ['suffolk'],
  },
  'GB-CAM': {
    key: 'GB-CAM',
    name: 'Cambridgeshire',
    bbox: { north: 52.75, south: 52.03, east: 0.50, west: -0.50 },
    aliases: ['cambridgeshire', 'cambs'],
  },
  'GB-LAN': {
    key: 'GB-LAN',
    name: 'Lancashire',
    bbox: { north: 54.23, south: 53.56, east: -2.05, west: -3.06 },
    aliases: ['lancashire', 'lancs'],
  },
  'GB-YKS': {
    key: 'GB-YKS',
    name: 'Yorkshire',
    bbox: { north: 54.50, south: 53.30, east: -0.08, west: -2.56 },
    aliases: ['yorkshire', 'yorks'],
  },
  'GB-MAN': {
    key: 'GB-MAN',
    name: 'Greater Manchester',
    bbox: { north: 53.69, south: 53.35, east: -1.91, west: -2.69 },
    aliases: ['manchester', 'greater manchester'],
  },
  'GB-MER': {
    key: 'GB-MER',
    name: 'Merseyside',
    bbox: { north: 53.55, south: 53.30, east: -2.65, west: -3.19 },
    aliases: ['merseyside', 'liverpool'],
  },
  'GB-WMD': {
    key: 'GB-WMD',
    name: 'West Midlands',
    bbox: { north: 52.62, south: 52.38, east: -1.63, west: -2.18 },
    aliases: ['west midlands', 'birmingham'],
  },
  'GB-GLS': {
    key: 'GB-GLS',
    name: 'Gloucestershire',
    bbox: { north: 52.12, south: 51.55, east: -1.58, west: -2.68 },
    aliases: ['gloucestershire', 'glos'],
  },
  'GB-COR': {
    key: 'GB-COR',
    name: 'Cornwall',
    bbox: { north: 50.93, south: 49.96, east: -4.15, west: -5.72 },
    aliases: ['cornwall'],
  },
};

const COMPOSITES: Record<string, CompositeRegion> = {
  'GB-SUSSEX': {
    key: 'GB-SUSSEX',
    name: 'Sussex',
    children: ['GB-ESX', 'GB-WSX'],
    aliases: ['sussex'],
  },
};

const aliasIndex = new Map<string, string>();

function buildAliasIndex(): void {
  if (aliasIndex.size > 0) return;
  for (const [key, region] of Object.entries(REGIONS)) {
    aliasIndex.set(region.name.toLowerCase(), key);
    for (const alias of region.aliases) {
      aliasIndex.set(alias.toLowerCase(), key);
    }
  }
  for (const [key, composite] of Object.entries(COMPOSITES)) {
    aliasIndex.set(composite.name.toLowerCase(), key);
    for (const alias of composite.aliases) {
      aliasIndex.set(alias.toLowerCase(), key);
    }
  }
}

export function resolveRegionKeys(locationName: string): string[] {
  buildAliasIndex();
  const lower = locationName.toLowerCase().trim();

  const directKey = aliasIndex.get(lower);
  if (directKey) {
    const composite = COMPOSITES[directKey];
    if (composite) {
      return composite.children;
    }
    return [directKey];
  }

  const entries = Array.from(aliasIndex.entries());
  for (const [alias, key] of entries) {
    if (lower.includes(alias) || alias.includes(lower)) {
      const composite = COMPOSITES[key];
      if (composite) return composite.children;
      return [key];
    }
  }

  return [];
}

export function getRegion(key: string): RegionDefinition | undefined {
  return REGIONS[key];
}

export function getComposite(key: string): CompositeRegion | undefined {
  return COMPOSITES[key];
}

export type GeoVerificationMethod = 'geo_bbox' | 'search_bounded' | 'unknown';

export interface GeoVerificationResult {
  status: 'VERIFIED_GEO' | 'OUT_OF_AREA' | 'SEARCH_BOUNDED' | 'UNKNOWN';
  method: GeoVerificationMethod;
  regionKey: string | null;
  regionName: string | null;
  lat: number | null;
  lng: number | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export function pointInBBox(lat: number, lng: number, bbox: BBox): boolean {
  return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
}

export function verifyLocationGeo(
  lat: number | null | undefined,
  lng: number | null | undefined,
  locationName: string,
  isHardConstraint: boolean,
): GeoVerificationResult {
  const regionKeys = resolveRegionKeys(locationName);

  if (regionKeys.length === 0) {
    if (lat != null && lng != null) {
      return {
        status: isHardConstraint ? 'UNKNOWN' : 'SEARCH_BOUNDED',
        method: isHardConstraint ? 'unknown' : 'search_bounded',
        regionKey: null,
        regionName: null,
        lat: lat ?? null,
        lng: lng ?? null,
        confidence: 'low',
        reason: `No region boundary data for "${locationName}"; ${isHardConstraint ? 'cannot geo-verify (hard constraint)' : 'search was bounded to this region (soft constraint)'}`,
      };
    }
    return {
      status: isHardConstraint ? 'UNKNOWN' : 'SEARCH_BOUNDED',
      method: isHardConstraint ? 'unknown' : 'search_bounded',
      regionKey: null,
      regionName: null,
      lat: null,
      lng: null,
      confidence: 'low',
      reason: `No region boundary data for "${locationName}" and no lat/lng available`,
    };
  }

  if (lat == null || lng == null) {
    return {
      status: isHardConstraint ? 'UNKNOWN' : 'SEARCH_BOUNDED',
      method: isHardConstraint ? 'unknown' : 'search_bounded',
      regionKey: regionKeys[0],
      regionName: getRegion(regionKeys[0])?.name ?? null,
      lat: null,
      lng: null,
      confidence: 'low',
      reason: `Lead missing lat/lng; ${isHardConstraint ? 'cannot geo-verify (hard constraint)' : 'search was bounded to region (soft constraint)'}`,
    };
  }

  for (const key of regionKeys) {
    const region = getRegion(key);
    if (!region) continue;
    if (pointInBBox(lat, lng, region.bbox)) {
      return {
        status: 'VERIFIED_GEO',
        method: 'geo_bbox',
        regionKey: key,
        regionName: region.name,
        lat,
        lng,
        confidence: 'high',
        reason: `Lead at (${lat.toFixed(4)}, ${lng.toFixed(4)}) is within ${region.name} bounding box`,
      };
    }
  }

  const regionNames = regionKeys.map(k => getRegion(k)?.name ?? k).join(' / ');
  return {
    status: 'OUT_OF_AREA',
    method: 'geo_bbox',
    regionKey: regionKeys[0],
    regionName: regionNames,
    lat,
    lng,
    confidence: 'high',
    reason: `Lead at (${lat.toFixed(4)}, ${lng.toFixed(4)}) is outside ${regionNames} bounding box(es)`,
  };
}

export function getAllRegionKeys(): string[] {
  return Object.keys(REGIONS);
}

export function getAllCompositeKeys(): string[] {
  return Object.keys(COMPOSITES);
}
