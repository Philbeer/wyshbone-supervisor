import { z } from 'zod';

export const CONSTRAINT_TYPES = [
  'COUNT_MIN',
  'LOCATION_EQUALS',
  'LOCATION_NEAR',
  'CATEGORY_EQUALS',
  'NAME_STARTS_WITH',
  'NAME_CONTAINS',
  'MUST_USE_TOOL',
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
  country: z.string().default('UK'),
  prefix_filter: z.string().nullable().default(null),
  name_filter: z.string().nullable().default(null),
  tool_preference: z.string().nullable().default(null),
  constraints: z.array(StructuredConstraintSchema),
  success_criteria: SuccessCriteriaSchema,
});

export type ParsedGoal = z.infer<typeof ParsedGoalSchema>;

const SYSTEM_PROMPT = `You are a goal parser for a B2B lead generation system. Parse user requests into structured constraints for searching businesses.

You must return a JSON object with these fields:
- original_goal: the verbatim user input
- requested_count_user: the number the user asked for (number or null if not specified)
- search_budget_count: always max(20, requested_count_user or 20) — this is how many we actually fetch
- business_type: the type of business (e.g. "pubs", "dentists", "restaurants")
- location: the location (e.g. "arundel", "london")
- country: country code or name, default "UK"
- prefix_filter: if user wants names starting with a specific letter/prefix (string or null)
- name_filter: if user wants names containing a specific word (string or null)
- tool_preference: if user specifies a tool like "google places" (string or null)
- constraints: array of typed constraint objects
- success_criteria: object defining what counts as success

CONSTRAINT TYPES and how to detect them:
- COUNT_MIN: when user says "find N" → { id: "c_count", type: "COUNT_MIN", field: "count", operator: ">=", value: N, hard: true, rationale: "User requested N results" }
- LOCATION_EQUALS: when user says "in <place>" → { id: "c_location", type: "LOCATION_EQUALS", field: "location", operator: "=", value: "<place>", hard: false, rationale: "..." }
- LOCATION_NEAR: when user says "near <place>" or "within X km" → { id: "c_location", type: "LOCATION_NEAR", field: "location", operator: "within_km", value: { center: "<place>", km: N }, hard: false, rationale: "..." }
- CATEGORY_EQUALS: the business type → { id: "c_category", type: "CATEGORY_EQUALS", field: "business_type", operator: "=", value: "<type>", hard: true, rationale: "..." }
- NAME_STARTS_WITH: when user says "starting with X" or "beginning with X" → { id: "c_name_prefix", type: "NAME_STARTS_WITH", field: "name", operator: "starts_with", value: "X", hard: false, rationale: "..." }
- NAME_CONTAINS: when user says "with the word X in the name" or "containing X" or "called X" or "named X" → { id: "c_name_contains", type: "NAME_CONTAINS", field: "name", operator: "contains_word", value: "X", hard: false, rationale: "..." }
- MUST_USE_TOOL: when user says "using google places" → { id: "c_tool", type: "MUST_USE_TOOL", field: "tool", operator: "=", value: "GOOGLE_PLACES", hard: false, rationale: "..." }

HARD vs SOFT rules:
- If user uses words like "must", "only", "exactly", "strict", "strictly", "do not relax", "hard constraint" → mark that constraint as hard: true
- Default hard: COUNT_MIN (always hard), CATEGORY_EQUALS (always hard)
- Default soft: LOCATION_EQUALS, LOCATION_NEAR, NAME_STARTS_WITH, NAME_CONTAINS, MUST_USE_TOOL
- Override: if user says "must be in london only" → LOCATION_EQUALS becomes hard

SUCCESS_CRITERIA:
- required_constraints: IDs of all hard constraints
- optional_constraints: IDs of all soft constraints
- target_count: same as requested_count_user

IMPORTANT: Parse the EXACT intent. For "find 4 pubs in arundel with the word swan in the name", you must:
- Set name_filter to "swan"
- Include a NAME_CONTAINS constraint with value "swan"
- Do NOT confuse "with the word X in the name" with a prefix filter

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
    if (parts[1]) country = parts[1].trim();
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

  const toolMatch = msg.match(/\b(?:with|using)\s+(google\s+places?\s+search|google\s+places?|google\s+maps?)\b/i);
  if (toolMatch) toolPreference = 'GOOGLE_PLACES';

  const searchBudgetCount = Math.max(20, requestedCountUser || 20);

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

  return {
    original_goal: rawGoal,
    requested_count_user: requestedCountUser,
    search_budget_count: searchBudgetCount,
    business_type: businessType,
    location,
    country,
    prefix_filter: prefixFilter,
    name_filter: nameFilter,
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
