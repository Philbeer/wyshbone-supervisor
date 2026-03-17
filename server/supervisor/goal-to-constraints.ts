import { z } from 'zod';

export const DEFAULT_LEADS_TARGET = 20;

export interface RequestedCountCanonical {
  requested_count_user: 'explicit' | 'any';
  requested_count_value: number | null;
  requested_count_effective: number;
}

export function buildRequestedCount(userCount: number | null): RequestedCountCanonical {
  if (userCount !== null && userCount > 0) {
    return { requested_count_user: 'explicit', requested_count_value: userCount, requested_count_effective: userCount };
  }
  return { requested_count_user: 'any', requested_count_value: null, requested_count_effective: DEFAULT_LEADS_TARGET };
}

export const CONSTRAINT_TYPES = [
  'COUNT_MIN',
  'LOCATION_EQUALS',
  'LOCATION_NEAR',
  'CATEGORY_EQUALS',
  'NAME_STARTS_WITH',
  'NAME_CONTAINS',
  'MUST_USE_TOOL',
  'HAS_ATTRIBUTE',
  'RELATIONSHIP_CHECK',
  'STATUS_CHECK',
  'TIME_CONSTRAINT',
  'WEBSITE_EVIDENCE',
  'RANKING',
] as const;

export type ConstraintType = typeof CONSTRAINT_TYPES[number];

export const ATTRIBUTE_LIKE_TYPES: readonly ConstraintType[] = [
  'HAS_ATTRIBUTE',
  'RELATIONSHIP_CHECK',
  'STATUS_CHECK',
  'TIME_CONSTRAINT',
  'WEBSITE_EVIDENCE',
  'RANKING',
] as const;

export function isAttributeLikeConstraint(type: string): boolean {
  return (ATTRIBUTE_LIKE_TYPES as readonly string[]).includes(type);
}

export const CanonicalSourceSchema = z.object({
  type: z.string(),
  field: z.string(),
  operator: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  hardness: z.string(),
  value_secondary: z.union([z.string(), z.number(), z.null()]).optional(),
}).optional();

export const StructuredConstraintSchema = z.object({
  id: z.string(),
  type: z.enum(CONSTRAINT_TYPES),
  field: z.string(),
  operator: z.string(),
  value: z.union([z.string(), z.number(), z.object({ center: z.string(), km: z.number() })]),
  hard: z.boolean(),
  rationale: z.string(),
  canonical: CanonicalSourceSchema,
});

export type StructuredConstraint = z.infer<typeof StructuredConstraintSchema>;

export const SuccessCriteriaSchema = z.object({
  required_constraints: z.array(z.string()),
  optional_constraints: z.array(z.string()),
  target_count: z.number().nullable(),
});

export type SuccessCriteria = z.infer<typeof SuccessCriteriaSchema>;

export const ParsedGoalSchema = z.object({
  original_goal: z.string(),
  requested_count_user: z.number().nullable(),
  search_budget_count: z.number(),
  business_type: z.string(),
  location: z.string(),
  country: z.string().default(''),
  prefix_filter: z.string().nullable().default(null),
  name_filter: z.string().nullable().default(null),
  attribute_filter: z.string().nullable().default(null),
  tool_preference: z.string().nullable().default(null),
  include_email: z.boolean().default(false),
  include_phone: z.boolean().default(false),
  include_website: z.boolean().default(false),
  constraints: z.array(StructuredConstraintSchema),
  success_criteria: SuccessCriteriaSchema,
});

export type ParsedGoal = z.infer<typeof ParsedGoalSchema>;

const SYSTEM_PROMPT = `You are a goal parser for a B2B lead generation system. Parse user requests into structured constraints for searching businesses.

You must return a JSON object with these fields:
- original_goal: the verbatim user input
- requested_count_user: the number the user explicitly asked for (number or null if not specified). Do NOT invent a count — if the user says "find pubs in london" without a number, set this to null.
- search_budget_count: always max(30, requested_count_user * 3 or 30), capped at 50 — we pull a wider candidate set for post-search verification
- business_type: the CORE type of business ONLY (e.g. "pubs", "dentists", "restaurants"). NEVER include attribute qualifiers here. "pubs with beer garden" → business_type="pubs", attribute_filter="beer garden". "restaurants with outdoor seating" → business_type="restaurants", attribute_filter="outdoor seating".
- location: the geographic location ONLY (e.g. "arundel", "london"). NEVER include count instructions, "return exactly" clauses, or "do not stop" phrases in the location. For "Find 20 pubs in Arundel and return exactly 20 results", the location is ONLY "Arundel", not "Arundel and return exactly 20 results".
- country: country code or name. ALWAYS infer the country from the location. For US states (e.g. Texas, California, New York, Florida, etc.) or US cities, use "US". For UK locations (e.g. London, Sussex, Manchester, Kent, etc.), use "UK". For other countries, use the appropriate country code. If truly ambiguous, default to "UK".
- prefix_filter: if user wants names starting with a specific letter/prefix (string or null)
- name_filter: if user wants names containing a specific word IN THE BUSINESS NAME (string or null). Only use this for explicit name-matching requests like "with the word swan in the name".
- attribute_filter: if user wants businesses with a specific feature/attribute/amenity (string or null). Use this for venue features like "beer garden", "outdoor seating", "live music", "parking", "rooftop bar", "pool table", "function room" etc. These are NOT name filters — they describe what the venue HAS, not what it is called.
- tool_preference: if user specifies a tool like "google places" (string or null)
- include_email: true if user says "include email" or "with email" as a delivery requirement (boolean, default false). This is a DELIVERY REQUIREMENT, NOT a location or search term.
- include_phone: true if user says "include phone" or "with phone number" as a delivery requirement (boolean, default false). This is a DELIVERY REQUIREMENT, NOT a location or search term.
- include_website: true if user says "include website" or "with website" as a delivery requirement (boolean, default false). This is a DELIVERY REQUIREMENT, NOT a location or search term.
- constraints: array of typed constraint objects
- success_criteria: object defining what counts as success

CRITICAL RULE — Delivery requirements vs location:
- "find 10 pubs in Arundel and include email" → location="Arundel", include_email=true. "and include email" is a delivery requirement, NOT part of the location.
- "find pubs in Brighton and include phone and website" → location="Brighton", include_phone=true, include_website=true
- NEVER include "include email", "include phone", "include website", or "include contact details" in the location field.

CONSTRAINT TYPES and how to detect them:
- COUNT_MIN: when user says "find N" → { id: "c_count", type: "COUNT_MIN", field: "count", operator: ">=", value: N, hard: true, rationale: "User requested N results" }
- LOCATION_EQUALS: when user says "in <place>" → { id: "c_location", type: "LOCATION_EQUALS", field: "location", operator: "=", value: "<place>", hard: false, rationale: "..." }
- LOCATION_NEAR: when user says "near <place>" or "within X km" → { id: "c_location", type: "LOCATION_NEAR", field: "location", operator: "within_km", value: { center: "<place>", km: N }, hard: false, rationale: "..." }
- CATEGORY_EQUALS: DISABLED — business type is used as a text query term only, not as a verifiable constraint. Do NOT emit any CATEGORY_EQUALS constraint.
- NAME_STARTS_WITH: when user says "starting with X" or "beginning with X" → { id: "c_name_prefix", type: "NAME_STARTS_WITH", field: "name", operator: "starts_with", value: "X", hard: false, rationale: "..." }
- NAME_CONTAINS: when user says "with the word X in the name" or "called X" or "named X" → { id: "c_name_contains", type: "NAME_CONTAINS", field: "name", operator: "contains_word", value: "X", hard: false, rationale: "..." }. Only for BUSINESS NAME matching, not venue attributes.
- MUST_USE_TOOL: when user says "using google places" → { id: "c_tool", type: "MUST_USE_TOOL", field: "tool", operator: "=", value: "GOOGLE_PLACES", hard: false, rationale: "..." }
- HAS_ATTRIBUTE: when user wants venues with a specific feature/amenity → { id: "c_attr_<short_name>", type: "HAS_ATTRIBUTE", field: "attribute", operator: "has", value: "<attribute>", hard: true, rationale: "..." }. Examples: "beer garden", "outdoor seating", "live music", "parking", "wheelchair accessible". Default HARD because the user explicitly asked for this feature. Only set soft (hard: false) if user uses hedging language like "preferably", "if possible", "ideally", "optionally", "nice to have".

CRITICAL RULE — Attribute vs Name distinction:
- "pubs with a beer garden" → HAS_ATTRIBUTE (beer garden is a venue feature, NOT a name)
- "pubs with the word swan in the name" → NAME_CONTAINS (swan is in the business name)
- "restaurants with outdoor seating" → HAS_ATTRIBUTE (outdoor seating is a venue feature)
- "restaurants called The Swan" → NAME_CONTAINS (The Swan is a name)
- NEVER put attribute qualifiers into business_type. business_type must be ONLY the core category.

HARD vs SOFT rules:
- If user uses words like "must", "only", "exactly", "strict", "strictly", "do not relax", "hard constraint" → mark that constraint as hard: true
- Default hard: COUNT_MIN (always hard), HAS_ATTRIBUTE (hard because user explicitly asked for this feature)
- Default soft: LOCATION_EQUALS, LOCATION_NEAR, NAME_STARTS_WITH, NAME_CONTAINS, MUST_USE_TOOL
- HAS_ATTRIBUTE becomes soft ONLY if user uses hedging language: "preferably with", "if possible", "ideally", "optionally", "nice to have", "bonus if"
- Override: if user says "must be in london only" → LOCATION_EQUALS becomes hard.
- "find pubs that have a beer garden" → HAS_ATTRIBUTE hard: true (user stated it as a requirement)
- "find pubs, preferably with a beer garden" → HAS_ATTRIBUTE hard: false (user hedged)

SUCCESS_CRITERIA:
- required_constraints: IDs of all hard constraints
- optional_constraints: IDs of all soft constraints
- target_count: same as requested_count_user

IMPORTANT: Parse the EXACT intent. For "find 4 pubs in arundel with the word swan in the name", you must:
- Set name_filter to "swan"
- Include a NAME_CONTAINS constraint with value "swan"
- Do NOT confuse "with the word X in the name" with a prefix filter or attribute

For "find 7 pubs in chichester with a beer garden", you must:
- Set business_type to "pubs" (NOT "pubs with beer garden")
- Set attribute_filter to "beer garden"
- Include a HAS_ATTRIBUTE constraint with value "beer garden"
- Do NOT set name_filter (beer garden is not a name)

Return ONLY valid JSON. No markdown, no explanation.`;

function buildUserPrompt(goal: string): string {
  return `Parse this goal into structured constraints:\n\n"${goal}"`;
}

async function callAnthropicForParsing(anthropicKey: string, userPrompt: string): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 2000,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt + '\n\nReturn ONLY valid JSON.' }],
    }),
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(`Anthropic API ${response.status}: ${JSON.stringify(data).substring(0, 200)}`);
  const text = data.content?.[0]?.text || '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
}

async function callLLMForParsing(goal: string): Promise<Record<string, unknown>> {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const userPrompt = buildUserPrompt(goal);

  if (openaiKey) {
    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: openaiKey });
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      });
      const text = response.choices[0]?.message?.content || '{}';
      return JSON.parse(text);
    } catch (err: any) {
      const is429 = err?.status === 429 || String(err?.message ?? '').includes('429');
      if (is429 && anthropicKey) {
        console.warn('[GOAL_PARSER] OpenAI 429 — falling back to Claude haiku');
        return callAnthropicForParsing(anthropicKey, userPrompt);
      }
      throw err;
    }
  }

  if (anthropicKey) {
    return callAnthropicForParsing(anthropicKey, userPrompt);
  }

  throw new Error('No LLM API key configured');
}

const US_STATES = new Set([
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
  'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
  'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
  'minnesota','mississippi','missouri','montana','nebraska','nevada',
  'new hampshire','new jersey','new mexico','new york','north carolina',
  'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
  'south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming',
]);

export function inferCountryFromLocation(location: string): string {
  const lower = location.toLowerCase().trim();
  if (US_STATES.has(lower)) return 'US';
  if (lower.includes('usa') || lower.includes('united states') || lower.includes('america')) return 'US';
  if (/\b(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/i.test(lower) && lower.length <= 2) return 'US';
  return 'UK';
}

const DELIVERY_TOKENS_PATTERN = '(?:email|phone|website|contact\\s+details?)';
const DELIVERY_CHAIN = `(?:\\s+(?:and|,)\\s+${DELIVERY_TOKENS_PATTERN})*`;

const LOCATION_INSTRUCTION_PATTERNS: RegExp[] = [
  /\s+and\s+return\s+exactly\s+\d+\s+results?\.?/gi,
  /\s+and\s+return\s+exactly\s+\d+\.?/gi,
  /\.?\s*If\s+fewer\s+than\s+\d+\s+are\s+found[^]*$/gi,
  /\s*,?\s*do\s+not\s+stop\.?$/gi,
  /\s+return\s+exactly\s+\d+\s+results?\.?/gi,
  new RegExp(`\\s+and\\s+includ(?:e|ing)\\s+${DELIVERY_TOKENS_PATTERN}${DELIVERY_CHAIN}\\.?`, 'gi'),
  new RegExp(`\\s+includ(?:e|ing)\\s+${DELIVERY_TOKENS_PATTERN}${DELIVERY_CHAIN}\\.?`, 'gi'),
  new RegExp(`[\\s,;\\-]+includ(?:e|ing)\\s+${DELIVERY_TOKENS_PATTERN}${DELIVERY_CHAIN}\\.?`, 'gi'),
  new RegExp(`\\(\\s*includ(?:e|ing)\\s+${DELIVERY_TOKENS_PATTERN}${DELIVERY_CHAIN}\\s*\\)`, 'gi'),
  new RegExp(`\\s+with\\s+${DELIVERY_TOKENS_PATTERN}${DELIVERY_CHAIN}\\.?`, 'gi'),
];

const INSTRUCTION_KEYWORD_RE = /\b(include|including|email|phone|website|contact\s+details?)\b/i;

export function sanitiseLocationString(raw: string): string {
  let loc = raw.trim();
  for (const pattern of LOCATION_INSTRUCTION_PATTERNS) {
    pattern.lastIndex = 0;
    loc = loc.replace(pattern, '');
  }
  loc = loc.replace(/[.!]+$/, '');
  loc = loc.replace(/[,;:\-&]+\s*$/, '');
  loc = loc.trim();
  if (INSTRUCTION_KEYWORD_RE.test(loc)) {
    const cityOnly = loc.split(/[,;]/)[0].trim();
    if (!INSTRUCTION_KEYWORD_RE.test(cityOnly) && cityOnly.length > 0) {
      loc = cityOnly;
    } else {
      loc = loc.replace(/\b(?:and\s+)?(?:includ(?:e|ing)|with)\s+(?:email|phone|website|contact\s+details?)(?:\s+(?:and|,)\s+(?:email|phone|website|contact\s+details?))*/gi, '').trim();
    }
  }
  loc = loc.replace(/[,;:\-&]+\s*$/, '');
  return loc.trim();
}

export type ExactnessMode = 'hard' | 'soft';

export function detectExactnessMode(rawGoal: string): ExactnessMode {
  const lower = rawGoal.toLowerCase();
  if (/return\s+none\s+if\s+you\s+cannot\s+return\s+exactly/i.test(lower)) return 'hard';
  if (/must\s+be\s+exactly\s+\d+/i.test(lower)) return 'hard';
  return 'soft';
}

export function detectDoNotStop(rawGoal: string): boolean {
  return /do\s+not\s+stop/i.test(rawGoal);
}

export function detectDeliveryRequirements(rawGoal: string): { include_email: boolean; include_phone: boolean; include_website: boolean } {
  return {
    include_email: /\b(?:include|with)\s+email\b/i.test(rawGoal),
    include_phone: /\b(?:include|with)\s+phone\b/i.test(rawGoal),
    include_website: /\b(?:include|with)\s+website\b/i.test(rawGoal),
  };
}

function stripInstructionClauses(rawGoal: string): string {
  let msg = rawGoal;
  msg = msg.replace(/\.\s*If\s+fewer\s+than\s+\d+\s+are\s+found[^.]*\.?/gi, '.');
  msg = msg.replace(/\s+and\s+return\s+exactly\s+\d+\s+results?\.?/gi, '');
  msg = msg.replace(/\s+return\s+exactly\s+\d+\s+results?\.?/gi, '');
  msg = msg.replace(/,?\s*do\s+not\s+stop\.?/gi, '');
  for (const pattern of LOCATION_INSTRUCTION_PATTERNS) {
    pattern.lastIndex = 0;
    msg = msg.replace(pattern, '');
  }
  return msg.trim();
}

export async function parseGoalToConstraints(rawUserGoal: string): Promise<ParsedGoal> {
  const startMs = Date.now();
  try {
    const raw = await callLLMForParsing(rawUserGoal);

    raw.original_goal = rawUserGoal;

    const parsed = ParsedGoalSchema.parse(raw);

    parsed.location = sanitiseLocationString(parsed.location);

    const locConstraint = parsed.constraints.find(c => c.type === 'LOCATION_EQUALS' || c.type === 'LOCATION_NEAR');
    if (locConstraint && typeof locConstraint.value === 'string') {
      locConstraint.value = sanitiseLocationString(locConstraint.value);
    }

    parsed.constraints = parsed.constraints.filter(c => c.type !== 'CATEGORY_EQUALS');
    parsed.success_criteria.required_constraints = parsed.success_criteria.required_constraints.filter(id => id !== 'c_category');
    parsed.success_criteria.optional_constraints = parsed.success_criteria.optional_constraints.filter(id => id !== 'c_category');

    if (!parsed.include_email && /\b(?:include|with)\s+email\b/i.test(rawUserGoal)) parsed.include_email = true;
    if (!parsed.include_phone && /\b(?:include|with)\s+phone\b/i.test(rawUserGoal)) parsed.include_phone = true;
    if (!parsed.include_website && /\b(?:include|with)\s+website\b/i.test(rawUserGoal)) parsed.include_website = true;

    const elapsed = Date.now() - startMs;
    console.log(`[GOAL_PARSER] LLM parsed in ${elapsed}ms — business_type="${parsed.business_type}" location="${parsed.location}" count=${parsed.requested_count_user} constraints=${parsed.constraints.length} name_filter=${parsed.name_filter} prefix_filter=${parsed.prefix_filter}`);

    return parsed;
  } catch (err: any) {
    const elapsed = Date.now() - startMs;
    console.error(`[GOAL_PARSER] LLM parse failed after ${elapsed}ms (${err.message}) — no fallback, re-throwing`);
    throw err;
  }
}

export interface AccumulatedLead {
  name: string;
  address?: string;
  placeId?: string;
  place_id?: string;
}

export function checkHardConstraintsSatisfied(
  accumulatedLeads: AccumulatedLead[],
  constraints: StructuredConstraint[],
  requestedCountUser: number | null,
): { satisfied: boolean; unsatisfied: string[]; details: Record<string, string> } {
  const hardConstraints = constraints.filter(c => c.hard);
  const unsatisfied: string[] = [];
  const details: Record<string, string> = {};

  for (const c of hardConstraints) {
    switch (c.type) {
      case 'COUNT_MIN': {
        const target = typeof c.value === 'number' ? c.value : requestedCountUser || 0;
        if (accumulatedLeads.length < target) {
          unsatisfied.push(c.id);
          details[c.id] = `Need ${target}, have ${accumulatedLeads.length}`;
        }
        break;
      }

      case 'CATEGORY_EQUALS':
        break;

      case 'LOCATION_EQUALS':
        break;

      case 'NAME_STARTS_WITH': {
        const prefix = (typeof c.value === 'string' ? c.value : '').toLowerCase();
        if (prefix) {
          const matching = accumulatedLeads.filter(l => l.name.toLowerCase().startsWith(prefix));
          const target = requestedCountUser || 1;
          if (matching.length < target) {
            unsatisfied.push(c.id);
            details[c.id] = `Need ${target} names starting with "${prefix}", found ${matching.length}`;
          }
        }
        break;
      }

      case 'NAME_CONTAINS': {
        const word = (typeof c.value === 'string' ? c.value : '').toLowerCase();
        if (word) {
          const matching = accumulatedLeads.filter(l => l.name.toLowerCase().includes(word));
          const target = requestedCountUser || 1;
          if (matching.length < target) {
            unsatisfied.push(c.id);
            details[c.id] = `Need ${target} names containing "${word}", found ${matching.length}`;
          }
        }
        break;
      }

      case 'MUST_USE_TOOL':
        break;

      case 'LOCATION_NEAR':
        break;
    }
  }

  return {
    satisfied: unsatisfied.length === 0,
    unsatisfied,
    details,
  };
}

export function filterLeadsByNameConstraint(
  leads: Array<{ name: string; address?: string; phone?: string | null; website?: string | null; placeId?: string; source?: string }>,
  constraints: StructuredConstraint[],
): typeof leads {
  const nameStartsWith = constraints.find(c => c.type === 'NAME_STARTS_WITH');
  const nameContains = constraints.find(c => c.type === 'NAME_CONTAINS');

  if (!nameStartsWith && !nameContains) return leads;

  return leads.filter(lead => {
    const name = lead.name.toLowerCase();
    if (nameStartsWith) {
      const prefix = (typeof nameStartsWith.value === 'string' ? nameStartsWith.value : '').toLowerCase();
      if (!name.startsWith(prefix)) return false;
    }
    if (nameContains) {
      const word = (typeof nameContains.value === 'string' ? nameContains.value : '').toLowerCase();
      if (!name.includes(word)) return false;
    }
    return true;
  });
}
