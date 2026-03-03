import { canonicaliseBusinessType } from './learning-layer';
import { inferCountryFromLocation } from './goal-to-constraints';

export interface QueryShapeInput {
  intentClass: 'find_venues' | 'find_leads';
  entityType: string;
  country: string;
  majorConstraintTypes: string[];
}

export function computeQueryShapeKey(input: QueryShapeInput): string {
  const intent = input.intentClass;
  const entity = canonicaliseBusinessType(input.entityType);
  const country = (input.country || 'UK').toUpperCase().trim();
  const constraints = [...input.majorConstraintTypes]
    .map(c => c.toLowerCase().trim())
    .filter(Boolean)
    .sort()
    .join('+');

  const parts = [intent, entity, country];
  if (constraints) parts.push(constraints);
  return parts.join('::');
}

export function deriveQueryShapeFromGoal(parsed: {
  business_type: string;
  location: string;
  country: string;
  attribute_filter?: string | null;
  constraints?: Array<{ type: string; field: string; hard: boolean }>;
  intent_class?: 'find_venues' | 'find_leads';
}): QueryShapeInput {
  const LEAD_ENTITY_TYPES = new Set(['organisations', 'companies', 'businesses', 'firms', 'agencies', 'suppliers', 'vendors', 'contacts', 'leads']);
  const bt = (parsed.business_type || '').toLowerCase().trim();
  const intentClass: 'find_venues' | 'find_leads' = parsed.intent_class
    || (LEAD_ENTITY_TYPES.has(bt) ? 'find_leads' : 'find_venues');

  const entityType = parsed.business_type || 'unknown';

  let country = parsed.country || '';
  if (!country && parsed.location) {
    country = inferCountryFromLocation(parsed.location);
  }
  if (!country) country = 'UK';

  const majorConstraintTypes: string[] = [];
  if (parsed.attribute_filter) {
    majorConstraintTypes.push(`attr:${parsed.attribute_filter.toLowerCase().trim()}`);
  }
  if (parsed.constraints) {
    for (const c of parsed.constraints) {
      if (c.type === 'HAS_ATTRIBUTE' && c.hard) {
        const attrVal = `attr:${String((c as any).value || c.field).toLowerCase().trim()}`;
        if (!majorConstraintTypes.includes(attrVal)) {
          majorConstraintTypes.push(attrVal);
        }
      }
    }
  }

  return { intentClass, entityType, country, majorConstraintTypes };
}
