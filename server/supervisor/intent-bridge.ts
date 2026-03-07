import type { CanonicalIntent, CanonicalConstraint } from './canonical-intent';
import type { ParsedGoal, StructuredConstraint, SuccessCriteria } from './goal-to-constraints';
import { inferCountryFromLocation } from './goal-to-constraints';

export interface IntentPreviewFields {
  business_type: string | null;
  location: string | null;
  count: number | null;
  time_filter: string | null;
}

export interface ParsedGoalBridge {
  business_type: string;
  location: string;
  requested_count_user: number | null;
  constraints_hint: Array<{ type: string; raw: string; hardness: string }>;
}

export function canonicalIntentToPreviewFields(intent: CanonicalIntent): IntentPreviewFields {
  const timeConstraint = intent.constraints.find(c => c.type === 'time');
  return {
    business_type: intent.entity_category,
    location: intent.location_text,
    count: intent.requested_count,
    time_filter: timeConstraint?.raw ?? null,
  };
}

export function canonicalIntentToParsedGoalBridge(intent: CanonicalIntent): ParsedGoalBridge {
  return {
    business_type: intent.entity_category ?? '',
    location: intent.location_text ?? '',
    requested_count_user: intent.requested_count,
    constraints_hint: intent.constraints.map(c => ({
      type: c.type,
      raw: c.raw,
      hardness: c.hardness,
    })),
  };
}

function mapCanonicalConstraintType(c: CanonicalConstraint): StructuredConstraint | null {
  switch (c.type) {
    case 'attribute':
      return {
        id: `c_attr_${c.raw.replace(/\s+/g, '_').substring(0, 20)}`,
        type: 'HAS_ATTRIBUTE',
        field: 'attribute',
        operator: 'has',
        value: c.raw,
        hard: c.hardness === 'hard',
        rationale: c.raw,
      };
    case 'rating': {
      const ratingMatch = c.raw.match(/([\d.]+)/);
      return {
        id: 'c_rating',
        type: 'COUNT_MIN',
        field: 'rating',
        operator: '>=',
        value: ratingMatch ? parseFloat(ratingMatch[1]) : c.raw,
        hard: c.hardness === 'hard',
        rationale: c.raw,
      };
    }
    case 'name_filter':
      return {
        id: 'c_name',
        type: 'NAME_CONTAINS',
        field: 'name',
        operator: 'contains',
        value: c.raw,
        hard: c.hardness === 'hard',
        rationale: c.raw,
      };
    case 'time':
    case 'reviews':
    case 'relationship':
    case 'unknown_constraint':
    case 'category':
      return null;
    default:
      return null;
  }
}

export function canonicalIntentToParsedGoal(
  intent: CanonicalIntent,
  originalGoal: string,
): ParsedGoal {
  const businessType = intent.entity_category ?? '';
  const location = intent.location_text ?? '';
  const requestedCountUser = intent.requested_count;
  const searchBudgetCount = requestedCountUser
    ? Math.min(Math.max(30, requestedCountUser * 3), 50)
    : 30;

  const country = location ? inferCountryFromLocation(location) : 'UK';

  const constraints: StructuredConstraint[] = [];

  if (requestedCountUser !== null && requestedCountUser > 0) {
    constraints.push({
      id: 'c_count',
      type: 'COUNT_MIN',
      field: 'count',
      operator: '>=',
      value: requestedCountUser,
      hard: true,
      rationale: `User requested ${requestedCountUser} results`,
    });
  }

  if (location) {
    if (intent.geo_mode === 'radius') {
      constraints.push({
        id: 'c_location',
        type: 'LOCATION_NEAR',
        field: 'location',
        operator: 'within_km',
        value: { center: location, km: intent.radius_km ?? 10 },
        hard: false,
        rationale: `Near ${location}`,
      });
    } else {
      constraints.push({
        id: 'c_location',
        type: 'LOCATION_EQUALS',
        field: 'location',
        operator: '=',
        value: location,
        hard: false,
        rationale: `Location: ${location}`,
      });
    }
  }

  let attributeFilter: string | null = null;
  let nameFilter: string | null = null;
  let prefixFilter: string | null = null;

  for (const c of intent.constraints) {
    const mapped = mapCanonicalConstraintType(c);
    if (mapped) {
      constraints.push(mapped);
      if (mapped.type === 'HAS_ATTRIBUTE' && !attributeFilter) {
        attributeFilter = c.raw;
      }
      if (mapped.type === 'NAME_CONTAINS' && !nameFilter) {
        nameFilter = typeof mapped.value === 'string' ? mapped.value : null;
      }
      if (mapped.type === 'NAME_STARTS_WITH' && !prefixFilter) {
        prefixFilter = typeof mapped.value === 'string' ? mapped.value : null;
      }
    }
  }

  const requiredConstraintIds = constraints.filter(c => c.hard).map(c => c.id);
  const optionalConstraintIds = constraints.filter(c => !c.hard).map(c => c.id);

  const successCriteria: SuccessCriteria = {
    required_constraints: requiredConstraintIds,
    optional_constraints: optionalConstraintIds,
    target_count: requestedCountUser,
  };

  return {
    original_goal: originalGoal,
    requested_count_user: requestedCountUser,
    search_budget_count: searchBudgetCount,
    business_type: businessType,
    location,
    country,
    prefix_filter: prefixFilter,
    name_filter: nameFilter,
    attribute_filter: attributeFilter,
    tool_preference: null,
    include_email: false,
    include_phone: false,
    include_website: false,
    constraints,
    success_criteria: successCriteria,
  };
}

export function buildConversationContextString(
  messages: Array<{ role: string; content: string }>,
  maxTurns: number = 6,
): string {
  const recent = messages.slice(-maxTurns);
  return recent
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 500)}`)
    .join('\n');
}
