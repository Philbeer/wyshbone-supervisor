export interface AccumulatedCandidate {
  place_id?: string;
  name: string;
  address?: string;
  phone?: string | null;
  website?: string | null;
  source?: string;
  lat?: number | null;
  lng?: number | null;
  found_in_plan_version: number;
  found_at_radius_km: number;
  dedupe_key: string;
}

export const RADIUS_LADDER_KM = [0, 5, 10, 25, 50, 100];

export function makeDedupeKey(lead: { placeId?: string; place_id?: string; name?: string; address?: string }): string {
  const pid = lead.placeId || lead.place_id;
  if (pid) return `pid:${pid}`;
  const norm = `${(lead.name || '').toLowerCase().trim()}|${(lead.address || '').toLowerCase().trim()}`;
  return `hash:${norm}`;
}

export function mergeCandidate(
  acc: Map<string, AccumulatedCandidate>,
  key: string,
  lead: { name: string; address?: string; phone?: string | null; website?: string | null; placeId?: string; place_id?: string; source?: string; lat?: number | null; lng?: number | null },
  planVersion: number,
  radiusKm?: number,
): boolean {
  if (acc.has(key)) return false;
  acc.set(key, {
    place_id: lead.placeId || lead.place_id,
    name: lead.name,
    address: lead.address,
    phone: lead.phone,
    website: lead.website,
    source: lead.source,
    lat: lead.lat ?? null,
    lng: lead.lng ?? null,
    found_in_plan_version: planVersion,
    found_at_radius_km: radiusKm ?? 0,
    dedupe_key: key,
  });
  return true;
}
