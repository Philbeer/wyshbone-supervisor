import { describe, it, expect } from 'vitest';
import {
  buildMissionPlan,
  hasRelationshipConstraint,
  hasWebsiteEvidenceConstraint,
  hasDirectFieldConstraint,
  hasRankingConstraint,
  requiresWebSearch,
  requiresWebVisit,
  requiresTowerJudge,
  planRequiresMoreThanDiscovery,
  getConstraintsByExecutionOrder,
  type MissionPlan,
} from './mission-planner';
import type { StructuredMission } from './mission-schema';

function makeMission(overrides: Partial<StructuredMission> = {}): StructuredMission {
  return {
    entity_category: 'pubs',
    location_text: 'Arundel',
    requested_count: null,
    constraints: [],
    mission_mode: 'research_now',
    ...overrides,
  };
}

describe('Stage 2 Mission Planner', () => {

  describe('Test 1: "Find pubs in Arundel with Swan in the name"', () => {
    it('should use SEARCH_PLACES → FILTER_FIELDS (direct name filtering, no website verification)', () => {
      const mission = makeMission({
        entity_category: 'pubs',
        location_text: 'Arundel',
        constraints: [
          { type: 'text_compare', field: 'name', operator: 'contains', value: 'Swan', hardness: 'hard' },
        ],
      });

      const plan = buildMissionPlan(mission);

      expect(plan.strategy).toBe('discovery_then_direct_filter');
      expect(plan.tool_sequence).toEqual(['SEARCH_PLACES', 'FILTER_FIELDS']);
      expect(plan.rules_fired).toContain('RULE_DIRECT_FIELD_CHECK');
      expect(plan.tool_sequence).not.toContain('WEB_VISIT');
      expect(plan.tool_sequence).not.toContain('WEB_SEARCH');

      expect(plan.constraint_mappings).toHaveLength(1);
      expect(plan.constraint_mappings[0].constraint_type).toBe('text_compare');
      expect(plan.constraint_mappings[0].verification_method).toBe('field_match');
    });
  });

  describe('Test 2: "Find pubs in Arundel that mention live music on their website"', () => {
    it('should use SEARCH_PLACES → WEB_VISIT → EVIDENCE_EXTRACT → TOWER_JUDGE', () => {
      const mission = makeMission({
        entity_category: 'pubs',
        location_text: 'Arundel',
        constraints: [
          { type: 'website_evidence', field: 'website_text', operator: 'mentions', value: 'live music', hardness: 'hard' },
        ],
      });

      const plan = buildMissionPlan(mission);

      expect(plan.strategy).toBe('discovery_then_website_evidence');
      expect(plan.tool_sequence).toEqual(['SEARCH_PLACES', 'WEB_VISIT', 'EVIDENCE_EXTRACT', 'TOWER_JUDGE']);
      expect(plan.rules_fired).toContain('RULE_WEBSITE_EVIDENCE');
      expect(plan.constraint_mappings[0].verification_method).toBe('website_content_scan');
    });
  });

  describe('Test 3: "Find organisations that work with the local authority in Blackpool"', () => {
    it('should use SEARCH_PLACES → WEB_SEARCH → WEB_VISIT → EVIDENCE_EXTRACT → TOWER_JUDGE', () => {
      const mission = makeMission({
        entity_category: 'organisations',
        location_text: 'Blackpool',
        constraints: [
          { type: 'relationship_check', field: 'partnership', operator: 'partners_with', value: 'local authority', hardness: 'hard' },
        ],
      });

      const plan = buildMissionPlan(mission);

      expect(plan.strategy).toBe('discovery_then_external_evidence');
      expect(plan.tool_sequence).toEqual(['SEARCH_PLACES', 'WEB_SEARCH', 'WEB_VISIT', 'EVIDENCE_EXTRACT', 'TOWER_JUDGE']);
      expect(plan.rules_fired).toContain('RULE_RELATIONSHIP_EXTERNAL');
      expect(plan.constraint_mappings[0].verification_method).toBe('external_evidence_search');

      expect(plan.strategy).not.toBe('discovery_only');
      expect(plan.tool_sequence.length).toBeGreaterThan(1);
    });

    it('relationship_check must NEVER compile to discovery-only', () => {
      const mission = makeMission({
        entity_category: 'organisations',
        location_text: 'Blackpool',
        constraints: [
          { type: 'relationship_check', field: 'supplier', operator: 'serves', value: 'pubs', hardness: 'soft' },
        ],
      });

      const plan = buildMissionPlan(mission);

      expect(plan.strategy).not.toBe('discovery_only');
      expect(plan.tool_sequence).toContain('WEB_SEARCH');
      expect(plan.tool_sequence).toContain('WEB_VISIT');
      expect(plan.tool_sequence).toContain('EVIDENCE_EXTRACT');
      expect(plan.tool_sequence).toContain('TOWER_JUDGE');
      expect(hasRelationshipConstraint(plan)).toBe(true);
    });
  });

  describe('Test 4: "Find the best dentists in Brighton"', () => {
    it('should use SEARCH_PLACES → RANK_SCORE (no website or relationship path)', () => {
      const mission = makeMission({
        entity_category: 'dentists',
        location_text: 'Brighton',
        constraints: [
          { type: 'ranking', field: 'rating', operator: 'best', value: null, hardness: 'soft' },
        ],
      });

      const plan = buildMissionPlan(mission);

      expect(plan.strategy).toBe('discovery_then_rank');
      expect(plan.tool_sequence).toEqual(['SEARCH_PLACES', 'RANK_SCORE']);
      expect(plan.rules_fired).toContain('RULE_RANKING');
      expect(plan.tool_sequence).not.toContain('WEB_VISIT');
      expect(plan.tool_sequence).not.toContain('WEB_SEARCH');
      expect(plan.tool_sequence).not.toContain('EVIDENCE_EXTRACT');
    });
  });

  describe('Discovery-only (no actionable constraints)', () => {
    it('should produce discovery-only plan when no constraints present', () => {
      const mission = makeMission({
        entity_category: 'dentists',
        location_text: 'Brighton',
        constraints: [],
      });

      const plan = buildMissionPlan(mission);

      expect(plan.strategy).toBe('discovery_only');
      expect(plan.tool_sequence).toEqual(['SEARCH_PLACES']);
      expect(plan.rules_fired).toContain('RULE_DISCOVERY');
    });

    it('should produce discovery-only when only location/entity constraints', () => {
      const mission = makeMission({
        constraints: [
          { type: 'entity_discovery', field: 'type', operator: 'equals', value: 'pubs', hardness: 'hard' },
          { type: 'location_constraint', field: 'location', operator: 'equals', value: 'Arundel', hardness: 'hard' },
        ],
      });

      const plan = buildMissionPlan(mission);

      expect(plan.strategy).toBe('discovery_only');
      expect(plan.tool_sequence).toEqual(['SEARCH_PLACES']);
    });
  });

  describe('Multiple constraints (composite)', () => {
    it('should combine direct filter + website evidence with cheapest first', () => {
      const mission = makeMission({
        constraints: [
          { type: 'text_compare', field: 'name', operator: 'contains', value: 'Swan', hardness: 'hard' },
          { type: 'website_evidence', field: 'website_text', operator: 'mentions', value: 'live music', hardness: 'soft' },
        ],
      });

      const plan = buildMissionPlan(mission);

      expect(plan.tool_sequence).toContain('SEARCH_PLACES');
      expect(plan.tool_sequence).toContain('FILTER_FIELDS');
      expect(plan.tool_sequence).toContain('WEB_VISIT');
      expect(plan.tool_sequence).toContain('EVIDENCE_EXTRACT');
      expect(plan.tool_sequence).toContain('TOWER_JUDGE');

      expect(plan.rules_fired).toContain('RULE_DIRECT_FIELD_CHECK');
      expect(plan.rules_fired).toContain('RULE_WEBSITE_EVIDENCE');

      const filterIndex = plan.tool_sequence.indexOf('FILTER_FIELDS');
      const webVisitIndex = plan.tool_sequence.indexOf('WEB_VISIT');
      expect(filterIndex).toBeLessThan(webVisitIndex);
    });

    it('should order constraints by cost (direct < website < external)', () => {
      const mission = makeMission({
        constraints: [
          { type: 'relationship_check', field: 'partner', operator: 'partners_with', value: 'NHS', hardness: 'hard' },
          { type: 'text_compare', field: 'name', operator: 'contains', value: 'Dental', hardness: 'soft' },
          { type: 'website_evidence', field: 'website_text', operator: 'mentions', value: 'private dentistry', hardness: 'soft' },
        ],
      });

      const plan = buildMissionPlan(mission);

      const ordered = getConstraintsByExecutionOrder(plan);
      expect(ordered[0].constraint_type).toBe('text_compare');
      expect(ordered[1].constraint_type).toBe('website_evidence');
      expect(ordered[2].constraint_type).toBe('relationship_check');
    });
  });

  describe('Helper functions', () => {
    it('hasRelationshipConstraint', () => {
      const plan = buildMissionPlan(makeMission({
        constraints: [
          { type: 'relationship_check', field: 'partner', operator: 'partners_with', value: 'council', hardness: 'hard' },
        ],
      }));
      expect(hasRelationshipConstraint(plan)).toBe(true);

      const plan2 = buildMissionPlan(makeMission());
      expect(hasRelationshipConstraint(plan2)).toBe(false);
    });

    it('hasWebsiteEvidenceConstraint', () => {
      const plan = buildMissionPlan(makeMission({
        constraints: [
          { type: 'website_evidence', field: 'website_text', operator: 'mentions', value: 'vegan', hardness: 'soft' },
        ],
      }));
      expect(hasWebsiteEvidenceConstraint(plan)).toBe(true);
    });

    it('hasDirectFieldConstraint', () => {
      const plan = buildMissionPlan(makeMission({
        constraints: [
          { type: 'text_compare', field: 'name', operator: 'contains', value: 'Swan', hardness: 'hard' },
        ],
      }));
      expect(hasDirectFieldConstraint(plan)).toBe(true);
    });

    it('hasRankingConstraint', () => {
      const plan = buildMissionPlan(makeMission({
        constraints: [
          { type: 'ranking', field: 'rating', operator: 'best', value: null, hardness: 'soft' },
        ],
      }));
      expect(hasRankingConstraint(plan)).toBe(true);
    });

    it('requiresWebSearch only for relationship/external constraints', () => {
      const relPlan = buildMissionPlan(makeMission({
        constraints: [
          { type: 'relationship_check', field: 'partner', operator: 'partners_with', value: 'council', hardness: 'hard' },
        ],
      }));
      expect(requiresWebSearch(relPlan)).toBe(true);

      const textPlan = buildMissionPlan(makeMission({
        constraints: [
          { type: 'text_compare', field: 'name', operator: 'contains', value: 'Swan', hardness: 'hard' },
        ],
      }));
      expect(requiresWebSearch(textPlan)).toBe(false);
    });

    it('planRequiresMoreThanDiscovery', () => {
      const discoveryOnly = buildMissionPlan(makeMission());
      expect(planRequiresMoreThanDiscovery(discoveryOnly)).toBe(false);

      const withConstraint = buildMissionPlan(makeMission({
        constraints: [
          { type: 'text_compare', field: 'name', operator: 'contains', value: 'Swan', hardness: 'hard' },
        ],
      }));
      expect(planRequiresMoreThanDiscovery(withConstraint)).toBe(true);
    });
  });

  describe('Plan artefact structure', () => {
    it('should always include canonical_input', () => {
      const plan = buildMissionPlan(makeMission({
        constraints: [
          { type: 'text_compare', field: 'name', operator: 'contains', value: 'Swan', hardness: 'hard' },
        ],
      }));

      expect(plan.canonical_input.entity_category).toBe('pubs');
      expect(plan.canonical_input.location_text).toBe('Arundel');
      expect(plan.canonical_input.constraints).toHaveLength(1);
      expect(plan.canonical_input.constraints[0].type).toBe('text_compare');
    });

    it('should always include selection_reason', () => {
      const plan = buildMissionPlan(makeMission({
        constraints: [
          { type: 'relationship_check', field: 'partner', operator: 'partners_with', value: 'local authority', hardness: 'hard' },
        ],
      }));

      expect(plan.selection_reason).toContain('RULE_RELATIONSHIP_EXTERNAL');
      expect(plan.selection_reason).toContain('relationship_check');
      expect(plan.selection_reason).toContain('never discovery-only');
    });

    it('should produce expected_artefacts matching strategy', () => {
      const plan = buildMissionPlan(makeMission({
        constraints: [
          { type: 'website_evidence', field: 'website_text', operator: 'mentions', value: 'live music', hardness: 'hard' },
        ],
      }));

      expect(plan.expected_artefacts).toContain('search_results');
      expect(plan.expected_artefacts).toContain('web_visit_pages');
      expect(plan.expected_artefacts).toContain('attribute_evidence');
      expect(plan.expected_artefacts).toContain('tower_semantic_judgement');
    });
  });

  describe('Attribute check routes to website evidence', () => {
    it('attribute_check should route through website evidence path', () => {
      const mission = makeMission({
        constraints: [
          { type: 'attribute_check', field: 'amenity', operator: 'has', value: 'beer_garden', hardness: 'soft' },
        ],
      });

      const plan = buildMissionPlan(mission);

      expect(plan.strategy).toBe('discovery_then_website_evidence');
      expect(plan.tool_sequence).toContain('WEB_VISIT');
      expect(plan.tool_sequence).toContain('EVIDENCE_EXTRACT');
    });
  });

  describe('Status check routes to website evidence', () => {
    it('status_check should route through website evidence path', () => {
      const mission = makeMission({
        constraints: [
          { type: 'status_check', field: 'service', operator: 'has', value: 'accepting new patients', hardness: 'hard' },
        ],
      });

      const plan = buildMissionPlan(mission);

      expect(plan.strategy).toBe('discovery_then_website_evidence');
      expect(plan.tool_sequence).toContain('WEB_VISIT');
      expect(requiresTowerJudge(plan)).toBe(true);
    });
  });
});
