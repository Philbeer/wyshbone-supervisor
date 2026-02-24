import type { StructuredConstraint } from './goal-to-constraints';

const PLACES_SUPPORTED_CATEGORIES = new Set([
  'pub', 'pubs', 'bar', 'bars', 'restaurant', 'restaurants',
  'cafe', 'cafes', 'coffee shop', 'coffee shops',
  'hotel', 'hotels', 'motel', 'motels',
  'gym', 'gyms', 'dentist', 'dentists', 'doctor', 'doctors',
  'pharmacy', 'pharmacies', 'hospital', 'hospitals',
  'brewery', 'breweries', 'winery', 'wineries', 'distillery', 'distilleries',
  'bakery', 'bakeries', 'salon', 'salons', 'spa', 'spas',
  'garage', 'garages', 'mechanic', 'mechanics',
  'plumber', 'plumbers', 'electrician', 'electricians',
  'florist', 'florists', 'butcher', 'butchers',
  'supermarket', 'supermarkets', 'store', 'stores', 'shop', 'shops',
  'nightclub', 'nightclubs', 'club', 'clubs',
  'church', 'churches', 'school', 'schools',
  'veterinarian', 'veterinarians', 'vet', 'vets',
]);

export interface CvlConstraint {
  id: string;
  type: string;
  field: string;
  operator: string;
  value: unknown;
  hard: boolean;
  rationale: string;
}

export interface ConstraintsExtractedPayload {
  mission_type: 'lead_finder';
  original_user_goal: string;
  requested_count_user: number | null;
  constraints: CvlConstraint[];
  extraction_method: 'llm' | 'regex' | 'unknown';
}

export interface CapabilityEntry {
  constraint_id: string;
  constraint_type: string;
  field: string;
  hard: boolean;
  verifiable: boolean;
  verification_method: string | null;
  reason: string;
}

export interface ConstraintCapabilityCheckPayload {
  mission_type: 'lead_finder';
  capabilities: CapabilityEntry[];
  blocking_hard_constraints: string[];
  total_constraints: number;
  verifiable_count: number;
  unverifiable_count: number;
}

export type VerificationStatus = 'yes' | 'no' | 'unknown';
export type VerificationConfidence = 'high' | 'medium' | 'low';

export interface ConstraintCheck {
  constraint_id: string;
  constraint_type: string;
  field: string;
  hard: boolean;
  status: VerificationStatus;
  confidence: VerificationConfidence;
  reason: string;
  evidence_id: string | null;
}

export interface LeadVerificationResult {
  lead_index: number;
  lead_name: string;
  lead_place_id: string;
  constraint_checks: ConstraintCheck[];
  all_hard_satisfied: boolean;
  verified_exact: boolean;
}

export interface VerificationEvidence {
  evidence_id: string;
  constraint_id: string;
  lead_index: number;
  lead_name: string;
  field: string;
  source: string;
  snippet: string;
}

export interface UnverifiableHardConstraint {
  constraint_id: string;
  constraint_type: string;
  value: string;
  reason: string;
  suggested_action: string;
}

export interface VerificationSummaryPayload {
  mission_type: 'lead_finder';
  requested_count_user: number | null;
  candidates_checked: number;
  verified_exact_count: number;
  verified_total_count: number;
  unverifiable_count: number;
  hard_unknown_count: number;
  unverifiable_hard_constraints: UnverifiableHardConstraint[];
  suggested_next_action: string | null;
  constraint_results: Array<{
    constraint_id: string;
    constraint_type: string;
    field: string;
    hard: boolean;
    status: VerificationStatus;
    leads_passing: number;
    leads_failing: number;
    leads_unknown: number;
  }>;
  budget: {
    search_budget_count: number;
    leads_returned: number;
    leads_after_filters: number;
  };
}

export interface CvlVerificationOutput {
  leadVerifications: LeadVerificationResult[];
  evidenceItems: VerificationEvidence[];
  summary: VerificationSummaryPayload;
  verified_exact_count: number;
}

export function buildConstraintsExtractedPayload(
  originalUserGoal: string,
  requestedCountUser: number | null,
  constraints: StructuredConstraint[],
): ConstraintsExtractedPayload {
  return {
    mission_type: 'lead_finder',
    original_user_goal: originalUserGoal,
    requested_count_user: requestedCountUser,
    constraints: constraints.map(c => ({
      id: c.id,
      type: c.type,
      field: c.field,
      operator: c.operator,
      value: c.value,
      hard: c.hard,
      rationale: c.rationale,
    })),
    extraction_method: 'unknown',
  };
}

export function buildCapabilityCheck(
  constraints: StructuredConstraint[],
): ConstraintCapabilityCheckPayload {
  const capabilities: CapabilityEntry[] = [];

  for (const c of constraints) {
    let verifiable = false;
    let verification_method: string | null = null;
    let reason = '';

    switch (c.type) {
      case 'COUNT_MIN':
        verifiable = true;
        verification_method = 'count_check';
        reason = 'Verifiable by counting delivered leads';
        break;

      case 'CATEGORY_EQUALS': {
        const catValue = typeof c.value === 'string' ? c.value.toLowerCase() : '';
        const placesSupported = PLACES_SUPPORTED_CATEGORIES.has(catValue) ||
          PLACES_SUPPORTED_CATEGORIES.has(catValue.replace(/s$/, ''));
        if (placesSupported) {
          verifiable = true;
          verification_method = 'search_query_proxy';
          reason = `Business type "${catValue}" is a Places-supported category; search was executed with this type as the query, so results are inherently this category`;
        } else {
          verifiable = false;
          verification_method = null;
          reason = 'Business type is not a standard Places category; cannot independently verify from lead data';
        }
        break;
      }

      case 'LOCATION_EQUALS':
      case 'LOCATION_NEAR':
        verifiable = true;
        verification_method = 'address_contains';
        reason = 'Verifiable via lead address string comparison (confidence varies)';
        break;

      case 'NAME_STARTS_WITH':
        verifiable = true;
        verification_method = 'name_prefix_check';
        reason = 'Verifiable by checking lead.name starts with prefix';
        break;

      case 'NAME_CONTAINS':
        verifiable = true;
        verification_method = 'name_contains_check';
        reason = 'Verifiable by checking lead.name contains word';
        break;

      case 'MUST_USE_TOOL':
        verifiable = true;
        verification_method = 'tool_source_check';
        reason = 'Verifiable by checking lead.source field';
        break;

      case 'HAS_ATTRIBUTE':
        verifiable = true;
        verification_method = 'website_visit';
        reason = 'Attribute verified via website visit (WEB_VISIT) — keyword scan on official site pages';
        break;

      default:
        verifiable = false;
        verification_method = null;
        reason = 'Unverifiable with current tools';
        break;
    }

    capabilities.push({
      constraint_id: c.id,
      constraint_type: c.type,
      field: c.field,
      hard: c.hard,
      verifiable,
      verification_method,
      reason,
    });
  }

  const blocking_hard_constraints = capabilities
    .filter(cap => cap.hard && !cap.verifiable)
    .map(cap => cap.constraint_id);

  return {
    mission_type: 'lead_finder',
    capabilities,
    blocking_hard_constraints,
    total_constraints: capabilities.length,
    verifiable_count: capabilities.filter(c => c.verifiable).length,
    unverifiable_count: capabilities.filter(c => !c.verifiable).length,
  };
}

export interface VerifiableLead {
  name: string;
  address: string;
  phone: string | null;
  website: string | null;
  placeId: string;
  source: string;
}

export interface AttributeEvidenceEntry {
  verdict: 'yes' | 'no' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  evidenceUrl: string | null;
}

export type AttributeEvidenceMap = Map<string, Map<string, AttributeEvidenceEntry>>;

export function verifyLeads(
  leads: VerifiableLead[],
  constraints: StructuredConstraint[],
  requestedCountUser: number | null,
  searchBudgetCount: number,
  leadsReturnedFromApi: number,
  attributeEvidence?: AttributeEvidenceMap,
): CvlVerificationOutput {
  const leadVerifications: LeadVerificationResult[] = [];
  const evidenceItems: VerificationEvidence[] = [];
  let evidenceCounter = 0;

  const constraintAgg: Map<string, { passing: number; failing: number; unknown: number }> = new Map();
  for (const c of constraints) {
    constraintAgg.set(c.id, { passing: 0, failing: 0, unknown: 0 });
  }

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const checks: ConstraintCheck[] = [];
    let allHardSatisfied = true;

    for (const c of constraints) {
      const check = verifyOneConstraint(lead, c, i, evidenceCounter, evidenceItems, attributeEvidence);
      checks.push(check.result);
      evidenceCounter = check.nextEvidenceCounter;

      const agg = constraintAgg.get(c.id);
      if (agg) {
        if (check.result.status === 'yes') agg.passing++;
        else if (check.result.status === 'no') agg.failing++;
        else agg.unknown++;
      }

      if (c.hard && check.result.status !== 'yes') {
        allHardSatisfied = false;
      }
    }

    leadVerifications.push({
      lead_index: i,
      lead_name: lead.name,
      lead_place_id: lead.placeId,
      constraint_checks: checks,
      all_hard_satisfied: allHardSatisfied,
      verified_exact: allHardSatisfied,
    });
  }

  const verified_exact_count = leadVerifications.filter(lv => lv.verified_exact).length;
  const capCheck = buildCapabilityCheck(constraints);
  const unverifiable_constraints = constraints.filter(c => {
    const entry = capCheck.capabilities.find(cap => cap.constraint_id === c.id);
    return entry ? !entry.verifiable : false;
  });

  const unverifiableHardConstraints: UnverifiableHardConstraint[] = unverifiable_constraints
    .filter(c => c.hard)
    .map(c => {
      const entry = capCheck.capabilities.find(cap => cap.constraint_id === c.id);
      return {
        constraint_id: c.id,
        constraint_type: c.type,
        value: typeof c.value === 'string' ? c.value : String(c.value),
        reason: entry?.reason || 'Cannot be verified with current tools',
        suggested_action: `Verify "${typeof c.value === 'string' ? c.value : c.id}" via venue websites or manual check`,
      };
    });

  const hardUnknownCount = leadVerifications.reduce((count, lv) => {
    const hasHardUnknown = lv.constraint_checks.some(
      cc => cc.hard && cc.status === 'unknown'
    );
    return count + (hasHardUnknown ? 1 : 0);
  }, 0);

  const suggestedNextAction = unverifiableHardConstraints.length > 0
    ? `${unverifiableHardConstraints.length} hard constraint(s) cannot be verified from search data alone: ${unverifiableHardConstraints.map(u => `"${u.value}"`).join(', ')}. Suggested: Verify via venue websites or manual check.`
    : null;

  const constraint_results = constraints.map(c => {
    const agg = constraintAgg.get(c.id) || { passing: 0, failing: 0, unknown: 0 };
    let status: VerificationStatus = 'unknown';
    if (agg.unknown === 0 && agg.failing === 0 && agg.passing > 0) status = 'yes';
    else if (agg.failing > 0) status = 'no';
    else if (agg.unknown > 0 && agg.passing > 0) status = 'unknown';

    return {
      constraint_id: c.id,
      constraint_type: c.type,
      field: c.field,
      hard: c.hard,
      status,
      leads_passing: agg.passing,
      leads_failing: agg.failing,
      leads_unknown: agg.unknown,
    };
  });

  const summary: VerificationSummaryPayload = {
    mission_type: 'lead_finder',
    requested_count_user: requestedCountUser,
    candidates_checked: leads.length,
    verified_exact_count,
    verified_total_count: leads.length,
    unverifiable_count: unverifiable_constraints.length,
    hard_unknown_count: hardUnknownCount,
    unverifiable_hard_constraints: unverifiableHardConstraints,
    suggested_next_action: suggestedNextAction,
    constraint_results,
    budget: {
      search_budget_count: searchBudgetCount,
      leads_returned: leadsReturnedFromApi,
      leads_after_filters: leads.length,
    },
  };

  return {
    leadVerifications,
    evidenceItems,
    summary,
    verified_exact_count,
  };
}

function verifyOneConstraint(
  lead: VerifiableLead,
  constraint: StructuredConstraint,
  leadIndex: number,
  evidenceCounter: number,
  evidenceItems: VerificationEvidence[],
  attributeEvidence?: AttributeEvidenceMap,
): { result: ConstraintCheck; nextEvidenceCounter: number } {
  let status: VerificationStatus = 'unknown';
  let confidence: VerificationConfidence = 'low';
  let reason = '';
  let evidenceId: string | null = null;

  switch (constraint.type) {
    case 'COUNT_MIN': {
      status = 'yes';
      confidence = 'high';
      reason = 'Count constraint checked at summary level, not per-lead';
      break;
    }

    case 'CATEGORY_EQUALS': {
      const catVal = typeof constraint.value === 'string' ? constraint.value.toLowerCase() : '';
      const isPlacesSupported = PLACES_SUPPORTED_CATEGORIES.has(catVal) ||
        PLACES_SUPPORTED_CATEGORIES.has(catVal.replace(/s$/, ''));
      if (isPlacesSupported) {
        status = 'yes';
        confidence = 'high';
        reason = `Business type "${catVal}" is Places-supported; search query guarantees category match`;
      } else {
        status = 'unknown';
        confidence = 'low';
        reason = 'Cannot independently verify business category from lead data; search query used as proxy';
      }
      break;
    }

    case 'LOCATION_EQUALS': {
      const locationValue = typeof constraint.value === 'string' ? constraint.value.toLowerCase() : '';
      if (!locationValue) {
        status = 'unknown';
        confidence = 'low';
        reason = 'No location value to compare';
        break;
      }

      if (lead.address) {
        const addrLower = lead.address.toLowerCase();
        if (addrLower.includes(locationValue)) {
          status = 'yes';
          confidence = 'medium';
          reason = `Address "${lead.address}" contains location "${locationValue}"`;
          evidenceId = `ev_${evidenceCounter++}`;
          evidenceItems.push({
            evidence_id: evidenceId,
            constraint_id: constraint.id,
            lead_index: leadIndex,
            lead_name: lead.name,
            field: 'address',
            source: 'lead_data',
            snippet: lead.address,
          });
        } else {
          status = 'no';
          confidence = 'medium';
          reason = `Address "${lead.address}" does not contain location "${locationValue}"`;
        }
      } else {
        status = 'unknown';
        confidence = 'low';
        reason = 'Lead has no address to verify location against';
      }
      break;
    }

    case 'LOCATION_NEAR': {
      if (lead.address) {
        status = 'unknown';
        confidence = 'low';
        reason = 'Proximity check requires geocoding; address present but distance unverifiable with current tools';
      } else {
        status = 'unknown';
        confidence = 'low';
        reason = 'Lead has no address or geometry for proximity verification';
      }
      break;
    }

    case 'NAME_STARTS_WITH': {
      const prefix = typeof constraint.value === 'string' ? constraint.value.toLowerCase() : '';
      if (!prefix) {
        status = 'unknown';
        confidence = 'low';
        reason = 'No prefix value to check';
        break;
      }

      const nameLower = lead.name.toLowerCase();
      if (nameLower.startsWith(prefix)) {
        status = 'yes';
        confidence = 'high';
        reason = `Name "${lead.name}" starts with "${prefix}"`;
        evidenceId = `ev_${evidenceCounter++}`;
        evidenceItems.push({
          evidence_id: evidenceId,
          constraint_id: constraint.id,
          lead_index: leadIndex,
          lead_name: lead.name,
          field: 'name',
          source: 'lead_data',
          snippet: lead.name,
        });
      } else {
        status = 'no';
        confidence = 'high';
        reason = `Name "${lead.name}" does not start with "${prefix}"`;
      }
      break;
    }

    case 'NAME_CONTAINS': {
      const word = typeof constraint.value === 'string' ? constraint.value.toLowerCase() : '';
      if (!word) {
        status = 'unknown';
        confidence = 'low';
        reason = 'No word value to check';
        break;
      }

      const nameL = lead.name.toLowerCase();
      if (nameL.includes(word)) {
        status = 'yes';
        confidence = 'high';
        reason = `Name "${lead.name}" contains "${word}"`;
        evidenceId = `ev_${evidenceCounter++}`;
        evidenceItems.push({
          evidence_id: evidenceId,
          constraint_id: constraint.id,
          lead_index: leadIndex,
          lead_name: lead.name,
          field: 'name',
          source: 'lead_data',
          snippet: lead.name,
        });
      } else {
        status = 'no';
        confidence = 'high';
        reason = `Name "${lead.name}" does not contain "${word}"`;
      }
      break;
    }

    case 'MUST_USE_TOOL': {
      const requiredTool = typeof constraint.value === 'string' ? constraint.value.toLowerCase() : '';
      if (lead.source === 'google_places' && (requiredTool.includes('google') || requiredTool === 'google_places')) {
        status = 'yes';
        confidence = 'high';
        reason = `Lead sourced from google_places, matching requested tool`;
      } else if (lead.source === 'deterministic_stub') {
        status = 'no';
        confidence = 'high';
        reason = 'Lead sourced from stub data, not from requested tool';
      } else {
        status = 'unknown';
        confidence = 'low';
        reason = `Lead source "${lead.source}" — cannot confirm tool match`;
      }
      break;
    }

    case 'HAS_ATTRIBUTE': {
      const attrValue = typeof constraint.value === 'string' ? constraint.value.toLowerCase() : '';
      const leadEvMap = attributeEvidence?.get(lead.placeId);
      const attrEv = leadEvMap?.get(attrValue);
      if (attrEv) {
        status = attrEv.verdict;
        confidence = attrEv.confidence;
        reason = attrEv.reason;
        if (attrEv.verdict === 'yes' && attrEv.evidenceUrl) {
          evidenceId = `ev_${evidenceCounter++}`;
          evidenceItems.push({
            evidence_id: evidenceId,
            constraint_id: constraint.id,
            lead_index: leadIndex,
            lead_name: lead.name,
            field: 'attribute',
            source: 'website_visit',
            snippet: attrEv.evidenceUrl,
          });
        }
      } else {
        status = 'unknown';
        confidence = 'low';
        reason = `Attribute "${attrValue}" was not checked via website visit`;
      }
      break;
    }

    default: {
      status = 'unknown';
      confidence = 'low';
      reason = `Unverifiable with current tools (constraint type: ${constraint.type})`;
      break;
    }
  }

  return {
    result: {
      constraint_id: constraint.id,
      constraint_type: constraint.type,
      field: constraint.field,
      hard: constraint.hard,
      status,
      confidence,
      reason,
      evidence_id: evidenceId,
    },
    nextEvidenceCounter: evidenceCounter,
  };
}
