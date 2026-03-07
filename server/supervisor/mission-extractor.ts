import {
  type StructuredMission,
  type MissionExtractionTrace,
  type MissionValidationResult,
  parseAndValidateMissionJSON,
  MISSION_CONSTRAINT_TYPES,
  MISSION_MODES,
  TEXT_COMPARE_OPERATORS,
  NUMERIC_OPERATORS,
  HARDNESS_VALUES,
} from './mission-schema';

const PASS1_SYSTEM_PROMPT = `You are a semantic interpreter for a business search system. Your job is to read a messy user message and restate what the user is actually asking for in clean, unambiguous language.

RULES:
- Restate the user's intent in plain semantic English. Do not preserve their exact phrasing.
- Identify the type of entity they want (e.g. pubs, cafes, breweries, hospitals).
- Identify the location if given.
- Identify ALL constraints: name filters, attribute requirements, time windows, website evidence needs, monitoring requests, relationship checks, rankings, status checks, contact needs.
- For name filters like "with the word swan in the name", "called swan", "name includes swan" — state clearly: whose business name contains "swan". The comparison value is just "swan", not the full phrase.
- For website evidence like "mention vegan food on their website" — state clearly: whose website text contains "vegan food".
- For time constraints like "opened in the last 6 months" — state clearly: that opened within the last 6 months from today.
- For monitoring requests like "keep checking" or "alert me" — state clearly that the user wants ongoing monitoring or alerts, not a one-time search.
- Identify whether this is a one-time search, a monitoring task, an alert-on-change, or a recurring check.
- Do NOT output JSON. Output a short paragraph of clean English.`;

const PASS2_SYSTEM_PROMPT = `You are a schema mapper for a business search system. You receive a semantic interpretation of a user request and must convert it into a fixed JSON schema.

OUTPUT SCHEMA (return ONLY this JSON object, no markdown fences, no commentary):
{
  "entity_category": string (the type of entity: "pubs", "cafes", "breweries", "hospitals", etc.),
  "location_text": string or null (geographic location, e.g. "Arundel", "Manchester", "Texas", "UK"),
  "constraints": [
    {
      "type": one of ${JSON.stringify(MISSION_CONSTRAINT_TYPES)},
      "field": string (what field this applies to, e.g. "name", "website_text", "opening_date", "rating", "status"),
      "operator": string (the comparison operator),
      "value": string or number or boolean or null (the comparison value — MUST be the clean extracted value, NOT the user's full phrase),
      "value_secondary": string or number or null (only for "between" operator),
      "hardness": one of ${JSON.stringify(HARDNESS_VALUES)}
    }
  ],
  "mission_mode": one of ${JSON.stringify(MISSION_MODES)}
}

CONSTRAINT TYPE RULES:

entity_discovery: Use when the core task is finding entities of a type. field="category", operator="equals", value=entity type.
  — Usually implicit from entity_category, so only add if there is an ADDITIONAL category filter beyond the main one.

location_constraint: Use for geographic constraints. field="location", operator="within" or "near" or "equals", value=location.
  — Usually captured by location_text, so only add if there is an ADDITIONAL or complex location filter.

text_compare: Use for name matching, text searches. Operators: ${JSON.stringify(TEXT_COMPARE_OPERATORS)}.
  — "with the word swan in the name" → field="name", operator="contains", value="swan"
  — "called The Red Lion" → field="name", operator="contains", value="The Red Lion"
  — CRITICAL: value must be the clean search term only. "swan", NOT "swan in the name". "The Red Lion", NOT "called The Red Lion".

attribute_check: Use for venue features/amenities. field=attribute name, operator="has" or "equals", value=the attribute.
  — "with a beer garden" → field="amenity", operator="has", value="beer garden"
  — "dog friendly" → field="amenity", operator="has", value="dog friendly"

relationship_check: Use for business relationships. field=relationship type, operator="has" or "serves", value=related entity.
  — "works with NHS" → field="client", operator="serves", value="NHS"

numeric_range: Use for ratings, counts, reviews. Operators: ${JSON.stringify(NUMERIC_OPERATORS)}.
  — "rated above 4 stars" → field="rating", operator="gte", value=4
  — "more than 50 reviews" → field="review_count", operator="gte", value=50

time_constraint: Use for time-based filters. field=relevant date field, operator="within_last" or "after" or "before", value=time description.
  — "opened in the last 6 months" → field="opening_date", operator="within_last", value="6 months"
  — "opened recently" → field="opening_date", operator="within_last", value="recent"

status_check: Use for current status verification. field=status aspect, operator="equals" or "has", value=expected status.
  — "currently open" → field="operating_status", operator="equals", value="open"
  — "offer the sleep apnea implant" → field="service_offered", operator="has", value="sleep apnea implant"

website_evidence: Use when the user specifically wants evidence from websites. field="website_text", operator="contains" or "mentions", value=search term.
  — "mention vegan food on their website" → field="website_text", operator="contains", value="vegan food"

contact_extraction: Use when the user wants contact details. field=contact type, operator="extract", value=null.
  — "get their email addresses" → field="email", operator="extract", value=null

ranking: Use for ordering/ranking requests. field=ranking criterion, operator="top" or "best", value=count or null.
  — "top 10 by rating" → field="rating", operator="top", value=10

MISSION MODE RULES:
- "research_now": One-time search or lookup. Default for most queries.
- "monitor": User wants ongoing monitoring ("keep checking", "watch for").
- "alert_on_change": User wants to be notified when something changes ("alert me if", "notify me when").
- "recurring_check": User wants periodic re-checks ("check every week", "monthly update").

HARDNESS RULES:
- "hard": Stated as a requirement without hedging. Default for explicit constraints.
- "soft": Uses hedging language like "preferably", "if possible", "ideally".

Return ONLY valid JSON. No markdown fences, no commentary, no explanation.`;

export type MissionExtractorMode = 'off' | 'shadow';

export function getMissionExtractorMode(): MissionExtractorMode {
  const raw = (process.env.MISSION_EXTRACTOR_MODE || 'shadow').toLowerCase().trim();
  if (raw === 'off') return 'off';
  return 'shadow';
}

const MAX_CONTEXT_CHARS = 3000;

function truncateContext(ctx: string | undefined): string | undefined {
  if (!ctx) return ctx;
  if (ctx.length <= MAX_CONTEXT_CHARS) return ctx;
  return ctx.slice(-MAX_CONTEXT_CHARS);
}

export interface MissionExtractionResult {
  trace: MissionExtractionTrace;
  mission: StructuredMission | null;
  ok: boolean;
}

function selectModel(): string {
  if (process.env.OPENAI_API_KEY) return 'gpt-4o-mini';
  if (process.env.ANTHROPIC_API_KEY) return 'claude-3-5-haiku-20241022';
  return 'none';
}

async function callLLM(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
  if (model === 'gpt-4o-mini') {
    return callOpenAI(systemPrompt, userPrompt);
  }
  if (model.startsWith('claude-')) {
    return callAnthropic(model, systemPrompt, userPrompt);
  }
  throw new Error('No LLM API key available (OPENAI_API_KEY or ANTHROPIC_API_KEY required)');
}

async function callOpenAI(systemPrompt: string, userPrompt: string): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 2000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });
  return response.choices[0]?.message?.content || '';
}

async function callAnthropic(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${body.substring(0, 200)}`);
  }

  const data = await resp.json() as { content: Array<{ type: string; text?: string }> };
  const textBlock = data.content?.find((b) => b.type === 'text');
  return textBlock?.text || '';
}

function cleanJsonResponse(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```json')) s = s.slice(7);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  return s.trim();
}

function cleanupMissionValues(mission: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(mission.constraints)) {
    for (const c of mission.constraints) {
      if (typeof c === 'object' && c !== null && typeof c.value === 'string') {
        c.value = c.value.trim();
      }
    }
  }

  if (typeof mission.entity_category === 'string') {
    mission.entity_category = mission.entity_category.trim();
  }
  if (typeof mission.location_text === 'string') {
    mission.location_text = mission.location_text.trim();
  }

  return mission;
}

export async function extractStructuredMission(
  userMessage: string,
  conversationContext?: string,
): Promise<MissionExtractionResult> {
  const model = selectModel();
  const timestamp = new Date().toISOString();

  if (model === 'none') {
    const trace: MissionExtractionTrace = {
      raw_user_input: userMessage,
      pass1_semantic_interpretation: '',
      pass2_structured_mission: null,
      pass2_raw_json: '',
      validation_result: { ok: false, mission: null, errors: ['No LLM API key available'] },
      model: 'none',
      pass1_duration_ms: 0,
      pass2_duration_ms: 0,
      total_duration_ms: 0,
      timestamp,
    };
    return { trace, mission: null, ok: false };
  }

  const truncatedContext = truncateContext(conversationContext);

  let pass1Prompt: string;
  if (truncatedContext) {
    pass1Prompt = `Recent conversation:\n${truncatedContext}\n\nInterpret the semantic meaning of the LATEST user message:\n\n"${userMessage}"`;
  } else {
    pass1Prompt = `Interpret the semantic meaning of this user message:\n\n"${userMessage}"`;
  }

  let pass1Result = '';
  const pass1Start = Date.now();
  try {
    pass1Result = await callLLM(model, PASS1_SYSTEM_PROMPT, pass1Prompt);
  } catch (err: any) {
    const duration = Date.now() - pass1Start;
    const trace: MissionExtractionTrace = {
      raw_user_input: userMessage,
      pass1_semantic_interpretation: '',
      pass2_structured_mission: null,
      pass2_raw_json: '',
      validation_result: { ok: false, mission: null, errors: [`Pass 1 LLM call failed: ${err.message}`] },
      model,
      pass1_duration_ms: duration,
      pass2_duration_ms: 0,
      total_duration_ms: duration,
      timestamp,
    };
    console.error(`[MISSION_EXTRACTOR] Pass 1 failed: ${err.message}`);
    return { trace, mission: null, ok: false };
  }
  const pass1Duration = Date.now() - pass1Start;

  const pass2Prompt = `Convert this semantic interpretation into the structured mission JSON schema:\n\n"${pass1Result}"`;

  let pass2RawResponse = '';
  const pass2Start = Date.now();
  try {
    pass2RawResponse = await callLLM(model, PASS2_SYSTEM_PROMPT, pass2Prompt);
  } catch (err: any) {
    const pass2Duration = Date.now() - pass2Start;
    const totalDuration = pass1Duration + pass2Duration;
    const trace: MissionExtractionTrace = {
      raw_user_input: userMessage,
      pass1_semantic_interpretation: pass1Result,
      pass2_structured_mission: null,
      pass2_raw_json: '',
      validation_result: { ok: false, mission: null, errors: [`Pass 2 LLM call failed: ${err.message}`] },
      model,
      pass1_duration_ms: pass1Duration,
      pass2_duration_ms: pass2Duration,
      total_duration_ms: totalDuration,
      timestamp,
    };
    console.error(`[MISSION_EXTRACTOR] Pass 2 failed: ${err.message}`);
    return { trace, mission: null, ok: false };
  }
  const pass2Duration = Date.now() - pass2Start;
  const totalDuration = pass1Duration + pass2Duration;

  const cleanedJson = cleanJsonResponse(pass2RawResponse);

  let parsedRaw: Record<string, unknown>;
  try {
    parsedRaw = JSON.parse(cleanedJson);
  } catch {
    const validation: MissionValidationResult = {
      ok: false,
      mission: null,
      errors: [`Pass 2 returned invalid JSON: ${cleanedJson.substring(0, 200)}`],
    };
    const trace: MissionExtractionTrace = {
      raw_user_input: userMessage,
      pass1_semantic_interpretation: pass1Result,
      pass2_structured_mission: null,
      pass2_raw_json: pass2RawResponse,
      validation_result: validation,
      model,
      pass1_duration_ms: pass1Duration,
      pass2_duration_ms: pass2Duration,
      total_duration_ms: totalDuration,
      timestamp,
    };
    console.error(`[MISSION_EXTRACTOR] Pass 2 JSON parse failed`);
    return { trace, mission: null, ok: false };
  }

  const cleaned = cleanupMissionValues(parsedRaw);
  const validation = parseAndValidateMissionJSON(JSON.stringify(cleaned));

  const trace: MissionExtractionTrace = {
    raw_user_input: userMessage,
    pass1_semantic_interpretation: pass1Result,
    pass2_structured_mission: validation.mission,
    pass2_raw_json: pass2RawResponse,
    validation_result: validation,
    model,
    pass1_duration_ms: pass1Duration,
    pass2_duration_ms: pass2Duration,
    total_duration_ms: totalDuration,
    timestamp,
  };

  if (validation.ok) {
    console.log(
      `[MISSION_EXTRACTOR] Success — entity="${validation.mission!.entity_category}" ` +
      `location="${validation.mission!.location_text}" mode="${validation.mission!.mission_mode}" ` +
      `constraints=${validation.mission!.constraints.length} model=${model} ` +
      `pass1=${pass1Duration}ms pass2=${pass2Duration}ms total=${totalDuration}ms`
    );
  } else {
    console.warn(
      `[MISSION_EXTRACTOR] Validation failed — errors: ${validation.errors.join('; ')} ` +
      `model=${model} total=${totalDuration}ms`
    );
  }

  return { trace, mission: validation.mission, ok: validation.ok };
}
