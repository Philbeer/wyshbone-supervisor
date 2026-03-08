import type { StructuredMission, MissionConstraint, MissionConstraintType } from './mission-schema';
import { createArtefact } from './artefacts';

export type MissionToolStep =
  | 'SEARCH_PLACES'
  | 'FILTER_FIELDS'
  | 'WEB_VISIT'
  | 'WEB_SEARCH'
  | 'EVIDENCE_EXTRACT'
  | 'TOWER_JUDGE'
  | 'RANK_SCORE';

export type PlannerRuleId =
  | 'RULE_DISCOVERY'
  | 'RULE_DIRECT_FIELD_CHECK'
  | 'RULE_WEBSITE_EVIDENCE'
  | 'RULE_RELATIONSHIP_EXTERNAL'
  | 'RULE_RANKING';

export type PlanStrategyId =
  | 'discovery_only'
  | 'discovery_then_direct_filter'
  | 'discovery_then_website_evidence'
  | 'discovery_then_external_evidence'
  | 'discovery_then_rank'
  | 'composite';

export type VerificationMethod =
  | 'field_match'
  | 'website_content_scan'
  | 'external_evidence_search'
  | 'ranking_sort'
  | 'none';

export interface MissionPlanStep {
  order: number;
  tool: MissionToolStep;
  purpose: string;
  driven_by_constraint_indices: number[];
}

export interface ConstraintPlanMapping {
  constraint_index: number;
  constraint_type: MissionConstraintType;
  constraint_field: string;
  constraint_value: unknown;
  constraint_hardness: string;
  rule_fired: PlannerRuleId;
  strategy: PlanStrategyId;
  required_tools: MissionToolStep[];
  verification_method: VerificationMethod;
}

export interface MissionPlan {
  strategy: PlanStrategyId;
  tool_sequence: MissionToolStep[];
  steps: MissionPlanStep[];
  rules_fired: PlannerRuleId[];
  constraint_mappings: ConstraintPlanMapping[];
  verification_methods: VerificationMethod[];
  expected_artefacts: string[];
  selection_reason: string;
  canonical_input: {
    entity_category: string;
    location_text: string | null;
    mission_mode: string;
    constraints: Array<{
      index: number;
      type: MissionConstraintType;
      field: string;
      operator: string;
      value: unknown;
      hardness: string;
    }>;
  };
}

const CONSTRAINT_TYPE_TO_RULE: Record<MissionConstraintType, PlannerRuleId> = {
  entity_discovery: 'RULE_DISCOVERY',
  location_constraint: 'RULE_DISCOVERY',
  text_compare: 'RULE_DIRECT_FIELD_CHECK',
  attribute_check: 'RULE_WEBSITE_EVIDENCE',
  status_check: 'RULE_WEBSITE_EVIDENCE',
  website_evidence: 'RULE_WEBSITE_EVIDENCE',
  relationship_check: 'RULE_RELATIONSHIP_EXTERNAL',
  numeric_range: 'RULE_DIRECT_FIELD_CHECK',
  time_constraint: 'RULE_WEBSITE_EVIDENCE',
  contact_extraction: 'RULE_DISCOVERY',
  ranking: 'RULE_RANKING',
};

const CONSTRAINT_TYPE_TO_STRATEGY: Record<MissionConstraintType, PlanStrategyId> = {
  entity_discovery: 'discovery_only',
  location_constraint: 'discovery_only',
  text_compare: 'discovery_then_direct_filter',
  attribute_check: 'discovery_then_website_evidence',
  status_check: 'discovery_then_website_evidence',
  website_evidence: 'discovery_then_website_evidence',
  relationship_check: 'discovery_then_external_evidence',
  numeric_range: 'discovery_then_direct_filter',
  time_constraint: 'discovery_then_website_evidence',
  contact_extraction: 'discovery_only',
  ranking: 'discovery_then_rank',
};

const STRATEGY_TOOLS: Record<PlanStrategyId, MissionToolStep[]> = {
  discovery_only: ['SEARCH_PLACES'],
  discovery_then_direct_filter: ['SEARCH_PLACES', 'FILTER_FIELDS'],
  discovery_then_website_evidence: ['SEARCH_PLACES', 'WEB_VISIT', 'EVIDENCE_EXTRACT', 'TOWER_JUDGE'],
  discovery_then_external_evidence: ['SEARCH_PLACES', 'WEB_SEARCH', 'WEB_VISIT', 'EVIDENCE_EXTRACT', 'TOWER_JUDGE'],
  discovery_then_rank: ['SEARCH_PLACES', 'RANK_SCORE'],
  composite: [],
};

const STRATEGY_VERIFICATION: Record<PlanStrategyId, VerificationMethod> = {
  discovery_only: 'none',
  discovery_then_direct_filter: 'field_match',
  discovery_then_website_evidence: 'website_content_scan',
  discovery_then_external_evidence: 'external_evidence_search',
  discovery_then_rank: 'ranking_sort',
  composite: 'none',
};

const STRATEGY_ARTEFACTS: Record<PlanStrategyId, string[]> = {
  discovery_only: ['search_results'],
  discovery_then_direct_filter: ['search_results', 'filtered_candidates'],
  discovery_then_website_evidence: ['search_results', 'web_visit_pages', 'attribute_evidence', 'tower_semantic_judgement'],
  discovery_then_external_evidence: ['search_results', 'web_search_results', 'web_visit_pages', 'attribute_evidence', 'tower_semantic_judgement'],
  discovery_then_rank: ['search_results', 'ranked_candidates'],
  composite: [],
};

const STRATEGY_COST_ORDER: PlanStrategyId[] = [
  'discovery_only',
  'discovery_then_direct_filter',
  'discovery_then_rank',
  'discovery_then_website_evidence',
  'discovery_then_external_evidence',
];

function classifyConstraint(c: MissionConstraint, index: number): ConstraintPlanMapping {
  const rule = CONSTRAINT_TYPE_TO_RULE[c.type] ?? 'RULE_DISCOVERY';
  const strategy = CONSTRAINT_TYPE_TO_STRATEGY[c.type] ?? 'discovery_only';
  const requiredTools = STRATEGY_TOOLS[strategy];
  const verificationMethod = STRATEGY_VERIFICATION[strategy];

  return {
    constraint_index: index,
    constraint_type: c.type,
    constraint_field: c.field,
    constraint_value: c.value,
    constraint_hardness: c.hardness,
    rule_fired: rule,
    strategy,
    required_tools: requiredTools,
    verification_method: verificationMethod,
  };
}

function mergeToolSequences(strategies: PlanStrategyId[]): MissionToolStep[] {
  const orderedPool: MissionToolStep[] = [
    'SEARCH_PLACES',
    'FILTER_FIELDS',
    'RANK_SCORE',
    'WEB_SEARCH',
    'WEB_VISIT',
    'EVIDENCE_EXTRACT',
    'TOWER_JUDGE',
  ];

  const needed = new Set<MissionToolStep>();
  for (const s of strategies) {
    for (const t of STRATEGY_TOOLS[s]) {
      needed.add(t);
    }
  }

  return orderedPool.filter(t => needed.has(t));
}

function determineCompositeStrategy(strategies: PlanStrategyId[]): PlanStrategyId {
  const unique = [...new Set(strategies)];

  if (unique.length === 0) return 'discovery_only';
  if (unique.length === 1) return unique[0];

  const maxIndex = Math.max(...unique.map(s => STRATEGY_COST_ORDER.indexOf(s)));
  if (maxIndex >= 0 && unique.every(s => STRATEGY_COST_ORDER.indexOf(s) <= maxIndex)) {
    return STRATEGY_COST_ORDER[maxIndex];
  }

  return 'composite';
}

function buildSelectionReason(
  mission: StructuredMission,
  mappings: ConstraintPlanMapping[],
  finalStrategy: PlanStrategyId,
): string {
  const parts: string[] = [];

  parts.push(
    `Mission: find "${mission.entity_category}" in "${mission.location_text ?? 'unspecified location'}".`
  );

  if (mappings.length === 0) {
    parts.push('No constraints beyond discovery — discovery-only plan selected.');
    return parts.join(' ');
  }

  const ruleGroups = new Map<PlannerRuleId, ConstraintPlanMapping[]>();
  for (const m of mappings) {
    const group = ruleGroups.get(m.rule_fired) || [];
    group.push(m);
    ruleGroups.set(m.rule_fired, group);
  }

  for (const [rule, group] of ruleGroups) {
    const descriptions = group.map(
      g => `${g.constraint_type}(${g.constraint_field}="${g.constraint_value}")`
    );
    parts.push(`${rule} fired for: ${descriptions.join(', ')}.`);
  }

  parts.push(`Final strategy: ${finalStrategy}.`);

  const hasRelationship = mappings.some(m => m.rule_fired === 'RULE_RELATIONSHIP_EXTERNAL');
  if (hasRelationship) {
    parts.push(
      'relationship_check requires external evidence — plan includes WEB_SEARCH → WEB_VISIT → EVIDENCE_EXTRACT → TOWER_JUDGE (never discovery-only).'
    );
  }

  return parts.join(' ');
}

export function buildMissionPlan(mission: StructuredMission): MissionPlan {
  const canonicalInput: MissionPlan['canonical_input'] = {
    entity_category: mission.entity_category,
    location_text: mission.location_text,
    mission_mode: mission.mission_mode,
    constraints: mission.constraints.map((c, i) => ({
      index: i,
      type: c.type,
      field: c.field,
      operator: c.operator,
      value: c.value,
      hardness: c.hardness,
    })),
  };

  const actionableConstraints = mission.constraints.filter(
    c => c.type !== 'entity_discovery' && c.type !== 'location_constraint' && c.type !== 'contact_extraction'
  );

  const mappings: ConstraintPlanMapping[] = actionableConstraints.map((c, i) => {
    const originalIndex = mission.constraints.indexOf(c);
    return classifyConstraint(c, originalIndex);
  });

  const constraintStrategies = mappings.map(m => m.strategy);

  const finalStrategy = actionableConstraints.length === 0
    ? 'discovery_only'
    : determineCompositeStrategy(constraintStrategies);

  const toolSequence = actionableConstraints.length === 0
    ? ['SEARCH_PLACES' as MissionToolStep]
    : mergeToolSequences(constraintStrategies.length > 0 ? constraintStrategies : ['discovery_only']);

  const steps: MissionPlanStep[] = toolSequence.map((tool, i) => {
    const drivenBy = mappings
      .filter(m => m.required_tools.includes(tool))
      .map(m => m.constraint_index);

    let purpose: string;
    switch (tool) {
      case 'SEARCH_PLACES':
        purpose = `Discover candidate ${mission.entity_category} in ${mission.location_text ?? 'target area'}`;
        break;
      case 'FILTER_FIELDS':
        purpose = 'Apply direct field checks against discovery results (name, rating, etc.)';
        break;
      case 'RANK_SCORE':
        purpose = 'Rank and score candidates based on ranking criteria';
        break;
      case 'WEB_SEARCH':
        purpose = 'Search the web for external evidence of relationships or attributes not present in discovery data';
        break;
      case 'WEB_VISIT':
        purpose = 'Visit candidate websites to extract evidence for constraint verification';
        break;
      case 'EVIDENCE_EXTRACT':
        purpose = 'Extract and structure evidence snippets from visited pages';
        break;
      case 'TOWER_JUDGE':
        purpose = 'Send extracted evidence to Tower for semantic verification';
        break;
      default:
        purpose = tool;
    }

    return {
      order: i + 1,
      tool,
      purpose,
      driven_by_constraint_indices: drivenBy,
    };
  });

  const rulesFired = [...new Set(mappings.map(m => m.rule_fired))];
  if (rulesFired.length === 0) rulesFired.push('RULE_DISCOVERY');

  const verificationMethods = [...new Set(mappings.map(m => m.verification_method))];
  if (verificationMethods.length === 0) verificationMethods.push('none');

  const expectedArtefacts = actionableConstraints.length === 0
    ? ['search_results']
    : [...new Set(constraintStrategies.flatMap(s => STRATEGY_ARTEFACTS[s]))];

  const selectionReason = buildSelectionReason(mission, mappings, finalStrategy);

  return {
    strategy: finalStrategy,
    tool_sequence: toolSequence,
    steps,
    rules_fired: rulesFired,
    constraint_mappings: mappings,
    verification_methods: verificationMethods,
    expected_artefacts: expectedArtefacts,
    selection_reason: selectionReason,
    canonical_input: canonicalInput,
  };
}

export function hasRelationshipConstraint(plan: MissionPlan): boolean {
  return plan.constraint_mappings.some(m => m.constraint_type === 'relationship_check');
}

export function hasWebsiteEvidenceConstraint(plan: MissionPlan): boolean {
  return plan.constraint_mappings.some(
    m => m.constraint_type === 'website_evidence' ||
         m.constraint_type === 'attribute_check' ||
         m.constraint_type === 'status_check'
  );
}

export function hasDirectFieldConstraint(plan: MissionPlan): boolean {
  return plan.constraint_mappings.some(
    m => m.constraint_type === 'text_compare' ||
         m.constraint_type === 'numeric_range'
  );
}

export function hasRankingConstraint(plan: MissionPlan): boolean {
  return plan.constraint_mappings.some(m => m.constraint_type === 'ranking');
}

export function requiresWebSearch(plan: MissionPlan): boolean {
  return plan.tool_sequence.includes('WEB_SEARCH');
}

export function requiresWebVisit(plan: MissionPlan): boolean {
  return plan.tool_sequence.includes('WEB_VISIT');
}

export function requiresTowerJudge(plan: MissionPlan): boolean {
  return plan.tool_sequence.includes('TOWER_JUDGE');
}

export function planRequiresMoreThanDiscovery(plan: MissionPlan): boolean {
  return plan.tool_sequence.length > 1 || plan.strategy !== 'discovery_only';
}

export function getConstraintsByExecutionOrder(plan: MissionPlan): ConstraintPlanMapping[] {
  return [...plan.constraint_mappings].sort((a, b) => {
    const aCost = STRATEGY_COST_ORDER.indexOf(a.strategy);
    const bCost = STRATEGY_COST_ORDER.indexOf(b.strategy);
    return aCost - bCost;
  });
}

export function logMissionPlan(plan: MissionPlan, runId: string): void {
  console.log(`[MISSION_PLANNER] ======= Stage 2 Mission Plan =======`);
  console.log(`[MISSION_PLANNER] runId=${runId}`);
  console.log(`[MISSION_PLANNER] entity="${plan.canonical_input.entity_category}" location="${plan.canonical_input.location_text}" mode="${plan.canonical_input.mission_mode}"`);
  console.log(`[MISSION_PLANNER] strategy=${plan.strategy}`);
  console.log(`[MISSION_PLANNER] tool_sequence=${plan.tool_sequence.join(' → ')}`);
  console.log(`[MISSION_PLANNER] rules_fired=${plan.rules_fired.join(', ')}`);

  for (const step of plan.steps) {
    console.log(`[MISSION_PLANNER]   step ${step.order}: ${step.tool} — ${step.purpose} (driven by constraints: [${step.driven_by_constraint_indices.join(',')}])`);
  }

  for (const mapping of plan.constraint_mappings) {
    console.log(
      `[MISSION_PLANNER]   constraint[${mapping.constraint_index}]: type=${mapping.constraint_type} ` +
      `field="${mapping.constraint_field}" value="${mapping.constraint_value}" ` +
      `→ rule=${mapping.rule_fired} strategy=${mapping.strategy} verification=${mapping.verification_method}`
    );
  }

  console.log(`[MISSION_PLANNER] verification_methods=${plan.verification_methods.join(', ')}`);
  console.log(`[MISSION_PLANNER] expected_artefacts=${plan.expected_artefacts.join(', ')}`);
  console.log(`[MISSION_PLANNER] reason: ${plan.selection_reason}`);

  const hasRelationship = plan.constraint_mappings.some(m => m.constraint_type === 'relationship_check');
  if (hasRelationship) {
    const relStrategy = plan.constraint_mappings.find(m => m.constraint_type === 'relationship_check')?.strategy;
    if (relStrategy === 'discovery_only') {
      console.error(`[MISSION_PLANNER] INVARIANT VIOLATION: relationship_check compiled to discovery_only — this must never happen`);
    } else {
      console.log(`[MISSION_PLANNER] INVARIANT OK: relationship_check → ${relStrategy} (includes external evidence)`);
    }
  }

  console.log(`[MISSION_PLANNER] ====================================`);
}

export async function persistMissionPlan(
  plan: MissionPlan,
  runId: string,
  userId: string,
  conversationId?: string,
): Promise<void> {
  try {
    await createArtefact({
      runId,
      type: 'mission_plan',
      title: `Stage 2 Plan: ${plan.strategy} — ${plan.tool_sequence.join(' → ')}`,
      summary: `strategy=${plan.strategy} tools=${plan.tool_sequence.length} rules=${plan.rules_fired.join(',')} constraints=${plan.constraint_mappings.length} verification=${plan.verification_methods.join(',')}`,
      payload: plan as unknown as Record<string, unknown>,
      userId,
      conversationId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MISSION_PLANNER] Failed to write mission_plan artefact: ${msg}`);
  }
}
