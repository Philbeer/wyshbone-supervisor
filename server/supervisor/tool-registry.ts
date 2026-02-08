/**
 * Tool Registry — single source of truth for all tools the planner/executor can use.
 *
 * Each tool has:
 *  - id:          stable machine identifier (e.g. SEARCH_PLACES)
 *  - label:       human-readable name
 *  - description: one-liner used in planner prompts
 *  - enabled:     whether the tool may be selected / executed right now
 *  - paramsSchema: JSON-schema-style description of accepted parameters
 *  - category:    rough grouping (search | enrich | score | evaluate)
 *  - routingRules: optional constraints (e.g. "only for pub queries")
 */

export interface ToolParamSchema {
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
}

export interface ToolRoutingRule {
  field: string;
  operator: 'contains' | 'not_contains' | 'equals' | 'not_equals';
  value: string;
  reason: string;
}

export interface ToolDefinition {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  category: 'search' | 'enrich' | 'score' | 'evaluate' | 'utility';
  paramsSchema: Record<string, ToolParamSchema>;
  routingRules?: ToolRoutingRule[];
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    id: 'SEARCH_PLACES',
    label: 'Google Places Search',
    description: 'Search for businesses using Google Places API. Best for location-based business discovery.',
    enabled: true,
    category: 'search',
    paramsSchema: {
      query: { type: 'string', description: 'Search query (e.g. "pet shops")', required: true },
      location: { type: 'string', description: 'Location / region (e.g. "Kent")', required: true },
      country: { type: 'string', description: 'ISO country code', default: 'GB' },
      maxResults: { type: 'number', description: 'Max results to return', default: 20 },
    },
  },
  {
    id: 'SEARCH_WYSHBONE_DB',
    label: 'Wyshbone Internal Database Search',
    description: 'Search the Wyshbone internal leads database. Only useful for pub/bar/brewery queries when the DB is populated.',
    enabled: false,
    category: 'search',
    paramsSchema: {
      query: { type: 'string', description: 'Search query', required: true },
      location: { type: 'string', description: 'Location / region', required: false },
      limit: { type: 'number', description: 'Max results', default: 50 },
    },
    routingRules: [
      {
        field: 'query',
        operator: 'contains',
        value: 'pub|bar|brewery|tavern|inn|landlord',
        reason: 'SEARCH_WYSHBONE_DB is only suitable for pub/bar/brewery queries',
      },
    ],
  },
  {
    id: 'ENRICH_LEADS',
    label: 'Enrich Leads',
    description: 'Enrich discovered businesses with additional detail (website, phone, category).',
    enabled: true,
    category: 'enrich',
    paramsSchema: {
      query: { type: 'string', description: 'Original search query for context', required: true },
      location: { type: 'string', description: 'Location / region', required: true },
      country: { type: 'string', description: 'ISO country code', default: 'GB' },
      enrichType: { type: 'string', description: 'Enrichment depth', default: 'detail' },
    },
  },
  {
    id: 'SCORE_LEADS',
    label: 'Score Leads',
    description: 'Score and rank leads based on relevance and quality signals.',
    enabled: true,
    category: 'score',
    paramsSchema: {
      query: { type: 'string', description: 'Original search query for scoring context', required: true },
      location: { type: 'string', description: 'Location / region', required: true },
      country: { type: 'string', description: 'ISO country code', default: 'GB' },
      scoreModel: { type: 'string', description: 'Scoring model to use', default: 'basic' },
    },
  },
  {
    id: 'EVALUATE_RESULTS',
    label: 'Evaluate Results',
    description: 'Evaluate the overall quality of a lead generation run (coverage, scoring rate, verdict).',
    enabled: true,
    category: 'evaluate',
    paramsSchema: {
      totalSearched: { type: 'number', description: 'Total businesses searched', required: true },
      totalEnriched: { type: 'number', description: 'Total businesses enriched', required: true },
      totalScored: { type: 'number', description: 'Total businesses scored', required: true },
      goalDescription: { type: 'string', description: 'Goal for evaluation context' },
    },
  },
];

const registry = new Map<string, ToolDefinition>();
for (const tool of TOOL_DEFINITIONS) {
  registry.set(tool.id, tool);
}

export function getToolDefinition(toolId: string): ToolDefinition | undefined {
  return registry.get(toolId);
}

export function getAllTools(): ToolDefinition[] {
  return Array.from(registry.values());
}

export function getEnabledTools(): ToolDefinition[] {
  return getAllTools().filter(t => t.enabled);
}

export function getDisabledTools(): ToolDefinition[] {
  return getAllTools().filter(t => !t.enabled);
}

export function isToolEnabled(toolId: string): boolean {
  const tool = registry.get(toolId);
  return tool ? tool.enabled : false;
}

export function setToolEnabled(toolId: string, enabled: boolean): boolean {
  const tool = registry.get(toolId);
  if (!tool) return false;
  tool.enabled = enabled;
  return true;
}

export function checkRoutingRules(toolId: string, query: string): { allowed: boolean; reason?: string } {
  const tool = registry.get(toolId);
  if (!tool) return { allowed: false, reason: `Tool ${toolId} not found in registry` };
  if (!tool.enabled) return { allowed: false, reason: `Tool ${toolId} is disabled` };
  if (!tool.routingRules || tool.routingRules.length === 0) return { allowed: true };

  for (const rule of tool.routingRules) {
    const fieldValue = query.toLowerCase();
    const pattern = rule.value.toLowerCase();

    let passes = true;
    switch (rule.operator) {
      case 'contains': {
        const keywords = pattern.split('|');
        passes = keywords.some(kw => fieldValue.includes(kw));
        break;
      }
      case 'not_contains': {
        const keywords = pattern.split('|');
        passes = !keywords.some(kw => fieldValue.includes(kw));
        break;
      }
      case 'equals':
        passes = fieldValue === pattern;
        break;
      case 'not_equals':
        passes = fieldValue !== pattern;
        break;
    }

    if (!passes) {
      return { allowed: false, reason: rule.reason };
    }
  }

  return { allowed: true };
}

export function buildToolPromptSection(): string {
  const enabled = getEnabledTools();
  const lines: string[] = ['AVAILABLE TOOLS:'];

  enabled.forEach((tool, idx) => {
    lines.push(`${idx + 1}. ${tool.id} - ${tool.description}`);

    const required = Object.entries(tool.paramsSchema)
      .filter(([, s]) => s.required)
      .map(([name, s]) => `${name} (${s.type})`)
      .join(', ');
    if (required) lines.push(`   Required: ${required}`);

    const optional = Object.entries(tool.paramsSchema)
      .filter(([, s]) => !s.required)
      .map(([name, s]) => `${name} (${s.type}, default: ${JSON.stringify(s.default ?? 'none')})`)
      .join(', ');
    if (optional) lines.push(`   Optional: ${optional}`);

    if (tool.routingRules && tool.routingRules.length > 0) {
      for (const rule of tool.routingRules) {
        lines.push(`   ROUTING: ${rule.reason}`);
      }
    }

    lines.push('');
  });

  const disabled = getDisabledTools();
  if (disabled.length > 0) {
    lines.push('DISABLED TOOLS (do NOT select these):');
    disabled.forEach(tool => {
      lines.push(`- ${tool.id} — ${tool.description} [DISABLED]`);
    });
    lines.push('');
  }

  lines.push('ROUTING RULES:');
  lines.push('- Non-pub/bar/brewery queries MUST NOT use SEARCH_WYSHBONE_DB.');
  lines.push('- If SEARCH_WYSHBONE_DB is disabled, always use SEARCH_PLACES for business discovery.');
  lines.push('');

  return lines.join('\n');
}
