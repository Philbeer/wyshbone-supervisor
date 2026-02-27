import { z } from 'zod';

export const CONSTRAINT_TYPES = [
  'COUNT_MIN',
  'LOCATION_EQUALS',
  'LOCATION_NEAR',
  'CATEGORY_EQUALS',
  'NAME_STARTS_WITH',
  'NAME_CONTAINS',
  'MUST_USE_TOOL',
  'HAS_ATTRIBUTE',
] as const;

export type ConstraintType = typeof CONSTRAINT_TYPES[number];

export const StructuredConstraintSchema = z.object({
  id: z.string(),
  type: z.enum(CONSTRAINT_TYPES),
  field: z.string(),
  operator: z.string(),
  value: z.union([z.string(), z.number(), z.object({ center: z.string(), km: z.number() })]),
  hard: z.boolean(),
  rationale: z.string(),
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
- location: the location (e.g. "arundel", "london")
- country: country code or name. ALWAYS infer the country from the location. For US states (e.g. Texas, California, New York, Florida, etc.) or US cities, use "US". For UK locations (e.g. London, Sussex, Manchester, Kent, etc.), use "UK". For other countries, use the appropriate country code. If truly ambiguous, default to "UK".
- prefix_filter: if user wants names starting with a specific letter/prefix (string or null)
- name_filter: if user wants names containing a specific word IN THE BUSINESS NAME (string or null). Only use this for explicit name-matching requests like "with the word swan in the name".
- attribute_filter: if user wants businesses with a specific feature/attribute/amenity (string or null). Use this for venue features like "beer garden", "outdoor seating", "live music", "parking", "rooftop bar", "pool table", "function room" etc. These are NOT name filters — they describe what the venue HAS, not what it is called.
- tool_preference: if user specifies a tool like "google places" (string or null)
- constraints: array of typed constraint objects
- success_criteria: object defining what counts as success

CONSTRAINT TYPES and how to detect them:
- COUNT_MIN: when user says "find N" → { id: "c_count", type: "COUNT_MIN", field: "count", operator: ">=", value: N, hard: true, rationale: "User requested N results" }
- LOCATION_EQUALS: when user says "in <place>" → { id: "c_location", type: "LOCATION_EQUALS", field: "location", operator: "=", value: "<place>", hard: false, rationale: "..." }
- LOCATION_NEAR: when user says "near <place>" or "within X km" → { id: "c_location", type: "LOCATION_NEAR", field: "location", operator: "within_km", value: { center: "<place>", km: N }, hard: false, rationale: "..." }
- CATEGORY_EQUALS: the CORE business type ONLY → { id: "c_category", type: "CATEGORY_EQUALS", field: "business_type", operator: "=", value: "<core type>", hard: true, rationale: "..." }. The value must be the clean business type without attribute qualifiers.
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
- Default hard: COUNT_MIN (always hard), CATEGORY_EQUALS (always hard), HAS_ATTRIBUTE (hard because user explicitly asked for this feature)
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

async function callLLMForParsing(goal: string): Promise<Record<string, unknown>> {
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const userPrompt = buildUserPrompt(goal);

  if (openaiKey) {
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
  }

  if (anthropicKey) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 2000,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt + '\n\nReturn ONLY valid JSON.' }],
      }),
    });
    const data = await response.json() as any;
    const text = data.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
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

function regexFallback(rawGoal: string): ParsedGoal {
  const msg = rawGoal.trim();
  const constraints: StructuredConstraint[] = [];
  const requiredIds: string[] = [];
  const optionalIds: string[] = [];

  let businessType = 'pubs';
  let location = 'Local';
  let country = 'UK';
  let requestedCountUser: number | null = null;
  let prefixFilter: string | null = null;
  let nameFilter: string | null = null;
  let toolPreference: string | null = null;

  const countMatch = msg.match(/\bfind\s+(\d+)\s+/i);
  if (countMatch) {
    requestedCountUser = Math.min(parseInt(countMatch[1], 10), 200);
  }

  const numTypeMatch = msg.match(/\bfind\s+(?:\d+\s+)?([a-zA-Z\s]+?)(?:\s+in\b)/i);
  if (numTypeMatch) {
    businessType = numTypeMatch[1].trim().replace(/^\d+\s*/, '') || 'pubs';
  }

  const inMatch = msg.match(/\bin\s+([A-Z][a-zA-Z\s,]+?)(?:\s+(?:that|who|which|with|using)\b|$)/i);
  if (inMatch) {
    const loc = inMatch[1].trim().replace(/,\s*$/, '');
    const parts = loc.split(',');
    location = parts[0].trim();
    if (parts[1]) {
      country = inferCountryFromLocation(parts[1].trim());
    } else {
      country = inferCountryFromLocation(location);
    }
  }

  const prefixMatch = msg.match(/\b(?:begin|start|starting)\s+with\s+([A-Za-z])\b/i);
  if (prefixMatch) prefixFilter = prefixMatch[1].toUpperCase();

  const nameContainsMatch = msg.match(/\bwith\s+the\s+(?:word|name)\s+([a-zA-Z]+)\s+in\s+the\s+name\b/i)
    || msg.match(/\bcontaining\s+(?:the\s+word\s+)?["']?([a-zA-Z]+)["']?\s+in\s+(?:the\s+)?name\b/i)
    || msg.match(/\bnamed?\s+["']?([a-zA-Z]+)["']?\b/i)
    || msg.match(/\bcalled\s+["']?([a-zA-Z]+)["']?\b/i);
  if (nameContainsMatch && !prefixFilter) {
    nameFilter = nameContainsMatch[1];
  }

  const attrMatch = msg.match(/\bwith\s+(?:a\s+)?(?!the\s+word|the\s+name)(beer\s+garden|outdoor\s+seating|live\s+music|parking|rooftop|pool\s+table|function\s+room|wheelchair|garden|terrace|patio|wifi|karaoke)\b/i);
  let attributeFilter: string | null = null;
  if (attrMatch) {
    attributeFilter = attrMatch[1].trim();
  }

  const toolMatch = msg.match(/\b(?:with|using)\s+(google\s+places?\s+search|google\s+places?|google\s+maps?)\b/i);
  if (toolMatch) toolPreference = 'GOOGLE_PLACES';

  const searchBudgetCount = Math.min(50, Math.max(30, (requestedCountUser || 10) * 3));

  if (attributeFilter) {
    businessType = businessType.replace(new RegExp(`\\s+with\\s+(?:a\\s+)?${attributeFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), '').trim();
  }

  const hardKeywords = /\b(must|only|exactly|strict|strictly|do\s+not\s+relax)\b/i;
  const hasHardSignal = hardKeywords.test(msg);

  if (requestedCountUser !== null) {
    const c: StructuredConstraint = { id: 'c_count', type: 'COUNT_MIN', field: 'count', operator: '>=', value: requestedCountUser, hard: true, rationale: `User requested ${requestedCountUser} results` };
    constraints.push(c);
    requiredIds.push(c.id);
  }

  {
    const c: StructuredConstraint = { id: 'c_category', type: 'CATEGORY_EQUALS', field: 'business_type', operator: '=', value: businessType, hard: true, rationale: `User searching for ${businessType}` };
    constraints.push(c);
    requiredIds.push(c.id);
  }

  {
    const isHard = hasHardSignal && /\b(only|within)\b/i.test(msg);
    const c: StructuredConstraint = { id: 'c_location', type: 'LOCATION_EQUALS', field: 'location', operator: '=', value: location, hard: isHard, rationale: `User specified location: ${location}` };
    constraints.push(c);
    if (isHard) requiredIds.push(c.id); else optionalIds.push(c.id);
  }

  if (prefixFilter) {
    const isHard = hasHardSignal && /\b(must|exactly|strict)\b/i.test(msg);
    const c: StructuredConstraint = { id: 'c_name_prefix', type: 'NAME_STARTS_WITH', field: 'name', operator: 'starts_with', value: prefixFilter, hard: isHard, rationale: `User wants names starting with "${prefixFilter}"` };
    constraints.push(c);
    if (isHard) requiredIds.push(c.id); else optionalIds.push(c.id);
  }

  if (nameFilter) {
    const isHard = hasHardSignal && /\b(must|exactly|strict)\b/i.test(msg);
    const c: StructuredConstraint = { id: 'c_name_contains', type: 'NAME_CONTAINS', field: 'name', operator: 'contains_word', value: nameFilter, hard: isHard, rationale: `User wants names containing "${nameFilter}"` };
    constraints.push(c);
    if (isHard) requiredIds.push(c.id); else optionalIds.push(c.id);
  }

  if (toolPreference) {
    const isHard = hasHardSignal && /\bmust\s+use\b/i.test(msg);
    const c: StructuredConstraint = { id: 'c_tool', type: 'MUST_USE_TOOL', field: 'tool', operator: '=', value: toolPreference, hard: isHard, rationale: `User prefers ${toolPreference}` };
    constraints.push(c);
    if (isHard) requiredIds.push(c.id); else optionalIds.push(c.id);
  }

  if (attributeFilter) {
    const shortName = attributeFilter.replace(/\s+/g, '_').toLowerCase();
    const hedgingPattern = /\b(preferably|if\s+possible|ideally|optionally|nice\s+to\s+have|bonus\s+if)\b/i;
    const isSoft = hedgingPattern.test(msg);
    const isHard = !isSoft;
    const c: StructuredConstraint = { id: `c_attr_${shortName}`, type: 'HAS_ATTRIBUTE', field: 'attribute', operator: 'has', value: attributeFilter, hard: isHard, rationale: isHard ? `User requires venues with "${attributeFilter}"` : `User prefers venues with "${attributeFilter}" (hedging language detected)` };
    constraints.push(c);
    if (isHard) requiredIds.push(c.id); else optionalIds.push(c.id);
  }

  return {
    original_goal: rawGoal,
    requested_count_user: requestedCountUser,
    search_budget_count: searchBudgetCount,
    business_type: businessType,
    location,
    country,
    prefix_filter: prefixFilter,
    name_filter: nameFilter,
    attribute_filter: attributeFilter,
    tool_preference: toolPreference,
    constraints,
    success_criteria: {
      required_constraints: requiredIds,
      optional_constraints: optionalIds,
      target_count: requestedCountUser,
    },
  };
}

export async function parseGoalToConstraints(rawUserGoal: string): Promise<ParsedGoal> {
  const startMs = Date.now();
  try {
    const raw = await callLLMForParsing(rawUserGoal);

    raw.original_goal = rawUserGoal;

    const parsed = ParsedGoalSchema.parse(raw);

    const elapsed = Date.now() - startMs;
    console.log(`[GOAL_PARSER] LLM parsed in ${elapsed}ms — business_type="${parsed.business_type}" location="${parsed.location}" count=${parsed.requested_count_user} constraints=${parsed.constraints.length} name_filter=${parsed.name_filter} prefix_filter=${parsed.prefix_filter}`);

    return parsed;
  } catch (err: any) {
    const elapsed = Date.now() - startMs;
    console.warn(`[GOAL_PARSER] LLM parse failed after ${elapsed}ms (${err.message}) — falling back to regex`);
    const fallback = regexFallback(rawUserGoal);
    console.log(`[GOAL_PARSER] Regex fallback — business_type="${fallback.business_type}" location="${fallback.location}" count=${fallback.requested_count_user} constraints=${fallback.constraints.length} name_filter=${fallback.name_filter} prefix_filter=${fallback.prefix_filter}`);
    return fallback;
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
